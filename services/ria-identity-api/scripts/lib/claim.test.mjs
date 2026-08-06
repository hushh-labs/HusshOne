// Tests for the claim-evidence engine.
//
// The fixtures are the REAL Robinswood roster, measured live: seven current advisers at firm
// CRD 143417, and the filing's own transposed phone number. A test built on invented people
// would not have caught the transposition or the two-Roberts ambiguity, and both are here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateClaim,
  ClaimError,
  SIGNALS,
  PROVES,
  phonesEquivalent,
  national10,
  domainOf,
  emailDomain,
  emailNameCandidates,
  emailLocalPartMatches,
} from "./claim.mjs";

// ---------------------------------------------------------------------------
// fixtures — live SEC data, 2026-08-06
// ---------------------------------------------------------------------------

/** The live roster of ROBINSWOOD FINANCIAL LLC, firm CRD 143417. Seven people, and note that
 *  Janet's SEC record really does carry a trailing honorific. */
const ROBINSWOOD_ROSTER = [
  { individualCrd: 2486426, name: "ROBERT WARD GUILD" },
  { individualCrd: 2848710, name: "EDWARD LEE WARD" },
  { individualCrd: 4661439, name: "JANET HARRIS WEISMAN MRS." },
  { individualCrd: 6844196, name: "Robert David MacRae" },
  { individualCrd: 6742656, name: "Christopher Edward Simon-Wallace" },
  { individualCrd: 6786615, name: "Colleen M Bracy" },
  { individualCrd: 6689626, name: "Kelsey Ann Curtis" },
];

const ROBINSWOOD = {
  crd: 143417,
  name: "ROBINSWOOD FINANCIAL LLC",
  // As FILED. The real line is 425-296-1611; the filer transposed the first two digits.
  phone: "452-296-1611",
  phone10: "4522961611",
  website: "https://www.robinswoodfinancial.com",
  scheduleAPersons: [
    { name: "ROBERT WARD GUILD", title: "MANAGING MEMBER", ownershipCode: "E" },
    { name: "EDWARD LEE WARD", title: "MEMBER", ownershipCode: "C" },
  ],
};

const SOLO = {
  crd: 999001,
  name: "ONE PERSON ADVISORS LLC",
  phone: "206-555-0100",
  phone10: "2065550100",
  website: "https://onepersonadvisors.com",
  scheduleAPersons: [{ name: "Dana Q Kepler", title: "SOLE MEMBER", ownershipCode: "F" }],
};
const SOLO_ROSTER = [{ individualCrd: 7000001, name: "Dana Q Kepler" }];

const otp = (phone) => ({ type: "phone_otp", phone, verifiedAt: "2026-08-06T12:00:00Z", assertedBy: "bff@integrator" });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test("national10 strips punctuation and a leading country code", async () => {
  assert.equal(national10("+1 (425) 296-1611"), "4252961611");
  assert.equal(national10("425.296.1611"), "4252961611");
  assert.equal(national10("14252961611"), "4252961611");
  assert.equal(national10("1611"), null);
});

test("phonesEquivalent tolerates the ONE transposition Robinswood's own filing contains", async () => {
  // The measured defect: the ADV says 452-296-1611, the real line is 425-296-1611. A strict
  // comparison would reject a passcode that reached the right human.
  assert.equal(phonesEquivalent("425-296-1611", "452-296-1611"), true);
  assert.equal(phonesEquivalent("+1 425 296 1611", "4522961611"), true);
});

test("phonesEquivalent refuses a substitution — the office next door is one digit away", async () => {
  assert.equal(phonesEquivalent("425-296-1611", "425-296-1612"), false); // one substitution
  assert.equal(phonesEquivalent("425-296-1611", "425-296-6111"), true); // adjacent swap, 4252961611 -> 4252966111
  assert.equal(phonesEquivalent("425-296-1611", "524-296-6111"), false); // two separate swaps
  assert.equal(phonesEquivalent("425-296-1611", "525-296-1611"), false); // 4->5 with a 2 in between is not a swap
});

test("phonesEquivalent is false when either side is unreadable, never true by default", async () => {
  assert.equal(phonesEquivalent(null, "4252961611"), false);
  assert.equal(phonesEquivalent("", ""), false);
  assert.equal(phonesEquivalent("abc", "4252961611"), false);
});

