// Request parsing + validation for /v1/claim/*. Pure — no network, no disk, unit-testable.
//
// The division of labour matters here: this module decides whether the REQUEST is
// well-formed, and resolve.mjs decides whether the NUMBER is usable. So `phone` is accepted
// as free text and a nonsense number is a 200 with outcome:"invalid_phone" — the caller is
// a human mid-onboarding who deserves a guidance string in the response body, not a bare
// 400 the front-end has to reinterpret.

import { config } from "./config.mjs";

export class QueryError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "QueryError";
    this.field = field;
  }
}

const STREAMS = new Set(["ndjson", "sse", "off"]);
const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSEY = new Set(["false", "0", "no", "off"]);

/**
 * WHICH CLAIM TARGET THE CALLER IS ASKING ABOUT.
 *
 * One phone number belongs to a firm AND to every adviser registered there, so the lookup has
 * two legitimate answers and the caller says which it wants:
 *
 *   auto        both — the firm claim and, when the roster is small enough to be useful, the
 *               people. The default, and the only value that can return nextStep
 *               "choose_identity".
 *   firm        hydrate the firm claim and SKIP person hydration entirely. The fast path.
 *   individual  hydrate the people.
 *
 * `mode` GOES THROUGH pick(), WHICH THROWS. That is the whole point of adding it here rather
 * than reading it in the handler: an unknown query parameter is silently ignored by this
 * service (and by every other), so a front-end that shipped `mode=firms` — or `mode=Firm` on a
 * case-sensitive comparison, or `claimType=firm` because someone misremembered the name —
 * would get a full dual response back, look at the firmClaim in it, and conclude the parameter
 * worked. It would then be broken in exactly the case it was added for, silently, in
 * production. A 400 naming the legal values costs one round-trip and is discovered immediately.
 *
 * MODE IS A PERFORMANCE AND SHAPE CONTROL, NOT A DISCLOSURE CONTROL. Every withholding rule in
 * resolve.mjs applies identically in all three: mode=firm cannot surface a person that
 * mode=individual would withhold, and the large-firm and zero-advisory-staff gates behave the
 * same in every mode. mode=firm returns FEWER facts than auto, never more.
 */
export const MODES = new Set(["auto", "firm", "individual"]);

/** Claim targets /v1/claim/evaluate will score. Same two words as `mode`'s narrowing values,
 *  deliberately — a front-end that renders a "claim the firm" button passes the same token to
 *  both endpoints. */
const CLAIM_TYPES = new Set(["individual", "firm"]);

/** A hard ceiling on asserted evidence. The engine caps this too; it is duplicated here so a
 *  1,000-item array is refused before it is parsed rather than after. */
const MAX_EVIDENCE_ITEMS = 32;

// "+1 (914) 225-1000 extension 12345" is 34 characters, so 64 leaves generous room for
// whatever punctuation a human types while still refusing a pasted contact card — or a
// probe — being handed to the normaliser as if it were a phone number.
const MAX_PHONE_LENGTH = 64;
const MAX_NAME_LENGTH = 120;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function num(params, key) {
  const raw = params.get(key);
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new QueryError(`${key} must be a number`, key);
  return value;
}

