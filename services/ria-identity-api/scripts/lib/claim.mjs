// THE CLAIM-EVIDENCE ENGINE — what a piece of proof actually PROVES, and what is still missing.
//
// THE PROBLEM THIS FILE EXISTS FOR. One phone number legitimately belongs to a firm AND to
// every adviser registered there. 425-296-1611 is ROBINSWOOD FINANCIAL LLC's main line and it
// is also the working number of all seven advisers at Robinswood. So when a one-time passcode
// sent to that number comes back correct, the ONLY thing it has proved is that the claimant can
// answer that firm's phone. It has not proved WHICH of the seven they are, and it has not
// proved they may act for the entity.
//
// Every mistake in this area is the same mistake: treating AFFILIATION as IDENTITY. This module
// makes that mistake un-writable by giving each signal an explicit `proves` class and refusing
// to let one class satisfy a requirement in another.
//
//   firm_affiliation  the claimant is connected to this firm
//   identity          the claimant is this specific registered person
//   authority         the claimant may act for the legal entity
//   intent            what the claimant SAYS they are. Proves nothing. Recorded anyway.
//
// ASSERTED vs DERIVED — the second structural rule.
//
// This service does not send passcodes or emails; it cannot see an SMS or a mailbox. So the
// integrator's server-side BFF ATTESTS what it verified, and this module DERIVES what that
// attestation is worth. The split matters because it bounds forgery:
//
//   ASSERTED (only the BFF can know)   phone_otp, domain_email, oidc_verified_name,
//                                      roster_selection
//   DERIVED  (computed here, from SEC  sole_adviser, email_name_match, oidc_name_match,
//             data this service holds) adv_officer, on_live_roster
//
// A forged assertion is therefore narrow — "I verified this email address" — and never a
// forged CONCLUSION. An integrator cannot assert `sole_adviser` and be believed: whether a firm
// has exactly one currently registered adviser is a fact about the SEC's live roster, and we
// read the roster. Asserting a derived signal is recorded in the ledger as REJECTED, with the
// reason, rather than silently ignored — a BFF sending it is a bug someone needs to see.
//
// THE ONE RULE THAT IS NOT IN THE SPEC SENTENCE, AND WHY IT IS HERE.
//
// The stated firm threshold is `phone_otp AND (adv_officer OR (domain_email AND the claimant is
// on the live roster))`. Both of those inner sub-signals ask a question about THE CLAIMANT —
// "is the claimant an officer", "is the claimant on the roster" — so both need a name for the
// claimant. The only name available for free is the one they tapped, and the spec is explicit
// that `roster_selection` is INTENT ONLY and never identity evidence. Deriving `adv_officer`
// from a tap would launder that intent straight into authority: anyone who can answer the firm's
// phone taps the CEO's row and takes the entity. So both sub-signals require an IDENTITY-BOUND
// name — one that came from a channel that binds identity (a verified email whose local part
// matches, a verified OIDC name, or elimination at a one-adviser firm). This is a consequence of
// the spec's own rule about roster_selection, not a departure from it, and `identityBound` in
// the ledger says which channel supplied the name.
//
// NEVER LET ONE CLAIM GRANT THE OTHER. A result is scoped to exactly one claimType and one
// target. `grants` is emitted explicitly with at most one true field, so an integrator reading
// `allowed:true` off an individual evaluation cannot mistake it for entity authority.

import { namesMatch, parseName } from "./resolve.mjs";
import { stripHonorifics, matchPersonName } from "./vertex.mjs";

export class ClaimError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "ClaimError";
    this.field = field;
  }
}

export const CLAIM_TYPES = Object.freeze(["individual", "firm"]);

/** What each signal proves. The whole point of the module is that these are not interchangeable. */
export const PROVES = Object.freeze({
  FIRM_AFFILIATION: "firm_affiliation",
  IDENTITY: "identity",
  AUTHORITY: "authority",
  INTENT: "intent",
});

/** Every signal, what it proves, and whether a caller may assert it.
 *
 *  `assertable:false` is the anti-forgery line: those five are computed here from the SEC's own
 *  live records and a caller claiming one is telling us something it cannot know. */
export const SIGNALS = Object.freeze({
  phone_otp: Object.freeze({
    proves: PROVES.FIRM_AFFILIATION,
    assertable: true,
    label: "one-time passcode answered on the firm's Form ADV phone number",
    note: "Proves the claimant can answer THAT FIRM'S phone. It does not distinguish one adviser there from another.",
  }),
  domain_email: Object.freeze({
    proves: PROVES.FIRM_AFFILIATION,
    assertable: true,
    label: "email verified at the domain the firm filed on its Form ADV",
    note: "An independent affiliation channel. The domain must come from the firm's own filing, never from the claimant.",
  }),
  sole_adviser: Object.freeze({
    proves: PROVES.IDENTITY,
    assertable: false,
    label: "the only adviser the SEC currently lists at this firm",
    note: "Identity by elimination: affiliation plus exactly one registered person there is that person.",
  }),
  email_name_match: Object.freeze({
    proves: PROVES.IDENTITY,
    assertable: false,
    label: "the verified email's local part matches this adviser's name, and no other adviser's",
    note: "Derived from an accepted domain_email. A local part that fits two advisers binds neither.",
  }),
  oidc_name_match: Object.freeze({
    proves: PROVES.IDENTITY,
    assertable: false,
    label: "a third-party verified name matches this adviser's name, and no other adviser's",
    note: "Derived from an oidc_verified_name attestation. The issuer verified the name; we match it.",
  }),
  adv_officer: Object.freeze({
    proves: PROVES.AUTHORITY,
    assertable: false,
    label: "named on the firm's own Form ADV Schedule A as a direct owner or executive officer",
    note: "Derived by matching an IDENTITY-BOUND name against Schedule A. A tapped name is not enough.",
  }),
  on_live_roster: Object.freeze({
    proves: PROVES.FIRM_AFFILIATION,
    assertable: false,
    label: "this identity-bound person is on the firm's live SEC roster",
    note: "Derived. Requires an identity-bound name for the same reason adv_officer does.",
  }),
  roster_selection: Object.freeze({
    proves: PROVES.INTENT,
    assertable: true,
    label: "the claimant tapped their own row",
    note: "INTENT ONLY. Never identity evidence, in any combination, in either claim type.",
  }),
});

