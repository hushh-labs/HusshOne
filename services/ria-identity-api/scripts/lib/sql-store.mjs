// Read side of the LIVE Form ADV firm table in Cloud SQL (`ria` on
// hushh-tech-prod:us-central1:hushh-directories-db), reached through the Cloud SQL Auth Proxy.
//
// This replaces the JSON snapshot the service used to load at boot. Three properties matter:
//
//  1. FIRMS ONLY. The same database has an `advisers` table and this module deliberately
//     does not read it. Measured 2026-08-06: IAPD lists four advisers currently registered at
//     firm CRD 2907 and the table holds ONE of them — the other three have no row at all, so
//     they are missing records, not stale links. Any person question answered from that table
//     would tell a real adviser they are not registered. People come live from IAPD, always.
//
//  2. NOTHING HERE WRITES. Every statement is a SELECT. The crawler owns this data; we read
//     the same rows a human would read on the SEC's own site.
//
//  3. FRESHNESS IS PART OF THE ANSWER. `ingest_runs` records when the Form ADV feed last
//     landed successfully, and every response carries the age. A phone -> firm mapping from a
//     three-week-old bulk file is still a real filing, but the caller has to be able to see
//     how old it is without asking us.
//
//  4. IT IS OPTIONAL. This is the property the rest of the file is built around. The service
//     does not depend on a 24/7 database: the live Google Places -> IAPD chain answers phone
//     -> firm on its own, so a store that is UNCONFIGURED, SWITCHED OFF, UNREACHABLE or SLOW
//     must cost the caller nothing but a corroborating signal. Concretely, in this module:
//       - a disabled store NEVER opens a socket and NEVER throws; it reports
//         `consulted:false, skipped:"not_configured"` and the resolver treats that as
//         "we did not ask", which is a different fact from "we asked and there was no row";
//       - every query is raced against `db.timeoutMs` (default 800ms), so a hung proxy costs
//         800ms of a request that was doing the live chain in parallel anyway;
//       - `health()` returns `{configured:false}` or `{configured:true, reachable, ageDays,
//         stale}` and is the ONLY shape /health should render, so a database outage can
//         never be rendered as a service outage.
//
// Injectable by design: `createStore({ query })` takes any `(sql, params) => {rows}`, so the
// whole module unit-tests against fixtures with no database and no network.

import { digitsOnly, normalizePhone } from "./phone.mjs";

/** Anything that went wrong talking to Postgres. Carries `status` so the HTTP layer maps it
 *  to 502 (a dependency failure) and not to 500 (our bug) or 404 (a real answer).
 *
 *  NOTE FOR CALLERS ON THE LOOKUP PATH: none of this should reach an HTTP status any more.
 *  resolve.mjs catches every StoreError and continues on the live chain — this type exists so
 *  a caller can tell WHICH failure happened (`code`: "timeout", "not_configured", "pool_init",
 *  a pg SQLSTATE), not so a failure can be escalated into a 502 the user sees. */
export class StoreError extends Error {
  constructor(message, { cause = null, code = null } = {}) {
    super(message);
    this.name = "StoreError";
    this.status = 502;
    this.code = code;
    /** Convenience for the resolver, which reports these two very differently. */
    this.timeout = code === "timeout";
    this.notConfigured = code === "not_configured";
    if (cause) this.cause = cause;
  }
}

/** Said in one place so /health, /v1/stats and the resolver cannot drift into three
 *  differently-alarming ways of describing a perfectly supported configuration. */
export const NOT_CONFIGURED_NOTE =
  "No Cloud SQL Form ADV table is configured, so it is not consulted. Phone -> firm resolves live from Google Places cross-validated through SEC IAPD, and people come live from IAPD as always. This is a supported standalone mode, not a degraded one.";

/** What /health says about an absent database. Exported so a test can assert that the word
 *  the operator reads is never "unreachable" when nobody ever asked. */
export const NOT_CONFIGURED_HEALTH_KEYS = Object.freeze(["configured", "enabled", "enabledMode", "reason", "note"]);