function pick(params, key, allowed, fallback) {
  const raw = (params.get(key) || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (!allowed.has(raw)) throw new QueryError(`${key} must be one of: ${[...allowed].join(", ")}`, key);
  return raw;
}

/** Booleans are validated rather than coerced. The siblings treat "anything not in the
 *  false-list" as true, which is fine for a default-TRUE flag; here the flag defaults to
 *  false, so the same trick would silently swallow `detail=treu` and quietly return less
 *  data than the caller asked for. Naming the mistake is cheaper than debugging it. */
function bool(params, key, fallback) {
  const raw = (params.get(key) || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (TRUTHY.has(raw)) return true;
  if (FALSEY.has(raw)) return false;
  throw new QueryError(`${key} must be one of: ${[...TRUTHY, ...FALSEY].join(", ")}`, key);
}

/** Shared by both endpoints. Out-of-range CLAMPS (matching the sibling services, so a
 *  caller's limit=1000 still returns a useful page instead of an error) but non-numeric
 *  THROWS, because `limit=all` means the caller believes something untrue about the API. */
function limitOf(params) {
  return Math.round(clamp(num(params, "limit") ?? config.lookup.defaultLimit, 1, config.lookup.maxLimit));
}

/**
 * Parse `/v1/claim/lookup` query params.
 *
 * `phone` is required and passed through verbatim: normalisation (and the NANP judgement
 * call) belongs to phone.mjs via resolve.mjs, which has to report `query.national10` back
 * to the UI anyway.
 */
export function parseQuery(params) {
  const phone = (params.get("phone") || "").trim();
  if (!phone) throw new QueryError("phone is required.", "phone");
  if (phone.length > MAX_PHONE_LENGTH) {
    throw new QueryError(`phone must be ${MAX_PHONE_LENGTH} characters or fewer.`, "phone");
  }

  return {
    phone,
    // Hydrating every candidate into a full IAPD profile costs one upstream call per
    // person, so it is opt-IN — the opposite of the sibling services. A pick-list only
    // needs names; the profile matters after the claimant has picked a row.
    detail: bool(params, "detail", false),
    stream: pick(params, "stream", STREAMS, "ndjson"),
    limit: limitOf(params),
    // See MODES. Throws on an unknown value rather than being ignored.
    mode: pick(params, "mode", MODES, "auto"),
  };
}

/** A positive integer CRD, or null when the key is absent. Rejects 0, negatives and floats —
 *  all three would otherwise reach an upstream call as a malformed URL. */
function crdOf(params, key, { required = false } = {}) {
  const raw = (params.get(key) || "").trim();
  if (!raw) {
    if (required) throw new QueryError(`${key} is required.`, key);
    return null;
  }
  if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 0) {
    throw new QueryError(`${key} must be a positive integer CRD.`, key);
  }
  return Number(raw);
}

/**
 * Parse `/v1/claim/evaluate` — the policy endpoint.
 *
 * THE GET FORM CARRIES SIGNAL NAMES ONLY. `?evidence=phone_otp,roster_selection` is enough to
 * ask "what would a passcode alone get me here?", which is the question a front-end asks while
 * it is deciding what to render. Anything with a payload — the verified email address, the
 * OIDC-verified name — must be POSTed as JSON: those belong in a request BODY, not in a URL
 * that lands in an access log, a Referer header and a browser history entry. The parser will
 * not accept them here, so nobody can put a claimant's email in a query string by accident.
 */
export function parseEvaluateQuery(params) {
  const claimType = pick(params, "claimtype", CLAIM_TYPES, null) ?? pick(params, "claimType", CLAIM_TYPES, null);
  if (!claimType) {
    throw new QueryError(`claimType is required and must be one of: ${[...CLAIM_TYPES].join(", ")}.`, "claimType");
  }

  const raw = (params.get("evidence") || "").trim();
  const names = raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  if (names.length > MAX_EVIDENCE_ITEMS) {
    throw new QueryError(`evidence must list ${MAX_EVIDENCE_ITEMS} signals or fewer.`, "evidence");
  }
  for (const name of names) {
    if (!/^[a-z_]{2,40}$/.test(name)) throw new QueryError(`evidence contains an unusable signal name: ${name}`, "evidence");
    if (name === "domain_email" || name === "oidc_verified_name") {
      throw new QueryError(
        `${name} carries a claimant's personal data (an email address or a verified legal name) and must be POSTed as JSON, never put in a query string where it lands in access logs and browser history.`,
        "evidence",
      );
    }
  }

  return {
    claimType,
    firmCrd: crdOf(params, "firmCrd", { required: true }),
    individualCrd: crdOf(params, "individualCrd"),
    evidence: names.map((type) => ({ type })),
    limit: limitOf(params),
  };
}

/**
 * Parse a POSTed `/v1/claim/evaluate` body — the form an integrator's BFF actually uses.
 *
 * Validates SHAPE only. Whether a piece of evidence is worth anything is claim.mjs's judgement
 * and it has to be made in one place; this function's job is to make sure the thing handed to
 * that judgement is an object with a string `type`, so a malformed body is a 400 with a field
 * name instead of a 500 from inside the engine.
 */
export function parseEvaluateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new QueryError("The request body must be a JSON object.", "body");
  }

  const claimType = String(body.claimType ?? "").trim().toLowerCase();
  if (!CLAIM_TYPES.has(claimType)) {
    throw new QueryError(`claimType is required and must be one of: ${[...CLAIM_TYPES].join(", ")}.`, "claimType");
  }

  const intOrNull = (value, key, { required = false } = {}) => {
    if (value === null || value === undefined || value === "") {
      if (required) throw new QueryError(`${key} is required.`, key);
      return null;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new QueryError(`${key} must be a positive integer CRD.`, key);
    return n;
  };

  const evidence = body.evidence ?? [];
  if (!Array.isArray(evidence)) throw new QueryError("evidence must be an array.", "evidence");
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new QueryError(`evidence must contain ${MAX_EVIDENCE_ITEMS} items or fewer.`, "evidence");
  }
  evidence.forEach((item, i) => {
    if (typeof item === "string") return;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new QueryError(`evidence[${i}] must be a string or an object with a "type".`, "evidence");
    }
    if (!String(item.type ?? item.signal ?? "").trim()) {
      throw new QueryError(`evidence[${i}] has no "type".`, "evidence");
    }
  });

  return {
    claimType,
    firmCrd: intOrNull(body.firmCrd, "firmCrd", { required: true }),
    individualCrd: intOrNull(body.individualCrd ?? body.selectedIndividualCrd, "individualCrd"),
    evidence,
    limit: config.lookup.defaultLimit,
  };
}

/**
 * Parse `/v1/claim/search` query params — the fallback for when the phone number misses
 * (a mobile, a new office line, a firm that filed a different number on its Form ADV).
 */
export function parseSearchQuery(params) {
  const name = (params.get("name") || "").trim();
  if (!name) throw new QueryError("name is required.", "name");
  if (name.length > MAX_NAME_LENGTH) {
    throw new QueryError(`name must be ${MAX_NAME_LENGTH} characters or fewer.`, "name");
  }

  const stateRaw = (params.get("state") || "").trim();
  if (stateRaw && !/^[A-Za-z]{2}$/.test(stateRaw)) {
    throw new QueryError("state must be a two-letter US state or territory code (e.g. NY).", "state");
  }

  return {
    name,
    // Optional, but the single most useful narrowing signal we have for a common name.
    state: stateRaw ? stateRaw.toUpperCase() : null,
    limit: limitOf(params),
  };
}
