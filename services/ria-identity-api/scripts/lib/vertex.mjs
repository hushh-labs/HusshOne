// ===========================================================================
// THE RULE THIS MODULE EXISTS TO ENFORCE
// ===========================================================================
//
//   A language model may PROPOSE a candidate, RANK candidates, or PHRASE an explanation.
//   It may NEVER be the source of a fact that reaches the caller. Every identifier, name,
//   CRD, date and registration in a response must come from an SEC or FINRA endpoint.
//
// This is not a style preference. It is measured. Asked "who are the advisers at Robinswood
// Financial LLC, CRD 143417", a web-grounded LLM named TWO people. The SEC roster for that
// firm has SEVEN:
//
//   2486426 ROBERT WARD GUILD          2848710 EDWARD LEE WARD
//   4661439 JANET HARRIS WEISMAN       6844196 Robert David MacRae
//   6742656 Christopher Edward Simon-Wallace
//   6786615 Colleen M Bracy            6689626 Kelsey Ann Curtis
//
// Had the model been the source, five real advisers would have been told they do not exist
// — during the one flow where they are trying to claim their own professional identity.
//
// HOW THE RULE IS ENFORCED STRUCTURALLY (not by discipline, by shape):
//
//   Every exported function either
//     (a) returns an INDEX into a list of candidates the CALLER already fetched from SEC —
//         chooseFirmMatch, matchPersonName — so the fact still comes from the SEC record
//         and the model only picked which one; or
//     (b) returns FREE TEXT explicitly labelled non-authoritative — explain().
//
//   No exported function returns a name, a CRD, an address, a date or a registration.
//   Grep this file: there is no code path that copies a string out of a model response into
//   a returned identifier. The only model-authored bytes that escape are `reasoning` and
//   the `explain` sentence, and both are run through redactUnsourcedNumbers() so a
//   hallucinated CRD cannot ride out inside prose.
//
//   matchPersonName goes further, because handing one person another person's profile is
//   the worst thing this service can do. The model there cannot WIDEN the candidate set at
//   all: a deterministic guard narrows the roster to AT MOST ONE orthographically plausible
//   entry first, and the model may only confirm or veto that one entry. Its answer is
//   discarded unless it names exactly the index the deterministic guard had already
//   isolated. A model that returns a different index is treated as a failure, not as a
//   discovery.
//
// AND IT DEGRADES SILENTLY. Every failure — no credentials, no network, a timeout, a 500, a
// malformed body, an out-of-range index — returns null. Vertex must never be able to break
// a lookup; the caller always has a deterministic path that would have answered anyway.
//
// ---------------------------------------------------------------------------
// Transport notes, all MEASURED on project hushh-tech-prod (2026-08-06)
// ---------------------------------------------------------------------------
//   - The us-central1 REGIONAL endpoint 404s for every gemini model id tried. The GLOBAL
//     endpoint serves them. Hence config.vertex.location defaults to "global".
//   - generationConfig.thinkingConfig.thinkingBudget MUST be 0. Left unset, thinking
//     consumes the entire maxOutputTokens budget and candidates[0].content comes back with
//     no `parts` array at all — a silent empty answer that looks like a model refusal.
//   - Responses may arrive wrapped in ```json fences even with responseMimeType set, so the
//     parser strips them.
//
// Stdlib only. No npm. Credentials come from the metadata server first (Cloud Run, where
// there is no gcloud binary), then GOOGLE_APPLICATION_CREDENTIALS, then `gcloud auth
// print-access-token` for a laptop.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { config as defaultConfig } from "./config.mjs";
import { namesMatch, parseName } from "./resolve.mjs";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_PROJECT_URL = "http://metadata.google.internal/computeMetadata/v1/project/project-id";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Confidence floors. DELIBERATELY NOT ENV-OVERRIDABLE, for the same reason lookup.maxLimit
 *  is not: these are disclosure decisions, not tuning knobs. An operator dropping the person
 *  floor to 0.2 would quietly turn "we are sure this is you" into "probably you", and the
 *  thing on the other side of that judgement is somebody else's professional identity.
 *
 *  The person floor is higher than the firm floor on purpose. A wrong firm is embarrassing
 *  and is caught downstream by address cross-validation; a wrong person is handing over an
 *  identity, and nothing downstream catches it. */
const MIN_CONFIDENCE_FIRM = 0.6;
const MIN_CONFIDENCE_PERSON = 0.8;

/** Caps on model-authored prose that reaches a caller. Judgement is a sentence, not an essay. */
const MAX_REASONING_CHARS = 300;
const MAX_EXPLAIN_CHARS = 240;

/** Firm-name words that carry no identity. Two firms sharing only these share nothing:
 *  "Nestlerode & Loy Investment Advisors" and "International Assets Investment Management"
 *  overlap at INVESTMENT and at nothing else, and they are not the same firm. */