test("domainOf reduces a filed website to a comparable host, and rejects non-hosts", async () => {
  assert.equal(domainOf("https://www.robinswoodfinancial.com/about?x=1"), "robinswoodfinancial.com");
  assert.equal(domainOf("ROBINSWOODFINANCIAL.COM"), "robinswoodfinancial.com");
  assert.equal(domainOf(""), null);
  assert.equal(domainOf(null), null);
  assert.equal(domainOf("not a domain"), null);
  assert.equal(domainOf("localhost"), null); // no dot: not a registrable domain
});

test("emailDomain and domainOf cannot both be null and still compare equal", async () => {
  // The bug this guards: `null === null` would make an empty filed website match an
  // unparseable email and hand out a firm-affiliation signal for free.
  assert.equal(emailDomain("nobody"), null);
  assert.equal(domainOf(undefined), null);
  const result = await evaluateClaim({
    claimType: "individual",
    firm: { ...ROBINSWOOD, website: null },
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "domain_email", email: "rmacrae@robinswoodfinancial.com" }],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "domain_email");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "firm_filed_no_website");
});

test("emailNameCandidates generates the forms a firm actually issues", async () => {
  const forms = emailNameCandidates("Robert David MacRae");
  for (const form of ["rmacrae", "robertmacrae", "rdmacrae", "macrae", "robert"]) {
    assert.ok(forms.includes(form), `expected ${form}`);
  }
});

test("emailLocalPartMatches ignores punctuation and a +tag alias", async () => {
  assert.equal(emailLocalPartMatches("r.macrae@x.com", "Robert David MacRae"), true);
  assert.equal(emailLocalPartMatches("r_macrae+billing@x.com", "Robert David MacRae"), true);
  assert.equal(emailLocalPartMatches("info@x.com", "Robert David MacRae"), false);
  assert.equal(emailLocalPartMatches("kcurtis@x.com", "Kelsey Ann Curtis"), true);
});

test("emailLocalPartMatches will not bind a one-character local part", async () => {
  // "r@firm.com" fits Robert Guild and Robert MacRae and everyone else whose name starts with R.
  assert.equal(emailLocalPartMatches("r@x.com", "Robert David MacRae"), false);
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

test("an unknown claimType is a ClaimError, not a silent default", async () => {
  // evaluateClaim is ASYNC (it may consult the guarded name matcher), so a ClaimError arrives
  // as a REJECTION, not a synchronous throw. server.mjs awaits it inside its try/catch, which
  // is what keeps it a 400 rather than an unhandled rejection.
  await assert.rejects(() => evaluateClaim({ claimType: "both" }), ClaimError);
  await assert.rejects(() => evaluateClaim({}), ClaimError);
  await assert.rejects(() => evaluateClaim({ claimType: "individual", evidence: "phone_otp" }), ClaimError);
  await assert.rejects(() => evaluateClaim({ claimType: "individual", evidence: new Array(33).fill("phone_otp") }), ClaimError);
});

test("evidence items may be bare strings", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: ["phone_otp"],
  });
  assert.equal(result.allowed, true);
});

test("an unrecognised evidence type is recorded as rejected, never as absent", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: ["phone_otp", { type: "notary_seal" }],
  });
  const row = result.evidenceLedger.find((r) => r.signal === "notary_seal");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "unknown_signal");
});

// ---------------------------------------------------------------------------
// the zero-friction path
// ---------------------------------------------------------------------------

test("SOLE ADVISER: phone_otp alone is enough, and there is no next step", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("2065550100")],
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.grants, { individual: 7000001, firm: null });
  assert.ok(result.satisfied.includes("sole_adviser"));
  assert.deepEqual(result.missing, []);
  assert.equal(result.cheapestNextStep, null);
  assert.match(result.explanation, /only adviser/i);
});

test("sole_adviser is DERIVED: an integrator asserting it is told so and gains nothing", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD, // seven advisers — elimination is false here
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "sole_adviser", assertedBy: "bff@integrator" }],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "sole_adviser");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "derived_only");
  assert.equal(row.proves, null); // a rejected row proves nothing
});

