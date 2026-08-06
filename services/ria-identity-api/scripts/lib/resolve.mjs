// The brain: office phone number -> firm -> "which one of these advisers is you?".
//
// Everything here is public data, and EVERY SOURCE IS LIVE. There is no snapshot:
//
//   FIRM   : Cloud SQL `ria.firms` (the Form ADV feed the crawler keeps current) — fast and
//            authoritative for "who filed this number" — cross-checked against Google Places
//            resolved through IAPD firm search (places.mjs). The two are FUSED, and when
//            they disagree we say so and ask a human rather than silently preferring one.
//   PEOPLE : SEC IAPD, live, on every single request, without exception.
//
// The people rule is a correctness requirement, not a preference. Measured 2026-08-06: IAPD
// lists four advisers currently registered at firm CRD 2907 and the `advisers` table in the
// same database holds ONE of them — the other three have no row at all. A roster served from
// that table would have told three real advisers they do not exist.
//
// Nothing is inferred, enriched, or joined against any other source, and no personal contact
// detail is ever produced. The output narrows a question; the integrating front-end's OTP to
// the number that was typed is what actually answers it, which is why every response carries
// verificationRequired:true.
//
// TWO RULES SHAPE THE WHOLE FILE:
//
//  1. NEVER THROW ON AN IAPD FAILURE. A degraded answer ("here is your firm, tell us your
//     name") is worth far more to someone mid-onboarding than a 502. The upstream error is
//     reported in `.notes` and in the affected candidates' `.reasons`, never swallowed.
//
//  2. PRECISION OVER RECALL, EVERYWHERE A PERSON IS NAMED. A false negative costs a
//     candidate 40 points of ranking. A false positive offers someone ELSE'S professional
//     identity to claim. Those are not comparable, so namesMatch() refuses every case it is
//     not sure about, and the large-firm path deliberately names nobody at all unless there
//     is a real narrowing signal (see LARGE-FIRM DISCLOSURE below).

import { normalizePhone, formatNational10 } from "./phone.mjs";
import { ATTRIBUTION } from "./config.mjs";

// ---------------------------------------------------------------------------
// name matching — the highest-risk code in the service
// ---------------------------------------------------------------------------

/** Generational suffixes. Deliberately NO single-letter roman numerals: "V" and "I" are far
 *  more often a middle initial than a fifth-generation suffix, and guessing wrong there
 *  silently rewrites someone's surname. */
const GENERATIONAL = new Set(["JR", "SR", "II", "III", "IV", "VI", "VII", "VIII", "2ND", "3RD", "4TH"]);

/** Professional designations SEC filers append to their own names. Stripped and ignored —
 *  they carry no identity signal and their presence is pure filing-style noise. */
const CREDENTIALS = new Set([
  "MD", "PHD", "JD", "ESQ", "ESQUIRE", "CFA", "CFP", "CPA", "CHFC", "CLU", "MBA", "AAMS",
  "CIMA", "AIF", "AIFA", "RICP", "CEPA", "LUTCF", "CRPC", "CRPS", "CPWA", "CFS", "CAIA", "CMT",
]);

/** Surname particles. "JOHN VAN DER BERG" and "VAN DER BERG, JOHN" have to reach the same
 *  surname, otherwise every Dutch/Spanish/Italian name loses its Schedule A match. */
const PARTICLES = new Set([
  "VAN", "VON", "DER", "DEN", "DE", "DEL", "DELA", "DELLA", "DI", "DA", "DOS", "DU",
  "LA", "LE", "LOS", "SAINT", "ST", "TER", "TEN", "BIN", "IBN",
]);

/** Alternative SPELLINGS of one formal name. Not diminutives — the same name, written two
 *  ways, by two filers, about one person. These are symmetric and transitive within a group,
 *  and they are kept SEPARATE from the nickname table because they are the only reason a
 *  formal name may match a different formal name. */
const SPELLING_VARIANT_GROUPS = [
  ["STEVEN", "STEPHEN"],
  ["PHILIP", "PHILLIP"],
  ["JEFFREY", "JEFFERY"],
  ["TERESA", "THERESA"],
  ["KATHERINE", "KATHRYN"],
];

const SPELLINGS = new Map();
for (const group of SPELLING_VARIANT_GROUPS) {
  const set = new Set(group);
  for (const name of group) SPELLINGS.set(name, set);
}
/** Every formal spelling this formal name could be written as (itself, at minimum). */
const spellingsOf = (name) => SPELLINGS.get(name) || new Set([name]);

/** Nicknames, as alias -> the set of FORMAL names it can stand for.
 *
 *  Modelled as SETS rather than equivalence groups on purpose. A group-per-nickname would
 *  bridge PATRICK and PATRICIA through the shared alias "PAT" (likewise CHRIS, SAM, ALEX,
 *  TERRY), and quietly hand a man's profile to a woman with the same surname. With sets,
 *  PAT->{PATRICK,PATRICIA} matches either formal name while PATRICK and PATRICIA stay
 *  disjoint from each other.
 *
 *  CRITICAL — AN ALIAS NEVER APPEARS IN ITS OWN VALUE SET, and no alias is a key for its own
 *  spelling variants. Both rules exist because of a real bug: when the sets included the
 *  alias itself and the lookup was "do the two expanded sets intersect", JON->{JON,JONATHAN,
 *  JOHN} and JACK->{JACK,JOHN,JACKSON} intersected at JOHN and namesMatch("Jon Smith",
 *  "Jack Smith") returned TRUE. Nine such pairs shipped — Jon/Jack, Ted/Ed, Bob/Rob,
 *  Bill/Will, Beth/Betty, Kate/Kathy, Dick/Rich, Jim/Jamie, Sue/Suzy — and the failure mode
 *  was not a missed match: it named the WRONG adviser as a 50-75% owner and Managing Partner
 *  of a firm where every other person was withheld. That is offering one person another
 *  person's profile to claim.
 *
 *  Two different people can share a formal name. Jack and Jon are both Johns; they are not
 *  each other. See firstNamesMatch below for the rule that enforces it. */
const NICKNAMES = new Map(Object.entries({
  BOB: ["ROBERT"], BOBBY: ["ROBERT"], ROB: ["ROBERT"], ROBBIE: ["ROBERT"],
  BILL: ["WILLIAM"], BILLY: ["WILLIAM"], WILL: ["WILLIAM"], WILLIE: ["WILLIAM"],
  DICK: ["RICHARD"], RICK: ["RICHARD"], RICH: ["RICHARD"], RICHIE: ["RICHARD"],
  JIM: ["JAMES"], JIMMY: ["JAMES"], JAMIE: ["JAMES"],
  JACK: ["JOHN", "JACKSON"], JOHNNY: ["JOHN"], JON: ["JONATHAN", "JOHN"],
  JOE: ["JOSEPH"], JOEY: ["JOSEPH"],
  MIKE: ["MICHAEL"], MICK: ["MICHAEL"],
  TOM: ["THOMAS"], TOMMY: ["THOMAS"],
  CHUCK: ["CHARLES"], CHARLIE: ["CHARLES"],
  CHRIS: ["CHRISTOPHER", "CHRISTIAN", "CHRISTINE", "CHRISTINA"],
  DAN: ["DANIEL"], DANNY: ["DANIEL"],
  DAVE: ["DAVID"], DAVEY: ["DAVID"],
  ED: ["EDWARD", "EDWIN"], EDDIE: ["EDWARD"], TED: ["EDWARD", "THEODORE"], TEDDY: ["EDWARD", "THEODORE"],
  TONY: ["ANTHONY"], MATT: ["MATTHEW"],
  ANDY: ["ANDREW"], DREW: ["ANDREW"],
  STEVE: ["STEVEN", "STEPHEN"],
  KEN: ["KENNETH"], KENNY: ["KENNETH"],
  LARRY: ["LAWRENCE"], GREG: ["GREGORY"], TIM: ["TIMOTHY"], JEFF: ["JEFFREY", "JEFFERY"],
  DOUG: ["DOUGLAS"], RON: ["RONALD"], RONNIE: ["RONALD"],
  NICK: ["NICHOLAS"], ALEX: ["ALEXANDER", "ALEXANDRA", "ALEXIS"],
  BEN: ["BENJAMIN"], SAM: ["SAMUEL", "SAMANTHA"], PAT: ["PATRICK", "PATRICIA"],
  PHIL: ["PHILIP", "PHILLIP"],
  FRANK: ["FRANCIS", "FRANKLIN"], GERRY: ["GERALD"], JERRY: ["GERALD", "JEROME"],
  BETH: ["ELIZABETH"], LIZ: ["ELIZABETH"], BETSY: ["ELIZABETH"], BETTY: ["ELIZABETH"],
  KATHY: ["KATHERINE", "KATHRYN", "KATHLEEN"], KATE: ["KATHERINE", "KATHRYN"], KATIE: ["KATHERINE", "KATHRYN"],
  MEG: ["MARGARET"], PEGGY: ["MARGARET"], MAGGIE: ["MARGARET"],
  JEN: ["JENNIFER"], JENNY: ["JENNIFER"],
  DEB: ["DEBORAH", "DEBRA"], DEBBIE: ["DEBORAH", "DEBRA"],
  SUE: ["SUSAN"], SUZY: ["SUSAN"], BARB: ["BARBARA"], BECKY: ["REBECCA"],
  VICKI: ["VICTORIA"], VICKY: ["VICTORIA"], CINDY: ["CYNTHIA"], MANDY: ["AMANDA"],
  TERRY: ["TERENCE", "TERESA", "THERESA"],
}).map(([alias, formals]) => {
  // Expand each formal through its spelling variants ONCE, at module load: PHIL -> PHILIP
  // also covers PHILLIP without the lookup having to think about it.
  const set = new Set();
  for (const formal of formals) for (const spelling of spellingsOf(formal)) set.add(spelling);
  // Guard the invariant in code, not just in a comment: an alias that leaked into its own
  // formal set would silently restore the alias<->alias bridge this table exists to prevent.
  set.delete(alias);
  return [alias, set];
}));

/** Characters that must VANISH rather than become a separator, because they are internal to
 *  a single name: apostrophes ("O'Brien" == "OBrien"), periods ("J." == "J"), and every
 *  dash the SEC feeds actually carry ("Smith-Jones" == "SmithJones"). Listed by code point
 *  so nothing here can be misread as a character-class RANGE — a stray range in this spot
 *  would silently delete letters out of people's names. */
const GLUE_CODEPOINTS = new Set([
  0x0027, 0x2018, 0x2019, 0x0060, // ' ‘ ’ `
  0x002e, // .
  0x002d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, // - ‐ ‑ ‒ – — ―
]);

/** Uppercase, de-accent, and glue. Commas SURVIVE: they are the signal that the name is in
 *  "Last, First" order. Everything else non-alphanumeric becomes a separator. */