const FIRM_STOPWORDS = new Set([
  "INVESTMENT", "INVESTMENTS", "ADVISOR", "ADVISORS", "ADVISER", "ADVISERS", "ADVISORY",
  "MANAGEMENT", "CAPITAL", "WEALTH", "FINANCIAL", "FINANCE", "ASSET", "ASSETS",
  "PARTNERS", "PARTNERSHIP", "GROUP", "COMPANY", "ASSOCIATES", "SECURITIES", "PLANNING",
  "SERVICES", "SERVICE", "CONSULTING", "CONSULTANTS", "HOLDINGS", "INTERNATIONAL", "NATIONAL",
  "AMERICA", "AMERICAN", "GLOBAL", "TRUST", "FUND", "FUNDS", "EQUITY", "PORTFOLIO",
  "STRATEGIES", "SOLUTIONS", "RETIREMENT", "INSURANCE", "BROKERAGE", "LLC", "INC", "LP",
  "LLP", "PC", "PLLC", "CORP", "CORPORATION", "COMPANIES", "AND", "THE", "OF",
]);

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const str = (value) => (typeof value === "string" ? value.trim() : "");

const clamp01 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
};

/**
 * A model may hand back an index as 3, "3" or 3.0. Anything else is not an index.
 *
 * The type check is not pedantry. `Number([])` is 0 and `Number(true)` is 1, so a model that
 * answers `{"index": []}` would, under a bare Number() coercion, SELECT THE FIRST CANDIDATE
 * — turning a malformed answer into a confident wrong match. Caught by test, kept by test.
 */
function toIndex(value, length) {
  let n;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) n = Number(value.trim());
  else return null;
  if (!Number.isInteger(n)) return null;
  if (n < 0 || n >= length) return null;
  return n;
}

/**
 * Strip any digit run of four or more that does not appear ANYWHERE in the input we gave
 * the model.
 *
 * This is the last line of the rule. `reasoning` and the `explain` sentence are the only
 * model-authored bytes that reach a caller, and the dangerous thing they can carry is a
 * fabricated identifier — a CRD, an SEC file number, a year of registration — stated with
 * the same confidence as the real ones. Four digits is the floor because firm CRDs are
 * four (2907) and individual CRDs are seven; below that we would be redacting percentages
 * and street numbers for nothing.
 *
 * A number that WAS in the input is echoed untouched: repeating a fact the SEC gave us is
 * exactly what we asked the model to do.
 */
export function redactUnsourcedNumbers(text, sourceText) {
  const source = String(sourceText ?? "");
  return String(text ?? "").replace(/\d{4,}/g, (run) => (source.includes(run) ? run : "[unverified]"));
}