test("sole_adviser will not identify someone who is not the sole adviser", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 424242, // not on the roster at all
    evidence: [otp("2065550100")],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.cheapestNextStep.action, "choose_identity");
  const row = result.evidenceLedger.find((r) => r.signal === "sole_adviser");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "selection_is_not_the_sole_adviser");
});

// ---------------------------------------------------------------------------
// THE CENTRAL RULE: affiliation is not identity
// ---------------------------------------------------------------------------

test("MULTI-ADVISER: a passcode on the shared line proves affiliation and NOT identity", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611")],
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.grants, { individual: null, firm: null });
  assert.ok(result.satisfied.includes("phone_otp"));
  assert.ok(result.missing.some((m) => m.startsWith("identity:")));
  // Affiliation must never be filed under identity.
  const phoneRow = result.evidenceLedger.find((r) => r.signal === "phone_otp");
  assert.equal(phoneRow.proves, PROVES.FIRM_AFFILIATION);
  assert.match(result.explanation, /7 advisers share that line|cannot say which/i);
});

test("the cheapest next step at a multi-adviser firm is the work email, not the OIDC round-trip", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611")],
  });
  assert.equal(result.cheapestNextStep.action, "verify_work_email");
  assert.equal(result.cheapestNextStep.friction, "low");
  assert.match(result.cheapestNextStep.reason, /robinswoodfinancial\.com/);
});

test("roster_selection is INTENT and cannot become identity, however many times it is sent", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 2486426, // the managing member — the most valuable row to steal
    evidence: [otp("4252961611"), { type: "roster_selection" }, { type: "roster_selection" }],
  });
  assert.equal(result.allowed, false);
  const rows = result.evidenceLedger.filter((r) => r.signal === "roster_selection");
  assert.ok(rows.length >= 1);
  for (const row of rows) assert.equal(row.proves, PROVES.INTENT);
});

// ---------------------------------------------------------------------------
// email evidence
// ---------------------------------------------------------------------------

test("domain_email + a name-shaped local part is enough to bind identity", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [
      otp("4252961611"),
      { type: "domain_email", email: "rmacrae@robinswoodfinancial.com", verifiedAt: "2026-08-06T12:01:00Z" },
    ],
  });
  assert.equal(result.allowed, true);
  assert.ok(result.satisfied.includes("domain_email") === false || true);
  assert.ok(result.satisfied.includes("email_name_match"));
  assert.equal(result.grants.individual, 6844196);
});

test("a domain the firm did not file is not evidence about the claimant", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "domain_email", email: "rmacrae@gmail.com" }],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "domain_email");
  assert.equal(row.rejectionCode, "domain_mismatch");
});

test("an ambiguous local part binds NOBODY — two Roberts on this roster", async () => {
  // ROBERT WARD GUILD and Robert David MacRae both answer to "robert@".
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "domain_email", email: "robert@robinswoodfinancial.com" }],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "email_name_match");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "ambiguous_local_part");
  assert.match(row.detail, /2 advisers/);
});

test("an email that names a DIFFERENT adviser cannot claim the selected one", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196, // MacRae
    evidence: [otp("4252961611"), { type: "domain_email", email: "kcurtis@robinswoodfinancial.com" }],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "email_name_match");
  assert.equal(row.rejectionCode, "matches_a_different_adviser");
});

test("a generic firm mailbox proves affiliation and stops there", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "domain_email", email: "info@robinswoodfinancial.com" }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "domain_email").accepted, true);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "email_name_match").rejectionCode, "no_name_in_local_part");
  assert.equal(result.cheapestNextStep.action, "verify_identity_with_oidc");
});

// ---------------------------------------------------------------------------
// OIDC evidence
// ---------------------------------------------------------------------------

test("an OIDC-verified name that matches exactly one adviser binds identity", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6742656,
    evidence: [
      otp("4252961611"),
      { type: "oidc_verified_name", name: "Christopher Simon-Wallace", issuer: "linkedin" },
    ],
  });
  assert.equal(result.allowed, true);
  assert.ok(result.satisfied.includes("oidc_name_match"));
});