/** The columns we read. `raw` and `geog` are deliberately absent: `raw` is the unparsed Form
 *  ADV fragment (we already have every field we publish from it) and `geog` is a generated
 *  PostGIS column that does not serialise usefully over JSON. */
const FIRM_COLUMNS = `crd, sec_number, firm_name, street1, street2, city, state, zip, country,
       phone, website, aum, total_employees, num_accounts, registration_status,
       lat, lng, sources, first_seen, last_seen`;

/** Matches the functional index `firms_phone10_idx`. Keep the expression BYTE-IDENTICAL to
 *  the index definition or Postgres silently falls back to a sequential scan. */
const PHONE_DIGITS_SQL = `regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')`;

const FIRM_BY_PHONE_SQL = `
  SELECT ${FIRM_COLUMNS}
    FROM firms
   WHERE ${PHONE_DIGITS_SQL} = $1
      OR ${PHONE_DIGITS_SQL} = '1' || $1
   LIMIT 25`;

const FIRM_BY_CRD_SQL = `
  SELECT ${FIRM_COLUMNS}
    FROM firms
   WHERE crd = $1
   LIMIT 1`;

/** Same functional index, but against a set — used only for the transposition second pass. */
const FIRM_BY_PHONE_ANY_SQL = `
  SELECT ${FIRM_COLUMNS}
    FROM firms
   WHERE ${PHONE_DIGITS_SQL} = ANY($1::text[])
      OR ${PHONE_DIGITS_SQL} = ANY(SELECT '1' || v FROM unnest($1::text[]) AS v)
   LIMIT 25`;

/** The nine numbers reachable from a ten-digit number by swapping one ADJACENT pair of digits.
 *  Bounded, deterministic, and small enough for one indexed query. Identical neighbours produce
 *  the original number, which is dropped — it already missed. */
export function transpositionVariants(phone10) {
  const s = String(phone10 || "");
  if (!/^\d{10}$/.test(s)) return [];
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === s[i + 1]) continue;
    out.add(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
  }
  out.delete(s);
  return [...out];
}

/** The last time the FIRM feed landed successfully. `ok = true` is load-bearing: a run that
 *  started and failed must never be reported as freshness, or a broken pipeline reads as a
 *  healthy one.
 *
 *  But the run LEDGER is not the only evidence of age, and on its own it lies in the common
 *  case. Observed live: run id 44 pulled IA_FIRM_SEC_Feed_08_06_2026 and upserted the whole
 *  table — firms.last_seen moved to 2026-08-06 — then the operator's terminal was interrupted
 *  before the run could close, leaving finished_at NULL and ok=false. The ledger said "age
 *  unknown, assume stale" about data that was hours old, and /health told an operator to go
 *  check a pipeline that had in fact done its job.
 *
 *  So: prefer a completed run (it names the source file, which is the better provenance), and
 *  fall back to the newest firms.last_seen, which is the data's own evidence of when it was
 *  last written. `ledgerBacked` says which one answered, so an operator can still tell the
 *  difference between "a run closed cleanly" and "rows are recent but no run claims them". */
const FRESHNESS_SQL = `
  SELECT source_file, finished_at, rows_upserted, true AS ledger_backed
    FROM ingest_runs
   WHERE kind = 'firms' AND ok = true AND finished_at IS NOT NULL
   ORDER BY finished_at DESC
   LIMIT 1`;

const FRESHNESS_FALLBACK_SQL = `
  SELECT NULL::text AS source_file,
         MAX(last_seen) AS finished_at,
         COUNT(*)       AS rows_upserted,
         false          AS ledger_backed
    FROM firms`;

const numOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
};

/**
 * One `firms` row -> the firm record the rest of the service speaks.
 *
 * Two fields deserve their comment:
 *
 * `scheduleAPersons` is ABSENT, not empty. This table carries no Schedule A: the crawler
 * ingests the SEC's firm feed, whose per-firm fragment holds info / rgstn / item5A / item5F /
 * website / mainAddr and no owner list. Absent means "this source cannot say", which is what
 * lets toFirmSummary report `scheduleAPersonCount: null` instead of claiming a firm has zero
 * owners. An empty array here would be a lie with a privacy-shaped upside, and lies in this
 * direction are still lies.
 *
 * `advisoryEmployees` is the firm's own Form ADV item 5A total-employee count. It is the size
 * signal the disclosure gate reads, and it is frequently 0 or absent — which the gate must
 * treat as "unknown", never as "small". See scheduleAFallback in resolve.mjs.
 */
