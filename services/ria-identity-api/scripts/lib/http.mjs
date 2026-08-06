// Request-plumbing primitives that decide WHO a caller is, WHAT status their error deserves,
// and HOW MUCH upstream work one request may buy.
//
// They live here rather than in server.mjs for one reason: every one of them is a control,
// and a control that cannot be unit-tested is a control you find out about in production.
// server.mjs imports these; `node --test scripts/lib` proves them.

/**
 * The address we hold accountable for this request.
 *
 * X-Forwarded-For is CLIENT-SUPPLIED AT ITS LEFT END. Every proxy in the chain APPENDS the
 * peer it saw, so a caller who sends `X-Forwarded-For: 1.1.1.1` causes us to receive
 * `1.1.1.1, <their real address>`. Reading index [0] therefore reads a value the caller
 * chose, and rotating it resets both the token bucket and the daily cap — measured against
 * the old implementation, 15 requests that should have produced five 429s produced fifteen
 * 200s, each reporting a fresh daily quota.
 *
 * So we count from the RIGHT, where our own infrastructure writes:
 *
 *   trustedProxyCount = 0  no proxy; the header is pure attacker input and is IGNORED.
 *   trustedProxyCount = 1  one trusted hop (the socket peer, e.g. bare Cloud Run). The
 *                          client is the RIGHTMOST entry, appended by that hop.
 *   trustedProxyCount = 2  Cloud Run behind an external HTTPS load balancer, which appends
 *                          its own entry after the client's.
 *
 * A header with FEWER entries than we expect has not passed through the proxies we think it
 * has, so it is not trustworthy and we fall back to the socket address. That is the safe
 * direction: over-counting a shared NAT costs a legitimate caller some quota, while
 * under-counting hands an attacker an unlimited supply of identities.
 *
 * @param {{headers:object, socket?:{remoteAddress?:string}}} request
 * @param {number} trustedProxyCount
 * @returns {string} never empty
 */
export function clientIp(request, trustedProxyCount = 1) {
  const socket = request?.socket?.remoteAddress || "unknown";
  const trusted = Number.isInteger(trustedProxyCount) && trustedProxyCount >= 0 ? trustedProxyCount : 1;
  if (trusted === 0) return socket;

  const raw = request?.headers?.["x-forwarded-for"];
  // Node collapses a repeated header into a comma-joined string, but an array is legal and
  // an attacker sending the header twice is exactly the kind of thing that produces one.
  const joined = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  const hops = joined
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);

  if (hops.length === 0) return socket;
  const index = hops.length - trusted;
  if (index < 0) return socket;
  return hops[index] || socket;
}

/**
 * HTTP status for an error escaping a handler.
 *
 * The old code mapped everything that was not a QueryError to 502, so a nonexistent CRD came
 * back as "bad gateway" (the gateway was fine; the CRD does not exist) and a malformed CRD
 * came back the same way. Both are the caller's answer to get, not ours to hide: iapd.mjs
 * already raises IapdNotFoundError with status 404 and IapdError with status 400, and this
 * simply stops throwing that information away.
 *
 * 502 remains the default, because an unclassified failure between us and an upstream IS a
 * bad gateway.
 */
export function statusForError(error, { isQueryError = false } = {}) {
  if (isQueryError) return 400;
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return 502;
}

/**
 * Per-caller DAILY ceiling on the disclosing endpoints — an ANTI-BULK-ENUMERATION control.
 *
 * The token bucket bounds a burst and nothing else: a patient crawler at 30 lookups/minute
 * walks 43,200 numbers a day, which is exactly how you would turn this endpoint into the
 * reverse-phone-lookup it is not allowed to be. A legitimate onboarding flow spends ONE
 * lookup per adviser, so a daily ceiling costs the real use case nothing and ends the
 * abusive one.
 *
 * Counts reset at the UTC day boundary by clearing the whole map, which also bounds memory:
 * it can never hold more than one day of distinct callers.
 */
export class DailyCap {
  #counts = new Map();
  #day = null;