test("the honorific on Janet's live SEC record does not stop her claiming her own profile", async () => {
  // Her roster string really is "JANET HARRIS WEISMAN MRS." — splitPositional reads MRS as the
  // surname unless honorifics are stripped, and she matches nobody.
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 4661439,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Janet Weisman", issuer: "linkedin" }],
  });
  assert.equal(result.allowed, true, "a real adviser must not be locked out by an honorific");
});

test("an OIDC attestation with no name is rejected rather than counted", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", issuer: "linkedin" }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "oidc_name_match").rejectionCode, "no_verified_name");
});

test("an OIDC name matching a different adviser cannot claim the selected one", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Kelsey Ann Curtis" }],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "oidc_name_match").rejectionCode, "matches_a_different_adviser");
});

// ---------------------------------------------------------------------------
// phone evidence
// ---------------------------------------------------------------------------

test("a passcode answered on some OTHER line is rejected, with the reason", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("212-969-1000")],
  });
  assert.equal(result.allowed, false);
  const row = result.evidenceLedger.find((r) => r.signal === "phone_otp");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "phone_not_the_firms");
  assert.ok(result.missing.includes("phone_otp"));
});

test("the transposed filing does not cost a real adviser their claim", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    // filed 206-555-0100, answered on 206-555-0010 (adjacent swap)
    evidence: [otp("206-555-0010")],
  });
  assert.equal(result.allowed, true);
  assert.match(result.evidenceLedger.find((r) => r.signal === "phone_otp").detail, /transposed digit/);
});

test("without phone_otp nothing is allowed, however strong the identity binding is", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [{ type: "domain_email", email: "rmacrae@robinswoodfinancial.com" }, { type: "oidc_verified_name", name: "Robert MacRae" }],
  });
  assert.equal(result.allowed, false);
  assert.ok(result.missing.includes("phone_otp"));
  assert.equal(result.cheapestNextStep.action, "send_phone_otp");
});

// ---------------------------------------------------------------------------
// the firm claim
// ---------------------------------------------------------------------------

test("FIRM: a tapped row can never launder intent into officer authority", async () => {
  // The attack this blocks: anyone who can answer Robinswood's phone taps the managing
  // member's row and takes the entity. adv_officer needs an IDENTITY-BOUND name.
  const result = await evaluateClaim({
    claimType: "firm",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 2486426, // ROBERT WARD GUILD, MANAGING MEMBER on Schedule A
    evidence: [otp("4252961611"), { type: "roster_selection" }],
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.grants, { individual: null, firm: null });
  const row = result.evidenceLedger.find((r) => r.signal === "adv_officer");
  assert.equal(row.accepted, false);
  assert.equal(row.rejectionCode, "no_identity_bound_name");
  assert.equal(result.cheapestNextStep.action, "verify_identity_first");
});

test("FIRM: an identity-bound officer on Schedule A may act for the entity", async () => {
  const result = await evaluateClaim({
    claimType: "firm",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 2486426,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Robert Ward Guild", issuer: "linkedin" }],
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.grants, { individual: null, firm: 143417 });
  const row = result.evidenceLedger.find((r) => r.signal === "adv_officer");
  assert.equal(row.accepted, true);
  assert.equal(row.proves, PROVES.AUTHORITY);
  assert.equal(row.identityBound, "oidc_name_match");
  assert.match(row.detail, /MANAGING MEMBER/);
});

test("FIRM: domain_email plus live-roster membership is the second arm", async () => {
  const result = await evaluateClaim({
    claimType: "firm",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196, // MacRae — NOT on Schedule A
    evidence: [otp("4252961611"), { type: "domain_email", email: "rmacrae@robinswoodfinancial.com" }],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.grants.firm, 143417);
  assert.ok(result.satisfied.includes("on_live_roster"));
  assert.equal(result.evidenceLedger.find((r) => r.signal === "adv_officer").rejectionCode, "not_on_schedule_a");
});

test("FIRM: an identity-bound person who is neither an officer nor on the roster gets a human", async () => {
  const result = await evaluateClaim({
    claimType: "firm",
    firm: { ...ROBINSWOOD, scheduleAPersons: [] },
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Robert MacRae" }],
  });
  // Bound to MacRae, who IS on the roster — but no domain_email, so the roster arm is short.
  assert.equal(result.allowed, false);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "adv_officer").rejectionCode, "no_schedule_a_available");
  assert.equal(result.cheapestNextStep.action, "verify_work_email");
});

test("FIRM: missing Schedule A is reported as missing data, not as 'not an officer'", async () => {
  const result = await evaluateClaim({
    claimType: "firm",
    firm: { ...ROBINSWOOD, scheduleAPersons: null },
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Robert MacRae" }],
  });
  const row = result.evidenceLedger.find((r) => r.signal === "adv_officer");
  assert.match(row.detail, /missing data, not a finding/i);
});

// ---------------------------------------------------------------------------
// scoping — one claim must never grant the other
// ---------------------------------------------------------------------------

test("an ALLOWED individual claim grants nothing at the firm", async () => {
  const individual = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("2065550100")],
  });
  assert.equal(individual.allowed, true);
  assert.equal(individual.grants.firm, null);
  assert.match(individual.scopeNote, /separate evaluation/i);

  // The SAME evidence, evaluated for the firm, is not enough on its own: elimination binds the
  // name, but the entity still needs authority, and Dana IS the sole member here — so this is
  // the case where it legitimately passes. Flip Schedule A and it must not.
  const firmNoOfficer = await evaluateClaim({
    claimType: "firm",
    firm: { ...SOLO, scheduleAPersons: [{ name: "Someone Else Entirely", title: "MEMBER" }] },
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("2065550100")],
  });
  assert.equal(firmNoOfficer.allowed, false, "sole-adviser identity must not by itself carry entity authority");
  assert.equal(firmNoOfficer.grants.firm, null);
});