/** Asserted evidence types a BFF may send, and the field each one must carry to be useful. */
export const EVIDENCE_TYPES = Object.freeze({
  phone_otp: "phone (optional; checked against the firm's filed number when present)",
  domain_email: "email (required — the verified address)",
  oidc_verified_name: "name (required — the name the OIDC issuer verified)",
  roster_selection: "individualCrd (optional; defaults to selectedIndividualCrd)",
});

/** Friction of a next step, cheapest first. Ordering is data, not prose, so cheapestNextStep
 *  cannot drift from the labels the UI renders. */
const FRICTION_ORDER = Object.freeze({ none: 0, low: 1, medium: 2 });

const NOTICE =
  "Evidence must be asserted by the integrator's own server-side backend, from checks it performed itself. This service does not send passcodes or emails and cannot observe them. A browser must never be able to reach this endpoint with evidence of its own: a fabricated assertion defeats the entire model, and no threshold here can detect one.";

// ---------------------------------------------------------------------------
// small pure helpers, exported because each one encodes a measured gotcha
// ---------------------------------------------------------------------------

const digitsOf = (value) => String(value ?? "").replace(/\D+/g, "");

/** Last ten digits, so "+1 425 296 1611" and "(425) 296-1611" compare equal. */
export function national10(value) {
  const digits = digitsOf(value);
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits.length > 10 ? digits.slice(-10) : null;
}

/**
 * Do two phone numbers refer to the same line, tolerating ONE adjacent digit transposition?
 *
 * MEASURED, not hypothetical. ROBINSWOOD FINANCIAL LLC's own Form ADV filing carries its phone
 * as 452-296-1611. The real number — the one the claimant types, the one that resolves the firm,
 * the one an OTP is delivered to — is 425-296-1611. The filer swapped two digits and nobody at
 * the SEC corrects typing. A strict equality check would reject a correct passcode delivered to
 * the right human because a filing has a typo in it.
 *
 * ONE adjacent swap only. That is a typo. Two swaps, or a swap plus a substitution, is a
 * different phone number, and widening this to a general edit distance would start accepting the
 * office next door — 425-296-1612 is one substitution away and belongs to someone else.
 */
export function phonesEquivalent(a, b) {
  const left = national10(a);
  const right = national10(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length !== right.length) return false;

  const diff = [];
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) diff.push(i);
    if (diff.length > 2) return false;
  }
  if (diff.length !== 2) return false;
  const [i, j] = diff;
  if (j !== i + 1) return false; // adjacent only
  return left[i] === right[j] && left[j] === right[i];
}

/** The registrable domain of a URL or bare host, lowercased, `www.` dropped. Returns null for
 *  anything that is not a host — an empty website field must never become a domain that
 *  matches an empty email domain. */
export function domainOf(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host = raw;
  const scheme = host.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) host = host.slice(scheme[0].length);
  host = host.split("/")[0].split("?")[0].split("#")[0];
  host = host.split("@").pop(); // tolerate a userinfo prefix
  host = host.split(":")[0];
  if (host.startsWith("www.")) host = host.slice(4);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  return host;
}

/** The domain half of an email address. */
export function emailDomain(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  return domainOf(raw.slice(at + 1));
}