export function mapFirmRow(row) {
  if (!row) return null;
  const crd = numOrNull(row.crd);
  if (crd == null) return null;

  const phone = strOrNull(row.phone);
  const digits = digitsOnly(phone || "");
  const phone10 = digits.length === 10 ? digits : normalizePhone(phone).national10;
  const employees = numOrNull(row.total_employees);

  return {
    crd,
    name: strOrNull(row.firm_name),
    dba: null,
    secNumber: strOrNull(row.sec_number),
    // The crawler ingests the SEC firm feed (IA_FIRM_SEC_Feed_*.xml.gz), so every row here
    // is an SEC registration. State-only registrations are not in this table at all.
    registrationType: "sec",
    registrationStatus: strOrNull(row.registration_status),
    street1: strOrNull(row.street1),
    street2: strOrNull(row.street2),
    city: strOrNull(row.city),
    state: strOrNull(row.state),
    zip: strOrNull(row.zip),
    country: strOrNull(row.country),
    phone,
    phone10: phone10 || null,
    website: strOrNull(row.website),
    totalEmployees: employees,
    advisoryEmployees: employees,
    iarCount: null,
    effectiveAdviserCount: null,
    aum: numOrNull(row.aum),
    numAccounts: numOrNull(row.num_accounts),
    lat: numOrNull(row.lat),
    lng: numOrNull(row.lng),
    latestFilingDate: null,
    sources: Array.isArray(row.sources) ? row.sources : null,
    firstSeen: row.first_seen ? new Date(row.first_seen).toISOString() : null,
    lastSeen: row.last_seen ? new Date(row.last_seen).toISOString() : null,
    recordSource: "form_adv_db",
  };
}

/** Deterministic order, so the same phone number always produces the same pick-list: bigger
 *  reported headcount first (the better-documented registration), then by name. */