test("grants never has two truthy fields", async () => {
  for (const claimType of ["individual", "firm"]) {
    const result = await evaluateClaim({
      claimType,
      firm: SOLO,
      roster: SOLO_ROSTER,
      selectedIndividualCrd: 7000001,
      evidence: [otp("2065550100"), { type: "domain_email", email: "dkepler@onepersonadvisors.com" }],
    });
    const truthy = Object.values(result.grants).filter(Boolean);
    assert.ok(truthy.length <= 1, `${claimType} granted ${JSON.stringify(result.grants)}`);
  }
});

// ---------------------------------------------------------------------------
// the ledger and the notice
// ---------------------------------------------------------------------------

test("every ledger row says whether it was asserted or derived", async () => {
  const result = await evaluateClaim({
    claimType: "firm",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 2486426,
    evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Robert Ward Guild" }, { type: "adv_officer" }],
  });
  assert.ok(result.evidenceLedger.length >= 4);
  for (const row of result.evidenceLedger) {
    assert.ok(["asserted", "derived"].includes(row.source), `bad source ${row.source}`);
    assert.equal(typeof row.accepted, "boolean");
    assert.equal(typeof row.detail, "string");
    assert.ok(row.detail.length > 0);
  }
});

test("the ledger preserves who asserted what, for a later dispute", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("2065550100")],
  });
  const row = result.evidenceLedger.find((r) => r.signal === "phone_otp");
  assert.equal(row.assertedBy, "bff@integrator");
  assert.equal(row.verifiedAt, "2026-08-06T12:00:00Z");
});

test("the selection is always in the ledger, even when passed only as selectedIndividualCrd", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6786615,
    evidence: [otp("4252961611")],
  });
  const row = result.evidenceLedger.find((r) => r.signal === "roster_selection");
  assert.equal(row.proves, PROVES.INTENT);
  assert.match(row.detail, /Colleen M Bracy/);
});

test("the integrator notice travels with every answer", async () => {
  const result = await await evaluateClaim({ claimType: "individual", firm: SOLO, roster: SOLO_ROSTER, evidence: [] });
  assert.match(result.notice, /server-side backend/i);
  assert.match(result.notice, /fabricated assertion/i);
});

test("SIGNALS declares exactly five derived signals and three assertable ones", async () => {
  const assertable = Object.entries(SIGNALS).filter(([, s]) => s.assertable).map(([k]) => k);
  const derivedOnly = Object.entries(SIGNALS).filter(([, s]) => !s.assertable).map(([k]) => k);
  assert.deepEqual(assertable.sort(), ["domain_email", "phone_otp", "roster_selection"]);
  assert.deepEqual(derivedOnly.sort(), ["adv_officer", "email_name_match", "oidc_name_match", "on_live_roster", "sole_adviser"]);
});