const emailLocalPart = (value) => {
  const raw = String(value ?? "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  return at > 0 ? raw.slice(0, at) : null;
};

const alnum = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Could this email local part have been minted from this person's name?
 *
 * Generated forwards (name -> the local parts a firm plausibly issues) rather than parsed
 * backwards, because parsing "rmacrae" without a candidate name is guesswork and guesswork is
 * how you bind the wrong human to a profile.
 *
 * A BARE FIRST NAME IS DELIBERATELY INCLUDED and is exactly why the caller must check
 * uniqueness across the whole roster: `robert@` fits Robert Guild and Robert MacRae equally, and
 * a signal that fits two people binds neither. `emailNameCandidates` answers "could this be
 * them"; only `evaluateClaim` may conclude "this is them", and only when the answer is yes for
 * precisely one adviser.
 */
export function emailNameCandidates(name) {
  const parsed = parseName(stripHonorifics(name));
  const first = alnum(parsed.first);
  const last = alnum(parsed.last);
  const middles = (parsed.middles || []).map(alnum).filter(Boolean);
  if (!first && !last) return [];

  const forms = new Set();
  const add = (value) => {
    const v = alnum(value);
    if (v.length >= 2) forms.add(v);
  };

  if (first && last) {
    add(first + last);
    add(last + first);
    add(first[0] + last); // rmacrae
    add(first + last[0]);
    add(last + first[0]);
    add(last[0] + first);
    for (const middle of middles) {
      add(first + middle[0] + last);
      add(first[0] + middle[0] + last);
    }
  }
  add(first);
  add(last);
  return [...forms];
}

/** Does `email`'s local part fit `name`? Punctuation-insensitive: "r.macrae", "r_macrae" and
 *  "rmacrae" are one form, and a "+tag" suffix (a real, routable Gmail-style alias) is stripped
 *  before comparison rather than being allowed to defeat the match. */
export function emailLocalPartMatches(email, name) {
  const local = emailLocalPart(email);
  if (!local) return false;
  const stripped = alnum(local.split("+")[0]);
  if (stripped.length < 2) return false;
  return emailNameCandidates(name).includes(stripped);
}

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

const rosterEntry = (row, i) => ({
  index: i,
  individualCrd: Number.isFinite(Number(row?.individualCrd ?? row?.crd)) ? Number(row.individualCrd ?? row.crd) : null,
  name: row?.name ?? null,
});

/** Accept a bare string ("phone_otp") as well as the documented object, so the simplest possible
 *  integration works, and reject anything else loudly rather than counting it as nothing. */
function normalizeEvidence(raw, i) {
  if (typeof raw === "string") return { type: raw.trim().toLowerCase(), _pos: i };
  if (!raw || typeof raw !== "object") {
    throw new ClaimError(`evidence[${i}] must be a string or an object with a "type".`, "evidence");
  }
  const type = String(raw.type ?? raw.signal ?? "").trim().toLowerCase();
  if (!type) throw new ClaimError(`evidence[${i}] has no "type".`, "evidence");
  return { ...raw, type, _pos: i };
}

// ---------------------------------------------------------------------------
// the engine
// ---------------------------------------------------------------------------

/**
 * Score the evidence a claim is standing on.
 *
 * @param {object}   input
 * @param {"individual"|"firm"} input.claimType   which target is being claimed. Scoped: a result
 *                                                for one NEVER authorises the other.
 * @param {object|null} input.firm                the resolved firm summary (phone, website,
 *                                                scheduleAPersons). Its Form ADV fields are the
 *                                                only source of the phone and domain we trust.
 * @param {Array}    input.roster                 the LIVE current roster, [{individualCrd,name}].
 * @param {number|null} input.selectedIndividualCrd  who the claimant says they are.
 * @param {Array}    input.evidence               attestations from the integrator's BFF.
 * @returns {{allowed:boolean, satisfied:string[], missing:string[],
 *            cheapestNextStep:{action,reason,friction}|null, explanation:string,
 *            evidenceLedger:object[], grants:object, notice:string}}
 */
export async function evaluateClaim({
  claimType,
  firm = null,
  roster = [],
  selectedIndividualCrd = null,
  evidence = [],
} = {}, deps = {}) {
  // The name matcher used for oidc_name_match. Defaults to vertex.mjs's matchPersonName, which
  // is deterministic-first (namesMatch decides, and no model is called at all when it can),
  // refuses to break a two-way ambiguity, and — on ZERO deterministic hits — may consult Gemini
  // behind an orthographic guard that narrows the roster to at most one plausible entry before
  // the model ever sees it. It returns an INDEX into the roster we hand it, never a name, so it
  // cannot invent an adviser. Injectable so tests can run it deterministically.
  const matchName = typeof deps.matchPersonName === "function" ? deps.matchPersonName : matchPersonName;
  const type = String(claimType ?? "").trim().toLowerCase();
  if (!CLAIM_TYPES.includes(type)) {
    throw new ClaimError(`claimType must be one of: ${CLAIM_TYPES.join(", ")}.`, "claimType");
  }
  if (!Array.isArray(evidence)) throw new ClaimError("evidence must be an array.", "evidence");
  if (evidence.length > 32) throw new ClaimError("evidence must contain 32 items or fewer.", "evidence");

  const people = (Array.isArray(roster) ? roster : []).map(rosterEntry);
  // Number(null) and Number("") are both 0, and Number.isFinite(0) is true — so a plain
  // isFinite check silently turns "the claimant has not picked anyone yet" into "the claimant
  // named CRD 0". That fabricates a roster_selection line in the permanent evidence ledger and
  // makes every not-yet-selected branch unreachable. Absence must stay null.
  const rawSelected =
    selectedIndividualCrd === null || selectedIndividualCrd === undefined || selectedIndividualCrd === ""
      ? null
      : Number(selectedIndividualCrd);
  const selectedCrd = rawSelected != null && Number.isFinite(rawSelected) && rawSelected > 0 ? rawSelected : null;
  const selected = selectedCrd == null ? null : people.find((p) => p.individualCrd === selectedCrd) || null;
  // A CRD that is not on the live roster is not a claimable identity here. Saying so is the
  // difference between "we could not verify you" and "the person you named is not registered at
  // the firm whose phone you answered".
  const selectedOffRoster = selectedCrd != null && !selected;

  const ledger = [];
  const record = (row) => {
    ledger.push({
      signal: row.signal,
      source: row.source, // "asserted" | "derived"
      accepted: row.accepted,
      proves: row.accepted ? SIGNALS[row.signal]?.proves ?? null : null,
      detail: row.detail,
      ...(row.assertedBy ? { assertedBy: String(row.assertedBy).slice(0, 120) } : {}),
      ...(row.verifiedAt ? { verifiedAt: String(row.verifiedAt).slice(0, 40) } : {}),
      ...(row.identityBound ? { identityBound: row.identityBound } : {}),
      ...(row.corroborated === undefined ? {} : { corroborated: row.corroborated }),
      ...(row.rejectionCode ? { rejectionCode: row.rejectionCode } : {}),
    });
    return row.accepted;
  };

  // -------------------------------------------------------------------------
  // 1. asserted evidence
  // -------------------------------------------------------------------------
  const items = evidence.map(normalizeEvidence);
  const asserted = { phone_otp: false, domain_email: null, oidc_name: null, roster_selection: false };

  for (const item of items) {
    const known = SIGNALS[item.type];

    // A derived signal asserted by the caller. Recorded as rejected, never as absent: a BFF
    // sending `sole_adviser` believes it is helping, and needs to find out that it is not.
    if (known && known.assertable === false) {
      record({
        signal: item.type,
        source: "asserted",
        accepted: false,
        rejectionCode: "derived_only",
        detail: `${item.type} cannot be asserted. It is derived here from the SEC's own live records; an assertion of it carries no weight and was ignored.`,
        assertedBy: item.assertedBy,
      });
      continue;
    }

    switch (item.type) {
      case "phone_otp": {
        // The number matters. A passcode answered on some other line proves affiliation with
        // some other line. When the caller does not say which number, we take the flow at its
        // word — the lookup that produced this firm was keyed on its phone — and label it.
        const claimedPhone = item.phone ?? item.number ?? null;
        const filed = firm?.phone10 ?? firm?.phone ?? null;
        if (claimedPhone && filed && !phonesEquivalent(claimedPhone, filed)) {
          record({
            signal: "phone_otp",
            source: "asserted",
            accepted: false,
            rejectionCode: "phone_not_the_firms",
            detail: `The passcode was answered on ${national10(claimedPhone) || "an unreadable number"}, which is not the number ${firm?.name || "this firm"} filed on its Form ADV. It proves control of that other line, not affiliation with this firm.`,
            assertedBy: item.assertedBy,
            verifiedAt: item.verifiedAt,
          });
          break;
        }
        const transposed = claimedPhone && filed && national10(claimedPhone) !== national10(filed);
        asserted.phone_otp = true;
        // WHETHER WE ACTUALLY CHECKED. Found live, not by a test: when Cloud SQL was slow the
        // Form ADV row came back empty, so `filed` was null, and the acceptance message still
        // read "the number ROBINSWOOD FINANCIAL filed on its Form ADV" — asserting a
        // corroboration that had not happened, in the permanent record an adjudicator reads
        // when someone disputes the claim. The signal is still ACCEPTED (refusing every claim
        // whenever an optional database is slow would be a worse failure), but the ledger now
        // says plainly that nothing was compared.
        const corroborated = Boolean(claimedPhone && filed);
        record({
          signal: "phone_otp",
          source: "asserted",
          accepted: true,
          detail: !filed
            ? `Passcode answered${claimedPhone ? ` on ${national10(claimedPhone)}` : ""}. NOT CORROBORATED: the firm's own Form ADV phone number could not be read on this request, so nothing was compared against it. Treat this as an integrator assertion alone.`
            : transposed
              ? `Passcode answered on ${national10(claimedPhone)}, which differs from the filed ${national10(filed)} by one transposed digit — a filing typo, treated as the same line.`
              : claimedPhone
                ? `Passcode answered on ${national10(claimedPhone)}, the number ${firm?.name || "the firm"} filed on its Form ADV.`
                : `Passcode answered on the number that resolved this firm. The integrator did not restate it, so it was not compared against the filed ${national10(filed)}.`,
          corroborated,
          assertedBy: item.assertedBy,
          verifiedAt: item.verifiedAt,
        });
        break;
      }

      case "domain_email": {
        const email = String(item.email ?? item.address ?? "").trim();
        const at = emailDomain(email);
        // THE FILED DOMAIN, NEVER A SUPPLIED ONE. If the firm's Form ADV carries no website
        // there is nothing to check against, and accepting the claimant's own domain would let
        // them nominate the authority that vouches for them.
        const filedDomain = domainOf(firm?.website);
        if (!at) {
          record({
            signal: "domain_email",
            source: "asserted",
            accepted: false,
            rejectionCode: "no_email",
            detail: "domain_email carried no readable email address, so there is no domain to compare against the firm's filing.",
            assertedBy: item.assertedBy,
          });
          break;
        }
        if (!filedDomain) {
          record({
            signal: "domain_email",
            source: "asserted",
            accepted: false,
            rejectionCode: "firm_filed_no_website",
            detail: `${firm?.name || "This firm"} files no website on its Form ADV, so there is no authoritative domain to match ${at} against. A domain supplied by the claimant is not evidence about the claimant.`,
            assertedBy: item.assertedBy,
          });
          break;
        }
        if (at !== filedDomain) {
          record({
            signal: "domain_email",
            source: "asserted",
            accepted: false,
            rejectionCode: "domain_mismatch",
            detail: `${at} is not ${filedDomain}, the domain ${firm?.name || "the firm"} filed on its Form ADV.`,
            assertedBy: item.assertedBy,
          });
          break;
        }
        asserted.domain_email = { email, domain: at };
        record({
          signal: "domain_email",
          source: "asserted",
          accepted: true,
          detail: `Email verified at ${at}, the domain ${firm?.name || "the firm"} filed on its Form ADV.`,
          assertedBy: item.assertedBy,
          verifiedAt: item.verifiedAt,
        });
        break;
      }

      case "oidc_verified_name":
      case "oidc": {
        const name = String(item.name ?? item.verifiedName ?? "").trim();
        if (!name) {
          record({
            signal: "oidc_name_match",
            source: "asserted",
            accepted: false,
            rejectionCode: "no_verified_name",
            detail: "An OIDC attestation with no verified name proves nothing we can match. Send the name the issuer verified.",
            assertedBy: item.assertedBy,
          });
          break;
        }
        asserted.oidc_name = { name, issuer: item.issuer ?? null };
        record({
          signal: "oidc_verified_name",
          source: "asserted",
          accepted: true,
          detail: `${item.issuer ? String(item.issuer).slice(0, 60) : "A third-party issuer"} verified the name "${name}". Whether it identifies an adviser at this firm is derived below.`,
          assertedBy: item.assertedBy,
          verifiedAt: item.verifiedAt,
        });
        break;
      }

      case "roster_selection": {
        asserted.roster_selection = true;
        record({
          signal: "roster_selection",
          source: "asserted",
          accepted: true,
          detail:
            "The claimant tapped a row. This is INTENT — it tells us which profile to test the evidence against, and it is never itself evidence of identity.",
          assertedBy: item.assertedBy,
        });
        break;
      }

      default:
        record({
          signal: item.type,
          source: "asserted",
          accepted: false,
          rejectionCode: "unknown_signal",
          detail: `Unrecognised evidence type "${item.type}". Known asserted types: ${Object.keys(EVIDENCE_TYPES).join(", ")}.`,
          assertedBy: item.assertedBy,
        });
    }
  }

  // A selection made by passing selectedIndividualCrd rather than by sending a roster_selection
  // item is still a selection, and the ledger has to show it — an adjudicator reading this
  // record later needs to see WHICH profile the evidence was tested against, and that the
  // choice itself carried no weight.
  if (selectedCrd != null && !asserted.roster_selection) {
    record({
      signal: "roster_selection",
      source: "asserted",
      accepted: true,
      detail: selectedOffRoster
        ? `The claimant named CRD ${selectedCrd}, who is not on this firm's live roster. Recorded as intent; it proves nothing either way.`
        : `The claimant named CRD ${selectedCrd}${selected?.name ? ` (${selected.name})` : ""} via selectedIndividualCrd. INTENT — it decides which profile the evidence is tested against, and is never itself evidence of identity.`,
    });
  }

  // -------------------------------------------------------------------------
  // 2. derived identity
  // -------------------------------------------------------------------------

  /** Match a name against the roster and demand a UNIQUE hit. Two hits bind nobody — the same
   *  discipline pairScheduleA uses, and for the same reason: ambiguity must cost the score, not
   *  the person. */
  const uniqueRosterMatch = (name) => {
    const hits = people.filter((p) => namesMatch(stripHonorifics(name), stripHonorifics(p.name)));
    return hits.length === 1 ? hits[0] : null;
  };

  const derived = { sole_adviser: false, email_name_match: false, oidc_name_match: false };
  /** Which channel bound a name to a human, if any. Read by the firm arm. */
  let identityBound = null;

  // sole_adviser — identity by elimination, the zero-friction path.
  if (people.length === 1) {
    const only = people[0];
    const claimsSomeoneElse = selectedCrd != null && only.individualCrd !== selectedCrd;
    if (claimsSomeoneElse) {
      record({
        signal: "sole_adviser",
        source: "derived",
        accepted: false,
        rejectionCode: "selection_is_not_the_sole_adviser",
        detail: `The SEC lists exactly one adviser at ${firm?.name || "this firm"} (CRD ${only.individualCrd}), and it is not CRD ${selectedCrd}. Elimination cannot reach a person who is not on the roster.`,
      });
    } else {
      derived.sole_adviser = true;
      identityBound = { via: "sole_adviser", name: only.name, individualCrd: only.individualCrd };
      record({
        signal: "sole_adviser",
        source: "derived",
        accepted: true,
        detail: `${only.name || `CRD ${only.individualCrd}`} is the only adviser the SEC currently lists at ${firm?.name || "this firm"}, so affiliation with the firm identifies the person by elimination.`,
      });
    }
  }

  // email_name_match — derived from an ACCEPTED domain_email only.
  if (asserted.domain_email) {
    const hits = people.filter((p) => emailLocalPartMatches(asserted.domain_email.email, p.name));
    const local = emailLocalPart(asserted.domain_email.email);
    if (hits.length === 1 && (selectedCrd == null || hits[0].individualCrd === selectedCrd)) {
      derived.email_name_match = true;
      identityBound = identityBound || { via: "email_name_match", name: hits[0].name, individualCrd: hits[0].individualCrd };
      record({
        signal: "email_name_match",
        source: "derived",
        accepted: true,
        detail: `The verified local part "${local}" fits ${hits[0].name} and no other adviser on the live roster.`,
        identityBound: "email_name_match",
      });
    } else if (hits.length > 1) {
      record({
        signal: "email_name_match",
        source: "derived",
        accepted: false,
        rejectionCode: "ambiguous_local_part",
        detail: `The verified local part "${local}" fits ${hits.length} advisers at this firm (${hits.map((h) => h.name).join(", ")}), so it binds none of them.`,
      });
    } else if (hits.length === 1) {
      record({
        signal: "email_name_match",
        source: "derived",
        accepted: false,
        rejectionCode: "matches_a_different_adviser",
        detail: `The verified local part "${local}" fits ${hits[0].name} (CRD ${hits[0].individualCrd}), not the adviser being claimed (CRD ${selectedCrd}).`,
      });
    } else {
      record({
        signal: "email_name_match",
        source: "derived",
        accepted: false,
        rejectionCode: "no_name_in_local_part",
        detail: `The verified local part "${local}" does not resemble any adviser's name on the live roster, so the address proves affiliation with the firm but not which person.`,
      });
    }
  }

  // oidc_name_match — derived from an ACCEPTED oidc_verified_name only.
  //
  // WHY THIS ONE DOES NOT USE uniqueRosterMatch. Measured live: an OIDC issuer verifies the
  // legal name a person actually uses, and that is routinely a short form of what the SEC
  // holds. "Jan Weisman" against the live roster entry "JANET HARRIS WEISMAN MRS." produced NO
  // deterministic match, so a real adviser could not have claimed her own profile with a
  // verified government-backed name in hand. matchPersonName is the primitive built for exactly
  // this: it still lets namesMatch decide first and still refuses every ambiguity, but it has a
  // guarded fallback for the zero-hit case, and it answers with an index rather than a person.
  if (asserted.oidc_name) {
    let hit = null;
    let matchMethod = null;
    const judged = await matchName(
      { claimedName: asserted.oidc_name.name, rosterNames: people.map((p) => p.name) },
      deps,
    ).catch(() => null);
    if (judged && Number.isInteger(judged.index) && people[judged.index]) {
      hit = people[judged.index];
      matchMethod = judged.method || "namesMatch";
    }
    if (hit && (selectedCrd == null || hit.individualCrd === selectedCrd)) {
      derived.oidc_name_match = true;
      identityBound = identityBound || { via: "oidc_name_match", name: hit.name, individualCrd: hit.individualCrd };
      record({
        signal: "oidc_name_match",
        source: "derived",
        accepted: true,
        detail: `The verified name "${asserted.oidc_name.name}" matches ${hit.name} and no other adviser on the live roster (matched by ${matchMethod}).`,
        identityBound: "oidc_name_match",
      });
    } else {
      record({
        signal: "oidc_name_match",
        source: "derived",
        accepted: false,
        rejectionCode: hit ? "matches_a_different_adviser" : "no_unique_roster_match",
        detail: hit
          ? `The verified name "${asserted.oidc_name.name}" matches ${hit.name} (CRD ${hit.individualCrd}), not the adviser being claimed (CRD ${selectedCrd}).`
          : `The verified name "${asserted.oidc_name.name}" does not match exactly one adviser on the live roster, so it cannot bind this claim to a person.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 3. derived authority (firm arm only — both sub-signals need a bound name)
  // -------------------------------------------------------------------------
  const scheduleA = Array.isArray(firm?.scheduleAPersons) ? firm.scheduleAPersons : [];
  let adv_officer = false;
  let on_live_roster = false;

  if (type === "firm") {
    if (!identityBound) {
      record({
        signal: "adv_officer",
        source: "derived",
        accepted: false,
        rejectionCode: "no_identity_bound_name",
        detail:
          "Nothing has bound a name to this claimant yet, and Schedule A can only be searched for a name we trust. A tapped row is intent, not a name — deriving officer status from it would let anyone who can answer the firm's phone claim the entity as its CEO.",
      });
    } else if (!scheduleA.length) {
      record({
        signal: "adv_officer",
        source: "derived",
        accepted: false,
        rejectionCode: "no_schedule_a_available",
        detail: `No Form ADV Schedule A is available for ${firm?.name || "this firm"} from the source that answered, so we cannot say whether ${identityBound.name} is a disclosed owner or officer. This is missing data, not a finding that they are not one.`,
      });
    } else {
      const hits = scheduleA.filter((person) => namesMatch(stripHonorifics(person?.name), stripHonorifics(identityBound.name)));
      if (hits.length === 1) {
        adv_officer = true;
        record({
          signal: "adv_officer",
          source: "derived",
          accepted: true,
          identityBound: identityBound.via,
          detail: `${identityBound.name} is named on ${firm?.name || "the firm"}'s Form ADV Schedule A${hits[0]?.title ? ` as ${hits[0].title}` : ""}, which is the firm's own disclosure of who may act for it.`,
        });
      } else {
        record({
          signal: "adv_officer",
          source: "derived",
          accepted: false,
          rejectionCode: hits.length ? "ambiguous_schedule_a_match" : "not_on_schedule_a",
          detail: hits.length
            ? `${identityBound.name} matches ${hits.length} Schedule A entries, so no single one can be attributed to them.`
            : `${identityBound.name} is not among the ${scheduleA.length} owners and officers ${firm?.name || "the firm"} discloses on Schedule A.`,
        });
      }
    }

    if (identityBound) {
      on_live_roster = people.some((p) => p.individualCrd === identityBound.individualCrd);
      record({
        signal: "on_live_roster",
        source: "derived",
        accepted: on_live_roster,
        identityBound: identityBound.via,
        rejectionCode: on_live_roster ? undefined : "not_on_live_roster",
        detail: on_live_roster
          ? `${identityBound.name} is on the firm's live SEC roster.`
          : `${identityBound.name} is not on the firm's live SEC roster.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. thresholds
  // -------------------------------------------------------------------------
  const satisfied = [];
  const missing = [];
  const options = []; // achievable next steps, cheapest first after sorting

  const push = (list, name) => {
    if (!list.includes(name)) list.push(name);
  };

  if (asserted.phone_otp) push(satisfied, "phone_otp");
  else {
    push(missing, "phone_otp");
    options.push({
      action: "send_phone_otp",
      friction: "low",
      reason: `Send a one-time passcode to ${firm?.phone || "the number on the firm's Form ADV"} and have your backend attest that it was answered. This proves affiliation with ${firm?.name || "the firm"} — it is the baseline for either claim.`,
    });
  }

  let allowed = false;

  if (type === "individual") {
    if (!selectedCrd) push(missing, "roster_selection");
    if (selectedOffRoster) push(missing, "roster_selection");

    for (const [name, ok] of [
      ["sole_adviser", derived.sole_adviser],
      ["email_name_match", derived.email_name_match],
      ["oidc_name_match", derived.oidc_name_match],
    ]) {
      if (ok) push(satisfied, name);
    }
    if (asserted.roster_selection || selectedCrd) push(satisfied, "roster_selection");

    const hasIdentity = derived.sole_adviser || derived.email_name_match || derived.oidc_name_match;
    if (!hasIdentity) push(missing, "identity: one of sole_adviser, email_name_match, oidc_name_match");

    allowed = asserted.phone_otp && hasIdentity && Boolean(selectedCrd) && !selectedOffRoster;

    if (selectedOffRoster) {
      options.push({
        action: "choose_identity",
        friction: "none",
        reason: `CRD ${selectedCrd} is not on ${firm?.name || "this firm"}'s live SEC roster, so there is no profile here to claim. Pick a row from the roster this lookup returned.`,
      });
    } else if (!selectedCrd) {
      options.push({
        action: "choose_identity",
        friction: "none",
        reason: `Tell us which of the ${people.length} advisers at ${firm?.name || "the firm"} you are. This decides which profile the evidence is tested against; it is not itself evidence.`,
      });
    }
    if (!hasIdentity) {
      // Only ACHIEVABLE options. "Be the only adviser at your firm" is not a next step.
      if (!asserted.domain_email) {
        const filedDomain = domainOf(firm?.website);
        if (filedDomain) {
          options.push({
            action: "verify_work_email",
            friction: "low",
            reason: `Verify an email at @${filedDomain} — the domain ${firm?.name || "the firm"} filed on its Form ADV. If the address is built from your name we can bind it to your row without any further step.`,
          });
        }
      } else if (!derived.email_name_match) {
        options.push({
          action: "verify_identity_with_oidc",
          friction: "medium",
          reason: `Your email is verified at the firm's domain, but its local part does not single out one adviser. Sign in with a provider that verifies your legal name and we will match it against the roster.`,
        });
      }
      if (!asserted.oidc_name) {
        options.push({
          action: "verify_identity_with_oidc",
          friction: "medium",
          reason: `Sign in with a provider that verifies your legal name (the LinkedIn OIDC flow in this repo does), and we will match that verified name against ${firm?.name || "the firm"}'s live roster.`,
        });
      }
    }
  } else {
    // FIRM
    if (adv_officer) push(satisfied, "adv_officer");
    if (asserted.domain_email) push(satisfied, "domain_email");
    if (on_live_roster) push(satisfied, "on_live_roster");
    if (derived.sole_adviser) push(satisfied, "sole_adviser");
    if (derived.email_name_match) push(satisfied, "email_name_match");
    if (derived.oidc_name_match) push(satisfied, "oidc_name_match");

    const rosterArm = Boolean(asserted.domain_email) && on_live_roster;
    const authority = adv_officer || rosterArm;
    if (!authority) push(missing, "authority: adv_officer, or domain_email while on the firm's live roster");

    allowed = asserted.phone_otp && authority;

    if (!identityBound) {
      options.push({
        action: "verify_identity_first",
        friction: "medium",
        reason: `Claiming the entity needs a name we can trust before we can check it against ${firm?.name || "the firm"}'s Schedule A. Verify a work email built from your name, or sign in with a provider that verifies your legal name.`,
      });
    } else if (!authority) {
      if (!asserted.domain_email && domainOf(firm?.website)) {
        options.push({
          action: "verify_work_email",
          friction: "low",
          reason: `${identityBound.name} is on the live roster. Verify an email at @${domainOf(firm.website)} and that, with the roster membership, is enough to act for the firm.`,
        });
      }
      if (!adv_officer && !on_live_roster) {
        options.push({
          action: "contact_support",
          friction: "medium",
          reason: `${identityBound.name} is neither on ${firm?.name || "the firm"}'s live SEC roster nor on its Form ADV Schedule A. There is no public record here that supports acting for this entity — this needs a human.`,
        });
      }
    }
  }

  options.sort((a, b) => (FRICTION_ORDER[a.friction] ?? 9) - (FRICTION_ORDER[b.friction] ?? 9));
  const cheapestNextStep = allowed ? null : options[0] ?? null;

  // ── PROVISIONAL vs VERIFIED ────────────────────────────────────────────────────────────────
  // Onboarding is one step: answer the phone, pick your row, you are in. That is PROVISIONAL —
  // it proves affiliation with the firm and an intent, and it is deliberately NOT proof of
  // identity, because a shared office line cannot distinguish seven advisers from each other.
  // `allowed` above stays the strict, evidence-bound answer and is what any authority decision
  // must read. `provisional` is what lets the user through the door with profileVerified:false.
  // A consumer that treats provisional as verified has defeated the whole model — hence the two
  // fields are named so they cannot be confused, and NOTICE says it in the payload.
  const provisional =
    type === "individual"
      ? Boolean(asserted.phone_otp) && Boolean(selectedCrd) && !selectedOffRoster
      : Boolean(asserted.phone_otp);
  const verificationLevel = allowed ? "verified" : provisional ? "provisional" : "none";

  return {
    ok: true,
    claimType: type,
    // The claim the product actually grants at onboarding, and its honest label.
    provisional,
    verificationLevel,
    profileVerified: allowed,
    // What it would take to move from provisional to verified. Empty once verified.
    upgradePlan: allowed ? [] : options,
    provisionalNotice:
      verificationLevel === "provisional"
        ? "Provisional claim: the claimant answered the number this firm filed with the SEC and selected this profile. That proves firm affiliation and intent, NOT identity. Store the profile as unverified and require the upgrade steps before treating it as identity-proven."
        : null,
    // Scoped, always, and explicitly. `allowed` on its own has been misread as "this person is
    // verified"; `grants` cannot be misread, because at most one field in it is ever true.
    grants: {
      individual: allowed && type === "individual" ? selectedCrd : null,
      firm: allowed && type === "firm" ? (Number.isFinite(Number(firm?.crd)) ? Number(firm.crd) : null) : null,
    },
    allowed,
    firmCrd: Number.isFinite(Number(firm?.crd)) ? Number(firm.crd) : null,
    selectedIndividualCrd: selectedCrd,
    satisfied,
    missing,
    cheapestNextStep,
    explanation: explainClaim({ type, allowed, firm, people, selected, selectedOffRoster, satisfied, derived, identityBound, cheapestNextStep }),
    evidenceLedger: ledger,
    notice: NOTICE,
    // A separate claim on the other target must be evaluated on its own evidence. Say it in the
    // payload, not only in the docs.
    scopeNote:
      type === "individual"
        ? "This result authorises the named individual profile only. Claiming the FIRM is a separate evaluation with a different threshold; nothing here grants it."
        : "This result authorises the firm entity only. Claiming an individual adviser profile is a separate evaluation with a different threshold; nothing here grants it.",
  };
}

/** One plain sentence. Must not throw — the server renders it inside a response body. */
function explainClaim({ type, allowed, firm, people, selected, selectedOffRoster, derived, identityBound, cheapestNextStep }) {
  try {
    const firmName = firm?.name || "this firm";
    const who = selected?.name || identityBound?.name || null;

    if (allowed && type === "individual") {
      if (derived.sole_adviser) {
        return `${who || "This adviser"} is the only adviser the SEC currently lists at ${firmName}, and the passcode proved you answer that firm's line — so answering the phone identified you, with nothing else to do.`;
      }
      return `The passcode proved you are at ${firmName}, and an independently verified name matched ${who || "this adviser"} and nobody else on the roster — enough to claim that profile.`;
    }
    if (allowed && type === "firm") {
      return `${identityBound?.name || "The claimant"} is verified at ${firmName} and the firm's own filings support acting for the entity, so the firm profile can be claimed.`;
    }
    if (selectedOffRoster) {
      return `The adviser you selected is not on ${firmName}'s live SEC roster, so there is no profile here to claim.`;
    }
    if (type === "individual" && people.length > 1) {
      return `Answering ${firmName}'s phone proves you work with that firm, but ${people.length} advisers share that line — it cannot say which of them you are. ${cheapestNextStep?.reason || ""}`.trim();
    }
    return cheapestNextStep?.reason || `Not enough evidence yet to claim the ${type === "firm" ? "firm" : "adviser"} profile.`;
  } catch {
    return "We could not summarise this claim, but the evidence ledger below is complete.";
  }
}

export const CLAIM_EVIDENCE_NOTICE = NOTICE;