  constructor(limit) {
    this.limit = limit;
  }

  take(identity, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#counts.clear();
    }
    const used = this.#counts.get(identity) || 0;
    if (used >= this.limit) {
      const resetsAt = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      return {
        ok: false,
        used,
        limit: this.limit,
        resetsAt: new Date(resetsAt).toISOString(),
        retryAfterSec: Math.max(1, Math.ceil((resetsAt - now) / 1000)),
      };
    }
    this.#counts.set(identity, used + 1);
    return { ok: true, used: used + 1, limit: this.limit, remaining: this.limit - used - 1 };
  }

  get status() {
    return { limit: this.limit, day: this.#day, trackedIdentities: this.#counts.size };
  }
}

/**
 * How much upstream work ONE request may buy.
 *
 * The daily cap counts REQUESTS. Without a second control a single
 * `?detail=true&limit=50` fans out to fifty IAPD profile fetches plus roster pages plus the
 * Places -> IAPD firm-search chain, so a caller comfortably inside their daily quota can
 * still put fifty times their share of load on the SEC and on Google. This bounds that.
 *
 * The budget is spent in priority order by its callers — firm resolution first, then the
 * roster, then profile hydration — so running out DEGRADES the response (fewer hydrated
 * profiles, an honestly-flagged truncated roster) instead of failing it.
 */
export class UpstreamBudget {
  #limit;
  #spent = 0;
  #denied = 0;

  constructor(limit = Infinity) {
    const n = Number(limit);
    this.#limit = Number.isFinite(n) && n >= 0 ? Math.floor(n) : Infinity;
  }

  /** @returns {boolean} true if `n` calls were charged; false if that would overspend. */
  take(n = 1) {
    const cost = Math.max(1, Math.floor(Number(n) || 1));
    if (this.#spent + cost > this.#limit) {
      this.#denied += cost;
      return false;
    }
    this.#spent += cost;
    return true;
  }

  get remaining() {
    return this.#limit === Infinity ? Infinity : Math.max(0, this.#limit - this.#spent);
  }

  get spent() {
    return this.#spent;
  }

  get exhausted() {
    return this.remaining <= 0;
  }

  /** Serialisable, and JSON-safe: Infinity would stringify as null and read as "no data". */
  get status() {
    return {
      limit: this.#limit === Infinity ? null : this.#limit,
      spent: this.#spent,
      remaining: this.remaining === Infinity ? null : this.remaining,
      denied: this.#denied,
      exhausted: this.exhausted,
    };
  }
}

/**
 * Which candidates may be hydrated with a full IAPD profile on a `detail=true` request.
 *
 * Two independent limits, and both were bugs before:
 *   - a candidate with no `individualCrd` (a Schedule A officer we can name but cannot link
 *     to an IAPD record) used to be fetched anyway, so the caller got an internal
 *     "individualCrd must be a positive integer CRD" string back as `profileError`. There is
 *     nothing to fetch; it is skipped, and `profileSkipped` says why in plain English.
 *   - the count was bounded only by `limit`, which the caller chooses. It is now bounded by
 *     config, and by whatever is left of the request's upstream budget.
 *
 * @returns {{targets:object[], skipped:object[], capped:boolean, allowed:number}}
 */
export function selectHydrationTargets(candidates, { max = 10, budget = null } = {}) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const linkable = [];
  const skipped = [];
  for (const candidate of rows) {
    if (Number.isFinite(Number(candidate?.individualCrd)) && Number(candidate.individualCrd) > 0) {
      linkable.push(candidate);
    } else {
      skipped.push(candidate);
    }
  }

  const configured = Math.max(0, Math.floor(Number(max) || 0));
  const budgeted = budget ? budget.remaining : Infinity;
  const allowed = Math.max(0, Math.min(configured, budgeted === Infinity ? configured : budgeted));
  const targets = linkable.slice(0, allowed);
  return {
    targets,
    skipped,
    capped: linkable.length > targets.length,
    allowed,
  };
}