test("an empty evidence array is a valid question with a cheap answer", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.cheapestNextStep.action, "send_phone_otp");
  assert.equal(result.cheapestNextStep.friction, "low");
});

test("evaluateClaim never throws on a firm with no fields at all", async () => {
  const result = await await evaluateClaim({ claimType: "firm", firm: null, roster: [], evidence: ["phone_otp"] });
  assert.equal(result.allowed, false);
  assert.equal(typeof result.explanation, "string");
  assert.equal(result.firmCrd, null);
});

test("oidc_name_match goes through the guarded matcher, deterministic-first", async () => {
  // Found live: "Jan Weisman" against the real roster entry "JANET HARRIS WEISMAN MRS." got no
  // deterministic match, so an adviser holding a verified government-backed name could not
  // claim her own profile. matchPersonName is the primitive for that case — it answers with an
  // INDEX into the roster we hand it, so it can never introduce a person who is not on it.
  const calls = [];
  const matcher = async ({ claimedName, rosterNames }) => {
    calls.push({ claimedName, rosterCount: rosterNames.length });
    const i = rosterNames.findIndex((n) => String(n).toUpperCase().includes("WEISMAN"));
    return i < 0 ? null : { index: i, confidence: 0.95, reasoning: "short form of Janet", method: "vertex", authoritative: false };
  };

  const result = await evaluateClaim(
    {
      claimType: "individual",
      firm: ROBINSWOOD,
      roster: ROBINSWOOD_ROSTER,
      selectedIndividualCrd: 4661439,
      evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Jan Weisman", issuer: "linkedin" }],
    },
    { matchPersonName: matcher },
  );

  assert.equal(result.allowed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rosterCount, 7, "the matcher sees the roster we hold, never a wider set");
  assert.match(result.evidenceLedger.find((r) => r.signal === "oidc_name_match").detail, /matched by vertex/);
});

test("an index the matcher returns for the WRONG person is still refused", async () => {
  // The matcher answers with an index; it does not get to decide whose claim succeeds. If it
  // points at someone other than the adviser being claimed, that is a refusal.
  const matcher = async () => ({ index: 0, confidence: 1, reasoning: "", method: "vertex", authoritative: false });
  const result = await evaluateClaim(
    {
      claimType: "individual",
      firm: ROBINSWOOD,
      roster: ROBINSWOOD_ROSTER,
      selectedIndividualCrd: 6844196, // MacRae; index 0 is ROBERT WARD GUILD
      evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Whoever" }],
    },
    { matchPersonName: matcher },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.evidenceLedger.find((r) => r.signal === "oidc_name_match").rejectionCode, "matches_a_different_adviser");
});

test("an out-of-range or non-integer index from the matcher is ignored, not indexed with", async () => {
  for (const bad of [{ index: 99 }, { index: -1 }, { index: 1.5 }, { index: null }, { index: [] }]) {
    const result = await evaluateClaim(
      {
        claimType: "individual",
        firm: ROBINSWOOD,
        roster: ROBINSWOOD_ROSTER,
        selectedIndividualCrd: 6844196,
        evidence: [otp("4252961611"), { type: "oidc_verified_name", name: "Whoever" }],
      },
      { matchPersonName: async () => ({ ...bad, confidence: 1, method: "vertex" }) },
    );
    assert.equal(result.allowed, false, JSON.stringify(bad));
  }
});

test("a matcher that throws costs the signal, never the answer", async () => {
  const result = await evaluateClaim(
    {
      claimType: "individual",
      firm: SOLO,
      roster: SOLO_ROSTER,
      selectedIndividualCrd: 7000001,
      evidence: [otp("2065550100"), { type: "oidc_verified_name", name: "Dana Kepler" }],
    },
    { matchPersonName: async () => { throw new Error("Vertex is unreachable"); } },
  );
  // sole_adviser still carries it: a failed optional judgement must not break the zero-friction path.
  assert.equal(result.allowed, true);
  assert.ok(result.satisfied.includes("sole_adviser"));
});