function orderFirms(firms) {
  return firms.sort((a, b) => {
    const ac = a.advisoryEmployees ?? -1;
    const bc = b.advisoryEmployees ?? -1;
    if (ac !== bc) return bc - ac;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

/** Age of a Form ADV ingest, in the shape every response carries. Safe with a null row. */
export function freshnessFrom(row, { now = Date.now(), staleAfterDays = 14 } = {}) {
  const finishedAt = row?.finished_at ? new Date(row.finished_at) : null;
  const ms = finishedAt && !Number.isNaN(finishedAt.getTime()) ? now - finishedAt.getTime() : null;
  const ageDays = ms == null ? null : Math.round((ms / 86_400_000) * 10) / 10;
  return {
    lastIngestAt: finishedAt && !Number.isNaN(finishedAt.getTime()) ? finishedAt.toISOString() : null,
    sourceFile: strOrNull(row?.source_file),
    // true  = a completed ingest_runs row answered (best provenance: it names the feed file)
    // false = no closed run, so firms.last_seen answered instead (the rows' own write time)
    ledgerBacked: row == null ? null : row.ledger_backed !== false,
    rowsUpserted: numOrNull(row?.rows_upserted),
    ageDays,
    staleAfterDays,
    // Unknown age counts as stale. "We cannot tell you how old this is" is not a reassurance.
    stale: ageDays == null ? true : ageDays > staleAfterDays,
  };
}

/** Freshness for a database nobody consulted.
 *
 *  `stale` is FALSE here, and that is deliberate — it is the one place this module says
 *  something is fine when it does not know. Unknown age is stale (see freshnessFrom) because
 *  an unreadable timestamp on a source we ARE using is a warning. A source we are not using
 *  has no age to be worried about, and reporting stale:true would light up the "check the
 *  directories ingest job" hint on a deployment that deliberately has no ingest job. */
export function notConfiguredFreshness({ staleAfterDays = 14 } = {}) {
  return {
    configured: false,
    applicable: false,
    lastIngestAt: null,
    sourceFile: null,
    rowsUpserted: null,
    ageDays: null,
    staleAfterDays,
    stale: false,
    skipped: "not_configured",
    note: NOT_CONFIGURED_NOTE,
  };
}

/**
 * Build the store.
 *
 * @param {object} options
 * @param {(sql:string, params:any[]) => Promise<{rows:any[]}>} [options.query]
 *        Injected for tests. Omitted in production, where a pg Pool is created lazily on the
 *        first query so importing this module never opens a socket.
 * @param {object} [options.db]  config.db
 * @param {boolean} [options.enabled]
 *        Override for config.db.enabled. Default: whatever config resolved; failing that,
 *        true when a query is injected (a test that hands us a query means to use it) and
 *        otherwise only when a password or an explicit host exists.
 * @param {number} [options.timeoutMs]
 *        Per-query deadline, ms. 0 disables it. Default config.db.timeoutMs, else 800.
 */
export function createStore(options = {}) {
  const {
    db = {},
    query: injectedQuery = null,
    now = () => Date.now(),
    freshnessTtlMs = db.freshnessTtlMs ?? 300_000,
    staleAfterDays = db.staleAfterDays ?? 14,
  } = options;

  // Enablement, resolved once. The fallback chain matters: config.mjs decides this in
  // production, and the last clause keeps every existing injected-query test working without
  // making a bare createStore() in some future caller quietly dial a database nobody set up.
  const enabled = Boolean(
    options.enabled ?? db.enabled ?? (injectedQuery ? true : Boolean(db.password || db.hostConfigured)),
  );
  const enabledMode = db.enabledMode ?? (options.enabled != null || db.enabled != null ? "explicit" : "auto");
  const reason =
    db.reason ??
    (enabled
      ? "A Cloud SQL Form ADV table is configured and will be consulted."
      : "No Cloud SQL Form ADV table is configured.");

  const rawTimeout = Number(options.timeoutMs ?? db.timeoutMs);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : 800;

  // Freshness is a REPORTING read: nothing waits on it. `timeoutMs` exists to stop a hung proxy
  // delaying a LOOKUP that is already racing the live chain in parallel, and applying that same
  // budget here meant a cold pg pool — which needs ~800ms just to connect — timed out on every
  // cold start, so /health reported "age unknown, assume stale" about data that was hours old.
  // Six times the lookup budget, DERIVED from it so an operator who tightens one tightens both.
  const freshnessTimeoutMs = Number.isFinite(db.freshnessTimeoutMs) ? db.freshnessTimeoutMs : timeoutMs * 6;

  // How long a FAILED freshness read is remembered. Short, and separate from freshnessTtlMs:
  // caching a failure for the full five minutes served a boot-time blip as fact, while not
  // caching it at all made every /health pay the full deadline against a dead database.
  const freshnessErrorTtlMs = Number.isFinite(db.freshnessErrorTtlMs) ? db.freshnessErrorTtlMs : 10_000;

  let pool = null;
  let poolError = null;
  let closed = false;

  async function getPool() {
    if (pool) return pool;
    if (poolError) throw poolError;
    try {
      const { default: pg } = await import("pg");
      pool = new pg.Pool({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
        password: db.password,
        max: db.poolMax ?? 5,
        connectionTimeoutMillis: db.connectionTimeoutMs ?? 5_000,
        // Belt and braces against a query that will not come back: the pool timeout covers
        // connecting, this covers a connection that connected and then hung.
        statement_timeout: db.statementTimeoutMs ?? 5_000,
        // An idle client that the proxy has silently dropped must not be handed to a request.
        idleTimeoutMillis: 30_000,
        allowExitOnIdle: true,
      });
      // A pool-level error with no listener is an unhandled 'error' event, which takes the
      // whole process down when the proxy restarts. It must be a logged blip instead.
      pool.on("error", (error) => {
        console.warn(JSON.stringify({ event: "db.pool_error", error: error?.message || String(error) }));
      });
      return pool;
    } catch (error) {
      poolError = new StoreError(`Could not initialise the Postgres pool: ${error?.message || error}`, {
        cause: error,
        code: "pool_init",
      });
      throw poolError;
    }
  }

  /**
   * Race a query against the request-side deadline.
   *
   * WHY A RACE AND NOT JUST pg's TIMEOUTS. connectionTimeoutMs and statement_timeout bound a
   * broken socket and a runaway statement; neither bounds "the proxy accepted the connection
   * and then went quiet", and both are set five seconds out because that is the right number
   * for a socket and the wrong number for a person waiting. The DB is a corroborating source
   * running in parallel with the live chain, so the honest deadline is "however long the
   * answer can afford to wait for a second opinion" — 800ms by default.
   *
   * The loser of the race is NOT cancelled (pg has no cancel here) but it IS handled:
   * Promise.race attaches a rejection handler to both sides, so a query that fails after the
   * deadline cannot surface as an unhandled rejection and take the process down.
   */
  function withDeadline(work, label, budgetMs = timeoutMs) {
    if (!(budgetMs > 0)) return work;
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new StoreError(
            `Cloud SQL did not answer within ${budgetMs}ms (${label}); continuing without it`,
            { code: "timeout" },
          ),
        );
      }, budgetMs);
      // DELIBERATELY NOT unref()'d. An unref'd timer only fires if something ELSE is keeping
      // the loop alive, so when a hung query is the last pending work the deadline would
      // never fire and the caller would wait forever — the exact failure it exists to
      // prevent. It is cleared in the finally below, so it holds the loop for at most
      // `timeoutMs`, and only while a query is genuinely in flight.
    });
    return Promise.race([work, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async function run(sql, params, label, budgetMs = timeoutMs) {
    if (closed) throw new StoreError(`Store is closed (${label})`, { code: "closed" });
    // Structural guarantee, not just a policy: with the store disabled nothing below this
    // line runs, so there is no pool, no socket and no `pg` import. Every public method
    // short-circuits before it gets here — this is the backstop for the one that forgets.
    if (!enabled) {
      throw new StoreError(`Cloud SQL is not configured, so it was not consulted (${label})`, {
        code: "not_configured",
      });
    }
    try {
      // `injectedQuery` may throw synchronously; starting it inside a thenable keeps that on
      // the promise path so the deadline still applies to it.
      const work = injectedQuery
        ? Promise.resolve().then(() => injectedQuery(sql, params))
        : getPool().then((p) => p.query(sql, params));
      return await withDeadline(work, label, budgetMs);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(`Cloud SQL query failed (${label}): ${error?.message || error}`, {
        cause: error,
        code: error?.code || null,
      });
    }
  }

  let freshnessCache = null; // { at, value }

  const store = {
    /** Is the Form ADV table part of this deployment's answer at all? */
    get enabled() {
      return enabled;
    },

    /**
     * Firms whose Form ADV main-office telephone number is this number.
     *
     * Accepts anything normalizePhone understands, so a caller that already normalised does
     * not pay twice and a caller that forgot is not silently wrong. Returns [] for an
     * unparseable number WITHOUT touching the database.
     *
     * `consulted` IS THE FIELD THAT MATTERS. `firms: []` alone is ambiguous between two facts
     * the caller must not conflate: "the SEC's firm feed has no filing with this number"
     * (evidence — it lowers our belief that a Form ADV firm owns this line) and "we never
     * looked" (no evidence either way, and no reason to lower anything). The resolver renders
     * the first as a miss and the second as skipped/not_configured.
     *
     * @returns {Promise<{firms:object[], phone10:string|null, ms:number,
     *                    consulted:boolean, skipped:string|null}>}
     */
    async lookupByPhone(phone) {
      const raw = digitsOnly(phone);
      const phone10 = raw.length === 10 ? raw : normalizePhone(phone).national10;
      if (!phone10) return { firms: [], phone10: null, ms: 0, consulted: false, skipped: "invalid_phone" };
      // Disabled: no socket, no throw, no lost answer. The caller's live chain is already
      // in flight and is the whole answer in this mode.
      if (!enabled) return { firms: [], phone10, ms: 0, consulted: false, skipped: "not_configured" };

      const started = now();
      const result = await run(FIRM_BY_PHONE_SQL, [phone10], "lookupByPhone");
      let firms = orderFirms((result?.rows || []).map(mapFirmRow).filter(Boolean));
      let matchedVia = firms.length ? "exact" : null;

      // SECOND PASS: the firm typo'd its own number on the filing.
      //
      // Real case, measured 2026-08-06: ROBINSWOOD FINANCIAL (CRD 143417) files 452-296-1611.
      // The line that actually rings is 425-296-1611 — two adjacent digits transposed. Google
      // does not list that number either, so BOTH resolution paths missed and seven advisers at
      // a real firm got "no SEC-registered advisory firm files that number". The adviser has no
      // idea their firm's filing has a typo, and nothing they can type will fix it.
      //
      // So when the exact lookup finds nothing, try the ten-digit number's adjacent
      // transpositions — nine variants, one indexed query, only ever run on a miss. It is
      // deliberately NOT a fuzzy search: a transposition is a specific, common typing error
      // with a bounded variant set, unlike a wrong or missing digit which would collide with
      // real numbers belonging to other firms.
      //
      // A transposition hit is reported as such and never presented as an exact match, because
      // it is weaker evidence: the resolver and the caller both need to see that the number the
      // claimant typed is not the number on the filing.
      if (!firms.length) {
        const variants = transpositionVariants(phone10);
        if (variants.length) {
          const fuzzy = await run(FIRM_BY_PHONE_ANY_SQL, [variants], "lookupByPhone-transposed");
          const found = orderFirms((fuzzy?.rows || []).map(mapFirmRow).filter(Boolean));
          // Ambiguity here is not resolvable evidence — if two different firms' filed numbers
          // are each one transposition away from what was typed, we have learned nothing.
          if (found.length === 1) {
            firms = found;
            matchedVia = "transposition";
          }
        }
      }

      return { firms, phone10, ms: now() - started, consulted: true, skipped: null, matchedVia };
    },

    /** The Form ADV row for one firm CRD, or null. Null when the store is disabled, which is
     *  exactly what the callers already handle — firmRecordFor() in resolve.mjs and the
     *  /v1/firms/{crd} route both fall through to live IAPD firm detail on a null. */
    async getFirm(crd) {
      const key = Number(crd);
      if (!Number.isInteger(key) || key <= 0) return null;
      if (!enabled) return null;
      const result = await run(FIRM_BY_CRD_SQL, [key], "getFirm");
      return mapFirmRow((result?.rows || [])[0]) || null;
    },

    /**
     * How old the Form ADV mapping is. Cached for `freshnessTtlMs` — the bulk feed lands
     * daily at best, so asking per request would be pure overhead.
     *
     * NEVER THROWS. Freshness is metadata about an answer; failing to read it must not cost
     * the caller the answer itself.
     */
    async freshness() {
      const at = now();
      // No source, so no age. Not cached: it is a constant, and caching it would make the
      // shape depend on call order for no gain.
      if (!enabled) return notConfiguredFreshness({ staleAfterDays });
      if (freshnessCache && at - freshnessCache.at < freshnessTtlMs) return freshnessCache.value;
      let value;
      try {
        const result = await run(FRESHNESS_SQL, [], "freshness", freshnessTimeoutMs);
        let row = (result?.rows || [])[0] || null;
        // No closed run says anything about the firm feed. Ask the rows themselves how recently
        // they were written before concluding the age is unknown — an interrupted run leaves a
        // fully-updated table behind an open ledger entry, and calling that "stale" sends an
        // operator after a pipeline that already did its job.
        if (!row?.finished_at) {
          const fallback = await run(FRESHNESS_FALLBACK_SQL, [], "freshness-fallback", freshnessTimeoutMs);
          const candidate = (fallback?.rows || [])[0] || null;
          if (candidate?.finished_at) row = candidate;
        }
        value = { configured: true, applicable: true, ...freshnessFrom(row, { now: at, staleAfterDays }) };
      } catch (error) {
        value = {
          configured: true,
          applicable: true,
          ...freshnessFrom(null, { now: at, staleAfterDays }),
          error: error?.message || String(error),
        };
        // A failure is remembered only briefly (see freshnessErrorTtlMs). An unknown age is a
        // transient state, not a fact: the next caller after the blip must reach the database
        // and get the real answer, but a dead database must not make every health check pay
        // the full deadline.
        freshnessCache = { at: at - (freshnessTtlMs - freshnessErrorTtlMs), value };
        return value;
      }
      freshnessCache = { at, value };
      return value;
    },

    /** Reachability probe for /health. NEVER THROWS — it reports.
     *
     *  `ok` is NULL, not false, when the store is disabled. false means "we asked and it did
     *  not answer"; null means "there is nothing to ask". Collapsing the two is exactly how a
     *  deployment that never had a database ends up rendering a red dot forever. */
    async ping() {
      if (!enabled) {
        return { ok: null, ms: 0, error: null, configured: false, skipped: "not_configured" };
      }
      const started = now();
      try {
        const result = await run("SELECT 1 AS ok", [], "ping");
        return { ok: (result?.rows || [])[0]?.ok === 1, ms: now() - started, error: null, configured: true, skipped: null };
      } catch (error) {
        return { ok: false, ms: now() - started, error: error?.message || String(error), configured: true, skipped: null };
      }
    },

    /**
     * THE /health BLOCK for this dependency. NEVER THROWS.
     *
     * Two shapes, and the difference between them is the whole point:
     *
     *   not configured -> { configured:false, enabled:false, enabledMode, reason, note }
     *                     No `reachable`, no `stale`, no `ageDays`. There is no reading to
     *                     report, and a null in one of those fields is read by every
     *                     dashboard on earth as a failure.
     *
     *   configured     -> { configured:true, enabled:true, reachable:<bool>, ageDays, stale,
     *                       latencyMs, error, lastIngestAt, ...connection facts }
     *                     reachable:false is a real signal and stays honest — but it is a
     *                     signal about THIS SOURCE. The service is still fully functional on
     *                     the live chain, and `note` says so in the same breath so nobody
     *                     pages themselves at 3am for a corroborating source.
     *
     * The caller (/health) must keep its own `ok` true regardless: this block is the detail,
     * not the verdict.
     */
    async health() {
      if (!enabled) {
        return { configured: false, enabled: false, enabledMode, reason, note: NOT_CONFIGURED_NOTE };
      }
      const [probe, fresh] = await Promise.all([store.ping(), store.freshness()]);
      return {
        configured: true,
        enabled: true,
        enabledMode,
        reason,
        reachable: Boolean(probe.ok),
        latencyMs: probe.ms,
        error: probe.error,
        timeoutMs,
        ageDays: fresh?.ageDays ?? null,
        stale: fresh?.stale ?? true,
        lastIngestAt: fresh?.lastIngestAt ?? null,
        staleAfterDays,
        ...store.describe,
        note: probe.ok
          ? "Cloud SQL Form ADV table is answering and corroborates the live Places/IAPD chain."
          : "Cloud SQL is not answering, so phone -> firm resolves from the live Places/IAPD chain alone. Lookups continue to work; only the Form ADV corroboration is missing.",
      };
    },

    async close() {
      closed = true;
      if (pool) {
        const p = pool;
        pool = null;
        try {
          await p.end();
        } catch {
          // Shutting down. A pool that will not close cleanly must not stop the process.
        }
      }
    },

    get describe() {
      // Connection facts only, and never the password. When the store is disabled the
      // host/port/user are whatever the defaults happen to be and mean nothing — `enabled`
      // is the field to read first, which is why it is first.
      return {
        enabled,
        enabledMode,
        timeoutMs,
        host: enabled ? db.host ?? null : null,
        port: enabled ? db.port ?? null : null,
        database: enabled ? db.database ?? null : null,
        user: enabled ? db.user ?? null : null,
        passwordConfigured: Boolean(db.password),
        mode: !enabled ? "disabled" : injectedQuery ? "injected" : "pg-pool",
      };
    },
  };

  return store;
}