/** First sentence only, hard-capped. */
function firstSentence(text, maxChars) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const stop = flat.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? flat.slice(0, stop + 1) : flat;
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1).trimEnd()}…` : sentence;
}

/**
 * Parse a model response body that may or may not be fenced.
 *
 * responseMimeType: "application/json" is a request, not a guarantee — measured responses
 * still arrive as ```json … ``` — so unwrap fences before parsing and return null rather
 * than throwing on anything unparseable.
 */
export function parseModelJson(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return null;
    // A bare JSON string is a legal answer to explain() and a useless one to the index
    // functions — they look for `.index`, find nothing, and return null. No special case.
    if (typeof parsed === "string") return { sentence: parsed, text: parsed };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------
//
// Three sources, in this order, because production and a laptop have opposite shapes:
//
//   1. the GCE/Cloud Run METADATA SERVER — tried first, with a short timeout, because in
//      production there is no gcloud binary and no key file. Once it is found unreachable
//      we remember that for the life of the process rather than paying the probe every call.
//   2. GOOGLE_APPLICATION_CREDENTIALS — a service-account key (RS256 JWT bearer grant) or a
//      gcloud `authorized_user` ADC file (refresh-token grant). Both are handled with
//      node:crypto and fetch; neither needs a dependency.
//   3. `gcloud auth print-access-token` — the laptop path. execFile, never a shell, so
//      nothing here can be turned into command injection by an env var.

let tokenCache = null; // { token, expiresAt }
let metadataUnreachable = false;

/** Test seam and operational reset: drop the cached token and re-probe metadata. */
export function resetCredentialCache() {
  tokenCache = null;
  metadataUnreachable = false;
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!response?.ok) return null;
    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function metadataToken(fetchImpl, timeoutMs) {
  if (metadataUnreachable) return null;
  const body = await fetchJson(
    fetchImpl,
    METADATA_TOKEN_URL,
    { method: "GET", headers: { "Metadata-Flavor": "Google" } },
    timeoutMs,
  );
  if (!body?.access_token) {
    // Not "no token this time" — there is no metadata server here. Stop probing.
    metadataUnreachable = true;
    return null;
  }
  return { token: String(body.access_token), expiresInMs: Number(body.expires_in || 0) * 1000 };
}

/** The project id the metadata server reports, for a deployment that sets no project env. */
async function metadataProject(fetchImpl, timeoutMs) {
  if (metadataUnreachable) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(METADATA_PROJECT_URL, {
      method: "GET",
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (!response?.ok) return "";
    return str(await response.text());
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+/g, "");

/** RS256 JWT-bearer grant for a service-account key file. */
async function serviceAccountToken(key, fetchImpl, timeoutMs) {
  const tokenUri = str(key.token_uri) || OAUTH_TOKEN_URL;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const body = await fetchJson(
    fetchImpl,
    tokenUri,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    },
    timeoutMs,
  );
  if (!body?.access_token) return null;
  return { token: String(body.access_token), expiresInMs: Number(body.expires_in || 0) * 1000 };
}

/** Refresh-token grant for a gcloud `authorized_user` ADC file. */
async function authorizedUserToken(key, fetchImpl, timeoutMs) {
  const body = await fetchJson(
    fetchImpl,
    OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: key.refresh_token,
      }).toString(),
    },
    timeoutMs,
  );
  if (!body?.access_token) return null;
  return { token: String(body.access_token), expiresInMs: Number(body.expires_in || 0) * 1000 };
}

async function credentialFileToken(path, fetchImpl, timeoutMs) {
  let key;
  try {
    key = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  try {
    if (key?.type === "service_account" && key.client_email && key.private_key) {
      return await serviceAccountToken(key, fetchImpl, timeoutMs);
    }
    if (key?.type === "authorized_user" && key.refresh_token && key.client_id) {
      return await authorizedUserToken(key, fetchImpl, timeoutMs);
    }
  } catch {
    return null;
  }
  return null;
}

/** `gcloud auth print-access-token`. execFile, NOT exec — no shell, so nothing an operator
 *  puts in the environment can become a command. */
function gcloudToken(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      execFile(
        "gcloud",
        ["auth", "print-access-token", "--quiet"],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout) => {
          if (error) return done(null);
          const token = str(stdout);
          done(token ? { token, expiresInMs: 0 } : null);
        },
      );
    } catch {
      done(null);
    }
  });
}

/**
 * An OAuth access token for Vertex, or null.
 *
 * Cached with a TTL and dropped on any 401 by the caller. Never throws: the whole module's
 * contract is that a credential problem degrades a lookup to its deterministic path, and a
 * throw here would break that at the very first call.
 */
export async function getAccessToken(deps = {}) {
  const config = deps.config || defaultConfig;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const vertex = config?.vertex || {};
  const ttlMs = Number(vertex.tokenTtlMs) > 0 ? Number(vertex.tokenTtlMs) : 2_700_000;
  const metaTimeout = Number(vertex.metadataTimeoutMs) > 0 ? Number(vertex.metadataTimeoutMs) : 500;
  const timeoutMs = Number(vertex.timeoutMs) > 0 ? Number(vertex.timeoutMs) : 6_000;

  // An explicitly injected token wins outright: that is how the tests run with no network,
  // and how a caller with its own credential plumbing can bypass all of this.
  if (deps.token) return String(deps.token);

  if (tokenCache && tokenCache.expiresAt > now()) return tokenCache.token;
  if (typeof fetchImpl !== "function") return null;

  let acquired = await metadataToken(fetchImpl, metaTimeout);

  if (!acquired) {
    const credentialPath = str(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (credentialPath) acquired = await credentialFileToken(credentialPath, fetchImpl, timeoutMs);
  }

  if (!acquired) acquired = await gcloudToken(Math.max(timeoutMs, 10_000));

  if (!acquired?.token) return null;

  // Expire a minute early: a token that dies mid-flight costs a retry we can avoid.
  const lifetime = acquired.expiresInMs > 0 ? Math.max(acquired.expiresInMs - 60_000, 60_000) : ttlMs;
  tokenCache = { token: acquired.token, expiresAt: now() + Math.min(lifetime, ttlMs) };
  return tokenCache.token;
}

/** The project this module would call Vertex on: explicit config first, metadata last. */
async function resolveProject(deps) {
  const config = deps.config || defaultConfig;
  const configured = str(config?.vertex?.project);
  if (configured) return configured;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return "";
  const metaTimeout = Number(config?.vertex?.metadataTimeoutMs) > 0
    ? Number(config.vertex.metadataTimeoutMs)
    : 500;
  return await metadataProject(fetchImpl, metaTimeout);
}

/**
 * Is a judgement call possible right now — credentials obtainable AND a project known?
 *
 * ASYNC. It genuinely tries to obtain a token, because "is there an ADC token" is not a
 * question that can be answered synchronously. `await` it. A bare `if (isConfigured())`
 * is always true and is a bug.
 */
export async function isConfigured(deps = {}) {
  const config = deps.config || defaultConfig;
  if (config?.vertex?.enabled === false) return false;
  const project = await resolveProject(deps);
  if (!project) return false;
  const token = await getAccessToken(deps);
  return Boolean(token);
}

// ---------------------------------------------------------------------------
// the model call
// ---------------------------------------------------------------------------

function endpointFor(config, project) {
  const location = str(config?.vertex?.location) || "global";
  const model = str(config?.vertex?.model) || "gemini-2.5-flash";
  // MEASURED: the regional host 404s for every gemini id on this project; the global host
  // serves them. A configured region still gets its regional host — the caller asked.
  const host =
    location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(
    location,
  )}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

/** The text of the first candidate, or "". Tolerates the no-parts shape thinkingBudget:0
 *  exists to prevent, so a regression there reads as a null answer rather than a crash. */
function textOf(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("").trim();
}

/**
 * One generateContent round trip. Returns the parsed JSON object, or null for ANY failure.
 *
 * Refreshes the token exactly once on a 401 — a rotated or revoked credential should cost a
 * retry, not a degraded lookup — and gives up after that.
 */
async function callModel({ system, prompt, maxOutputTokens = 512 }, deps = {}) {
  const config = deps.config || defaultConfig;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (config?.vertex?.enabled === false) return null;
  if (typeof fetchImpl !== "function") return null;

  const project = await resolveProject(deps);
  if (!project) return null;

  const url = endpointFor(config, project);
  const timeoutMs = Number(config?.vertex?.timeoutMs) > 0 ? Number(config.vertex.timeoutMs) : 6_000;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: 0,
      candidateCount: 1,
      maxOutputTokens,
      responseMimeType: "application/json",
      // MEASURED, LOAD-BEARING: without this, thinking eats the whole output budget and
      // candidates[0].content comes back with no parts at all.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getAccessToken(deps);
    if (!token) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": str(config?.iapd?.userAgent) || "hushh-ria-identity-api/0.1",
        },
        body,
        signal: controller.signal,
      });
    } catch {
      return null; // timeout, DNS, socket — all the same to a caller with a fallback
    } finally {
      clearTimeout(timer);
    }

    if (response?.status === 401 && attempt === 0 && !deps.token) {
      tokenCache = null; // rotated/revoked; buy exactly one fresh attempt
      continue;
    }
    if (!response?.ok) return null;

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      return null;
    }
    return parseModelJson(textOf(payload));
  }
  return null;
}

// ---------------------------------------------------------------------------
// chooseFirmMatch
// ---------------------------------------------------------------------------

const SYSTEM_FIRM = [
  "You disambiguate SEC-registered investment advisory firms.",
  "You are given a business name and address, and a numbered list of candidate firms that were already retrieved from the SEC.",
  "Choose the ONE candidate that is the same real-world firm, or none.",
  "You must not invent firms, CRD numbers or addresses. Answer only with an index into the list.",
  "A candidate that merely shares generic industry words (investment, advisors, capital, management, wealth) is NOT a match.",
  "SEC firm-name search matches registered DBAs, so an unrelated firm can appear as the only candidate. Prefer none over a guess.",
  'Reply with JSON only: {"index": <integer index or null>, "confidence": <0.0-1.0>, "reasoning": "<one short sentence>"}',
].join(" ");

/** Identity-bearing tokens of a firm name: the words that are not industry furniture. */
function significantTokens(name) {
  return new Set(
    String(name ?? "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length >= 4 && !FIRM_STOPWORDS.has(token)),
  );
}

const addressText = (address) => {
  if (!address) return "";
  if (typeof address === "string") return address;
  return [address.street1, address.street2, address.city, address.state, address.zip || address.postalCode]
    .map((part) => str(part))
    .filter(Boolean)
    .join(", ");
};

/** Everything about one candidate that the model is allowed to see — built entirely from
 *  the caller's SEC record, never from anything the model said earlier. */
function describeCandidate(candidate, index) {
  const name = str(candidate?.name) || str(candidate?.firmName) || str(candidate?.ia_firm_name);
  const crd = candidate?.crd ?? candidate?.firmCrd ?? candidate?.firm_id ?? "";
  const address = addressText(candidate?.officeAddress || candidate?.address);
  const dbas = (Array.isArray(candidate?.otherNames) ? candidate.otherNames : []).filter(Boolean);
  const parts = [`[${index}] ${name || "(unnamed)"}`];
  if (crd !== "" && crd !== null && crd !== undefined) parts.push(`CRD ${crd}`);
  if (address) parts.push(address);
  if (dbas.length) {
    // The COUNT is deliberately shown alongside the sample. A firm registering one trade
    // name and a firm registering a hundred of them are making very different claims, and
    // "matched one of 100 DBAs" is the exact shape of the Nestlerode decoy below.
    parts.push(
      `${dbas.length} registered trade name(s), e.g. ${dbas.slice(0, 5).join("; ")}${dbas.length > 5 ? "; …" : ""}`,
    );
  }
  return parts.join(" — ");
}

/** Uppercase alphanumeric tokens of an address, for token-level (not substring) comparison.
 *  Substring matching would find "FL" inside "FLORAL" and "PA" inside "PARK". */
const addressTokens = (value) =>
  new Set(
    addressText(value)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .split(" ")
      .filter(Boolean),
  );

/**
 * Does this candidate share real-world evidence with the business we asked about?
 *
 * A DETERMINISTIC FLOOR UNDER THE MODEL'S JUDGEMENT, and the reason it exists is measured.
 * SEC firm search for "Nestlerode & Loy Investment Advisors" returns exactly ONE hit —
 * CRD 144426 INTERNATIONAL ASSETS INVESTMENT MANAGEMENT, LLC of Orlando FL — because that
 * firm registers about a hundred DBAs and one of them is the name we searched for. The firm
 * actually wanted, CRD 2907 NESTLERODE & LOY, INC. of State College PA, is not in the result
 * set at all. `total: 1` is not confidence, and a model handed a list of one is under real
 * pressure to pick it.
 *
 * Two kinds of evidence count, and A DBA MATCH IS NOT ONE OF THEM ON ITS OWN:
 *
 *   LEGAL NAME  — an identity-bearing token shared with the candidate's registered legal
 *                 name. NESTLERODE is one; INVESTMENT, ADVISORS and MANAGEMENT are industry
 *                 furniture and are stopworded out, which is why International Assets shares
 *                 nothing with Nestlerode & Loy even though four of their words coincide.
 *   ADDRESS     — the candidate's own city or state appearing as a token in the address we
 *                 were given. State College PA matches CRD 2907; Orlando FL matches nothing
 *                 about a State College business.
 *
 * A DBA-only overlap is deliberately insufficient: it is precisely what the decoy has. A
 * genuine trading-name case still passes here through the ADDRESS arm, which is the right
 * evidence for it anyway.
 */
function candidateHasEvidence(businessName, businessAddress, candidate) {
  const wanted = significantTokens(businessName);
  const legalName = str(candidate?.name) || str(candidate?.firmName) || str(candidate?.ia_firm_name);
  for (const token of significantTokens(legalName)) if (wanted.has(token)) return true;

  const wantedAddress = addressTokens(businessAddress);
  if (wantedAddress.size) {
    const office = candidate?.officeAddress || candidate?.address;
    const state = str(office?.state).toUpperCase();
    if (state && wantedAddress.has(state)) return true;
    const cityTokens = [...addressTokens({ city: str(office?.city) })];
    if (cityTokens.length && cityTokens.every((token) => wantedAddress.has(token))) return true;
  }

  return false;
}

/**
 * Which SEC firm candidate is the business we are looking at?
 *
 * Replaces brittle string normalisation — "Nestlerode & Loy Investment Advisors" vs
 * "NESTLERODE & LOY, INC." is not a problem any normaliser solves without also matching
 * things it must not.
 *
 * RETURNS AN INDEX INTO `candidates`, never a firm. The caller already holds the SEC record
 * at that index; every fact it goes on to publish comes from there, not from here.
 *
 * @param {{businessName:string, businessAddress?:string|object, candidates:object[]}} input
 * @returns {Promise<{index:number, confidence:number, reasoning:string, authoritative:false}|null>}
 *          null whenever we are not sure, not configured, or anything at all failed.
 */
export async function chooseFirmMatch({ businessName, businessAddress, candidates } = {}, deps = {}) {
  const name = str(businessName);
  const list = Array.isArray(candidates) ? candidates : [];
  if (!name || list.length === 0) return null;

  const prompt = [
    `Business name: ${name}`,
    `Business address: ${addressText(businessAddress) || "(unknown)"}`,
    "",
    "Candidate SEC-registered firms:",
    ...list.map((candidate, index) => describeCandidate(candidate, index)),
    "",
    `Which candidate index (0-${list.length - 1}) is this same firm? Use null if none of them is.`,
  ].join("\n");

  const answer = await callModel({ system: SYSTEM_FIRM, prompt }, deps);
  if (!answer) return null;

  const index = toIndex(answer.index, list.length);
  if (index === null) return null;

  const confidence = clamp01(answer.confidence);
  if (confidence < MIN_CONFIDENCE_FIRM) return null;

  // The deterministic floor. The model does not get to overrule this.
  if (!candidateHasEvidence(name, businessAddress, list[index])) return null;

  return {
    index,
    confidence,
    reasoning: redactUnsourcedNumbers(firstSentence(answer.reasoning, MAX_REASONING_CHARS), prompt),
    // Restated on every object because the constraint has to travel with the value, the
    // same way ATTRIBUTION's notices travel with the payload.
    authoritative: false,
  };
}

// ---------------------------------------------------------------------------
// matchPersonName
// ---------------------------------------------------------------------------

const SYSTEM_PERSON = [
  "You decide whether a claimed personal name refers to a specific person on a roster retrieved from the SEC.",
  "The roster is authoritative and complete. You must not invent people.",
  "Names may be written 'Last, First Middle' or 'First Middle Last', with suffixes, middle initials, nicknames and hyphenated surnames.",
  "Be precision-biased: if two roster members could plausibly be the claimed person, answer null. A wrong answer hands one person another person's professional identity.",
  "Two different nicknames of the same formal name (Jon and Jack are both Johns; Ted and Ed are both Edwards) are NOT the same person.",
  "A generational suffix on one side only (Jr vs no Jr) means a different person: father and son at a family firm is common.",
  'Reply with JSON only: {"index": <integer index or null>, "confidence": <0.0-1.0>, "reasoning": "<one short sentence>"}',
].join(" ");

const rosterNameOf = (entry) => (typeof entry === "string" ? entry : str(entry?.name));

/** Honorifics. NOT credentials and NOT suffixes — a separate class, stripped here because
 *  resolve.mjs's tables do not carry them and IAPD really does publish them.
 *
 *  MEASURED, live: individual CRD 4661439 comes back from the SEC roster as
 *  "JANET HARRIS WEISMAN MRS." — and splitPositional reads the LAST token as the surname,
 *  so that person's surname parses as "MRS". Every name comparison against her then fails,
 *  including the deterministic one: namesMatch("Janet Weisman", "JANET HARRIS WEISMAN MRS.")
 *  is false. She is a real adviser at a real firm who could not have claimed her own profile.
 *
 *  Stripping here fixes it for this module without touching resolve.mjs (339 tests, the
 *  highest-risk file in the service). THE UNDERLYING GAP IS STILL THERE for every other
 *  caller of namesMatch/parseName and should be fixed at the source. */
const HONORIFICS = new Set([
  "MR", "MRS", "MS", "MISS", "MX", "DR", "PROF", "PROFESSOR", "REV", "FR", "SIR", "DAME",
  "LADY", "LORD", "HON", "HONORABLE", "CAPT", "CAPTAIN", "COL", "MAJ", "LT", "SGT", "GEN",
]);

/** Remove honorific words, preserving the comma that signals "Last, First" order. Falls back
 *  to the original whenever stripping would leave too little to compare — a surname that
 *  genuinely IS one of these words must not be deleted. */
export function stripHonorifics(input) {
  const text = String(input ?? "");
  if (!text.trim()) return text;
  const stripped = text
    .replace(/[A-Za-z]+\.?/g, (word) => (HONORIFICS.has(word.replace(/\./g, "").toUpperCase()) ? " " : word))
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*$/, "")
    .trim();
  const words = stripped.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  return words.length >= 2 ? stripped : text;
}

/**
 * Every surname key a positional name could have.
 *
 * "ANA GARCIA LOPEZ" is either Ana Lopez with the middle name Garcia, or Ana Garcia-Lopez
 * written without its hyphen, and SEC filings contain both conventions for one person. This
 * mirrors resolve.mjs's parseVariants so the guard below agrees with namesMatch about what
 * a surname is; a comma-delimited name has exactly one reading and gets no variants.
 */
function readings(input) {
  const base = parseName(stripHonorifics(input));
  if (!base.ok) return [];
  if (base.inverted || !base.middles.length) return [base];
  const variants = [base];
  for (let i = base.middles.length - 1; i >= 0; i -= 1) {
    variants.push({
      ...base,
      middles: base.middles.slice(0, i),
      last: base.middles.slice(i).join("") + base.last,
    });
  }
  return variants;
}

/** Equal, or one is the other's initial. Mirrors resolve.mjs tokensCompatible. */
function tokensCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length === 1) return b[0] === a;
  if (b.length === 1) return a[0] === b;
  return false;
}

function middlesCompatible(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (!tokensCompatible(a[i], b[i])) return false;
  return true;
}

/** The longest a short form of a name can be and still be a short form.
 *
 *  MEASURED FAILURE, live against the real Robinswood roster. With a bare "one is a prefix
 *  of the other" rule, "Robertson MacRae" reached Robert David MacRae, gemini-2.5-flash
 *  returned index 3 at 0.9 confidence, and its stated reason was that "'Robertson' [is] a
 *  known diminutive or alternative form of 'Robert'". It is not. The model invented a
 *  linguistic fact and the guard was loose enough to let it through — the exact failure this
 *  whole file exists to make impossible.
 *
 *  A diminutive is a TRUNCATION, and truncations are short: JAN, ROB, CHRIS, KATE. ROBERT is
 *  six characters and a complete formal name in its own right, so it is not a short form of
 *  ROBERTSON — and by the same rule ROBERT is not a short form of ROBERTA, which is the same
 *  trap with a person of a different sex on the other side of it. */
const MAX_SHORT_FORM_LENGTH = 5;

/** Is `short` a plausible truncation of `long` — i.e. a nickname shape, not a different name? */
function isTruncationOf(short, long) {
  if (short.length < 2 || short.length > MAX_SHORT_FORM_LENGTH) return false;
  if (long.length <= short.length) return false;
  return long.startsWith(short);
}

/**
 * ORTHOGRAPHIC PLAUSIBILITY — the guard that bounds what the model is allowed to propose.
 *
 * The model may only ever confirm a pairing that is already explicable FROM THE TWO STRINGS
 * THEMSELVES. Concretely, one of:
 *
 *   - the two names are the same tokens in a different order (transliteration, or a filing
 *     that put the surname first without a comma); or
 *   - the surnames agree, the suffixes agree, no middle initial contradicts, and one given
 *     name is a TRUNCATION of the other (JAN/JANET, CHRIS/CHRISTOPHER) or a corroborated
 *     initial (K/KELSEY, where an agreeing middle name carries it).
 *
 * This is what stops the model bridging JACK and ROBERT MacRae, or JON and JACK Smith, or —
 * measured, at 0.9 confidence with a confabulated etymology — ROBERTSON and ROBERT MacRae.
 * Those pairs share a surname and nothing else on the page. The guard rejects them before
 * the model is asked, and rejects them again if it answers anyway.
 *
 * It deliberately COSTS RECALL. PEGGY/MARGARET and BILL/WILLIAM are real equivalences this
 * guard refuses — BILL/WILLIAM because resolve.mjs's table already handles it deterministically
 * (so the model is never consulted), PEGGY/MARGARET because nothing in the two strings says
 * they are one person, and "the model knows" is not evidence this service accepts.
 */
function orthographicallyPlausible(claimedName, rosterName) {
  const claimed = readings(claimedName);
  const roster = readings(rosterName);
  if (!claimed.length || !roster.length) return false;

  // Same tokens, any order. THE SUFFIX IS PART OF THE BAG: without it "JOHN SMITH" and
  // "JOHN SMITH JR" are the same multiset, and the guard would have handed a model the
  // chance to merge a father and his son. Caught by test, kept by test.
  const bag = (parsed) =>
    [parsed.first, ...parsed.middles, parsed.last, parsed.suffix].filter(Boolean).sort().join(" ");
  if (bag(claimed[0]) && bag(claimed[0]) === bag(roster[0])) return true;

  for (const left of claimed) {
    for (const right of roster) {
      if (left.last !== right.last) continue;
      if (left.suffix !== right.suffix) continue;
      if (!middlesCompatible(left.middles, right.middles)) continue;

      const a = left.first;
      const b = right.first;
      if (!a || !b) continue;
      if (a === b) return true;
      // A bare initial, corroborated by an agreeing middle name (middlesCompatible above).
      if (a.length === 1 && b.startsWith(a)) return true;
      if (b.length === 1 && a.startsWith(b)) return true;
      if (isTruncationOf(a, b) || isTruncationOf(b, a)) return true;
    }
  }
  return false;
}

/**
 * Which person on this SEC roster is the claimant?
 *
 * THE HIGHEST-RISK JUDGEMENT IN THE SERVICE, so the model has the least room here:
 *
 *   1. DETERMINISTIC FIRST. resolve.mjs's namesMatch() decides. Exactly one hit is the
 *      answer and no model is called at all — that is the path "Bob MacRae", "Chris Simon
 *      Wallace" and "Kelsey Curtis" all take against the real Robinswood roster.
 *   2. MORE THAN ONE deterministic hit is an ambiguity a model must not break. Two people
 *      the hand-written table says both match are two people who could both be the
 *      claimant. Return null.
 *   3. Zero hits is the only case the model sees, and even then it cannot widen anything:
 *      the orthographic guard narrows the roster to AT MOST ONE plausible entry first. Zero
 *      plausible entries, or two, and we return null WITHOUT SPENDING A CALL.
 *   4. The model's answer is accepted only if it names exactly that one index, above the
 *      confidence floor. A different index is treated as a failure, not as a discovery —
 *      that is the structural expression of "a model may rank, never source".
 *
 * RETURNS AN INDEX INTO `rosterNames`. Never a name.
 *
 * @param {{claimedName:string, rosterNames:(string|{name:string})[]}} input
 * @returns {Promise<{index:number, confidence:number, reasoning:string, method:string,
 *                    authoritative:false}|null>}
 */
export async function matchPersonName({ claimedName, rosterNames } = {}, deps = {}) {
  const claimed = str(claimedName);
  const roster = (Array.isArray(rosterNames) ? rosterNames : []).map(rosterNameOf);
  if (!claimed || roster.length === 0) return null;

  // 1 & 2 — the deterministic path, which is also the fast path. Honorifics are stripped
  // first: without that, "JANET HARRIS WEISMAN MRS." (a real live SEC roster entry) parses
  // with the surname "MRS" and matches nobody. See HONORIFICS above.
  const claimedClean = stripHonorifics(claimed);
  const rosterClean = roster.map(stripHonorifics);
  const deterministic = [];
  for (let i = 0; i < roster.length; i += 1) {
    if (roster[i] && namesMatch(claimedClean, rosterClean[i])) deterministic.push(i);
  }
  if (deterministic.length === 1) {
    return {
      index: deterministic[0],
      confidence: 1,
      reasoning: "Matched deterministically by name structure; no language model was consulted.",
      method: "namesMatch",
      authoritative: false,
    };
  }
  if (deterministic.length > 1) return null; // genuinely ambiguous; a model must not break the tie

  // 3 — the guard. The model cannot see a candidate set wider than this.
  const plausible = [];
  for (let i = 0; i < roster.length; i += 1) {
    if (roster[i] && orthographicallyPlausible(claimed, roster[i])) plausible.push(i);
  }
  if (plausible.length !== 1) return null;
  const only = plausible[0];

  const prompt = [
    `Claimed name: ${claimed}`,
    "",
    "SEC roster for this firm:",
    ...roster.map((name, index) => `[${index}] ${name}`),
    "",
    `Which roster index (0-${roster.length - 1}) is the claimed person? Use null if the claimed person is not on this roster, or if more than one member could be them.`,
  ].join("\n");

  const answer = await callModel({ system: SYSTEM_PERSON, prompt }, deps);
  if (!answer) return null;

  const index = toIndex(answer.index, roster.length);
  // 4 — confirm-or-veto only. Any other index is a failure.
  if (index !== only) return null;

  const confidence = clamp01(answer.confidence);
  if (confidence < MIN_CONFIDENCE_PERSON) return null;

  return {
    index,
    confidence,
    reasoning: redactUnsourcedNumbers(firstSentence(answer.reasoning, MAX_REASONING_CHARS), prompt),
    method: "vertex",
    authoritative: false,
  };
}

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

const SYSTEM_EXPLAIN = [
  "You write one short, plain-English sentence for an onboarding UI, addressed as 'you' to the adviser using it.",
  "Use ONLY the facts given to you. Never add a firm name, a person's name, a CRD, a number or a date that is not in the input.",
  "The outcome is an INTERNAL CODE. Explain what it means in ordinary words; never repeat the code itself or any part of it.",
  "No hedging, no marketing, no second sentence.",
  'Reply with JSON only: {"sentence": "<one sentence>"}',
].join(" ");

/** What each outcome MEANS, in words a person can read.
 *
 *  Without this the model was handed the raw slug and dutifully wrote it into the copy —
 *  measured: `large_firm` produced "We found 7 advisers at large firms in Kirkland, WA",
 *  which is not English and not true. The slugs are resolve.mjs's lookup outcomes. */
const OUTCOME_GLOSS = {
  single_person: "exactly one adviser is registered at this phone number's firm, so they only need to confirm it is them",
  few_candidates: "a small number of advisers are registered at this firm, so they can pick themselves from a short list",
  large_firm: "too many advisers are registered at this firm to list, so they need to give their name to narrow it down",
  no_match: "the phone number did not resolve to any SEC-registered advisory firm",
  firm_only: "the firm was identified but its adviser roster could not be retrieved right now",
};

/** The label that MUST travel with an explain() sentence onto the wire.
 *
 *  explain() returns a bare string because that is what a UI wants to render, so the label
 *  cannot live on the value — it lives here, and it is the caller's job to emit it beside
 *  the sentence exactly the way ATTRIBUTION's notices are emitted beside the data. A
 *  sentence published without it is a machine-written sentence presented as a record. */
export const EXPLAIN_NOTICE =
  "This sentence is machine-generated commentary to help you read the result. It is not part of the SEC record and is not evidence of anything; the firm and adviser details above are the authoritative facts.";

/**
 * A sentence for the UI. NON-AUTHORITATIVE BY CONSTRUCTION — this is category (b) of the
 * rule at the top: free text, never a fact. Publish it with EXPLAIN_NOTICE.
 *
 * Two things keep it honest. The model is given only what the caller already knows, and the
 * sentence it returns is passed through redactUnsourcedNumbers() against that input, so a
 * fabricated CRD or SEC file number cannot ride out inside prose that looks like an
 * explanation. Callers must render this as commentary, never as a record.
 *
 * Returns null on any failure — the caller's own copy deck is the fallback, and it always
 * has one.
 *
 * @param {{outcome:string, firm?:object, candidateCount?:number}} input
 * @returns {Promise<string|null>} one sentence, or null
 */
export async function explain({ outcome, firm, candidateCount } = {}, deps = {}) {
  const kind = str(outcome);
  if (!kind) return null;

  const firmName = str(firm?.name) || str(firm?.firmName);
  const where = [str(firm?.officeAddress?.city) || str(firm?.city), str(firm?.officeAddress?.state) || str(firm?.state)]
    .filter(Boolean)
    .join(", ");
  const count = Number.isFinite(Number(candidateCount)) ? Number(candidateCount) : null;

  const prompt = [
    `Outcome code: ${kind}`,
    `What that means: ${OUTCOME_GLOSS[kind] || "an unrecognised outcome; say only what the facts below support"}`,
    firmName ? `Firm: ${firmName}` : "Firm: (not identified)",
    where ? `Location: ${where}` : "",
    count === null ? "" : `Advisers currently registered there: ${count}`,
    "",
    "Write one sentence telling the person what we found and what happens next. Do not use the outcome code.",
  ]
    .filter(Boolean)
    .join("\n");

  const answer = await callModel({ system: SYSTEM_EXPLAIN, prompt, maxOutputTokens: 256 }, deps);
  if (!answer) return null;

  const sentence = firstSentence(answer.sentence ?? answer.text ?? answer.reasoning, MAX_EXPLAIN_CHARS);
  if (!sentence) return null;
  return redactUnsourcedNumbers(sentence, prompt);
}