function normalizeNameString(input) {
  const decomposed = String(input ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
  let glued = "";
  for (const ch of decomposed) if (!GLUE_CODEPOINTS.has(ch.codePointAt(0))) glued += ch;
  return glued
    .replace(/[^A-Z0-9,\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokenize = (s) => (s ? s.split(" ").filter(Boolean) : []);

/** Pull generational suffixes and credentials out of a token list, wherever they sit —
 *  "SMITH JR, JOHN" puts the suffix on the surname side, "SMITH, JOHN JR" on the given side. */
function stripAffixes(tokens) {
  const kept = [];
  const suffixes = [];
  for (const token of tokens) {
    if (GENERATIONAL.has(token)) suffixes.push(token);
    else if (CREDENTIALS.has(token)) continue;
    else kept.push(token);
  }
  return { kept, suffixes };
}

/**
 * Parse a human name into comparable parts, accepting both orders SEC publishes:
 * Form ADV Schedule A gives "LYLE, ALLAN, GLEN"; IAPD gives "Allan Glen Lyle".
 *
 * @returns {{first:string|null, middles:string[], last:string|null, suffix:string,
 *            display:string, inverted:boolean, ok:boolean}}
 */
export function parseName(input) {
  const normalized = normalizeNameString(input);
  const empty = { first: null, middles: [], last: null, suffix: "", display: "", inverted: false, ok: false };
  if (!normalized) return empty;

  let lastTokens;
  let givenTokens;
  let inverted = false;
  const suffixes = [];

  const collect = (tokens) => {
    const { kept, suffixes: found } = stripAffixes(tokens);
    suffixes.push(...found);
    return kept;
  };

  if (normalized.includes(",")) {
    const segments = normalized.split(",").map((s) => s.trim()).filter(Boolean);
    const surnameSide = collect(tokenize(segments[0] || ""));
    const givenSide = collect(tokenize(segments.slice(1).join(" ")));
    if (surnameSide.length && givenSide.length) {
      lastTokens = surnameSide;
      givenTokens = givenSide;
      inverted = true; // the comma DELIMITS the surname, so it needs no guessing
    } else {
      // "SMITH," or ", JOHN" — not really an inverted name; fall through to positional order.
      const all = [...surnameSide, ...givenSide];
      ({ lastTokens, givenTokens } = splitPositional(all));
    }
  } else {
    ({ lastTokens, givenTokens } = splitPositional(collect(tokenize(normalized))));
  }

  if (!lastTokens || !lastTokens.length) return empty;

  const first = givenTokens.length ? givenTokens[0] : null;
  const middles = givenTokens.slice(1);
  // Surname particles are joined WITHOUT a separator so "VAN DER BERG" (positional) and
  // "VAN DER BERG" (inverted) and "VANDERBERG" all land on the same key.
  const last = lastTokens.join("");

  return {
    first,
    middles,
    last,
    suffix: [...suffixes].sort().join(" "),
    display: [first, ...middles, lastTokens.join(" ")].filter(Boolean).join(" "),
    inverted,
    ok: Boolean(first && last),
  };
}

/**
 * Every reading of a name that is consistent with what was written.
 *
 * A comma delimits the surname, so an inverted name has exactly one reading. A POSITIONAL
 * name does not: "ANA GARCIA LOPEZ" is either Ana Lopez with the middle name Garcia, or Ana
 * Garcia-Lopez written without its hyphen — and SEC filings contain both conventions for
 * the same person. So a positional name also yields the readings where the surname absorbs
 * its trailing given tokens, and namesMatch accepts if ANY pair of readings agrees.
 *
 * This widens recall without touching precision: the surname key still has to be identical,
 * and the remaining given names still have to be compatible, so "MARY SMITHJONES" still
 * fails against both "MARY SMITH" and "MARY JONES".
 */
function parseVariants(input) {
  const base = parseName(input);
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

/** Positional ("First Middle Last") split, with two corrections:
 *   - a trailing single letter is a middle initial that drifted to the end, not a surname;
 *   - a surname particle absorbs everything after it ("JOHN VAN DER BERG"). */
function splitPositional(tokens) {
  const t = [...tokens];
  if (t.length <= 1) return { lastTokens: t, givenTokens: [] };

  let trailingInitial = null;
  if (t.length >= 3 && t[t.length - 1].length === 1) trailingInitial = t.pop();
  if (t.length === 1) return { lastTokens: t, givenTokens: trailingInitial ? [trailingInitial] : [] };

  let cut = t.length - 1;
  for (let i = 1; i < t.length - 1; i += 1) {
    if (PARTICLES.has(t[i])) {
      cut = i;
      break;
    }
  }

  const givenTokens = t.slice(0, cut);
  if (trailingInitial) givenTokens.push(trailingInitial);
  return { lastTokens: t.slice(cut), givenTokens };
}

/**
 * Do these two GIVEN names belong to the same person?
 *
 * The rule, in one line: an alias may reach its own formal name, but ONE ALIAS MAY NEVER
 * REACH ANOTHER ALIAS.
 *
 *   JON  vs JOHN      -> true   (alias to its formal)
 *   JACK vs JOHN      -> true   (alias to its formal)
 *   JON  vs JACK      -> FALSE  (two aliases; they merely share a formal name)
 *   STEVE  vs STEPHEN -> true   (alias to a spelling variant of its formal)
 *   STEVEN vs STEPHEN -> true   (two formals that are one name spelled two ways)
 *   PATRICK vs PATRICIA -> false (two formals, no shared spelling)
 *
 * The alias<->alias case is the one that shipped broken. Sharing a formal name is not
 * evidence of being the same person — Jack and Jon are both Johns, and a firm can hold both.
 * Precision over recall: refusing the pair costs a candidate 40 points of ranking, accepting
 * it hands someone another person's profile to claim.
 */
function anyIn(values, set) {
  for (const value of values) if (set.has(value)) return true;
  return false;
}

function firstNamesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  const aFormals = NICKNAMES.get(a);
  const bFormals = NICKNAMES.get(b);

  // Both sides are diminutives. Distinct aliases NEVER match, whatever they share.
  if (aFormals && bFormals) return false;

  if (aFormals) return anyIn(spellingsOf(b), aFormals);
  if (bFormals) return anyIn(spellingsOf(a), bFormals);

  // Two formal names: the same name spelled two ways, or not a match at all.
  return anyIn(spellingsOf(a), spellingsOf(b));
}

/** Two given-name tokens are compatible if they are equal, or one is the other's initial. */
function tokensCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length === 1) return b[0] === a;
  if (b.length === 1) return a[0] === b;
  return false;
}

/** Middle names agree, or one side simply did not record any. Only the positions BOTH sides
 *  filled in are compared — one source dropping a second middle name is not a conflict, but
 *  "JOHN A SMITH" vs "JOHN B SMITH" is, and that pair must never match. */
function middlesCompatible(a, b) {
  if (!a.length || !b.length) return true;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (!tokensCompatible(a[i], b[i])) return false;
  return true;
}

/** At least one middle position where both sides agree AND at least one of them spelled the
 *  name out. This is what licences a first-INITIAL match: "J ROBERT SMITH" == "JOHN ROBERT
 *  SMITH" is safe because ROBERT corroborates, while a bare "J SMITH" == "JOHN SMITH" is
 *  not — a firm can easily hold a Jane, a James and a John Smith. */
function middlesCorroborate(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (tokensCompatible(a[i], b[i]) && (a[i].length > 1 || b[i].length > 1)) return true;
  }
  return false;
}

/**
 * Do these two strings name the same person?
 *
 * Survives "Last, First Middle" vs "First Middle Last", case, accents, punctuation,
 * suffixes and middle-initial-vs-full-middle-name. Refuses:
 *   - different surnames, always;
 *   - contradicting middle names/initials ("JOHN A SMITH" vs "JOHN B SMITH");
 *   - a suffix on one side but not the other ("JOHN SMITH JR" vs "JOHN SMITH"). Father and
 *     son at the family firm is a REAL configuration in this data, and the un-suffixed
 *     filing is usually the father's — so a missing suffix is treated as evidence of a
 *     different person rather than as sloppy data entry. This costs real matches when only
 *     one source recorded the suffix; being wrong in the other direction costs someone
 *     their identity;
 *   - a bare first initial with nothing to corroborate it;
 *   - single-token names on either side, which carry too little to be sure about;
 *   - TWO DIFFERENT NICKNAMES OF ONE FORMAL NAME. "Jon" and "Jack" are both Johns and are
 *     not each other; likewise Ted/Ed, Bob/Rob, Bill/Will, Beth/Betty, Kate/Kathy,
 *     Dick/Rich, Jim/Jamie, Sue/Suzy. See firstNamesMatch.
 */
export function namesMatch(a, b) {
  const lefts = parseVariants(a);
  const rights = parseVariants(b);
  for (const left of lefts) {
    for (const right of rights) {
      if (readingsMatch(left, right)) return true;
    }
  }
  return false;
}

/** One reading of each name against one reading of the other. */
function readingsMatch(left, right) {
  if (left.last !== right.last) return false;
  if (left.suffix !== right.suffix) return false;
  if (!middlesCompatible(left.middles, right.middles)) return false;

  if (firstNamesMatch(left.first, right.first)) return true;

  const initialish =
    (left.first.length === 1 && right.first[0] === left.first) ||
    (right.first.length === 1 && left.first[0] === right.first);
  if (initialish) return middlesCorroborate(left.middles, right.middles);

  return false;
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/** Signal weights, straight from the product spec. MAX_RAW is their sum, which is what
 *  `score` is normalised against — so 100 means "every signal we have fired". */
export const SIGNALS = {
  SCHEDULE_A: 40,
  SOLE_ADVISER: 20,
  MAJOR_OWNER: 15,
  SENIOR_TITLE: 10,
  NO_DISCLOSURES: 5,
};
const MAX_RAW = Object.values(SIGNALS).reduce((a, b) => a + b, 0);

/** Ownership codes are Form ADV bands: A <5%, B 5-10%, C 10-25%, D 25-50%, E 50-75%, F 75%+.
 *  D and above means this person substantially owns the firm — a strong signal that the
 *  office line is theirs. */
const MAJOR_OWNERSHIP = new Set(["D", "E", "F"]);
const SENIOR_TITLE_RE = /\b(CEO|CHIEF EXECUTIVE|PRESIDENT|FOUNDER|MANAGING|PRINCIPAL|OWNER)\b/;

const OWNERSHIP_BAND = { D: "25-50%", E: "50-75%", F: "75% or more" };

const normalizeScore = (raw) => Math.max(0, Math.min(100, Math.round((raw / MAX_RAW) * 100)));

// ---------------------------------------------------------------------------
// shaping
// ---------------------------------------------------------------------------

const DEFAULT_SITE_BASE = "https://adviserinfo.sec.gov";
/** Where the SEC serves the generated PDF reports. Separate host from the HTML site, and it
 *  is not configurable because a wrong value here produces a link to nothing. */
const REPORTS_BASE = "https://reports.adviserinfo.sec.gov";
const BROCHURE_BASE = "https://files.adviserinfo.sec.gov/IAPD/Content/Common/crd_iapd_Brochure.aspx";
const siteBaseOf = (deps) => deps?.config?.iapd?.siteBase || DEFAULT_SITE_BASE;
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

function limitOf(deps) {
  const raw = Number(deps?.limit ?? deps?.config?.lookup?.defaultLimit ?? 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(deps?.config?.lookup?.maxLimit ?? 50, Math.round(raw)));
}

/**
 * What we publish about a firm — THE ONLY firm shape that ever reaches the wire.
 *
 * Everything here is on the firm's own adviserinfo.sec.gov page, and there is not one person
 * name in it. Schedule A PEOPLE are reduced to a COUNT, deliberately and in every context:
 *
 *   - on the ambiguous-firm path the claimant only has to pick which firm is theirs, and
 *     naming a dozen officers across several firms discloses far more than the question;
 *   - on GET /v1/firms/{crd} the whole firm record used to be returned RAW, scheduleAPersons
 *     array and all. CRDs are small sequential integers, so that route could be walked to
 *     rebuild a national directory of RIA owners and officers by name and title — the exact
 *     thing this service must never become. It now returns this projection and nothing else.
 *
 * Person names surface as candidates once — and only once — a single firm is in play and the
 * size gate below has been passed.
 *
 * `scheduleAPersonCount` is NULL, not 0, when the source cannot say. The live Cloud SQL
 * Form ADV feed carries no Schedule A at all, and reporting 0 there would assert that a firm
 * has no disclosed owners when the truth is that we did not look.
 */
export function toFirmSummary(firm, deps) {
  if (!firm) return null;
  const crd = Number(firm.crd);
  return {
    crd,
    name: firm.name ?? null,
    dba: firm.dba ?? null,
    secNumber: firm.secNumber ?? null,
    registrationType: firm.registrationType ?? null,
    registrationStatus: firm.registrationStatus ?? null,
    address: {
      street1: firm.street1 ?? null,
      street2: firm.street2 ?? null,
      city: firm.city ?? null,
      state: firm.state ?? null,
      zip: firm.zip ?? null,
      country: firm.country ?? null,
    },
    phone: firm.phone ?? null,
    phone10: firm.phone10 ?? null,
    website: firm.website ?? null,
    totalEmployees: firm.totalEmployees ?? null,
    advisoryEmployees: firm.advisoryEmployees ?? null,
    iarCount: firm.iarCount ?? null,
    effectiveAdviserCount: firm.effectiveAdviserCount ?? null,
    aum: firm.aum ?? null,
    numAccounts: firm.numAccounts ?? null,
    latestFilingDate: firm.latestFilingDate ?? null,
    scheduleAPersonCount: Array.isArray(firm.scheduleAPersons) ? firm.scheduleAPersons.length : null,
    branchCount: firm.branchCount ?? null,
    recordSource: firm.recordSource ?? null,
    lastSeen: firm.lastSeen ?? null,
    reportUrl: Number.isFinite(crd) ? `${siteBaseOf(deps)}/firm/summary/${crd}` : null,
  };
}

/**
 * The complete body of GET /v1/firms/{crd}.
 *
 * It lives HERE, not in server.mjs, for one reason: the disclosure bug it fixes was in the
 * route, and a route that only a running HTTP server can exercise is a route with no
 * regression test. The shipped version returned the whole indexed record — including
 * `scheduleAPersons`, every direct owner and executive officer by name, title and ownership
 * band — alongside the raw live record, under the keys `indexed` and `live`. Confirmed
 * against the build: /v1/claim/lookup on J.P. Morgan (CRD 79) deliberately withheld all 15
 * of those people and returned a count, and then GET /v1/firms/79 handed back all 15 with
 * their titles. CRDs are small sequential integers, so the route could be walked into a
 * national directory of RIA owners and officers.
 *
 * The single defence is that the two source records are PROJECTED through toFirmSummary and
 * neither is echoed whole. Whatever a source starts carrying, only firm-level fields survive.
 *
 * 404 IS AN ANSWER AND MUST BE EARNED. Two empty sources are not automatically "no such firm":
 * with Cloud SQL switched off (a supported standalone deployment) and IAPD erroring, BOTH are
 * empty and NEITHER looked. Publishing that as "No firm found for CRD 2907" tells a caller the
 * SEC has no record of a firm that is registered and fine — a dependency failure dressed up as
 * a fact about the world. So a 404 requires at least one source to have actually said no, and
 * everything else is a 503 the caller can retry.
 *
 * @param {object} input
 * @param {number} input.crd
 * @param {object|null} input.filed     the Cloud SQL Form ADV record (already flat)
 * @param {object|null} input.live      the IAPD firm detail (nested officeAddress)
 * @param {string|null} input.filedError
 * @param {string|null} input.liveError
 * @param {number|null} input.liveStatus  the IAPD error's HTTP status; 404 means "no such firm",
 *                                        which IS evidence. Anything else is a fault.
 * @param {boolean} input.filedConsulted  false when the store is disabled — it returned null
 *                                        without ever being asked. Defaults TRUE, so a caller
 *                                        that does not know stays on the old behaviour.
 * @param {string|null} input.filedSkipped
 * @param {object|null} input.freshness
 * @returns {{status:number, body:object}}
 */
export function buildFirmDetail({
  crd,
  filed = null,
  live = null,
  filedError = null,
  liveError = null,
  liveStatus = null,
  filedConsulted = true,
  filedSkipped = null,
  freshness = null,
  attribution = ATTRIBUTION,
  deps = {},
} = {}) {
  if (!filed && !live) {
    // "We asked and there is no row" — evidence. A store that errored or was never consulted
    // is not.
    const formAdvSaidNo = filedConsulted === true && !filedError;
    // IAPD answering 404 is the SEC saying the CRD does not exist. Any other failure (503,
    // timeout, socket) is our dependency being broken, not the firm being absent.
    const iapdSaidNo = !liveError || Number(liveStatus) === 404;

    if (formAdvSaidNo || iapdSaidNo) {
      return {
        status: 404,
        body: {
          ok: false,
          error: `No firm found for CRD ${crd}`,
          crd,
          filedError,
          liveError,
          sources: {
            formAdvDb: { consulted: filedConsulted === true, skipped: filedSkipped, error: filedError },
            iapd: { consulted: true, status: liveStatus, error: liveError },
          },
          verificationRequired: true,
          attribution,
        },
      };
    }

    return {
      status: 503,
      body: {
        ok: false,
        error: `Neither source could be consulted for CRD ${crd}, so we cannot say whether this firm exists. This is a dependency failure on our side, not a statement about the SEC's register — please retry.`,
        crd,
        filedError,
        liveError,
        sources: {
          formAdvDb: { consulted: false, skipped: filedSkipped, error: filedError },
          iapd: { consulted: true, status: liveStatus, error: liveError },
        },
        retryable: true,
        verificationRequired: true,
        attribution,
      },
    };
  }

  // Flatten the live record onto the filed one — but only where live actually has a value,
  // so a null in the IAPD payload cannot erase a good filed address.
  const flattenedLive = live
    ? {
        crd: live.crd,
        name: live.name,
        secNumber: live.secNumber,
        street1: live.officeAddress?.street1,
        street2: live.officeAddress?.street2,
        city: live.officeAddress?.city,
        state: live.officeAddress?.state,
        zip: live.officeAddress?.zip,
        country: live.officeAddress?.country,
        registrationStatus: Array.isArray(live.registrationStatus) ? live.registrationStatus[0]?.status ?? null : null,
      }
    : null;

  const merged = { ...(filed || {}) };
  for (const [key, value] of Object.entries(flattenedLive || {})) {
    if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }

  return {
    status: 200,
    body: {
      ok: true,
      crd: Number(crd),
      // THE projection. Nothing else from either record reaches the wire.
      firm: toFirmSummary({ ...merged, crd: Number(crd) }, deps),
      sources: {
        formAdvDb: { present: Boolean(filed), error: filedError, lastSeen: filed?.lastSeen ?? null },
        iapd: { present: Boolean(live), error: liveError, live: true },
      },
      freshness,
      // People are NOT available from this route, by design. Say so, rather than leaving a
      // caller to conclude the firm has no advisers.
      disclosure:
        "Firm-level public record only. This route never returns the names of a firm's owners, officers or advisers; use /v1/claim/lookup, which applies the disclosure rules for naming a person.",
      verificationRequired: true,
      attribution,
    },
  };
}

/** Keys that toFirmSummary is allowed to emit. The regression test for the /v1/firms/{crd}
 *  disclosure bug asserts against this list, so adding a person-shaped field to the summary
 *  fails the build rather than shipping. */
export const FIRM_SUMMARY_KEYS = Object.freeze([
  "crd", "name", "dba", "secNumber", "registrationType", "registrationStatus", "address",
  "phone", "phone10", "website", "totalEmployees", "advisoryEmployees", "iarCount",
  "effectiveAdviserCount", "aum", "numAccounts", "latestFilingDate", "scheduleAPersonCount",
  "branchCount", "recordSource", "lastSeen", "reportUrl",
]);

const scheduleAOf = (firm) => (Array.isArray(firm?.scheduleAPersons) ? firm.scheduleAPersons : []);

/**
 * Match the live roster against the firm's Schedule A, but only where the match is
 * UNAMBIGUOUS in both directions.
 *
 * If one Schedule A line matches two advisers (two John Smiths on the roster), or one
 * adviser matches two Schedule A lines, we cannot tell which is which — so nobody gets the
 * 40-point boost. Ambiguity has to cost the score, not the person.
 */
function pairScheduleA(individuals, schedulePersons) {
  const pairs = new Map(); // individual index -> schedule A person
  const byIndividual = new Map();
  const bySchedule = new Map();

  individuals.forEach((individual, i) => {
    schedulePersons.forEach((person, j) => {
      if (!namesMatch(person?.name, individual?.name)) return;
      byIndividual.set(i, (byIndividual.get(i) || []).concat(j));
      bySchedule.set(j, (bySchedule.get(j) || []).concat(i));
    });
  });

  for (const [i, js] of byIndividual) {
    if (js.length !== 1) continue;
    const j = js[0];
    if ((bySchedule.get(j) || []).length !== 1) continue;
    pairs.set(i, schedulePersons[j]);
  }
  return pairs;
}

/** One roster adviser, scored and explained. */
function buildCandidate({ individual, schedulePerson, firm, soleAdviser, deps, extraReasons = [] }) {
  const reasons = [];
  let raw = 0;

  const firmName = firm?.name || "this firm";

  if (schedulePerson) {
    raw += SIGNALS.SCHEDULE_A;
    reasons.push(`Named on ${firmName}'s Form ADV Schedule A (direct owners and executive officers)`);
  }
  if (soleAdviser) {
    raw += SIGNALS.SOLE_ADVISER;
    reasons.push("The only adviser the SEC currently lists at this firm");
  }
  const ownership = String(schedulePerson?.ownershipCode || "").trim().toUpperCase();
  if (MAJOR_OWNERSHIP.has(ownership)) {
    raw += SIGNALS.MAJOR_OWNER;
    reasons.push(`Discloses ownership of ${OWNERSHIP_BAND[ownership]} of the firm (Schedule A code ${ownership})`);
  }
  const title = schedulePerson?.title ? String(schedulePerson.title) : null;
  if (title && SENIOR_TITLE_RE.test(title.toUpperCase())) {
    raw += SIGNALS.SENIOR_TITLE;
    reasons.push(`Holds a senior role at the firm: ${title}`);
  } else if (title) {
    reasons.push(`Listed on Schedule A as: ${title}`);
  }
  if (individual?.hasDisclosures === false) {
    raw += SIGNALS.NO_DISCLOSURES;
    reasons.push("No disclosure events on the SEC record");
  } else if (individual?.hasDisclosures === true) {
    reasons.push("Has one or more disclosure events on the SEC record");
  }
  if (individual?.branchCity && individual?.branchState) {
    reasons.push(`Registered at the ${individual.branchCity}, ${individual.branchState} office`);
  }
  reasons.push(...extraReasons);

  const crd = Number.isFinite(Number(individual?.crd)) ? Number(individual.crd) : null;

  return {
    individualCrd: crd,
    name: individual?.name || null,
    firmCrd: Number(firm?.crd) || null,
    firmName: firm?.name || null,
    title,
    score: normalizeScore(raw),
    reasons,
    // The name parts come straight from the roster row (ind_firstname / ind_middlename /
    // ind_lastname), so a front-end can render "Robert" without re-splitting a display string
    // and getting "Simon-Wallace" or "WEISMAN MRS." wrong. `otherNames` is NULL rather than []
    // because the roster endpoint does not carry it at all — only the individual detail
    // endpoint does, and reporting [] here would assert that a person has no other names when
    // the truth is that this source does not say.
    firstName: individual?.firstName ?? null,
    middleName: individual?.middleName ?? null,
    lastName: individual?.lastName ?? null,
    otherNames: individual?.otherNames ?? null,
    branchCity: individual?.branchCity ?? null,
    branchState: individual?.branchState ?? null,
    hasDisclosures: individual?.hasDisclosures ?? null,
    profileUrl: crd == null ? null : `${siteBaseOf(deps)}/individual/summary/${crd}`,
    // The IAPD individual report. Measured: this URL works for pure RIAs, where FINRA's
    // files.brokercheck.finra.org equivalent 403s for anyone with no broker record.
    reportUrl: crd == null ? null : `${REPORTS_BASE}/reports/individual/individual_${crd}.pdf`,
  };
}

/** A Schedule A officer/owner we can name but cannot link to an IAPD record.
 *
 *  Used only when the live roster is unusable (IAPD down, or the SEC lists nobody currently
 *  registered at the firm). `individualCrd` and `profileUrl` are null BY DESIGN: without a
 *  CRD there is no profile to hand over, so this can inform the claimant without ever
 *  offering them a record to claim. `disclosedName` is the SEC's own verbatim string. */
function scheduleACandidate(person, firm, deps, extraReasons) {
  const parsed = parseName(person?.name);
  const reasons = [`Disclosed on ${firm?.name || "the firm"}'s Form ADV Schedule A as an owner or executive officer`];
  let raw = SIGNALS.SCHEDULE_A;

  const ownership = String(person?.ownershipCode || "").trim().toUpperCase();
  if (MAJOR_OWNERSHIP.has(ownership)) {
    raw += SIGNALS.MAJOR_OWNER;
    reasons.push(`Discloses ownership of ${OWNERSHIP_BAND[ownership]} of the firm (Schedule A code ${ownership})`);
  }
  const title = person?.title ? String(person.title) : null;
  if (title && SENIOR_TITLE_RE.test(title.toUpperCase())) {
    raw += SIGNALS.SENIOR_TITLE;
    reasons.push(`Holds a senior role at the firm: ${title}`);
  } else if (title) {
    reasons.push(`Listed on Schedule A as: ${title}`);
  }
  reasons.push(...extraReasons);

  return {
    individualCrd: null,
    name: parsed.display || person?.name || null,
    disclosedName: person?.name ?? null,
    firmCrd: Number(firm?.crd) || null,
    firmName: firm?.name || null,
    title,
    score: normalizeScore(raw),
    reasons,
    branchCity: firm?.city ?? null,
    branchState: firm?.state ?? null,
    hasDisclosures: null,
    profileUrl: null,
  };
}

/**
 * The Schedule A fallback list — and the size gate that decides whether it may exist at all.
 *
 * WHY THE GATE. When the live roster is unusable we can still read the firm's own Form ADV
 * Schedule A. For a one-person shop that is exactly the right answer: SEC-registered solo
 * advisers frequently have NO record in IAPD's individual index (their IAR registration sits
 * at the state level), so the roster legitimately comes back empty and the single disclosed
 * owner IS the person who answers that phone.
 *
 * For anything bigger it is the wrong answer and a genuinely bad disclosure. Measured
 * against the real index: 914-225-1000 resolves to CONSULTING GROUP ADVISORY SERVICES LLC
 * (a Morgan Stanley entity at 2000 Westchester Avenue, 9 IARs) whose roster is also empty —
 * ungated, typing a corporate switchboard number returned its CEO, two directors and its
 * CCO by name. That is a reverse-lookup of a phone number into named executives, which is
 * the exact thing this service is not allowed to be.
 *
 * So we name Schedule A people only when the FIRM'S OWN FILING says the number belongs to a
 * handful of people, and fail CLOSED when the filing does not say.
 *
 * A FILED ZERO IS NOT EVIDENCE OF SMALLNESS. This is the bug the gate shipped with. The test
 * was `headcount ?? null` then `headcount > few`, so 0 was neither null nor greater than 5
 * and fell straight through to the naming branch. Measured against the real data: phone
 * 212-969-1000 is ALLIANCEBERNSTEIN CORPORATION, which reports 0 advisory employees and
 * discloses 14 Schedule A persons — so a caller typing that switchboard number got the
 * firm's entire board and C-suite by name. 88 firms in the shipped index reported 0, 19 of
 * them with more than five disclosed people. 0 means "not stated on this line of the filing",
 * exactly like null, and it is now treated exactly like null.
 */
export function scheduleAFallback(firm, deps, extraReasons = [], limit = 10) {
  const few = deps.config?.lookup?.fewCandidatesMax ?? 5;
  const raw = firm?.effectiveAdviserCount ?? firm?.advisoryEmployees ?? null;
  // Number(null) is 0 and Number("") is 0, so an `??`-style coercion would turn "the filing
  // does not say" into "the filing says zero" — two different facts that must both fail
  // closed but must not be reported as each other.
  const headcount =
    raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  const people = scheduleAOf(firm);
  if (!people.length) return { candidates: [], withheld: false };

  // Fails CLOSED on every value that is not a positive number no larger than `few`:
  // null, 0, a negative, a non-number, and anything above the threshold.
  const knownSmall = headcount != null && headcount > 0 && headcount <= few;
  if (!knownSmall) {
    const stated =
      headcount == null
        ? "an unstated number of"
        : headcount === 0
          ? "no"
          : String(headcount);
    const because =
      headcount === 0
        ? "A reported zero means the firm did not state a headcount on that line, which is not evidence that one person answers this phone."
        : "At that size the office number identifies the firm, not a person.";
    return {
      candidates: [],
      withheld: true,
      note: `The firm's own Form ADV reports ${stated} advisory staff, so its Schedule A owners and officers are not listed here. ${because}`,
    };
  }
  return {
    candidates: rankCandidates(people.map((person) => scheduleACandidate(person, firm, deps, extraReasons))).slice(0, limit),
    withheld: false,
  };
}

/** Highest score first; ties broken by a clean record, then alphabetically, so the same
 *  request always produces the same order. */
function rankCandidates(candidates) {
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.hasDisclosures !== b.hasDisclosures) return a.hasDisclosures ? 1 : -1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

// ---------------------------------------------------------------------------
// DUAL IDENTITY — one phone number, two legitimate claim targets
// ---------------------------------------------------------------------------
//
// 425-296-1611 is ROBINSWOOD FINANCIAL LLC's main line AND the working number of all seven
// advisers registered there. Both claims are real, and the service must not guess: it returns
// both targets and lets the human say which they are.
//
// `mode` NARROWS THE ANSWER AND CAN NEVER WIDEN IT, and that is enforced by SHAPE rather than
// by care. Look at where the two fields come from:
//
//   individualClaims  is a projection of `result.candidates` — the array produced by the
//                     disclosure logic in resolveByPhone, which never reads `mode` at all. The
//                     large-firm gate, the zero-advisory-staff gate, the Schedule A fallback
//                     gate and the roster-size thresholds all run identically in every mode,
//                     because they run BEFORE this projection and cannot see it.
//   firmClaim         is toFirmSummary plus firm-level filing metadata. toFirmSummary is the
//                     projection that already exists to keep person names out of a firm answer
//                     (see the /v1/firms/{crd} incident in its docstring), and it is reused
//                     here rather than re-derived, so a person-shaped field cannot appear in a
//                     firmClaim without appearing in that function first — where
//                     FIRM_SUMMARY_KEYS fails the build.
//
// So the strongest statement about modes is a structural one: for a given phone number, the
// set of people named in mode=firm is EMPTY, and the set named in mode=individual is exactly
// the set named in mode=auto. mode cannot be used to see more.

const CLAIM_MODES = new Set(["auto", "firm", "individual"]);

/** The requested mode. Unknown values are rejected at the edge by query.mjs (with a 400, on
 *  purpose — see MODES there); this defaults rather than throws so a direct library caller
 *  that passes nothing gets the full answer. */
export function modeOf(deps) {
  const raw = String(deps?.mode ?? "auto").trim().toLowerCase();
  return CLAIM_MODES.has(raw) ? raw : "auto";
}

/**
 * The firm as a CLAIM TARGET.
 *
 * Everything in toFirmSummary, plus the filing metadata a claimant needs to recognise their own
 * firm and the report URLs a human can check us against. `live` is the IAPD firm detail, which
 * is the only source for registrations, notice filings and brochures — when it was not fetched
 * those fields are NULL and `enriched:false` says why, rather than [] pretending the firm has
 * none.
 */
export function toFirmClaim(firm, deps, { live = null, liveError = null, enriched = false } = {}) {
  const summary = toFirmSummary(firm, deps);
  if (!summary) return null;
  const crd = summary.crd;
  const brochures = Array.isArray(live?.brochures) ? live.brochures : null;

  return {
    ...summary,
    claimType: "firm",
    registrationType: summary.registrationType ?? (live?.iaScope ?? null),
    registrations: Array.isArray(live?.registrationStatus) ? live.registrationStatus : null,
    noticeFilings: Array.isArray(live?.noticeFilings) ? live.noticeFilings : null,
    brochures: brochures
      ? brochures.map((b) => ({
          ...b,
          // The ADV Part 2 brochure is the one genuinely PDF-only firm artifact — narrative
          // prose (fee schedules in sentences, conflicts, strategy) with no structured
          // equivalent anywhere. So we link it rather than pretending to have parsed it.
          url: b?.versionId ? `${BROCHURE_BASE}?BRCHR_VRSN_ID=${b.versionId}` : null,
        }))
      : null,
    mailingAddress: live?.mailingAddress ?? null,
    // Human-checkable documents. The firm ADV PDF is deliberately a LINK and not a parse
    // target: every field in it is published as structured XML in the SEC's daily
    // IA_FIRM_SEC_Feed compilation, so parsing 21 pages of PDF would be re-deriving data we
    // can already read.
    reportUrl: summary.reportUrl,
    formAdvPdfUrl: Number.isFinite(crd) ? `${REPORTS_BASE}/reports/ADV/${crd}/PDF/${crd}.pdf` : null,
    formCrsUrl: Number.isFinite(crd) ? `${REPORTS_BASE}/crs/crs_${crd}.pdf` : null,
    // Where the firm block came from, so an integrator can tell a Form ADV row from a live
    // IAPD read without asking us.
    enriched,
    enrichmentError: liveError ?? null,
    enrichmentNote: enriched
      ? "Registrations, notice filings and brochures were read live from SEC IAPD."
      : "Registrations, notice filings and brochures are null because live IAPD firm detail was not fetched for this request. Null means 'not read', never 'none on file'.",
  };
}

/**
 * One roster adviser as a CLAIM TARGET.
 *
 * A pure rename-and-annotate of a candidate the disclosure logic already decided to publish.
 * It adds no field that could not already be read off that candidate — which is what makes
 * "mode cannot widen disclosure" a fact about the code rather than a promise.
 *
 * `claimable` is false for a Schedule A fallback entry: those have no individual CRD, so there
 * is no SEC profile behind them to hand over. They are shown so a claimant recognises the firm,
 * never as something to claim.
 */
export function toIndividualClaim(candidate) {
  if (!candidate) return null;
  const crd = candidate.individualCrd;
  return {
    ...candidate,
    claimType: "individual",
    // `Number.isFinite(Number(null))` is TRUE — Number(null) is 0 — and a Schedule A fallback
    // entry has individualCrd EXACTLY null. Written the obvious way, every un-linkable officer
    // was published as claimable:true, which is the front-end being invited to offer a claim on
    // a profile that does not exist. The test for this is the one that caught it.
    claimable: typeof crd === "number" && Number.isInteger(crd) && crd > 0,
  };
}

/**
 * Project a decided result into the dual-identity response.
 *
 * Runs LAST, over an envelope whose `candidates` are already final. It filters, it never
 * fetches and it never re-decides.
 */
export function applyClaimShape(result, { firm = null, mode = "auto", deps = {}, live = null, liveError = null } = {}) {
  const enriched = Boolean(live);
  const firmClaim = firm ? toFirmClaim(firm, deps, { live, liveError, enriched }) : null;

  // BELT AND BRACES. mode=firm returns from resolveByPhone before the roster is even fetched,
  // so `candidates` is already empty here. This line means that even a future refactor which
  // moved the roster fetch earlier could not leak a person into a firm-mode answer.
  const candidates = mode === "firm" ? [] : result.candidates || [];
  const individualClaims = candidates.map(toIndividualClaim);

  const personNextStep = result.nextStep;
  let nextStep = personNextStep;
  if (firmClaim) {
    if (mode === "firm") nextStep = "confirm_firm";
    else if (mode === "auto") nextStep = individualClaims.length ? "choose_identity" : "confirm_firm";
    // mode=individual keeps the person-oriented step it always had.
  }

  return {
    ...result,
    mode,
    nextStep,
    // The step the person-claim flow would take on its own, preserved unchanged. A front-end
    // that only ever cared about "pick_person" keeps a field that still means that.
    personNextStep,
    firmClaim,
    individualClaims,
    claimTargets: {
      firm: firmClaim ? firmClaim.crd : null,
      individuals: individualClaims.filter((c) => c.claimable).map((c) => c.individualCrd),
    },
    // Say the quiet part in the payload. An integrator reading only `individualClaims` in
    // firm mode must not conclude the firm has no advisers.
    modeNote:
      mode === "firm"
        ? "mode=firm: the SEC adviser roster was not fetched for this request, so no person is named and individualClaims is empty. That is a request-shape decision, not a statement that this firm has no advisers — ask again with mode=auto."
        : mode === "individual"
          ? "mode=individual: people were resolved in full; the firm block carries the Form ADV facts but was not enriched from live IAPD firm detail."
          : "mode=auto: both claim targets are returned. The claimant chooses which is theirs; this service never guesses between a firm and a person who share a phone number.",
  };
}

function baseEnvelope(fields) {
  return {
    query: fields.query,
    outcome: fields.outcome,
    confidence: fields.confidence,
    firms: fields.firms || [],
    candidates: fields.candidates || [],
    nextStep: fields.nextStep,
    notes: fields.notes || [],
    verificationRequired: true,
    attribution: fields.attribution,
    ...(fields.extra || {}),
  };
}

const PHONE_REASON_TEXT = {
  empty: "No phone number was entered.",
  no_digits: "That entry contains no digits, so it cannot be a phone number.",
  too_short: "That number is too short to be a US or Canadian phone number.",
  too_long: "That number is too long to be a US or Canadian phone number.",
  non_nanp_country: "That looks like a phone number outside the US and Canada, which SEC Form ADV filings are not indexed by here.",
  invalid_area_code: "That area code is not a valid North American area code.",
  invalid_exchange: "That is not a valid North American phone number — check the three digits after the area code.",
};

// ---------------------------------------------------------------------------
// firm resolution — two live sources, fused
// ---------------------------------------------------------------------------

/**
 * What `sources.formAdv.status` can say, and which of those is EVIDENCE.
 *
 * Cloud SQL is an optional source (config.db.enabled). "We asked and the SEC's firm feed has
 * no filing with this number" and "we never asked" are different facts and only the first one
 * is a reason to believe no Form ADV firm owns the line. Collapsing them is how a deployment
 * that deliberately runs without a database ends up telling advisers the SEC has no record of
 * their office number.
 *
 *   hit            asked; the feed named at least one firm.       EVIDENCE
 *   miss           asked; the feed named none.                    EVIDENCE
 *   not_configured no database in this deployment. Never asked.   no evidence
 *   no_store       no store wired into the resolver at all.       no evidence
 *   timeout        asked; it did not answer inside the deadline.  no evidence
 *   error          asked; it failed.                              no evidence
 *   not_consulted  nothing was asked — the phone never parsed.    no evidence
 */
export const FORM_ADV_STATUS = Object.freeze({
  HIT: "hit",
  MISS: "miss",
  NOT_CONFIGURED: "not_configured",
  NO_STORE: "no_store",
  TIMEOUT: "timeout",
  ERROR: "error",
  NOT_CONSULTED: "not_consulted",
});

/** The only two statuses that say anything about whether a Form ADV firm files this number. */
export const FORM_ADV_EVIDENCE_STATUSES = Object.freeze([FORM_ADV_STATUS.HIT, FORM_ADV_STATUS.MISS]);

const FORM_ADV_STATUS_NOTE = Object.freeze({
  hit: "The SEC Form ADV firm table was consulted and files this number.",
  miss: "The SEC Form ADV firm table was consulted and no firm files this number.",
  not_configured:
    "No Cloud SQL Form ADV table is part of this deployment, so it was NOT consulted. This is not evidence that no firm files this number — phone -> firm was resolved live from Google Places cross-validated through SEC IAPD.",
  no_store: "No Form ADV table is wired into this resolver, so it was NOT consulted.",
  timeout: "The SEC Form ADV firm table did not answer inside its deadline, so its answer is unknown — not empty.",
  error: "The SEC Form ADV firm table could not be read, so its answer is unknown — not empty.",
  not_consulted: "Nothing was consulted: the number could not be parsed.",
});

/** db-task outcome -> one of FORM_ADV_STATUS. */
function formAdvStatus(db, firms) {
  if (db.error) return db.timeout ? FORM_ADV_STATUS.TIMEOUT : FORM_ADV_STATUS.ERROR;
  if (!db.consulted) return db.skipped === "no_store" ? FORM_ADV_STATUS.NO_STORE : FORM_ADV_STATUS.NOT_CONFIGURED;
  return firms.length > 0 ? FORM_ADV_STATUS.HIT : FORM_ADV_STATUS.MISS;
}

/** True when this source actually told us something about the number. */
export const formAdvIsEvidence = (sources) => FORM_ADV_EVIDENCE_STATUSES.includes(sources?.formAdv?.status);

/** What one Places lookup costs the request's upstream budget: one Google call, up to three
 *  IAPD firm searches (the query variants) and up to two IAPD firm-detail confirmations.
 *  Charged up front as a block, because half a chain is not a cheaper answer, it is a wrong
 *  one — better to skip the cross-check entirely and say so. */
const PLACES_CHAIN_COST = 6;

/** IAPD firm detail -> the flat firm record toFirmSummary speaks. Used only on the
 *  Places-only path, where the DB has no row for the CRD that Places validated to.
 *
 *  advisoryEmployees stays NULL: this endpoint does not publish a headcount, and inventing a
 *  0 here would walk straight back into the disclosure bug that scheduleAFallback exists to
 *  prevent. */
function fromIapdFirmDetail(detail, extra = {}) {
  if (!detail) return null;
  const address = detail.officeAddress || {};
  const status = Array.isArray(detail.registrationStatus) ? detail.registrationStatus : [];
  return {
    crd: Number(detail.crd),
    name: detail.name ?? null,
    dba: null,
    secNumber: detail.secNumber ?? null,
    registrationType: detail.isIaFirm ? "sec" : null,
    registrationStatus: status.length ? String(status[0]?.status ?? status[0] ?? "") || null : null,
    street1: address.street1 ?? null,
    street2: address.street2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    zip: address.zip ?? null,
    country: address.country ?? null,
    phone: null,
    phone10: null,
    website: null,
    totalEmployees: null,
    advisoryEmployees: null,
    iarCount: null,
    effectiveAdviserCount: null,
    aum: null,
    numAccounts: null,
    latestFilingDate: null,
    recordSource: "iapd_live",
    ...extra,
  };
}

/**
 * Phone -> firm, from BOTH live sources, fused.
 *
 * (a) Cloud SQL `ria.firms` — the Form ADV filing that names this number as a main office
 *     line. Authoritative, indexed, sub-millisecond.
 * (b) Google Places -> IAPD firm search -> address cross-validation (places.mjs). Runs when
 *     (a) misses AND as a cross-check when (a) hits, because a Form ADV bulk row can be
 *     weeks old and a business that moved or renamed shows up here first.
 *
 * The fusion rules, in full:
 *
 *   both agree on a CRD          -> high,   matchedOn ["form_adv","places"]
 *   Cloud SQL only               -> medium, matchedOn ["form_adv"], plus the mapping's age
 *   Places only (validated)      -> medium, matchedOn ["places"]
 *   Places only, NO DATABASE     -> high when the live chain cross-validated it on its own
 *   they DISAGREE                -> ambiguous_firm, BOTH firms returned, nextStep pick_firm
 *   neither                      -> no_match
 *
 * (a) IS OPTIONAL. When it is not part of the deployment it is reported as NOT CONSULTED, not
 * as a miss: `firms: []` from a source nobody asked is not evidence that no Form ADV firm
 * files this number, and publishing it as such would tell an adviser the SEC has no record of
 * their office line. See FORM_ADV_STATUS above.
 *
 * The disagreement rule is the one that matters. Silently preferring either source is a coin
 * flip presented as an answer, and the losing side is somebody else's firm — the claimant is
 * the only person in the loop who knows which one is theirs, so we ask them.
 *
 * A multi-firm Cloud SQL hit (a shared suite, a parent and its affiliates, a compliance
 * provider's line — 630 numbers in the table map to two firms and 202 to three or more) is
 * ambiguous by default, but a Places result that lands ON ONE OF THEM resolves it: that is
 * exactly the corroboration a human would use.
 */
async function matchFirm(parsed, deps) {
  const budget = deps.budget || null;
  const store = deps.store || null;
  const places = deps.places || null;

  const dbTask = (async () => {
    // `store.enabled === false` — the strict comparison is load-bearing. Cloud SQL is optional
    // (config.db.enabled), and a store that is switched off answers without opening a socket.
    // `!store.enabled` would ALSO catch every test double and every future store that simply
    // does not carry the field, silently turning a working source off.
    if (store?.enabled === false) {
      return { firms: [], error: null, available: false, ms: null, consulted: false, skipped: "not_configured" };
    }
    if (typeof store?.lookupByPhone !== "function") {
      return { firms: [], error: null, available: false, ms: null, consulted: false, skipped: "no_store" };
    }
    try {
      const found = await store.lookupByPhone(parsed.national10);
      // CARRY `consulted` OUT OF THE STORE, do not infer it from `.firms`. An empty array is
      // ambiguous between "the SEC's firm feed has no filing with this number" (evidence) and
      // "we never asked" (no evidence at all), and reporting the second as the first tells a
      // caller the SEC has nothing on a number nobody ever looked up.
      return {
        firms: found?.firms || [],
        error: null,
        available: true,
        ms: found?.ms ?? null,
        consulted: found?.consulted ?? true,
        skipped: found?.skipped ?? null,
      };
    } catch (error) {
      // Rule 1: never throw on an upstream failure. A dead database still leaves Places.
      return {
        firms: [],
        error: errorMessage(error),
        available: true,
        ms: null,
        consulted: false,
        skipped: null,
        timeout: error?.timeout === true || error?.code === "timeout",
      };
    }
  })();

  const placesTask = (async () => {
    // BUDGET IS ONLY CHARGED FOR WORK THAT WILL HAPPEN. The guard used to be
    // `typeof places?.resolveByPhoneLive !== "function"`, and deps.places is the places.mjs
    // MODULE NAMESPACE — that function always exists, so the guard never fired. With no
    // PLACES_API_KEY the chain then charged its full 6 units, cut the real budget from 24 to
    // 18, and reported `available:true` for a source that made no call at all.
    //
    // `apiKey` unspecified (null/undefined) means the caller did not tell us — an injected
    // client knows its own configuration and is trusted. An EMPTY string is the server saying
    // "there is no key", which is exactly the case that must skip.
    const apiKey = deps.placesOpts?.apiKey ?? deps.config?.places?.apiKey ?? null;
    const configured = apiKey == null ? true : Boolean(String(apiKey).trim());
    if (!configured || typeof places?.resolveByPhoneLive !== "function") {
      return { result: null, error: null, available: false, skipped: "not_configured" };
    }
    if (budget && !budget.take(PLACES_CHAIN_COST)) {
      return { result: null, error: null, available: true, skipped: "upstream_budget_exhausted" };
    }
    try {
      const result = await places.resolveByPhoneLive(parsed.raw || parsed.national10, deps.placesOpts || {});
      return { result, error: null, available: true, skipped: null };
    } catch (error) {
      return { result: null, error: errorMessage(error), available: true, skipped: null };
    }
  })();

  // Both in flight at once: the DB answers in under a millisecond and the Places chain takes
  // ~2s, so serialising them would make every hit pay for the cross-check twice over.
  const [db, live] = await Promise.all([dbTask, placesTask]);

  const dbFirms = db.firms;
  const byCrd = new Map(dbFirms.map((firm) => [Number(firm.crd), firm]));
  const placesCrd = live.result?.crd ?? null;

  const dbStatus = formAdvStatus(db, dbFirms);

  const sources = {
    formAdv: {
      available: db.available,
      matched: dbFirms.length > 0,
      // THE TWO FIELDS THAT STOP A NON-ANSWER READING AS AN ANSWER. `consulted` says whether
      // the table was asked at all; `status` says what came back. Only "miss" is evidence —
      // everything else is an absence of evidence, and they must not be collapsed together.
      consulted: db.consulted,
      status: dbStatus,
      skipped: db.skipped ?? null,
      note: FORM_ADV_STATUS_NOTE[dbStatus],
      crds: dbFirms.map((firm) => Number(firm.crd)),
      queryMs: db.ms,
      error: db.error,
    },
    places: {
      available: live.available,
      skipped: live.skipped,
      // `found` is the Places business hit; `crd` is what survived IAPD cross-validation.
      businessFound: Boolean(live.result?.business),
      crd: placesCrd,
      firmName: live.result?.firmName ?? null,
      confidence: live.result?.confidence ?? null,
      matchedOn: live.result?.matchedOn ?? [],
      score: live.result?.score ?? null,
      maxScore: live.result?.maxScore ?? null,
      branchCount: live.result?.branchCount ?? null,
      reason: live.result?.reason ?? null,
      candidates: live.result?.candidates ?? [],
      error: live.error,
      // Google Maps Platform terms: of this block ONLY placeId may be persisted. The name,
      // address, phone and website are for live use in this response and nothing else.
      business: live.result?.business
        ? {
            placeId: live.result.business.placeId ?? null,
            name: live.result.business.name ?? null,
            formattedAddress: live.result.business.formattedAddress ?? null,
            phoneVerified: live.result.business.phoneVerified ?? null,
            persistable: ["placeId"],
          }
        : null,
    },
    roster: {
      from: "sec_iapd_live",
      // Precise, because the distinction is the whole point: people come from IAPD (through
      // a short read-through TTL cache of IAPD's OWN responses), and never from the
      // `advisers` table in our database — which is measurably incomplete and would have
      // told three of Nestlerode's four advisers that they are not registered.
      note: "Advisers come from SEC IAPD, through a short-lived read-through cache of IAPD's own responses. No adviser is ever served from a local adviser table.",
    },
  };

  // --- neither source produced a firm -------------------------------------------------
  if (dbFirms.length === 0 && placesCrd == null) {
    return { kind: "none", firms: [], sources, live };
  }

  // --- both produced something --------------------------------------------------------
  if (dbFirms.length > 0 && placesCrd != null) {
    const agreed = byCrd.get(Number(placesCrd));
    if (agreed) {
      return {
        kind: "one",
        firm: agreed,
        confidence: "high",
        matchedOn: ["form_adv", "places"],
        firms: [agreed],
        sources,
        live,
        notes:
          dbFirms.length > 1
            ? [`${dbFirms.length} advisory firms file that number on their Form ADV; the live business listing for the number identifies ${agreed.name || `CRD ${agreed.crd}`}, which resolves it.`]
            : [],
      };
    }

    // DISAGREEMENT. Both sources are credible and they name different firms. Return both.
    const placesFirm =
      (await firmRecordFor(placesCrd, deps, live)) ||
      fromIapdFirmDetail(null) ||
      { crd: Number(placesCrd), name: live.result?.firmName ?? null, recordSource: "iapd_live" };
    return {
      kind: "disagree",
      firms: [...dbFirms, placesFirm],
      sources,
      live,
      notes: [
        `Two live sources disagree about this number. The SEC Form ADV filing gives ${dbFirms.map((f) => f.name || `CRD ${f.crd}`).join(", ")}; the current business listing for the number resolves to ${placesFirm.name || `CRD ${placesFirm.crd}`}. A firm that recently moved, renamed or re-registered looks exactly like this, so we are not guessing which is yours.`,
      ],
    };
  }

  // --- Cloud SQL only -----------------------------------------------------------------
  if (dbFirms.length > 0) {
    if (dbFirms.length === 1) {
      return {
        kind: "one",
        firm: dbFirms[0],
        confidence: "medium",
        matchedOn: ["form_adv"],
        firms: dbFirms,
        sources,
        live,
        notes: [],
      };
    }
    return { kind: "ambiguous", firms: dbFirms, sources, live, notes: [] };
  }

  // --- Places only --------------------------------------------------------------------
  const firm = await firmRecordFor(placesCrd, deps, live);
  if (!firm) return { kind: "none", firms: [], sources, live };

  // A DATABASE THAT WAS SWITCHED OFF IS NOT A FAILED CORROBORATION.
  //
  // When the Form ADV table WAS consulted and did not have this number, "medium" is right:
  // one of our two sources looked and disagreed by silence. When it was never part of this
  // deployment there is no disagreement to report, and the live chain has already done a real
  // two-way cross-validation of its own — Google's business listing for the number against the
  // SEC's authoritative firm detail, agreeing on the NAME, clearing the high score threshold,
  // with no runner-up close enough to be ambiguous. That is places.mjs's `high`, which it will
  // not return on geography alone, on an unconfirmed search hit, or on a tie. Marking it down
  // to "medium" would penalise a supported standalone deployment for a source it does not have.
  // A source that was ASKED and failed (timeout/error) stays "medium": we expected a second
  // opinion and did not get one. A source that is not part of the deployment was never
  // expected, so there is nothing missing.
  const placesAlone = live.result || {};
  const crossValidated =
    placesAlone.confidence === "high" &&
    (placesAlone.matchedOn || []).includes("name") &&
    placesAlone.ambiguous !== true;
  const dbAbsent = dbStatus === FORM_ADV_STATUS.NOT_CONFIGURED || dbStatus === FORM_ADV_STATUS.NO_STORE;
  const confidence = dbAbsent && crossValidated ? "high" : "medium";

  const note = dbAbsent
    ? `${FORM_ADV_STATUS_NOTE[dbStatus]} The live business listing for that number was cross-validated against the SEC's own firm record${crossValidated ? ", agreeing on the firm's name and address with no close rival" : ""}.`
    : db.consulted
      ? "No Form ADV filing in our copy of the SEC firm feed lists that number, but the live business listing for it resolves to this firm on the SEC's own register. Confirm the firm before trusting the match."
      : `${FORM_ADV_STATUS_NOTE[dbStatus]} The firm below comes from the live business listing for the number, cross-validated against the SEC's own firm record.`;

  return {
    kind: "one",
    firm,
    confidence,
    matchedOn: ["places"],
    firms: [firm],
    sources,
    live,
    notes: [note],
  };
}

/** A firm record for a CRD that only Places produced: the Cloud SQL row if there is one
 *  (richer, and it carries the filed headcount the disclosure gate reads), otherwise live
 *  IAPD firm detail. Never throws. */
async function firmRecordFor(crd, deps, live) {
  const key = Number(crd);
  if (!Number.isFinite(key)) return null;

  if (typeof deps.store?.getFirm === "function") {
    try {
      const row = await deps.store.getFirm(key);
      if (row) return { ...row, branchCount: live?.result?.branchCount ?? null };
    } catch {
      // Fall through to the live record. A database miss must not cost us the answer.
    }
  }

  if (typeof deps.iapd?.getFirm === "function") {
    if (!deps.budget || deps.budget.take(1)) {
      try {
        const detail = await deps.iapd.getFirm(key, deps.iapdOpts?.firm || {});
        return fromIapdFirmDetail(detail, { branchCount: live?.result?.branchCount ?? null });
      } catch {
        // Nothing left to try.
      }
    }
  }

  return live?.result?.firmName
    ? { crd: key, name: live.result.firmName, recordSource: "iapd_live", branchCount: live.result.branchCount ?? null }
    : null;
}

// ---------------------------------------------------------------------------
// roster — LIVE from IAPD, every request, paged
// ---------------------------------------------------------------------------

/**
 * The advisers currently registered at a firm, live from IAPD.
 *
 * WHY THIS PAGES. The old code called listFirmIndividuals with no limit and no start, so it
 * saw at most one 100-row page and reported IAPD's raw match count as if it were a roster.
 * Measured: CRD 793 came back as "100 current advisers out of 5039" for a firm that files
 * 3,388 advisory staff. Both numbers were wrong in different ways — 100 was a page size, and
 * 5039 counts everyone who has EVER been registered there, including former employees.
 *
 * So: page up to `config.iapd.rosterMaxRows`, filter to current employees ourselves, and
 * report three separate honest numbers —
 *   currentAdviserCount            people currently at the firm, in the rows we fetched
 *   rosterMatchesIncludingFormer   IAPD's raw match count, former employees included
 *   rosterTruncated                true when we stopped before exhausting the matches
 * — so nobody downstream can mistake one for another.
 *
 * `currentOnly` is NOT passed to iapd.mjs: it filters after mapping, which would make a page
 * of mostly-former employees look like the end of the roster and stop paging early.
 */
async function fetchRoster(firmCrd, deps) {
  const pageSize = Math.max(1, Math.min(100, Number(deps.config?.iapd?.rosterPageSize) || 100));
  const maxRows = Math.max(pageSize, Number(deps.config?.iapd?.rosterMaxRows) || 300);
  const budget = deps.budget || null;

  const rows = [];
  let matches = 0;
  let pages = 0;
  let budgetExhausted = false;

  for (let start = 0; start < maxRows; start += pageSize) {
    if (budget && !budget.take(1)) {
      budgetExhausted = true;
      break;
    }
    const page = await deps.iapd.listFirmIndividuals(Number(firmCrd), {
      ...(deps.iapdOpts?.roster || {}),
      limit: Math.min(pageSize, maxRows - start),
      start,
    });
    pages += 1;
    matches = Number(page?.total) || matches;
    const batch = page?.individuals || [];
    rows.push(...batch);
    if (batch.length === 0) break;
    if (rows.length >= matches) break;
  }

  const current = rows.filter((individual) => individual && individual.isCurrentAtFirm !== false);
  return {
    individuals: current,
    currentAdviserCount: current.length,
    rosterMatchesIncludingFormer: matches,
    rosterFetched: rows.length,
    rosterTruncated: rows.length < matches,
    rosterPages: pages,
    budgetExhausted,
  };
}

// ---------------------------------------------------------------------------
// the main entry point
// ---------------------------------------------------------------------------

/** Weakest link wins. A `single_person` outcome under a firm match we only half-believe is
 *  not high confidence, and saying so is the difference between "this is you" and "this is
 *  probably your firm, and if so this is you". */
const CONFIDENCE_ORDER = { none: 0, low: 1, medium: 2, high: 3 };
const weakest = (a, b) => (CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b);

/**
 * Resolve a typed office phone number to a firm and the advisers who might be the caller.
 *
 * Every source is live (see the file header). The response carries `sources` — where each
 * fact came from — and `freshness` — how old the Form ADV mapping is — so an integrator can
 * audit the answer without asking us.
 *
 * @param {string} phone  raw, as the human typed it
 * @param {object} deps   { store, places, placesOpts, iapd, iapdOpts, config, budget,
 *                          cache, detail, limit }
 * @returns {Promise<object>} never rejects on an upstream failure
 */
export async function resolveByPhone(phone, deps = {}) {
  const attribution = deps.attribution || ATTRIBUTION;
  const parsed = normalizePhone(phone);
  const query = { raw: parsed.raw, national10: parsed.national10, valid: parsed.ok };
  const limit = limitOf(deps);
  const mode = modeOf(deps);

  // THE DUAL-IDENTITY PROJECTION, applied at every exit.
  //
  // `envelope` deliberately SHADOWS the module-level baseEnvelope for the rest of this
  // function, so all nine return sites pick up the claim shape without nine edits — and, more
  // to the point, so a tenth return site added later cannot forget it. `shape` is filled in as
  // the firm becomes known; before that it is all null and the projection emits firmClaim:null.
  const shape = { firm: null, live: null, liveError: null };
  const envelope = (fields) =>
    applyClaimShape(baseEnvelope(fields), { firm: shape.firm, mode, deps, live: shape.live, liveError: shape.liveError });

  // Read once, up front, so every branch below can report it. Never throws — the store
  // swallows its own errors here because freshness is metadata about an answer and must not
  // cost the caller the answer.
  const freshness = await readFreshness(deps);

  if (!parsed.ok) {
    return envelope({
      query,
      outcome: "invalid_phone",
      confidence: "none",
      // There is no "retype the phone" step in the contract's enum, and enter_name is the
      // route that actually gets this person onboarded, so we point at it — the explanation
      // still tells them to check the number first.
      nextStep: "enter_name",
      notes: [PHONE_REASON_TEXT[parsed.reason] || "That does not look like a US or Canadian phone number."],
      attribution,
      extra: {
        phoneReason: parsed.reason,
        extension: parsed.extension,
        // No upstream call was made, so there is nothing to attribute — and nothing was
        // consulted, which is a different fact from "consulted and found nothing".
        sources: {
          formAdv: {
            available: null,
            matched: false,
            consulted: false,
            status: FORM_ADV_STATUS.NOT_CONSULTED,
            skipped: "invalid_phone",
            note: FORM_ADV_STATUS_NOTE[FORM_ADV_STATUS.NOT_CONSULTED],
          },
          places: { available: null, skipped: "invalid_phone" },
          roster: null,
        },
        freshness,
      },
    });
  }

  const match = await matchFirm(parsed, deps);
  const sources = match.sources;

  if (match.kind === "none") {
    const reasons = [];
    if (sources.formAdv.error) reasons.push(`the SEC Form ADV firm table could not be read (${sources.formAdv.error})`);
    if (sources.places.error) reasons.push(`the live business lookup failed (${sources.places.error})`);
    if (sources.places.skipped === "not_configured") reasons.push("no live business lookup is configured on this deployment");
    const degraded = reasons.length
      ? ` We could not check every source: ${reasons.join("; ")}.`
      : "";
    // "We never consulted the Form ADV table" MUST NOT be published as "no SEC-registered
    // advisory firm files that number". The first clause of that sentence is a claim about our
    // copy of the SEC firm feed, and it is only sayable when that feed was actually read.
    const headline = formAdvIsEvidence(sources)
      ? "No SEC-registered advisory firm files that number as its main office line, and no business listing for it resolves to one."
      : `No business listing for that number resolves to an SEC-registered advisory firm. ${FORM_ADV_STATUS_NOTE[sources.formAdv.status]}`;
    return envelope({
      query,
      outcome: "no_match",
      confidence: "none",
      nextStep: "enter_name",
      notes: [
        `${headline} Advisers often reach us on a direct line or mobile that never appears on a Form ADV.${degraded}`,
      ],
      attribution,
      extra: { sources, freshness },
    });
  }

  if (match.kind === "ambiguous" || match.kind === "disagree") {
    // Naming people now would name people at firms that are not the claimant's, so the
    // pick-list is FIRMS ONLY — and toFirmSummary reduces Schedule A to a count, so it stays
    // firms-only however the caller renders it.
    const note =
      match.kind === "disagree"
        ? match.notes[0]
        : `${match.firms.length} advisory firms list that number on their Form ADV. Pick the firm first; we will list its advisers next.`;
    return envelope({
      query,
      outcome: "ambiguous_firm",
      confidence: "low",
      nextStep: "pick_firm",
      firms: match.firms.map((firm) => toFirmSummary(firm, deps)),
      notes: [note],
      attribution,
      extra: { sources, freshness, firmDisagreement: match.kind === "disagree" },
    });
  }

  const firm = match.firm;
  const firmSummary = toFirmSummary(firm, deps);
  const firmConfidence = match.confidence;
  const firmNotes = [...(match.notes || [])];
  if (match.matchedOn.length === 1 && match.matchedOn[0] === "form_adv") {
    firmNotes.push(
      freshness.lastIngestAt
        ? `Matched from the SEC Form ADV firm feed as of ${freshness.lastIngestAt.slice(0, 10)} (${freshness.ageDays} days old)${
            sources.places.available ? `; the live business listing did not corroborate it (${sources.places.reason || sources.places.skipped || "no business found"}).` : "."
          }`
        : "Matched from the SEC Form ADV firm feed, whose age we could not read.",
    );
  }

  shape.firm = firm;

  const thresholds = {
    single: deps.config?.lookup?.singlePersonMax ?? 1,
    few: deps.config?.lookup?.fewCandidatesMax ?? 5,
  };

  // FIRM ENRICHMENT — live IAPD firm detail, for registrations, notice filings and brochures.
  //
  // Started HERE, before the roster is awaited, so in mode=auto it overlaps the roster pages
  // instead of adding its own round trip to the wall clock. Skipped entirely in
  // mode=individual, where the caller has said it does not want the firm block enriched.
  // It never throws: a firm answer must not depend on an optional detail call.
  const wantFirmDetail = mode !== "individual" && typeof deps.iapd?.getFirm === "function";
  const firmDetailPromise = wantFirmDetail
    ? (async () => {
        if (deps.budget && !deps.budget.take(1)) return { live: null, error: "upstream call budget exhausted before firm detail could be read" };
        try {
          return { live: await deps.iapd.getFirm(Number(firm.crd), deps.iapdOpts?.firm || {}), error: null };
        } catch (error) {
          return { live: null, error: errorMessage(error) };
        }
      })()
    : Promise.resolve({ live: null, error: null });

  // THE mode=firm FAST PATH.
  //
  // The roster is never fetched, so no person is named — not from IAPD, and not from the
  // Schedule A fallback either, which is the one place a firm-shaped question could otherwise
  // have produced human names. This is the cheapest correct answer to "is this my firm?": one
  // cached firm-detail read against up to three roster pages plus per-person work.
  if (mode === "firm") {
    const detail = await firmDetailPromise;
    shape.live = detail.live;
    shape.liveError = detail.error;
    return envelope({
      query,
      outcome: "firm_only",
      confidence: firmConfidence,
      nextStep: "confirm_firm",
      firms: [firmSummary],
      candidates: [],
      notes: [
        `mode=firm: matched ${firm.name || "the firm"} that files this number. The SEC adviser roster was not consulted, so nobody is named here.`,
        ...firmNotes,
      ],
      attribution,
      extra: {
        currentAdviserCount: null,
        sources,
        freshness,
        firmMatch: firmMatchBlock(match),
      },
    });
  }

  // THE ROSTER IS ALWAYS LIVE. No local table is consulted for a person, ever.
  let roster = null;
  let rosterError = null;
  try {
    if (typeof deps.iapd?.listFirmIndividuals !== "function") throw new Error("IAPD client unavailable");
    roster = await fetchRoster(firm.crd, deps);
  } catch (error) {
    // Contract rule: NEVER throw on an IAPD failure. The firm is still a real, useful answer.
    rosterError = errorMessage(error);
  }

  const firmDetail = await firmDetailPromise;
  shape.live = firmDetail.live;
  shape.liveError = firmDetail.error;

  const schedulePersons = scheduleAOf(firm);

  if (rosterError) {
    const degraded = `Could not reach the SEC IAPD adviser roster (${rosterError}), so the people below come from the firm's Form ADV Schedule A and cannot be confirmed as currently registered.`;
    const fallback = scheduleAFallback(firm, deps, [degraded], limit);
    return envelope({
      query,
      outcome: "large_firm",
      confidence: "low",
      nextStep: "enter_name",
      firms: [firmSummary],
      candidates: fallback.candidates,
      notes: [`Matched the firm, but the live SEC adviser roster is unavailable: ${rosterError}`, ...firmNotes, ...(fallback.note ? [fallback.note] : [])],
      attribution,
      extra: { rosterError, sources, freshness, firmMatch: firmMatchBlock(match) },
    });
  }

  const individuals = roster.individuals;
  const currentCount = roster.currentAdviserCount;
  const pairs = pairScheduleA(individuals, schedulePersons);
  const rosterFacts = {
    currentAdviserCount: currentCount,
    rosterMatchesIncludingFormer: roster.rosterMatchesIncludingFormer,
    rosterMatchesNote:
      "rosterMatchesIncludingFormer is IAPD's raw match count for this firm and INCLUDES former employees. It is not a roster size.",
    rosterTruncated: roster.rosterTruncated,
    rosterPages: roster.rosterPages,
  };

  if (currentCount === 0) {
    // The firm is real and the roster call succeeded — the SEC's individual index simply
    // holds nobody for it. This is COMMON, not exotic: a solo SEC-registered adviser is
    // often absent from IAPD's individual search because the IAR registration lives at the
    // state level. Same bucket as a big firm: we have a firm and cannot narrow to a person,
    // so the claimant goes to the name step — but if the firm is small enough, its Schedule
    // A tells them who we think they are.
    const note = "The SEC's individual records list nobody currently registered at this firm.";
    const fallback = scheduleAFallback(firm, deps, [`${note} The name below is from the firm's own Form ADV Schedule A.`], limit);
    return envelope({
      query,
      outcome: "large_firm",
      confidence: "low",
      nextStep: "enter_name",
      firms: [firmSummary],
      candidates: fallback.candidates,
      notes: [note, ...firmNotes, ...(fallback.note ? [fallback.note] : [])],
      attribution,
      extra: { ...rosterFacts, sources, freshness, firmMatch: firmMatchBlock(match) },
    });
  }

  const soleAdviser = currentCount === 1;
  const scored = rankCandidates(
    individuals.map((individual, i) =>
      buildCandidate({
        individual,
        schedulePerson: pairs.get(i) || null,
        firm,
        soleAdviser,
        deps,
      }),
    ),
  );

  if (currentCount <= thresholds.single) {
    return envelope({
      query,
      outcome: "single_person",
      confidence: weakest("high", firmConfidence),
      nextStep: "confirm",
      firms: [firmSummary],
      candidates: scored.slice(0, limit),
      notes: ["Exactly one adviser is currently registered at the firm that filed this number. Confirm, then verify by one-time passcode to the number that was entered.", ...firmNotes],
      attribution,
      extra: { ...rosterFacts, sources, freshness, firmMatch: firmMatchBlock(match) },
    });
  }

  if (currentCount <= thresholds.few && !roster.rosterTruncated) {
    return envelope({
      query,
      outcome: "few_candidates",
      confidence: weakest("medium", firmConfidence),
      nextStep: "pick_person",
      firms: [firmSummary],
      candidates: scored.slice(0, limit),
      notes: [`${currentCount} advisers are currently registered at that firm — short enough for the claimant to pick their own row.`, ...firmNotes],
      attribution,
      extra: { ...rosterFacts, sources, freshness, firmMatch: firmMatchBlock(match) },
    });
  }

  // LARGE-FIRM DISCLOSURE.
  // A phone number at a firm this size narrows nothing — the claimant cannot pick themselves
  // out of a hundred names, which is exactly why nextStep is enter_name. So the only people
  // named here are the ones a SIGNAL points at: advisers who appear on the firm's own Form
  // ADV Schedule A as owners or executive officers. If no roster member matches Schedule A,
  // an arbitrary alphabetical slice of the roster would be pure disclosure with zero
  // disambiguation value, so we name nobody. That is what keeps a switchboard number for a
  // 10,000-adviser wirehouse from returning a list of ten strangers.
  const boosted = scored.filter((candidate) => candidate.score >= normalizeScore(SIGNALS.SCHEDULE_A));
  const notes = [
    `${roster.rosterTruncated ? `At least ${currentCount}` : currentCount} advisers are currently registered at that firm — too many for this number to identify anyone.`,
  ];
  if (boosted.length) {
    notes.push("Only advisers named on the firm's own Form ADV Schedule A are listed; everyone else at a firm this size is withheld because the phone number does not distinguish them.");
  } else {
    notes.push("No adviser is named individually: at a firm this size the office number identifies the firm, not a person. Ask for the adviser's name instead.");
  }
  notes.push(...firmNotes);

  return envelope({
    query,
    outcome: "large_firm",
    confidence: "low",
    nextStep: "enter_name",
    firms: [firmSummary],
    candidates: boosted.slice(0, limit),
    notes,
    attribution,
    extra: {
      ...rosterFacts,
      withheldForSize: currentCount - boosted.length,
      sources,
      freshness,
      firmMatch: firmMatchBlock(match),
    },
  });
}

/**
 * Everything /v1/claim/evaluate needs to score a claim at one firm: the firm's own filing, and
 * the LIVE roster of who is registered there.
 *
 * BOTH SIDES MATTER AND THEY COME FROM DIFFERENT PLACES. The Form ADV row (Cloud SQL) is the
 * only source of the firm's filed PHONE and WEBSITE — the two facts the evidence engine checks
 * an OTP and an email domain against — and the only source of Schedule A. The live IAPD roster
 * is the only source of who is currently registered. Neither can substitute for the other, and
 * a missing one is reported rather than defaulted: claim.mjs treats an absent website as "no
 * authoritative domain to match against" and refuses the signal, which is the correct answer,
 * where an empty string would have silently matched an unparseable email.
 *
 * Never throws. A source that will not answer becomes an error string in the result, because
 * the evidence engine's job is to say what is PROVEN, and "we could not read the roster" has to
 * reach the caller as a reason rather than as an empty roster that looks like a firm with no
 * advisers — which would make everyone at it a sole adviser by elimination.
 */
export async function loadClaimContext(firmCrd, deps = {}) {
  const crd = Number(firmCrd);
  const [filed, live, roster] = await Promise.all([
    typeof deps.store?.getFirm === "function"
      ? deps.store.getFirm(crd).catch((error) => ({ __error: errorMessage(error) }))
      : Promise.resolve(null),
    typeof deps.iapd?.getFirm === "function"
      ? deps.iapd.getFirm(crd, deps.iapdOpts?.firm || {}).catch((error) => ({ __error: errorMessage(error) }))
      : Promise.resolve(null),
    typeof deps.iapd?.listFirmIndividuals === "function"
      ? fetchRoster(crd, deps).catch((error) => ({ __error: errorMessage(error) }))
      : Promise.resolve({ __error: "IAPD client unavailable" }),
  ]);

  const filedError = filed?.__error ?? null;
  const liveError = live?.__error ?? null;
  const rosterError = roster?.__error ?? null;
  const filedFirm = filedError ? null : filed;
  const liveFirm = liveError ? null : live;

  const firm = filedFirm || liveFirm ? {
    crd,
    name: filedFirm?.name ?? liveFirm?.name ?? null,
    dba: filedFirm?.dba ?? null,
    secNumber: filedFirm?.secNumber ?? liveFirm?.secNumber ?? null,
    // Phone and website exist ONLY on the Form ADV row. The IAPD firm endpoint does not carry
    // either, so with the database switched off both are null and every evidence check that
    // depends on them declines rather than guessing.
    phone: filedFirm?.phone ?? null,
    phone10: filedFirm?.phone10 ?? null,
    website: filedFirm?.website ?? null,
    city: filedFirm?.city ?? liveFirm?.officeAddress?.city ?? null,
    state: filedFirm?.state ?? liveFirm?.officeAddress?.state ?? null,
    advisoryEmployees: filedFirm?.advisoryEmployees ?? null,
    effectiveAdviserCount: filedFirm?.effectiveAdviserCount ?? null,
    scheduleAPersons: Array.isArray(filedFirm?.scheduleAPersons) ? filedFirm.scheduleAPersons : null,
  } : null;

  return {
    firm,
    firmSummary: firm ? toFirmSummary(firm, deps) : null,
    roster: rosterError ? [] : (roster?.individuals || []).map((individual) => ({
      individualCrd: Number.isFinite(Number(individual?.crd)) ? Number(individual.crd) : null,
      name: individual?.name ?? null,
    })),
    currentAdviserCount: rosterError ? null : roster?.currentAdviserCount ?? null,
    rosterTruncated: rosterError ? null : roster?.rosterTruncated ?? null,
    sources: {
      formAdvDb: { present: Boolean(filedFirm), error: filedError, hasPhone: Boolean(filedFirm?.phone10), hasWebsite: Boolean(filedFirm?.website), hasScheduleA: Array.isArray(filedFirm?.scheduleAPersons) },
      iapdFirm: { present: Boolean(liveFirm), error: liveError },
      iapdRoster: { present: !rosterError, error: rosterError, live: true },
    },
    errors: [filedError, liveError, rosterError].filter(Boolean),
  };
}

/** The one-glance summary of HOW the firm was decided, next to the firm itself. */
function firmMatchBlock(match) {
  return {
    crd: match.firm ? Number(match.firm.crd) : null,
    confidence: match.confidence ?? "low",
    matchedOn: match.matchedOn ?? [],
    agreed: (match.matchedOn ?? []).length > 1,
  };
}

/** Form ADV mapping age. Never throws; an unreadable age is reported as unknown-and-stale,
 *  because "we cannot tell you how old this is" is not a reassurance. */
async function readFreshness(deps) {
  const unknown = {
    lastIngestAt: null,
    sourceFile: null,
    rowsUpserted: null,
    ageDays: null,
    stale: true,
    source: "cloud_sql:ria.ingest_runs(kind=firms, ok=true)",
  };
  if (typeof deps.store?.freshness !== "function") return { ...unknown, error: "no store configured" };
  try {
    const value = await deps.store.freshness();
    return { ...unknown, ...value };
  } catch (error) {
    return { ...unknown, error: errorMessage(error) };
  }
}


// ---------------------------------------------------------------------------
// name fallback
// ---------------------------------------------------------------------------

/**
 * Name search — the fallback when the phone number misses.
 *
 * Unlike resolveByPhone this DOES propagate an IAPD failure. IAPD is the only source here,
 * so a swallowed error would render as "no adviser by that name", which is a materially
 * wrong answer to give someone trying to find themselves. The server turns it into a 502.
 *
 * IT SPENDS THE REQUEST'S UPSTREAM BUDGET. It used to ignore it entirely: the server built an
 * UpstreamBudget for the route and handed it over, and nothing here ever called `.take()`, so
 * one profile fetch per row ran unbounded. Measured, `?name=smith&limit=50` made 51 requests
 * to the SEC against a configured ceiling of 24 — the caller chose `limit`, so the caller
 * chose our load on the SEC. Now the search itself costs one unit, hydration costs one per
 * row, and hydration is additionally bounded by config.lookup.maxProfileCallsPerRequest —
 * the same ceiling the phone path already respected. Running out DEGRADES the answer: the
 * row still appears in the pick-list, just without its firm, and says why.
 *
 * @returns {Promise<{candidates:object[], total:number, hydration:object, upstream:object|null}>}
 */
export async function searchByName(name, deps = {}) {
  const limit = limitOf(deps);
  const state = deps.state || null;
  const budget = deps.budget || null;
  /** @returns {boolean} true when the call may be made. No budget means no ceiling. */
  const spend = (n = 1) => !budget || budget.take(n);

  // The search IS the answer, so there is nothing to degrade to if it cannot be afforded.
  // status 429 rather than 502: the ceiling is ours, not the SEC's, and the caller can retry.
  if (!spend(1)) {
    const error = new Error(
      "This request's upstream call budget was exhausted before the SEC name search could run.",
    );
    error.status = 429;
    throw error;
  }

  const hits = await deps.iapd.searchIndividualsByName(name, {
    ...(deps.iapdOpts?.search || {}),
    state,
    limit,
  });
  const individuals = Array.isArray(hits) ? hits : hits?.individuals || [];

  // A name-search hit carries no firm, and "Sarah Chen" is unusable as a pick-list row
  // without one. Hydrating the profile is one cached call per row and turns the list into
  // something a human can actually choose from. It is best-effort: a row whose profile will
  // not load still appears, just without its firm.
  const rows = individuals.slice(0, limit);
  const maxProfiles = Math.max(0, Math.floor(Number(deps.config?.lookup?.maxProfileCallsPerRequest ?? limit)) || 0);
  let hydrated = 0;
  let hydrationCapped = false;
  await forEachLimited(rows, 5, async (row) => {
    if (typeof deps.iapd?.getIndividual !== "function" || !Number.isFinite(Number(row?.crd))) return;
    // Both ceilings are checked before the call, and the counter is incremented before the
    // await so concurrent workers cannot overshoot it.
    if (hydrated >= maxProfiles) {
      hydrationCapped = true;
      row.__profileSkipped = `Only ${maxProfiles} adviser profiles are loaded per request, so this row is listed without its firm.`;
      return;
    }
    if (!spend(1)) {
      hydrationCapped = true;
      row.__profileSkipped = "This request's upstream call budget was spent before this profile could be loaded, so this row is listed without its firm.";
      return;
    }
    hydrated += 1;
    try {
      row.__profile = await deps.iapd.getIndividual(Number(row.crd), deps.iapdOpts?.individual || {});
    } catch (error) {
      row.__profileError = errorMessage(error);
    }
  });

  // Firm records for the employers we just learned about, from the live Cloud SQL Form ADV
  // table. Best-effort and de-duplicated: a name search across a big firm would otherwise ask
  // for the same row once per row. A failure costs a candidate its firm-level signals, never
  // its place in the list.
  const firmCrds = [
    ...new Set(
      rows
        .map((row) => Number(row.__profile?.currentEmployments?.[0]?.firmCrd))
        .filter((crd) => Number.isFinite(crd) && crd > 0),
    ),
  ];
  const firmRecords = new Map();
  if (typeof deps.store?.getFirm === "function") {
    await forEachLimited(firmCrds, 5, async (crd) => {
      try {
        const record = await deps.store.getFirm(crd);
        if (record) firmRecords.set(crd, record);
      } catch {
        // Leave it absent: the candidate still renders, just without the firm's own filing.
      }
    });
  }

  const candidates = rows.map((row) => {
    const employment = row.__profile?.currentEmployments?.[0] || null;
    const firmCrd = employment ? Number(employment.firmCrd) : null;
    const indexedFirm = firmCrd ? firmRecords.get(firmCrd) || null : null;

    const reasons = [`Matched the name "${name}" in the SEC IAPD adviser directory`];
    if (state) reasons.push(`Registered in ${state}`);
    let raw = 0;

    let schedulePerson = null;
    if (indexedFirm) {
      const matches = scheduleAOf(indexedFirm).filter((person) => namesMatch(person?.name, row?.name));
      if (matches.length === 1) schedulePerson = matches[0];
    }
    if (schedulePerson) {
      raw += SIGNALS.SCHEDULE_A;
      reasons.push(`Named on ${indexedFirm.name}'s Form ADV Schedule A (direct owners and executive officers)`);
      const ownership = String(schedulePerson.ownershipCode || "").trim().toUpperCase();
      if (MAJOR_OWNERSHIP.has(ownership)) {
        raw += SIGNALS.MAJOR_OWNER;
        reasons.push(`Discloses ownership of ${OWNERSHIP_BAND[ownership]} of the firm (Schedule A code ${ownership})`);
      }
      if (schedulePerson.title && SENIOR_TITLE_RE.test(String(schedulePerson.title).toUpperCase())) {
        raw += SIGNALS.SENIOR_TITLE;
        reasons.push(`Holds a senior role at the firm: ${schedulePerson.title}`);
      }
    }
    if (row.hasDisclosures === false) {
      raw += SIGNALS.NO_DISCLOSURES;
      reasons.push("No disclosure events on the SEC record");
    }
    if (row.__profileError) reasons.push(`Could not load the full SEC profile (${row.__profileError}); firm not shown.`);
    if (row.__profileSkipped) reasons.push(row.__profileSkipped);

    const crd = Number.isFinite(Number(row?.crd)) ? Number(row.crd) : null;
    return {
      individualCrd: crd,
      name: row?.name || null,
      firmCrd: Number.isFinite(firmCrd) ? firmCrd : null,
      firmName: employment?.firmName || indexedFirm?.name || null,
      title: schedulePerson?.title || null,
      score: normalizeScore(raw),
      reasons,
      branchCity: row?.branchCity ?? null,
      branchState: row?.branchState ?? null,
      hasDisclosures: row?.hasDisclosures ?? null,
      profileUrl: crd == null ? null : `${siteBaseOf(deps)}/individual/summary/${crd}`,
    };
  });

  return {
    candidates: rankCandidates(candidates),
    total: Array.isArray(hits) ? hits.length : hits?.total ?? candidates.length,
    // What this request actually spent, so an integrator can see a truncated answer for what
    // it is instead of reading it as "the SEC knows less about this person".
    hydration: { requested: rows.length, hydrated, capped: hydrationCapped, max: maxProfiles },
    upstream: budget ? budget.status : null,
  };
}

async function forEachLimited(items, limit, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

// ---------------------------------------------------------------------------
// explanation
// ---------------------------------------------------------------------------

const firmLabel = (result) => result?.firms?.[0]?.name || "that firm";

/**
 * One plain-English sentence for the UI to render above the pick-list.
 *
 * MUST NOT THROW: the server calls this while building the meta frame, after writeHead, so
 * a throw here costs the caller the entire response. Every path returns a string, and an
 * unknown outcome falls back rather than blowing up.
 */
export function explain(result) {
  try {
    const outcome = result?.outcome;
    const firms = result?.firms || [];
    const candidates = result?.candidates || [];
    const typed = result?.query?.national10 ? formatNational10(result.query.national10) : null;

    if (outcome === "invalid_phone") {
      const why = result?.notes?.[0] || "That does not look like a US or Canadian phone number.";
      return `${why} Check the number, or search by name instead.`;
    }

    if (outcome === "no_match") {
      // Only claim the Form ADV feed says nothing if the Form ADV feed was actually read.
      if (!formAdvIsEvidence(result?.sources)) {
        return `No live business listing for ${typed || "that number"} resolves to an SEC-registered advisory firm — tell us your name and we will find your registration instead.`;
      }
      return `No SEC-registered advisory firm lists ${typed || "that number"} on its Form ADV, and no live business listing for it resolves to one — tell us your name and we will find your registration instead.`;
    }

    if (outcome === "ambiguous_firm") {
      const shown = firms.slice(0, 3).map((f) => f.name).filter(Boolean).join(", ");
      const more = firms.length > 3 ? `, and ${firms.length - 3} more` : "";
      if (result?.firmDisagreement) {
        // Two live sources, two different firms. Saying "N firms list that number" here would
        // be false — only one of them filed it — so the disagreement gets its own sentence.
        return `The SEC's Form ADV filing and the current business listing for ${typed || "that number"} point at different firms${shown ? ` — ${shown}${more}` : ""} — which one is yours?`;
      }
      return `${firms.length} advisory firms list ${typed || "that number"}${shown ? ` — ${shown}${more}` : ""} — which one is yours?`;
    }

    if (outcome === "firm_only") {
      // Caught by a live run, not by a test: mode=firm produced an outcome explain() had never
      // heard of, so it fell through to "we could not narrow that number down to one adviser —
      // tell us your name instead". That is exactly wrong for this path. We narrowed the number
      // down perfectly; the caller asked us not to look at people. Telling them to type their
      // name would send a front-end that only ever wanted to confirm a firm down a person flow.
      return `${typed || "That number"} is the main line for ${firmLabel(result)} — is that your firm?`;
    }

    if (outcome === "single_person") {
      const person = candidates[0]?.name;
      return person
        ? `That number is the main line for ${firmLabel(result)}, where ${person} is the only adviser the SEC currently lists — is that you?`
        : `That number is the main line for ${firmLabel(result)}, where the SEC currently lists one adviser — is that you?`;
    }

    if (outcome === "few_candidates") {
      const n = result?.currentAdviserCount || candidates.length;
      return `That number is the main line for ${firmLabel(result)} — is one of these ${n} advisers you?`;
    }

    if (outcome === "large_firm") {
      const n = result?.currentAdviserCount;
      if (result?.rosterError) {
        return `That number is the main line for ${firmLabel(result)}, but the SEC's adviser roster is not responding right now — tell us your name and we will find you.`;
      }
      if (n === 0) {
        return `That number is the main line for ${firmLabel(result)}, but the SEC lists no advisers currently registered there — tell us your name so we can find your registration.`;
      }
      const count = n ? (result?.rosterTruncated ? `at least ${n} ` : `${n} `) : "too many ";
      return `That number is a main line for ${firmLabel(result)}, where the SEC lists ${count}advisers — too many to tell you apart by phone number alone, so tell us your name.`;
    }

    return "We could not narrow that number down to one adviser — tell us your name instead.";
  } catch {
    // A cosmetic sentence must never cost the caller their data.
    return "We could not narrow that number down to one adviser — tell us your name instead.";
  }
}