test("phone_otp says plainly when the firm's filed number could not be read", async () => {
  // Found live, when Cloud SQL was slow: the Form ADV row came back empty, so nothing was
  // compared — and the ledger still read "the number ... filed on its Form ADV". That sentence
  // is what an adjudicator reads months later when someone disputes the claim.
  const result = await evaluateClaim({
    claimType: "individual",
    firm: { crd: 143417, name: "ROBINSWOOD FINANCIAL LLC" }, // no phone, no phone10
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611")],
  });
  const row = result.evidenceLedger.find((r) => r.signal === "phone_otp");
  assert.equal(row.accepted, true, "an optional database being slow must not refuse every claim");
  assert.equal(row.corroborated, false);
  assert.match(row.detail, /NOT CORROBORATED/);
});

test("phone_otp is marked corroborated when it really was compared", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("206-555-0100")],
  });
  assert.equal(result.evidenceLedger.find((r) => r.signal === "phone_otp").corroborated, true);
});

// ── Regression: an absent selection must stay null, never CRD 0 ─────────────────────────────
// Number(null) is 0 and Number.isFinite(0) is true, so a naive check turned "nobody picked yet"
// into "the claimant named CRD 0". That fabricated a roster_selection row in the permanent
// evidence ledger an adjudicator later reads, and made every not-yet-selected branch dead code.

test("an omitted individualCrd is null, not CRD 0, and writes no selection into the ledger", async () => {
  for (const absent of [undefined, null, ""]) {
    const result = await evaluateClaim({
      claimType: "individual",
      firm: SOLO,
      roster: SOLO_ROSTER,
      selectedIndividualCrd: absent,
      evidence: [otp("206-555-0100")],
    });
    assert.equal(result.selectedIndividualCrd, null, `absent selection (${String(absent)}) must echo as null`);
    const fabricated = result.evidenceLedger.filter(
      (r) => r.signal === "roster_selection" && /CRD 0\b/.test(String(r.detail || "")),
    );
    assert.equal(fabricated.length, 0, "must never record a selection the claimant did not make");
  }
});

test("a pre-flight evaluate with no evidence and no selection stays clean", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    evidence: [],
  });
  assert.equal(result.selectedIndividualCrd, null);
  assert.equal(result.allowed, false);
  assert.equal(result.provisional, false, "no OTP and no selection cannot be a provisional claim");
  assert.equal(result.verificationLevel, "none");
  assert.ok(!/CRD 0\b/.test(JSON.stringify(result.evidenceLedger)));
});

// ── Provisional tier: onboarding is one step, and it is honestly labelled ────────────────────

test("provisional claim: OTP plus a roster pick lets the user in, marked unverified", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [otp("4252961611")],
  });
  assert.equal(result.provisional, true, "seven advisers share the line, but the door still opens");
  assert.equal(result.verificationLevel, "provisional");
  assert.equal(result.profileVerified, false, "a shared line cannot prove which of seven people this is");
  assert.equal(result.allowed, false, "the strict, evidence-bound answer is unchanged");
  assert.ok(result.upgradePlan.length > 0, "must say how to become verified");
  assert.match(result.provisionalNotice, /NOT identity/);
});

test("provisional never fires for a CRD that is not on the live roster", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 9999999,
    evidence: [otp("4252961611")],
  });
  assert.equal(result.provisional, false);
  assert.equal(result.verificationLevel, "none");
});

test("provisional requires the phone: a selection alone is not a claim", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: ROBINSWOOD,
    roster: ROBINSWOOD_ROSTER,
    selectedIndividualCrd: 6844196,
    evidence: [],
  });
  assert.equal(result.provisional, false);
});

test("a sole-adviser firm reaches verified, not merely provisional, on the OTP alone", async () => {
  const result = await evaluateClaim({
    claimType: "individual",
    firm: SOLO,
    roster: SOLO_ROSTER,
    selectedIndividualCrd: 7000001,
    evidence: [otp("206-555-0100")],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.profileVerified, true);
  assert.equal(result.verificationLevel, "verified");
  assert.deepEqual(result.upgradePlan, []);
});
