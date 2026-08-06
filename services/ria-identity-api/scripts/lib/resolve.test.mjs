// Unit tests for the resolver. Pure: a fake Cloud SQL store, a fake Google Places client and
// a fake IAPD client are injected, so nothing here touches the network, the disk or a
// database.
//
// The namesMatch block is the one that matters most. A false positive there offers one
// adviser someone ELSE'S professional identity to claim, so the negative cases below —
// father and son, two unrelated people sharing a surname, a contradicting middle initial —
// are the real assertions and the positives are the regression net around them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveByPhone,
  searchByName,
  namesMatch,
  parseName,
  explain,
  SIGNALS,
  toFirmSummary,
  FIRM_SUMMARY_KEYS,
  scheduleAFallback,
  buildFirmDetail,
  loadClaimContext,
} from "./resolve.mjs";
import { UpstreamBudget } from "./http.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function firmRecord(overrides = {}) {
  return {
    crd: 10603,
    name: "LYLE, ALLAN GLEN",
    dba: "LYLE & FORSYTH INVESTMENT MANAGERS",
    secNumber: "801-16717",
    registrationType: "sec",
    street1: "1000 FOURTH ST",
    street2: "SUITE 800",
    city: "SAN RAFAEL",
    state: "CA",
    zip: "94901",
    country: "United States",
    phone: "(415) 492-9240",
    phone10: "4154929240",
    website: null,
    totalEmployees: 2,
    advisoryEmployees: 1,
    iarCount: 1,
    effectiveAdviserCount: 1,
    aum: 221189432,
    registrationStatus: "Approved",
    latestFilingDate: "2026-03-03",
    scheduleAPersons: [
      { name: "LYLE, ALLAN, GLEN", title: "OWNER CHIEF COMPLIANCE OFFICER", ownershipCode: "E", isControlPerson: true },
    ],
    ...overrides,
  };
}

/** A stand-in for sql-store.mjs — the LIVE Cloud SQL Form ADV firm table. Firms only: there
 *  is deliberately no way to ask this double about a person, because the real one has none. */
function makeStore(firms, { error = null, freshness = null } = {}) {
  const byCrd = new Map();
  const byPhone = new Map();
  for (const firm of firms) {
    byCrd.set(Number(firm.crd), firm);
    if (!firm.phone10) continue;
    byPhone.set(firm.phone10, (byPhone.get(firm.phone10) || []).concat(Number(firm.crd)));
  }
  return {
    calls: [],
    async lookupByPhone(phone10) {
      this.calls.push(["lookupByPhone", phone10]);
      if (error) throw error;
      const crds = byPhone.get(phone10) || [];
      return { firms: crds.map((crd) => byCrd.get(crd)).filter(Boolean), phone10, ms: 1 };
    },
    async getFirm(crd) {
      this.calls.push(["getFirm", crd]);
      if (error) throw error;
      return byCrd.get(Number(crd)) || null;
    },
    async freshness() {
      return (
        freshness || {
          lastIngestAt: "2026-07-29T14:26:24.587Z",
          sourceFile: "IA_FIRM_SEC_Feed_07_29_2026.xml.gz",
          rowsUpserted: 23640,
          ageDays: 8,
          staleAfterDays: 14,
          stale: false,
        }
      );
    },
  };
}

/** A stand-in for places.mjs resolveByPhoneLive. `crd:null` is the honest miss shape. */
function makePlaces(byPhone = {}) {
  return {
    calls: [],
    async resolveByPhoneLive(phone) {
      this.calls.push(phone);
      const digits = String(phone).replace(/\D/g, "").slice(-10);
      const hit = byPhone[digits];
      if (!hit) {
        return { found: false, crd: null, firmName: null, confidence: "low", matchedOn: [], candidates: [], score: null, maxScore: 165, branchCount: null, reason: "no_match", business: null };
      }
      return {
        found: hit.crd != null,
        crd: hit.crd ?? null,
        firmName: hit.firmName ?? null,
        confidence: hit.confidence ?? "high",
        matchedOn: hit.matchedOn ?? ["name", "city", "state", "zip", "address"],
        candidates: hit.candidates ?? [],
        score: hit.score ?? 165,
        maxScore: 165,
        branchCount: hit.branchCount ?? 1,
        reason: hit.reason ?? null,
        business: hit.business ?? { placeId: "ChIJtest", name: hit.firmName ?? null, formattedAddress: "somewhere", phoneVerified: true, persistable: ["placeId"] },
      };
    },
  };
}

function person(name, extra = {}) {
  return {
    crd: extra.crd ?? 1000 + name.length,
    name,
    firstName: null,
    middleName: null,
    lastName: null,
    iaScope: "Active",
    isCurrentAtFirm: true,
    hasDisclosures: false,
    iaOnly: true,
    branchCity: "SAN RAFAEL",
    branchState: "CA",
    branchZip: "94901",
    ...extra,
  };
}

/** An iapd double. `roster` is what listFirmIndividuals returns; passing an Error makes the
 *  call reject, which is how the degradation path is exercised. */
function fakeIapd({ roster, individuals, search, profiles } = {}) {
  return {
    calls: [],
    async listFirmIndividuals(firmCrd, opts) {
      this.calls.push(["roster", firmCrd, opts]);
      if (roster instanceof Error) throw roster;
      const people = individuals || [];
      const current = people.filter((p) => p.isCurrentAtFirm);
      return roster || { total: people.length, currentCount: current.length, individuals: opts?.currentOnly ? current : people };
    },
    async getIndividual(crd) {
      this.calls.push(["individual", crd]);
      const profile = profiles?.[crd];
      if (profile instanceof Error) throw profile;
      if (!profile) throw new Error(`no profile ${crd}`);
      return profile;
    },
    async searchIndividualsByName(name, opts) {
      this.calls.push(["search", name, opts]);
      if (search instanceof Error) throw search;
      return search || [];
    },
  };
}

const depsFor = (store, iapd, extra = {}) => ({
  store,
  iapd,
  iapdOpts: { roster: { base: "test" }, individual: { base: "test" }, search: { base: "test" }, firm: { base: "test" } },
  config: { iapd: { siteBase: "https://adviserinfo.sec.gov" }, lookup: { defaultLimit: 10, maxLimit: 50, singlePersonMax: 1, fewCandidatesMax: 5 } },
  ...extra,
});

// ---------------------------------------------------------------------------
// namesMatch — POSITIVES
// ---------------------------------------------------------------------------

const POSITIVES = [
  // The exact shape the SEC publishes: Schedule A is "LAST, FIRST, MIDDLE", IAPD is natural order.
  ["LYLE, ALLAN, GLEN", "Allan Glen Lyle", "inverted vs natural order"],
  ["LYLE, ALLAN, GLEN", "Allan G Lyle", "middle initial vs full middle name"],
  ["SMITH, JOHN", "john smith", "case-insensitive"],
  ["DOE, JOHN, MICHAEL", "John Doe", "one side omitted the middle name entirely"],
  ["OBRIEN, MARY", "Mary O'Brien", "apostrophe is internal, not a separator"],
  ["GARCIA-LOPEZ, ANA", "Ana Garcia Lopez", "hyphenated surname vs the same surname glued"],
  ["GARCIA LOPEZ, ANA", "Ana Garcia-Lopez", "compound surname, the comma on the other side"],
  ["JOSE ANGEL RUIZ", "José Ángel Ruiz", "accents are stripped, not treated as different letters"],
  ["VAN DER BERG, JOHN", "John van der Berg", "surname particles rejoin the surname"],
  ["SMITH, JOHN JR", "John Smith Jr.", "same generational suffix on both sides"],
  ["WEISS, JEFFREY, CFP", "Jeff Weiss", "credential stripped, nickname resolved"],
  ["SMITH, ROBERT", "Bob Smith", "nickname"],
  ["SMITH, PAT", "Patricia Smith", "ambiguous nickname resolves to a compatible formal name"],
  ["J ROBERT SMITH", "John Robert Smith", "first initial corroborated by a full middle name"],
  ["SMITH, WILLIAM, H", "Bill H Smith", "nickname plus matching middle initial"],
  ["  MARY   ANN   JONES  ", "Jones, Mary Ann", "whitespace noise"],
  ["ANDERSON, KATHERINE, L", "Kathy L Anderson", "female nickname plus middle initial"],
];

for (const [a, b, why] of POSITIVES) {
  test(`namesMatch MATCHES: ${a} ~ ${b} (${why})`, () => {
    assert.equal(namesMatch(a, b), true, why);
    assert.equal(namesMatch(b, a), true, "must be symmetric");
  });
}

// ---------------------------------------------------------------------------
// namesMatch — NEGATIVES (these are the ones that protect someone's identity)
// ---------------------------------------------------------------------------

const NEGATIVES = [
  ["SMITH, JOHN", "Jane Smith", "two different people sharing a surname"],
  ["SMITH, JOHN", "John Smyth", "near-miss surname is still a different surname"],
  ["SMITH, JOHN, A", "John B Smith", "contradicting middle initial"],
  ["SMITH, JOHN, ALBERT", "John Bernard Smith", "contradicting full middle name"],
  ["SMITH, JOHN JR", "John Smith", "father and son: suffix on one side only"],
  ["SMITH, JOHN JR", "John Smith Sr", "father and son: different suffixes"],
  ["SMITH, JOHN III", "John Smith II", "third vs second generation"],
  ["SMITH, PATRICK", "Patricia Smith", "PAT bridges both, but the formal names must not bridge"],
  ["CHEN, CHRISTOPHER", "Christine Chen", "CHRIS bridges both, but the formal names must not bridge"],
  ["J SMITH", "John Smith", "bare first initial with nothing to corroborate it"],
  ["SMITH", "John Smith", "a surname alone is not a person"],
  ["", "John Smith", "empty string"],
  [null, "John Smith", "null"],
  ["ACME HOLDINGS LLC", "John Smith", "an entity owner on Schedule A is not the adviser"],
  ["SMITH-JONES, MARY", "Mary Smith", "double-barrelled surname is not the first half of it"],
  ["SMITH-JONES, MARY", "Mary Jones", "double-barrelled surname is not the second half of it"],
  ["LOPEZ, ANA MARIA", "Ana Lucia Lopez", "same first name, different second given name"],
  // The compound-surname readings must not leak in the other direction.
  ["GARCIALOPEZ, ANA", "Ana Lopez", "a compound surname is not its tail"],
  ["GARCIALOPEZ, ANA", "Ana Garcia", "a compound surname is not its head"],
  ["GARCIA LOPEZ, ANA", "Ana Garcia Ruiz", "sharing one surname token is not sharing a surname"],
];

for (const [a, b, why] of NEGATIVES) {
  test(`namesMatch REFUSES: ${JSON.stringify(a)} vs ${b} (${why})`, () => {
    assert.equal(namesMatch(a, b), false, why);
    assert.equal(namesMatch(b, a), false, "must be symmetric");
  });
}

test("parseName splits both SEC orders onto the same parts", () => {
  const inverted = parseName("LYLE, ALLAN, GLEN");
  const natural = parseName("Allan Glen Lyle");
  assert.deepEqual(
    { first: inverted.first, middles: inverted.middles, last: inverted.last },
    { first: "ALLAN", middles: ["GLEN"], last: "LYLE" },
  );
  assert.equal(natural.last, inverted.last);
  assert.equal(natural.first, inverted.first);
  assert.equal(inverted.display, "ALLAN GLEN LYLE", "display form is usable in a pick-list");
});

test("parseName treats a trailing single letter as a middle initial, not a surname", () => {
  const parsed = parseName("JOHN SMITH V");
  assert.equal(parsed.last, "SMITH");
  assert.deepEqual(parsed.middles, ["V"]);
});

// ---------------------------------------------------------------------------
// resolveByPhone — outcome branches
// ---------------------------------------------------------------------------

test("invalid phone: outcome invalid_phone, no firms, no candidates", async () => {
  const result = await resolveByPhone("555", depsFor(makeStore([]), fakeIapd()));
  assert.equal(result.outcome, "invalid_phone");
  assert.equal(result.confidence, "none");
  assert.equal(result.nextStep, "enter_name");
  assert.deepEqual(result.query, { raw: "555", national10: null, valid: false });
  assert.deepEqual(result.firms, []);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.verificationRequired, true);
  assert.ok(result.attribution.sourceUrl.includes("adviserinfo.sec.gov"));
});

test("invalid phone: a foreign number is named as such rather than blamed on length", async () => {
  const result = await resolveByPhone("+44 20 7946 0958", depsFor(makeStore([]), fakeIapd()));
  assert.equal(result.outcome, "invalid_phone");
  assert.equal(result.phoneReason, "non_nanp_country");
});

test("no firm on that number: no_match / none / enter_name", async () => {
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([]), fakeIapd()));
  assert.equal(result.outcome, "no_match");
  assert.equal(result.confidence, "none");
  assert.equal(result.nextStep, "enter_name");
  assert.equal(result.query.national10, "4154929240");
  assert.equal(result.query.valid, true);
});

test("an unreachable Cloud SQL degrades to no_match and SAYS the database failed", async () => {
  const store = makeStore([], { error: new Error("ECONNREFUSED 127.0.0.1:5439") });
  const result = await resolveByPhone("415-492-9240", depsFor(store, fakeIapd()));
  assert.equal(result.outcome, "no_match");
  assert.match(result.notes.join(" "), /could not be read/i);
  assert.match(result.notes.join(" "), /ECONNREFUSED/);
  assert.equal(result.sources.formAdv.error.includes("ECONNREFUSED"), true);
});

test("Cloud SQL alone is MEDIUM confidence, and the response says how old the mapping is", async () => {
  const firm = firmRecord();
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const result = await resolveByPhone("(415) 492-9240", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "single_person");
  // One live source that nothing corroborated. It used to say "high" on the strength of a
  // snapshot alone.
  assert.equal(result.confidence, "medium");
  assert.deepEqual(result.firmMatch.matchedOn, ["form_adv"]);
  assert.equal(result.freshness.ageDays, 8);
  assert.match(result.notes.join(" "), /8 days old/);
  // The DUAL-IDENTITY contract: in the default mode=auto a resolved firm is itself a claim
  // target, so the next step is "which of these two are you?", not "confirm the person".
  // personNextStep preserves the step the person-only flow would have taken.
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.personNextStep, "confirm");
  assert.equal(result.firmClaim.crd, 10603);
  assert.equal(result.individualClaims.length, 1);
  assert.equal(result.firms.length, 1);
  assert.equal(result.firms[0].crd, 10603);
  assert.equal(result.candidates.length, 1);

  const candidate = result.candidates[0];
  assert.equal(candidate.individualCrd, 2749311);
  assert.equal(candidate.firmCrd, 10603);
  assert.equal(candidate.title, "OWNER CHIEF COMPLIANCE OFFICER");
  assert.equal(candidate.profileUrl, "https://adviserinfo.sec.gov/individual/summary/2749311");
  // Every signal fires: Schedule A + sole adviser + ownership E + OWNER title + clean record.
  assert.equal(candidate.score, 100);
  assert.ok(candidate.reasons.length >= 4);
  assert.match(candidate.reasons.join(" | "), /Schedule A/);
  assert.match(candidate.reasons.join(" | "), /only adviser/i);

  // The roster call must pass a NUMBER crd and a page window. It must NOT pass currentOnly:
  // iapd.mjs applies that filter AFTER mapping, so a page of mostly-former employees would
  // look like the end of the roster and stop the paging early (see F8 / fetchRoster).
  assert.deepEqual(iapd.calls[0].slice(0, 2), ["roster", 10603]);
  assert.equal(iapd.calls[0][2].currentOnly, undefined);
  assert.equal(iapd.calls[0][2].start, 0);
  assert.equal(typeof iapd.calls[0][2].limit, "number");
  assert.equal(iapd.calls[0][2].base, "test", "transport opts must reach the client");
  // Former employees are filtered here, and the counts are reported separately and honestly.
  assert.equal(result.currentAdviserCount, 1);
  assert.equal(result.rosterTruncated, false);
});

test("scoring: the same person without any Schedule A entry scores far lower", async () => {
  const firm = firmRecord({ scheduleAPersons: [] });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const result = await resolveByPhone("4154929240", depsFor(makeStore([firm]), iapd));
  assert.equal(result.outcome, "single_person");
  const expected = Math.round(((SIGNALS.SOLE_ADVISER + SIGNALS.NO_DISCLOSURES) / 90) * 100);
  assert.equal(result.candidates[0].score, expected);
  assert.equal(result.candidates[0].title, null);
});

test("scoring: a disclosure event costs the clean-record points and is stated in reasons", async () => {
  const firm = firmRecord();
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 7, hasDisclosures: true })] });
  const result = await resolveByPhone("4154929240", depsFor(makeStore([firm]), iapd));
  assert.equal(result.candidates[0].score, Math.round((85 / 90) * 100));
  assert.match(result.candidates[0].reasons.join(" | "), /disclosure events/i);
});

test("2-5 current advisers: few_candidates / medium / pick_person, Schedule A ranked first", async () => {
  const firm = firmRecord({
    crd: 300,
    name: "YANNI & ASSOCIATES INVESTMENT ADVISORS",
    phone10: "7245551212",
    scheduleAPersons: [{ name: "YANNI, MICHAEL, J", title: "PRESIDENT", ownershipCode: "F", isControlPerson: true }],
  });
  const iapd = fakeIapd({
    individuals: [
      person("Alice Baker", { crd: 11 }),
      person("Michael J Yanni", { crd: 12 }),
      person("Carol Dunn", { crd: 13, hasDisclosures: true }),
    ],
  });
  const result = await resolveByPhone("724-555-1212", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "few_candidates");
  assert.equal(result.confidence, "medium");
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.personNextStep, "pick_person");
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0].name, "Michael J Yanni", "the Schedule A president outranks the others");
  assert.ok(result.candidates[0].score > result.candidates[1].score);
  assert.equal(result.candidates[2].name, "Carol Dunn", "the disclosure event breaks the tie downward");
  assert.match(explain(result), /is one of these 3 advisers you\?$/);
});

test("more than five advisers: large_firm / low / enter_name, and only Schedule A officers are named", async () => {
  const firm = firmRecord({
    crd: 400,
    name: "BIG WEALTH LLC",
    phone10: "2125550100",
    scheduleAPersons: [{ name: "REED, SUSAN", title: "MANAGING PARTNER", ownershipCode: "D", isControlPerson: true }],
  });
  const individuals = ["Susan Reed", "Adam One", "Beth Two", "Carl Three", "Dana Four", "Eli Five", "Fay Six"]
    .map((name, i) => person(name, { crd: 500 + i }));
  const result = await resolveByPhone("212-555-0100", depsFor(makeStore([firm]), fakeIapd({ individuals })));

  assert.equal(result.outcome, "large_firm");
  assert.equal(result.confidence, "low");
  // One Schedule A officer survived the size gate, so there IS an identity to choose.
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.personNextStep, "enter_name");
  assert.equal(result.firms.length, 1, "the firm is still returned");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, "Susan Reed");
  assert.equal(result.withheldForSize, 6);
});

test("a big firm with nobody on Schedule A names NOBODY", async () => {
  const firm = firmRecord({ crd: 401, name: "MORGAN STANLEY", phone10: "9142251000", scheduleAPersons: [] });
  const individuals = Array.from({ length: 60 }, (_, i) => person(`Adviser Number${i}`, { crd: 9000 + i }));
  const result = await resolveByPhone("914-225-1000", depsFor(makeStore([firm]), fakeIapd({ individuals })));

  assert.equal(result.outcome, "large_firm");
  // Nobody is named, so the only claim target left is the firm itself. The person route is
  // still published, unchanged, as personNextStep.
  assert.equal(result.nextStep, "confirm_firm");
  assert.equal(result.personNextStep, "enter_name");
  assert.deepEqual(result.individualClaims, [], "a switchboard number must not return a list of strangers");
  assert.deepEqual(result.candidates, [], "a switchboard number must not return a list of strangers");
  assert.match(result.notes.join(" "), /identifies the firm, not a person/);
});

test("several firms on one number: ambiguous_firm / low / pick_firm, and NO people", async () => {
  const firms = [
    firmRecord({ crd: 1, name: "LORD ABBETT CLO MANAGEMENT LP", phone10: "2018272000", effectiveAdviserCount: 4 }),
    firmRecord({ crd: 2, name: "LORD ABBETT FIF ADVISOR LLC", phone10: "2018272000", effectiveAdviserCount: 9 }),
    firmRecord({ crd: 3, name: "LORD, ABBETT & CO. LLC", phone10: "2018272000", effectiveAdviserCount: 300 }),
  ];
  const iapd = fakeIapd({ individuals: [person("Someone Here")] });
  const result = await resolveByPhone("201-827-2000", depsFor(makeStore(firms), iapd));

  assert.equal(result.outcome, "ambiguous_firm");
  assert.equal(result.confidence, "low");
  assert.equal(result.nextStep, "pick_firm");
  assert.equal(result.firms.length, 3);
  assert.deepEqual(result.candidates, [], "naming people would name people at firms that are not the claimant's");
  assert.equal(iapd.calls.length, 0, "no upstream call is needed to ask which firm it is");
  // Firm summaries carry a COUNT of Schedule A people, never their names, on this path.
  assert.equal(result.firms[0].scheduleAPersonCount, 1);
  assert.equal(result.firms[0].scheduleAPersons, undefined);
});

// ---------------------------------------------------------------------------
// degradation
// ---------------------------------------------------------------------------

test("IAPD failure NEVER throws: degrades to the firm plus its Schedule A officers", async () => {
  const firm = firmRecord();
  const iapd = fakeIapd({ roster: new Error("IAPD request timed out after 8000ms") });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "large_firm");
  assert.equal(result.confidence, "low");
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.personNextStep, "enter_name");
  assert.equal(result.firms.length, 1);
  assert.match(result.rosterError, /timed out/);
  assert.equal(result.candidates.length, 1);
  // Named from Form ADV, but with NO crd and NO profile link: we can tell the claimant who
  // the firm disclosed without offering them a record to claim.
  assert.equal(result.candidates[0].individualCrd, null);
  assert.equal(result.candidates[0].profileUrl, null);
  assert.equal(result.candidates[0].name, "ALLAN GLEN LYLE");
  assert.equal(result.candidates[0].disclosedName, "LYLE, ALLAN, GLEN");
  assert.match(result.candidates[0].reasons.join(" | "), /Could not reach the SEC IAPD adviser roster/);
  assert.match(explain(result), /not responding right now/);
});

test("a missing iapd client is treated as an outage, not a crash", async () => {
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firmRecord()]), {}));
  assert.equal(result.outcome, "large_firm");
  assert.match(result.rosterError, /unavailable/i);
});

test("firm matched but the SEC lists nobody currently registered there", async () => {
  const firm = firmRecord();
  const iapd = fakeIapd({ roster: { total: 3, currentCount: 0, individuals: [] } });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "large_firm");
  assert.equal(result.currentAdviserCount, 0);
  assert.equal(result.candidates.length, 1, "Schedule A still answers 'whose firm is this'");
  assert.equal(result.candidates[0].individualCrd, null);
  assert.match(explain(result), /no advisers currently registered/);
});

// The Schedule A fallback is gated on the firm's OWN reported size. This is the real
// 914-225-1000 case: CONSULTING GROUP ADVISORY SERVICES LLC (a Morgan Stanley entity, 9
// IARs) has an empty IAPD roster, and without the gate a corporate switchboard number
// returned its CEO, two directors and its CCO by name.
test("a 9-adviser firm with an empty roster names NOBODY from Schedule A", async () => {
  const firm = firmRecord({
    crd: 137463,
    name: "CONSULTING GROUP ADVISORY SERVICES LLC",
    phone10: "9142251000",
    iarCount: 9,
    advisoryEmployees: 9,
    effectiveAdviserCount: 9,
    scheduleAPersons: [
      { name: "RICCIARDELLI, PAUL, EMMANUEL", title: "DIRECTOR, CHIEF EXECUTIVE OFFICER AND PRESIDENT", ownershipCode: null, isControlPerson: true },
      { name: "ROBERTS, GARY, RYAN", title: "CHIEF COMPLIANCE OFFICER", ownershipCode: null, isControlPerson: true },
    ],
  });
  const iapd = fakeIapd({ roster: { total: 0, currentCount: 0, individuals: [] } });
  const result = await resolveByPhone("914-225-1000", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "large_firm");
  assert.equal(result.nextStep, "confirm_firm");
  assert.equal(result.personNextStep, "enter_name");
  assert.equal(result.firms.length, 1, "the firm itself is still a useful answer");
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.individualClaims, []);
  assert.match(result.notes.join(" "), /identifies the firm, not a person/);
});

test("the same gate applies when IAPD is down, and fails CLOSED on an unknown headcount", async () => {
  const big = firmRecord({ crd: 700, phone10: "2125550199", effectiveAdviserCount: 40, advisoryEmployees: 40 });
  const unknown = firmRecord({ crd: 701, phone10: "2125550198", effectiveAdviserCount: null, advisoryEmployees: null });
  const outage = () => fakeIapd({ roster: new Error("IAPD 503") });

  const bigResult = await resolveByPhone("212-555-0199", depsFor(makeStore([big]), outage()));
  assert.deepEqual(bigResult.candidates, []);

  const unknownResult = await resolveByPhone("212-555-0198", depsFor(makeStore([unknown]), outage()));
  assert.deepEqual(unknownResult.candidates, [], "an unstated headcount is not evidence of smallness");
  assert.match(unknownResult.notes.join(" "), /unstated number/);
});

test("Schedule A boost is withheld when the name is ambiguous on either side", async () => {
  const firm = firmRecord({
    crd: 500,
    phone10: "6125550111",
    scheduleAPersons: [{ name: "SMITH, JOHN", title: "PRESIDENT", ownershipCode: "E", isControlPerson: true }],
  });
  const iapd = fakeIapd({ individuals: [person("John Smith", { crd: 21 }), person("John Smith", { crd: 22 }), person("Ann Ray", { crd: 23 })] });
  const result = await resolveByPhone("612-555-0111", depsFor(makeStore([firm]), iapd));

  assert.equal(result.outcome, "few_candidates");
  for (const candidate of result.candidates) {
    assert.equal(candidate.title, null, "one Schedule A line matching two people identifies neither");
    assert.ok(candidate.score < 44, `expected no Schedule A boost, got ${candidate.score}`);
  }
});

test("the candidate list honours deps.limit", async () => {
  const firm = firmRecord({ crd: 600, phone10: "3035550100", scheduleAPersons: [] });
  const individuals = [person("A One", { crd: 1 }), person("B Two", { crd: 2 }), person("C Three", { crd: 3 })];
  const result = await resolveByPhone("303-555-0100", depsFor(makeStore([firm]), fakeIapd({ individuals }), { limit: 2 }));
  assert.equal(result.outcome, "few_candidates");
  assert.equal(result.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

test("explain returns one sentence for every outcome and never throws", () => {
  const samples = [
    { outcome: "invalid_phone", notes: ["That number is too short to be a US or Canadian phone number."] },
    { outcome: "no_match", query: { national10: "4154929240" } },
    { outcome: "ambiguous_firm", firms: [{ name: "A LLC" }, { name: "B LLC" }, { name: "C LLC" }, { name: "D LLC" }] },
    { outcome: "single_person", firms: [{ name: "LYLE & FORSYTH" }], candidates: [{ name: "Allan Glen Lyle" }] },
    { outcome: "few_candidates", firms: [{ name: "YANNI & ASSOCIATES" }], candidates: [{}, {}], currentAdviserCount: 2 },
    { outcome: "large_firm", firms: [{ name: "MORGAN STANLEY" }], currentAdviserCount: 100 },
  ];
  for (const sample of samples) {
    const sentence = explain(sample);
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 20, `too short for ${sample.outcome}: ${sentence}`);
  }
  assert.match(explain(samples[4]), /is one of these 2 advisers you\?/);
  assert.match(explain(samples[2]), /4 advisory firms/);
});

test("explain survives garbage rather than costing the caller the whole response", () => {
  for (const input of [undefined, null, {}, { outcome: "something_new" }, { outcome: "single_person", firms: null, candidates: null }]) {
    const sentence = explain(input);
    assert.equal(typeof sentence, "string");
    assert.ok(sentence.length > 0);
  }
});

// ---------------------------------------------------------------------------
// searchByName
// ---------------------------------------------------------------------------

test("searchByName returns candidates with the firm hydrated from the profile", async () => {
  const firm = firmRecord({ crd: 10603 });
  const iapd = fakeIapd({
    search: [person("Allan Glen Lyle", { crd: 2749311, branchCity: "SAN RAFAEL", branchState: "CA" })],
    profiles: {
      2749311: { crd: 2749311, name: "Allan Glen Lyle", currentEmployments: [{ firmCrd: 10603, firmName: "LYLE, ALLAN GLEN" }] },
    },
  });
  const result = await searchByName("Allan Lyle", depsFor(makeStore([firm]), iapd, { state: "CA", limit: 5 }));

  assert.equal(result.total, 1);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.individualCrd, 2749311);
  assert.equal(candidate.firmCrd, 10603);
  assert.equal(candidate.firmName, "LYLE, ALLAN GLEN");
  assert.equal(candidate.title, "OWNER CHIEF COMPLIANCE OFFICER");
  assert.ok(candidate.score >= 44, "the Schedule A match must survive the name-search path too");
  assert.equal(iapd.calls[0][2].state, "CA", "the state filter reaches IAPD");
});

test("searchByName still lists a person whose profile will not load", async () => {
  const iapd = fakeIapd({
    search: [person("Jane Doe", { crd: 99 })],
    profiles: { 99: new Error("IAPD 503") },
  });
  const result = await searchByName("Jane Doe", depsFor(makeStore([]), iapd));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].firmCrd, null);
  assert.match(result.candidates[0].reasons.join(" | "), /Could not load the full SEC profile/);
});

test("searchByName PROPAGATES an IAPD outage instead of reporting 'no such adviser'", async () => {
  const iapd = fakeIapd({ search: new Error("IAPD request failed") });
  await assert.rejects(() => searchByName("Jane Doe", depsFor(makeStore([]), iapd)), /IAPD request failed/);
});

// ===========================================================================
// F4 — namesMatch bridged two DIFFERENT nicknames through one shared formal name
// ===========================================================================
//
// Demonstrated end to end against the shipped build: it named the WRONG adviser as a 50-75%
// owner and Managing Partner at a firm where everyone else was withheld. Sharing a formal
// name is not evidence of being the same person — a firm can hold both a Jack and a Jon.

const ALIAS_COLLISIONS = [
  ["Jon Smith", "Jack Smith", "both are Johns"],
  ["Ted Smith", "Ed Smith", "both are Edwards"],
  ["Bob Smith", "Rob Smith", "both are Roberts"],
  ["Bill Smith", "Will Smith", "both are Williams"],
  ["Beth Smith", "Betty Smith", "both are Elizabeths"],
  ["Kate Smith", "Kathy Smith", "both are Katherines"],
  ["Dick Smith", "Rich Smith", "both are Richards"],
  ["Jim Smith", "Jamie Smith", "both are Jameses"],
  ["Sue Smith", "Suzy Smith", "both are Susans"],
  // The same rule, in the other direction and with more of the table:
  ["Bobby Smith", "Robbie Smith", "two diminutives of Robert"],
  ["Mike Smith", "Mick Smith", "two diminutives of Michael"],
  ["Tom Smith", "Tommy Smith", "two diminutives of Thomas"],
  ["Chuck Smith", "Charlie Smith", "two diminutives of Charles"],
  ["Andy Smith", "Drew Smith", "two diminutives of Andrew"],
  ["Meg Smith", "Peggy Smith", "two diminutives of Margaret"],
  ["Jen Smith", "Jenny Smith", "two diminutives of Jennifer"],
  ["Deb Smith", "Debbie Smith", "two diminutives of Deborah"],
  ["Gerry Smith", "Jerry Smith", "two diminutives of Gerald"],
  ["Vicki Smith", "Vicky Smith", "two spellings of one diminutive of Victoria"],
  ["Ken Smith", "Kenny Smith", "two diminutives of Kenneth"],
];

for (const [a, b, why] of ALIAS_COLLISIONS) {
  test(`namesMatch REFUSES "${a}" vs "${b}" (${why})`, () => {
    assert.equal(namesMatch(a, b), false);
    assert.equal(namesMatch(b, a), false, "and it is symmetric");
  });
}

const ALIAS_TO_FORMAL = [
  ["Jon Smith", "John Smith"],
  ["Jon Smith", "Jonathan Smith"],
  ["Jack Smith", "John Smith"],
  ["Ted Smith", "Edward Smith"],
  ["Ted Smith", "Theodore Smith"],
  ["Ed Smith", "Edward Smith"],
  ["Bob Smith", "Robert Smith"],
  ["Rob Smith", "Robert Smith"],
  ["Bill Smith", "William Smith"],
  ["Will Smith", "William Smith"],
  ["Beth Smith", "Elizabeth Smith"],
  ["Betty Smith", "Elizabeth Smith"],
  ["Kate Smith", "Katherine Smith"],
  ["Kathy Smith", "Kathleen Smith"],
  ["Dick Smith", "Richard Smith"],
  ["Rich Smith", "Richard Smith"],
  ["Jim Smith", "James Smith"],
  ["Jamie Smith", "James Smith"],
  ["Sue Smith", "Susan Smith"],
  ["Suzy Smith", "Susan Smith"],
  // Through a spelling variant of the formal name, which must still work.
  ["Steve Smith", "Steven Smith"],
  ["Steve Smith", "Stephen Smith"],
  ["Phil Smith", "Philip Smith"],
  ["Phil Smith", "Phillip Smith"],
  ["Jeff Smith", "Jeffrey Smith"],
  ["Jeff Smith", "Jeffery Smith"],
];

for (const [alias, formal] of ALIAS_TO_FORMAL) {
  test(`namesMatch still accepts "${alias}" vs "${formal}" (an alias reaching its own formal)`, () => {
    assert.equal(namesMatch(alias, formal), true);
    assert.equal(namesMatch(formal, alias), true);
  });
}

test("two FORMAL names that are one name spelled two ways still match", () => {
  assert.equal(namesMatch("Steven Smith", "Stephen Smith"), true);
  assert.equal(namesMatch("Philip Smith", "Phillip Smith"), true);
  assert.equal(namesMatch("Jeffrey Smith", "Jeffery Smith"), true);
  assert.equal(namesMatch("Teresa Smith", "Theresa Smith"), true);
});

test("the gendered pairs the SET model already protected are still refused", () => {
  assert.equal(namesMatch("Patrick Smith", "Patricia Smith"), false);
  assert.equal(namesMatch("Christopher Smith", "Christine Smith"), false);
  assert.equal(namesMatch("Samuel Smith", "Samantha Smith"), false);
  assert.equal(namesMatch("Alexander Smith", "Alexandra Smith"), false);
  // ...and an alias may still reach either formal, which is the point of the set model.
  assert.equal(namesMatch("Pat Smith", "Patrick Smith"), true);
  assert.equal(namesMatch("Pat Smith", "Patricia Smith"), true);
});

test("F4 end to end: the wrong adviser is no longer offered a stranger's Schedule A profile", async () => {
  // One Schedule A owner, "SMITH, JON", and a roster holding a DIFFERENT person, Jack Smith.
  // The shipped build paired them and handed Jack a 50-75% ownership claim on Jon's line.
  const firm = firmRecord({
    crd: 4242,
    phone10: "4155550101",
    advisoryEmployees: 9,
    effectiveAdviserCount: 9,
    scheduleAPersons: [{ name: "SMITH, JON", title: "MANAGING PARTNER", ownershipCode: "E" }],
  });
  const individuals = [
    person("Jack Smith", { crd: 111 }),
    ...Array.from({ length: 7 }, (_, i) => person(`Other Person${i}`, { crd: 200 + i })),
  ];
  const result = await resolveByPhone("415-555-0101", depsFor(makeStore([firm]), fakeIapd({ individuals })));

  assert.equal(result.outcome, "large_firm");
  assert.deepEqual(result.candidates, [], "nobody may be named on this evidence");
  assert.match(result.notes.join(" "), /No adviser is named individually/);
});

// ===========================================================================
// F2 — a reported headcount of 0 was treated as "a small firm"
// ===========================================================================

test("F2: a filed headcount of ZERO withholds Schedule A, exactly like an unstated one", async () => {
  // The real case: phone 212-969-1000 is ALLIANCEBERNSTEIN CORPORATION (CRD 107445), which
  // files 0 advisory employees and discloses 14 Schedule A persons. The shipped gate read
  // `headcount ?? null` then `headcount > few`, so 0 was neither null nor > 5 and fell into
  // the naming branch — the switchboard number returned the firm's entire board by name.
  const firm = firmRecord({
    crd: 107445,
    name: "ALLIANCEBERNSTEIN CORPORATION",
    phone10: "2129691000",
    advisoryEmployees: 0,
    effectiveAdviserCount: 0,
    totalEmployees: 0,
    scheduleAPersons: [
      { name: "HOLLOWAY, ROBERT", title: "CHAIRMAN", ownershipCode: "F" },
      { name: "DOE, JANE", title: "CHIEF EXECUTIVE OFFICER", ownershipCode: "E" },
      { name: "ROE, RICHARD", title: "DIRECTOR", ownershipCode: "A" },
    ],
  });
  // Empty live roster — the path where the Schedule A fallback is reached.
  const result = await resolveByPhone("212-969-1000", depsFor(makeStore([firm]), fakeIapd({ individuals: [] })));

  assert.deepEqual(result.candidates, [], "a filed 0 is not evidence of smallness");
  const wire = JSON.stringify(result);
  for (const name of ["HOLLOWAY", "CHAIRMAN", "JANE", "CHIEF EXECUTIVE", "RICHARD", "DIRECTOR"]) {
    assert.equal(wire.includes(name), false, `"${name}" must not appear anywhere in the response`);
  }
  assert.match(result.notes.join(" "), /reports no advisory staff/);
  assert.match(result.notes.join(" "), /not evidence/);
});

test("F2: the gate distinguishes a filed 0 from an unstated headcount in its wording", async () => {
  const zero = firmRecord({ advisoryEmployees: 0, effectiveAdviserCount: 0, scheduleAPersons: [{ name: "DOE, JANE", title: "CEO" }] });
  const unstated = firmRecord({ advisoryEmployees: null, effectiveAdviserCount: null, scheduleAPersons: [{ name: "DOE, JANE", title: "CEO" }] });
  const deps = depsFor(makeStore([]), fakeIapd());

  const zeroGate = scheduleAFallback(zero, deps);
  const unstatedGate = scheduleAFallback(unstated, deps);
  assert.equal(zeroGate.withheld, true);
  assert.equal(unstatedGate.withheld, true);
  assert.match(zeroGate.note, /reports no advisory staff/);
  assert.match(unstatedGate.note, /unstated number/);
});

test("F2: every non-positive and non-numeric headcount fails CLOSED", async () => {
  const deps = depsFor(makeStore([]), fakeIapd());
  const people = [{ name: "DOE, JANE", title: "CEO" }];
  for (const headcount of [0, -1, null, undefined, "", "many", NaN, 6, 500]) {
    const gate = scheduleAFallback(firmRecord({ effectiveAdviserCount: headcount, advisoryEmployees: headcount, scheduleAPersons: people }), deps);
    assert.deepEqual(gate.candidates, [], `headcount ${JSON.stringify(headcount)} must name nobody`);
    assert.equal(gate.withheld, true);
  }
  // ...and a genuinely small, genuinely stated firm still gets its answer.
  const small = scheduleAFallback(firmRecord({ effectiveAdviserCount: 2, advisoryEmployees: 2, scheduleAPersons: people }), deps);
  assert.equal(small.candidates.length, 1);
  assert.equal(small.withheld, false);
});

// ===========================================================================
// F1 — the firm projection must never carry a person name
// ===========================================================================

test("F1: toFirmSummary emits firm facts only, and a Schedule A COUNT", () => {
  const firm = firmRecord({
    scheduleAPersons: [
      { name: "LYLE, ALLAN, GLEN", title: "OWNER", ownershipCode: "E" },
      { name: "KOWALSKI, IAN", title: "PRESIDENT", ownershipCode: "D" },
    ],
  });
  const summary = toFirmSummary(firm, { config: { iapd: { siteBase: "https://adviserinfo.sec.gov" } } });

  assert.deepEqual(Object.keys(summary).sort(), [...FIRM_SUMMARY_KEYS].sort());
  assert.equal(summary.scheduleAPersonCount, 2);
  assert.equal("scheduleAPersons" in summary, false);

  const wire = JSON.stringify(summary);
  for (const leak of ["KOWALSKI", "IAN", "PRESIDENT", "ownershipCode", "isControlPerson"]) {
    assert.equal(wire.includes(leak), false, `"${leak}" leaked out of the firm projection`);
  }
});

test("F1: a source that cannot say reports scheduleAPersonCount NULL, not 0", () => {
  // The live Cloud SQL Form ADV feed carries no Schedule A at all. Reporting 0 would assert
  // that the firm has no disclosed owners, which is a claim that source does not make.
  const fromDb = firmRecord();
  delete fromDb.scheduleAPersons;
  const summary = toFirmSummary(fromDb, {});
  assert.equal(summary.scheduleAPersonCount, null);
});

test("F1: no firm ever reaches the wire un-projected, on any outcome", async () => {
  const withOwners = (crd, phone10) =>
    firmRecord({
      crd,
      phone10,
      scheduleAPersons: [{ name: "SECRET, PERSON", title: "MANAGING PARTNER", ownershipCode: "F" }],
    });

  const cases = [
    // ambiguous_firm — two firms on one number
    ["415-555-0202", makeStore([withOwners(1, "4155550202"), withOwners(2, "4155550202")]), fakeIapd()],
    // large_firm — an empty roster at a firm too big to name anyone
    ["415-555-0203", makeStore([{ ...withOwners(3, "4155550203"), advisoryEmployees: 40, effectiveAdviserCount: 40 }]), fakeIapd({ individuals: [] })],
    // roster outage
    ["415-555-0204", makeStore([{ ...withOwners(4, "4155550204"), advisoryEmployees: 40, effectiveAdviserCount: 40 }]), fakeIapd({ roster: new Error("IAPD 503") })],
  ];

  for (const [phone, store, iapd] of cases) {
    const result = await resolveByPhone(phone, depsFor(store, iapd));
    for (const firm of result.firms) {
      assert.equal("scheduleAPersons" in firm, false);
      assert.equal(typeof firm.scheduleAPersonCount, "number");
    }
    assert.equal(JSON.stringify(result.firms).includes("SECRET"), false, `${phone} leaked a Schedule A name`);
  }
});

// ===========================================================================
// F8 — the roster saturated at one page and reported IAPD's match count as a roster
// ===========================================================================

/** A paging-aware IAPD double: honours start/limit and reports a total larger than one page. */
function pagingIapd(total, currentEvery = 1) {
  const all = Array.from({ length: total }, (_, i) =>
    person(`Person Number${i}`, { crd: 10_000 + i, isCurrentAtFirm: i % currentEvery === 0 }),
  );
  return {
    calls: [],
    async listFirmIndividuals(firmCrd, opts) {
      this.calls.push(["roster", firmCrd, opts]);
      const start = Number(opts?.start) || 0;
      const limit = Number(opts?.limit) || 100;
      const page = all.slice(start, start + limit);
      return { total: all.length, currentCount: page.filter((p) => p.isCurrentAtFirm).length, individuals: page };
    },
    async getIndividual() {
      throw new Error("not used");
    },
    async searchIndividualsByName() {
      return [];
    },
  };
}

test("F8: the roster PAGES instead of saturating at 100", async () => {
  const firm = firmRecord({ crd: 793, phone10: "2125550777", advisoryEmployees: 3388, effectiveAdviserCount: 3388 });
  const iapd = pagingIapd(250);
  const result = await resolveByPhone("212-555-0777", depsFor(makeStore([firm]), iapd, { config: bigConfig() }));

  assert.equal(iapd.calls.length, 3, "three pages of 100, up to rosterMaxRows");
  assert.deepEqual(iapd.calls.map((c) => c[2].start), [0, 100, 200]);
  assert.equal(result.currentAdviserCount, 250, "the shipped code reported 100");
  assert.equal(result.rosterTruncated, false);
});

test("F8: rosterTotal is gone; the raw match count is NAMED as including former employees", async () => {
  const firm = firmRecord({ crd: 793, phone10: "2125550778", advisoryEmployees: 3388, effectiveAdviserCount: 3388 });
  // 5039 matches, of which only every third row is current — exactly the CRD 793 shape.
  const iapd = pagingIapd(5039, 3);
  const result = await resolveByPhone("212-555-0778", depsFor(makeStore([firm]), iapd, { config: bigConfig() }));

  assert.equal("rosterTotal" in result, false, "the misleading field must not come back");
  assert.equal(result.rosterMatchesIncludingFormer, 5039);
  assert.match(result.rosterMatchesNote, /INCLUDES former employees/);
  assert.equal(result.rosterTruncated, true);
  assert.equal(result.currentAdviserCount, 100, "current people in the 300 rows we fetched");
  assert.match(result.notes.join(" "), /At least 100 advisers/);
  assert.match(explain(result), /at least 100 advisers/i);
});

test("F8: paging stops at rosterMaxRows and never spends more than the budget allows", async () => {
  const firm = firmRecord({ crd: 793, phone10: "2125550779", advisoryEmployees: 3388, effectiveAdviserCount: 3388 });
  const iapd = pagingIapd(5039);
  const budget = new UpstreamBudget(2);
  const result = await resolveByPhone("212-555-0779", depsFor(makeStore([firm]), iapd, { config: bigConfig(), budget }));
  assert.ok(iapd.calls.length <= 2, `spent ${iapd.calls.length} upstream calls against a budget of 2`);
  assert.equal(result.rosterTruncated, true);
});

function bigConfig() {
  return {
    iapd: { siteBase: "https://adviserinfo.sec.gov", rosterPageSize: 100, rosterMaxRows: 300 },
    lookup: { defaultLimit: 10, maxLimit: 50, singlePersonMax: 1, fewCandidatesMax: 5 },
  };
}

// ===========================================================================
// LIVE-SOURCE FUSION — Cloud SQL x Google Places
// ===========================================================================

test("fusion: both sources agree -> HIGH, matchedOn form_adv + places", async () => {
  const firm = firmRecord({ crd: 2907, phone10: "8142386249", name: "NESTLERODE & LOY, INC." });
  const places = makePlaces({ "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC." } });
  const iapd = fakeIapd({ individuals: [person("Judy Loy", { crd: 2249019 })] });

  const result = await resolveByPhone("814-238-6249", depsFor(makeStore([firm]), iapd, { places }));
  assert.equal(result.outcome, "single_person");
  assert.equal(result.confidence, "high");
  assert.deepEqual(result.firmMatch.matchedOn, ["form_adv", "places"]);
  assert.equal(result.sources.places.crd, 2907);
  assert.equal(result.sources.formAdv.matched, true);
});

test("fusion: Places only (Cloud SQL misses) -> MEDIUM, matchedOn places", async () => {
  const places = makePlaces({ "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC." } });
  const iapd = {
    ...fakeIapd({ individuals: [person("Judy Loy", { crd: 2249019 })] }),
    async getFirm(crd) {
      return { crd, name: "NESTLERODE & LOY, INC.", secNumber: "801-112333", isIaFirm: true, officeAddress: { city: "STATE COLLEGE", state: "PA" }, registrationStatus: [] };
    },
  };
  const result = await resolveByPhone("814-238-6249", depsFor(makeStore([]), iapd, { places }));
  assert.equal(result.firms.length, 1);
  assert.equal(result.firms[0].crd, 2907);
  assert.deepEqual(result.firmMatch.matchedOn, ["places"]);
  assert.equal(result.confidence, "medium");
  assert.match(result.notes.join(" "), /No Form ADV filing in our copy/);
});

test("fusion: the two sources DISAGREE -> ambiguous_firm with BOTH firms, never a silent pick", async () => {
  const filed = firmRecord({ crd: 111, phone10: "4155550303", name: "FILED ADVISORS LLC" });
  const other = firmRecord({ crd: 222, phone10: "9999999999", name: "LISTED ADVISORS LLC" });
  const places = makePlaces({ "4155550303": { crd: 222, firmName: "LISTED ADVISORS LLC" } });

  const result = await resolveByPhone("415-555-0303", depsFor(makeStore([filed, other]), fakeIapd(), { places }));
  assert.equal(result.outcome, "ambiguous_firm");
  assert.equal(result.nextStep, "pick_firm");
  assert.equal(result.firmDisagreement, true);
  assert.deepEqual(result.firms.map((f) => f.crd).sort(), [111, 222]);
  assert.deepEqual(result.candidates, [], "no person may be named while the firm is in doubt");
  assert.match(explain(result), /point at different firms/);
});

test("fusion: Places RESOLVES a multi-firm Cloud SQL hit rather than leaving it ambiguous", async () => {
  const a = firmRecord({ crd: 111, phone10: "4155550404", name: "SUITE MATE ONE" });
  const b = firmRecord({ crd: 222, phone10: "4155550404", name: "SUITE MATE TWO" });
  const places = makePlaces({ "4155550404": { crd: 222, firmName: "SUITE MATE TWO" } });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });

  const result = await resolveByPhone("415-555-0404", depsFor(makeStore([a, b]), iapd, { places }));
  assert.equal(result.outcome, "single_person");
  assert.equal(result.firms[0].crd, 222);
  assert.equal(result.confidence, "high");
  assert.match(result.notes.join(" "), /resolves it/);
});

test("fusion: neither source matches -> no_match, and it names what it checked", async () => {
  const places = makePlaces({});
  const result = await resolveByPhone("612-371-2811", depsFor(makeStore([]), fakeIapd(), { places }));
  assert.equal(result.outcome, "no_match");
  assert.equal(result.sources.formAdv.matched, false);
  assert.equal(result.sources.places.crd, null);
  assert.equal(result.freshness.ageDays, 8);
});

test("fusion: a Places outage NEVER throws — the Cloud SQL answer still lands", async () => {
  const firm = firmRecord();
  const places = {
    async resolveByPhoneLive() {
      throw new Error("places exploded");
    },
  };
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd, { places }));
  assert.equal(result.outcome, "single_person");
  assert.equal(result.confidence, "medium");
  assert.match(result.sources.places.error, /places exploded/);
});

test("the Places block on the wire is marked with what may be persisted", async () => {
  const firm = firmRecord({ crd: 2907, phone10: "8142386249" });
  const places = makePlaces({ "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC." } });
  const result = await resolveByPhone("814-238-6249", depsFor(makeStore([firm]), fakeIapd(), { places }));
  assert.deepEqual(result.sources.places.business.persistable, ["placeId"]);
  assert.equal(result.sources.places.business.placeId, "ChIJtest");
});

test("PEOPLE NEVER COME FROM THE DATABASE: the store is only ever asked about firms", async () => {
  const firm = firmRecord();
  const store = makeStore([firm]);
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  await resolveByPhone("415-492-9240", depsFor(store, iapd));
  assert.deepEqual(store.calls.map((c) => c[0]), ["lookupByPhone"]);
  // ...and the roster came from IAPD, live.
  assert.equal(iapd.calls[0][0], "roster");
});

test("the upstream budget refuses the Places chain rather than half-running it", async () => {
  const firm = firmRecord();
  const places = makePlaces({ "4154929240": { crd: 10603 } });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const budget = new UpstreamBudget(2); // the chain costs 6
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd, { places, budget }));
  assert.equal(result.sources.places.skipped, "upstream_budget_exhausted");
  assert.equal(result.outcome, "single_person", "and the answer still lands from Cloud SQL");
});

// ===========================================================================
// F1 — GET /v1/firms/{crd} returned the raw record, Schedule A names and all
// ===========================================================================

/** The two records the route actually merges, both loaded with people, so the test fails if
 *  either one is ever echoed whole again. */
const FIRM_ROUTE_INPUT = {
  crd: 79,
  filed: {
    crd: 79,
    name: "J.P. MORGAN SECURITIES LLC",
    secNumber: "801-3702",
    registrationType: "sec",
    registrationStatus: "Registered",
    street1: "270 PARK AVENUE",
    city: "NEW YORK",
    state: "NY",
    zip: "10017",
    country: "United States",
    phone: "800-999-2000",
    phone10: "8009992000",
    advisoryEmployees: 8703,
    totalEmployees: 8703,
    aum: 429694491042,
    lastSeen: "2026-07-29T14:26:10.407Z",
    recordSource: "form_adv_db",
    // The field that shipped straight to the caller.
    scheduleAPersons: [
      { name: "DIMON, JAMES", title: "CHAIRMAN AND CEO", ownershipCode: "A", isControlPerson: true },
      { name: "ERDOES, MARY", title: "CHIEF EXECUTIVE OFFICER, ASSET MANAGEMENT", ownershipCode: "B" },
    ],
  },
  live: {
    crd: 79,
    name: "J.P. MORGAN SECURITIES LLC",
    secNumber: "801-3702",
    officeAddress: { street1: "270 PARK AVENUE", city: "NEW YORK", state: "NY", zip: "10017", country: "United States" },
    registrationStatus: [{ status: "Approved" }],
    brochures: [{ name: "FORM ADV PART 2A" }],
  },
  freshness: { lastIngestAt: "2026-07-29T14:26:24.587Z", ageDays: 8, stale: false },
};

test("F1: GET /v1/firms/{crd} returns firm facts ONLY — no person, ever", () => {
  const { status, body } = buildFirmDetail(FIRM_ROUTE_INPUT);
  assert.equal(status, 200);

  const wire = JSON.stringify(body);
  for (const leak of ["DIMON", "JAMES", "ERDOES", "MARY", "CHAIRMAN", "CHIEF EXECUTIVE", "ownershipCode", "isControlPerson", "scheduleAPersons"]) {
    assert.equal(wire.includes(leak), false, `"${leak}" reached the caller from /v1/firms/79`);
  }
  // The shipped route echoed both source records whole under these keys.
  assert.equal("indexed" in body, false);
  assert.equal("live" in body, false);
  assert.deepEqual(Object.keys(body.firm).sort(), [...FIRM_SUMMARY_KEYS].sort());
});

test("F1/F7: the firm route carries verificationRequired and says people are not available here", () => {
  const { body } = buildFirmDetail(FIRM_ROUTE_INPUT);
  assert.equal(body.verificationRequired, true, "the shipped route omitted this entirely");
  assert.match(body.disclosure, /never returns the names/);
  assert.equal(body.freshness.ageDays, 8);
});

test("F1: the Schedule A COUNT survives, so a caller still knows people exist", () => {
  const { body } = buildFirmDetail(FIRM_ROUTE_INPUT);
  assert.equal(body.firm.scheduleAPersonCount, 2);
});

test("F1: the live record fills gaps without erasing a good filed value", () => {
  const { body } = buildFirmDetail({
    ...FIRM_ROUTE_INPUT,
    live: { crd: 79, name: null, officeAddress: { city: "NEW YORK", state: null }, registrationStatus: [{ status: "Approved" }] },
  });
  assert.equal(body.firm.name, "J.P. MORGAN SECURITIES LLC", "a null live name must not erase the filed one");
  assert.equal(body.firm.address.state, "NY");
  assert.equal(body.firm.registrationStatus, "Approved", "the live status DOES win where it has one");
});

test("F1: neither source has the firm -> 404, not 200 with an empty shell", () => {
  const { status, body } = buildFirmDetail({ crd: 999999999, filed: null, live: null, liveError: "IAPD has no record" });
  assert.equal(status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.verificationRequired, true);
});

test("F1: one source down still answers from the other, and says which failed", () => {
  const dbDown = buildFirmDetail({ ...FIRM_ROUTE_INPUT, filed: null, filedError: "ECONNREFUSED" });
  assert.equal(dbDown.status, 200);
  assert.equal(dbDown.body.sources.formAdvDb.present, false);
  assert.equal(dbDown.body.sources.formAdvDb.error, "ECONNREFUSED");
  assert.equal(dbDown.body.firm.name, "J.P. MORGAN SECURITIES LLC");

  const iapdDown = buildFirmDetail({ ...FIRM_ROUTE_INPUT, live: null, liveError: "IAPD 503" });
  assert.equal(iapdDown.status, 200);
  assert.equal(iapdDown.body.sources.iapd.error, "IAPD 503");
  assert.equal(JSON.stringify(iapdDown.body).includes("DIMON"), false);
});

// ===========================================================================
// H4 — the Places chain charged the budget for work it never did
// ===========================================================================

/** A places double that records every call, so "did we actually call Google?" is answerable. */
function countingPlaces(byPhone = {}) {
  const inner = makePlaces(byPhone);
  return {
    calls: inner.calls,
    resolveByPhoneLive: (...args) => inner.resolveByPhoneLive(...args),
  };
}

test("H4: with no PLACES_API_KEY the chain is skipped and costs NOTHING", async () => {
  // What shipped: the guard was `typeof places?.resolveByPhoneLive !== "function"`, and
  // deps.places is the places.mjs MODULE NAMESPACE — that function is always there, so the
  // guard never fired. The 6-unit chain cost was charged with no key configured, cutting the
  // real budget from 24 to 18 and reporting `available:true` for a source that made no call.
  const firm = firmRecord();
  const places = countingPlaces({ "4154929240": { crd: 10603 } });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const budget = new UpstreamBudget(24);

  const result = await resolveByPhone(
    "415-492-9240",
    depsFor(makeStore([firm]), iapd, { places, budget, placesOpts: { apiKey: "" }, config: { iapd: { siteBase: "https://adviserinfo.sec.gov" }, lookup: { defaultLimit: 10, maxLimit: 50, singlePersonMax: 1, fewCandidatesMax: 5 }, places: { apiKey: "" } } }),
  );

  assert.deepEqual(places.calls, [], "Google must not be called with no key configured");
  assert.equal(result.sources.places.available, false, "a source that made no call is not 'available'");
  assert.equal(result.sources.places.skipped, "not_configured");
  assert.equal(budget.spent, 1, "only the one roster page was spent — the unrun chain charged nothing");
  assert.equal(budget.remaining, 23, "the caller keeps the budget the chain used to eat");
  assert.equal(result.outcome, "single_person", "and the answer still lands");
});

test("H4: a configured key still runs the chain and still pays for it", async () => {
  const firm = firmRecord();
  const places = countingPlaces({ "4154929240": { crd: 10603 } });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const budget = new UpstreamBudget(24);

  const result = await resolveByPhone(
    "415-492-9240",
    depsFor(makeStore([firm]), iapd, { places, budget, placesOpts: { apiKey: "live-key" } }),
  );

  assert.equal(places.calls.length, 1);
  assert.equal(result.sources.places.available, true);
  assert.equal(budget.spent, 7, "the 6-unit chain plus one roster page");
  assert.deepEqual(result.firmMatch.matchedOn, ["form_adv", "places"]);
});

test("H4: an injected client that says nothing about a key is still trusted", async () => {
  // Every unit test in this file injects a places double and never mentions an API key. That
  // must keep working: `unspecified` means "the client knows its own configuration", while an
  // EMPTY STRING is the server saying there is no key.
  const firm = firmRecord();
  const places = countingPlaces({ "4154929240": { crd: 10603 } });
  const iapd = fakeIapd({ individuals: [person("Allan Glen Lyle", { crd: 2749311 })] });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd, { places }));
  assert.equal(places.calls.length, 1);
  assert.equal(result.confidence, "high");
});

// ===========================================================================
// H3 — /v1/claim/search ignored the budget the server built for it
// ===========================================================================

/** An IAPD double for the name path: `rows` search hits, every profile resolvable. */
function searchIapd(rows) {
  return {
    calls: [],
    async searchIndividualsByName(name, opts) {
      this.calls.push(["search", name, opts]);
      return rows;
    },
    async getIndividual(crd) {
      this.calls.push(["individual", crd]);
      return { crd, name: `Person ${crd}`, currentEmployments: [{ firmCrd: 10603, firmName: "LYLE, ALLAN GLEN" }] };
    },
    async listFirmIndividuals() {
      throw new Error("the name path must never fetch a roster");
    },
  };
}

const searchConfig = () => ({
  iapd: { siteBase: "https://adviserinfo.sec.gov" },
  lookup: { defaultLimit: 10, maxLimit: 50, singlePersonMax: 1, fewCandidatesMax: 5, maxProfileCallsPerRequest: 10 },
});

test("H3: searchByName spends the budget instead of ignoring it", async () => {
  // Measured on the shipped build: GET /v1/claim/search?name=smith&limit=50 made 51 requests
  // to the SEC against a configured ceiling of 24, because the budget the server built was
  // handed over and never taken from.
  const rows = Array.from({ length: 50 }, (_, i) => person(`Person ${i}`, { crd: 5000 + i }));
  const iapd = searchIapd(rows);
  const budget = new UpstreamBudget(24);

  const result = await searchByName(
    "smith",
    depsFor(makeStore([]), iapd, { budget, limit: 50, config: searchConfig() }),
  );

  const upstream = iapd.calls.length;
  assert.ok(upstream <= 24, `spent ${upstream} upstream calls against a ceiling of 24`);
  assert.equal(upstream, 11, "one name search plus the 10-profile hydration ceiling");
  assert.equal(budget.spent, 11, "and every one of them was charged to the budget");
  assert.equal(result.candidates.length, 50, "the pick-list is NOT truncated — only its hydration is");
  assert.equal(result.hydration.hydrated, 10);
  assert.equal(result.hydration.capped, true);
});

test("H3: a row that could not be hydrated still appears, and says why", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => person(`Person ${i}`, { crd: 6000 + i }));
  const iapd = searchIapd(rows);
  const budget = new UpstreamBudget(24);
  const result = await searchByName(
    "smith",
    depsFor(makeStore([]), iapd, { budget, limit: 12, config: searchConfig() }),
  );

  const unhydrated = result.candidates.filter((c) => c.firmCrd == null);
  assert.equal(unhydrated.length, 2, "12 rows, a 10-profile ceiling");
  assert.match(unhydrated[0].reasons.join(" "), /listed without its firm/);
});

test("H3: an exhausted budget refuses the search rather than calling the SEC anyway", async () => {
  const iapd = searchIapd([person("Jane Doe", { crd: 99 })]);
  const budget = new UpstreamBudget(0);
  await assert.rejects(
    () => searchByName("smith", depsFor(makeStore([]), iapd, { budget, config: searchConfig() })),
    (error) => {
      assert.match(error.message, /upstream call budget/);
      assert.equal(error.status, 429, "our ceiling, not the SEC's — the caller may retry");
      return true;
    },
  );
  assert.deepEqual(iapd.calls, [], "not one request left the process");
});

test("H3: with no budget at all searchByName still works (the resolver is not server-only)", async () => {
  const iapd = searchIapd([person("Jane Doe", { crd: 99 })]);
  const result = await searchByName("Jane", depsFor(makeStore([]), iapd, { config: searchConfig() }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.upstream, null);
});

// ===========================================================================
// CLOUD SQL IS OPTIONAL — "we never asked" must never be published as "there is no filing"
// ===========================================================================

/** The shape sql-store.mjs returns when RIA_DB_ENABLED=off: enabled:false, and every method
 *  answers without opening a socket. */
function disabledStore() {
  return {
    enabled: false,
    calls: [],
    async lookupByPhone(phone10) {
      this.calls.push(["lookupByPhone", phone10]);
      return { firms: [], phone10, ms: 0, consulted: false, skipped: "not_configured" };
    },
    async getFirm() {
      return null;
    },
    async freshness() {
      return { configured: false, applicable: false, ageDays: null, stale: false, skipped: "not_configured" };
    },
  };
}

test("DB OFF: the Form ADV table is reported as NOT CONSULTED, never as a miss", async () => {
  const store = disabledStore();
  const result = await resolveByPhone("612-371-2811", depsFor(store, fakeIapd(), { places: makePlaces({}) }));

  assert.equal(result.sources.formAdv.consulted, false);
  assert.equal(result.sources.formAdv.status, "not_configured");
  assert.equal(result.sources.formAdv.matched, false);
  assert.deepEqual(store.calls, [], "a disabled store is not even asked");

  const said = result.notes.join(" ");
  assert.equal(
    said.includes("No SEC-registered advisory firm files that number"),
    false,
    "that sentence is a claim about a table we never read",
  );
  assert.match(said, /NOT consulted/i);
  assert.equal(
    explain(result).includes("on its Form ADV"),
    false,
    "the UI sentence must not claim the Form ADV feed said anything either",
  );
});

test("DB CONSULTED AND EMPTY: that IS evidence, and still reads as a miss", async () => {
  const result = await resolveByPhone("612-371-2811", depsFor(makeStore([]), fakeIapd(), { places: makePlaces({}) }));
  assert.equal(result.sources.formAdv.consulted, true, "a double with no `enabled` field must still be consulted");
  assert.equal(result.sources.formAdv.status, "miss");
  assert.match(result.notes.join(" "), /No SEC-registered advisory firm files that number/);
  assert.match(explain(result), /on its Form ADV/);
});

test("DB FAULT: a timeout and an error are their own statuses, not a miss", async () => {
  const timeoutError = Object.assign(new Error("Cloud SQL did not answer within 800ms (lookupByPhone)"), {
    timeout: true,
    code: "timeout",
  });
  const timedOut = await resolveByPhone(
    "612-371-2811",
    depsFor(makeStore([], { error: timeoutError }), fakeIapd(), { places: makePlaces({}) }),
  );
  assert.equal(timedOut.sources.formAdv.status, "timeout");
  assert.equal(timedOut.sources.formAdv.consulted, false);

  const failed = await resolveByPhone(
    "612-371-2811",
    depsFor(makeStore([], { error: new Error("ECONNREFUSED") }), fakeIapd(), { places: makePlaces({}) }),
  );
  assert.equal(failed.sources.formAdv.status, "error");
  assert.match(failed.notes.join(" "), /could not be read/);
});

test("DB OFF: a cross-validated Places match keeps its confidence — the missing DB is not a doubt", async () => {
  // The live chain already did a two-way cross-validation: Google's listing for the number
  // against the SEC's own firm detail, agreeing on the NAME, above the high threshold, with no
  // ambiguous runner-up. Marking that down because a database we deliberately switched off did
  // not corroborate it would penalise a supported standalone deployment.
  const places = makePlaces({
    "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC.", confidence: "high", matchedOn: ["name", "city", "state", "zip", "address"] },
  });
  const iapd = {
    ...fakeIapd({ individuals: [person("Judy Loy", { crd: 2249019 })] }),
    async getFirm(crd) {
      return { crd, name: "NESTLERODE & LOY, INC.", isIaFirm: true, officeAddress: { city: "STATE COLLEGE", state: "PA" }, registrationStatus: [] };
    },
  };

  const result = await resolveByPhone("814-238-6249", depsFor(disabledStore(), iapd, { places }));
  assert.equal(result.firms[0].crd, 2907);
  assert.deepEqual(result.firmMatch.matchedOn, ["places"]);
  assert.equal(result.firmMatch.confidence, "high", "a genuine two-way cross-validation on its own");
  assert.equal(result.confidence, "high");
  assert.match(result.notes.join(" "), /cross-validated against the SEC's own firm record/);
});

test("DB OFF: a Places match that is NOT cross-validated stays medium", async () => {
  const places = makePlaces({
    "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC.", confidence: "medium", matchedOn: ["city", "state", "zip"] },
  });
  const iapd = {
    ...fakeIapd({ individuals: [person("Judy Loy", { crd: 2249019 })] }),
    async getFirm(crd) {
      return { crd, name: "NESTLERODE & LOY, INC.", isIaFirm: true, officeAddress: {}, registrationStatus: [] };
    },
  };
  const result = await resolveByPhone("814-238-6249", depsFor(disabledStore(), iapd, { places }));
  assert.equal(result.firmMatch.confidence, "medium");
});

test("DB CONSULTED AND EMPTY: Places-only stays MEDIUM, because a source did look and disagree", async () => {
  const places = makePlaces({
    "8142386249": { crd: 2907, firmName: "NESTLERODE & LOY, INC.", confidence: "high", matchedOn: ["name", "city", "state", "zip", "address"] },
  });
  const iapd = {
    ...fakeIapd({ individuals: [person("Judy Loy", { crd: 2249019 })] }),
    async getFirm(crd) {
      return { crd, name: "NESTLERODE & LOY, INC.", isIaFirm: true, officeAddress: {}, registrationStatus: [] };
    },
  };
  const result = await resolveByPhone("814-238-6249", depsFor(makeStore([]), iapd, { places }));
  assert.equal(result.firmMatch.confidence, "medium");
});

// ---------------------------------------------------------------------------
// /v1/firms/{crd}: an empty answer from two sources that never spoke is not a 404
// ---------------------------------------------------------------------------

test("firm route: DB off + IAPD fault is a DEPENDENCY FAILURE, not 'no such firm'", async () => {
  const { status, body } = buildFirmDetail({
    crd: 2907,
    filed: null,
    live: null,
    filedConsulted: false,
    filedSkipped: "not_configured",
    liveError: "IAPD HTTP 503 (firm 2907)",
    liveStatus: 503,
  });
  assert.equal(status, 503, "nobody looked, so we cannot say the firm does not exist");
  assert.equal(body.ok, false);
  assert.equal(body.retryable, true);
  assert.equal(body.error.includes("No firm found"), false);
  assert.equal(body.sources.formAdvDb.consulted, false);
  assert.equal(body.verificationRequired, true);
});

test("firm route: DB off + a genuine IAPD 404 IS a 404", async () => {
  const { status, body } = buildFirmDetail({
    crd: 999999999,
    filed: null,
    live: null,
    filedConsulted: false,
    filedSkipped: "not_configured",
    liveError: "IAPD has no record for CRD 999999999",
    liveStatus: 404,
  });
  assert.equal(status, 404, "the SEC itself said the CRD does not exist");
  assert.match(body.error, /No firm found/);
});

test("firm route: a consulted DB that has no row keeps the 404 even when IAPD faults", async () => {
  const { status } = buildFirmDetail({
    crd: 2907,
    filed: null,
    live: null,
    filedConsulted: true,
    liveError: "ECONNRESET",
    liveStatus: null,
  });
  assert.equal(status, 404, "one source did look and found nothing");
});

// ---------------------------------------------------------------------------
// DUAL IDENTITY AND `mode`
//
// One phone number belongs to a firm AND to every adviser registered there, so the lookup has
// two legitimate claim targets. The tests that matter here are not the happy shapes — they are
// the four that prove `mode` is a NARROWING control and never a widening one.
// ---------------------------------------------------------------------------

/** The names a result puts on the wire, from every place a person can appear. If a future
 *  change starts disclosing people through a new field, this helper is what fails. */
const namesDisclosed = (result) =>
  [
    ...(result.candidates || []).map((c) => c.name),
    ...(result.individualClaims || []).map((c) => c.name),
    ...(result.firms || []).flatMap((f) => (Array.isArray(f.scheduleAPersons) ? f.scheduleAPersons.map((p) => p.name) : [])),
    ...(result.firmClaim && Array.isArray(result.firmClaim.scheduleAPersons)
      ? result.firmClaim.scheduleAPersons.map((p) => p.name)
      : []),
  ]
    .filter(Boolean)
    .sort();

/** An iapd double that also answers getFirm, so the enrichment path is exercised. */
function fakeIapdWithFirm(options = {}, firmDetail = null) {
  const base = fakeIapd(options);
  base.getFirm = async function (crd) {
    this.calls.push(["firm", crd]);
    if (firmDetail instanceof Error) throw firmDetail;
    return (
      firmDetail || {
        crd: Number(crd),
        name: "LYLE, ALLAN GLEN",
        secNumber: "801-16717",
        iaScope: "Active",
        officeAddress: null,
        mailingAddress: { street1: "PO BOX 1", city: "SAN RAFAEL", state: "CA", zip: "94901", country: "United States" },
        registrationStatus: [{ status: "Approved", date: "2001-04-02" }],
        noticeFilings: [{ state: "CA", status: "Approved" }],
        brochures: [{ versionId: 987654, name: "Part 2A", dateSubmitted: "2026-03-03" }],
        reportUrl: "https://adviserinfo.sec.gov/firm/summary/10603",
      }
    );
  };
  return base;
}

const FOUR = ["Ann Alpha", "Ben Bravo", "Cara Charlie", "Dan Delta"].map((n, i) => person(n, { crd: 8100 + i }));

test("mode=auto returns BOTH claim targets and asks the human which they are", async () => {
  const firm = firmRecord({ effectiveAdviserCount: 4 });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: FOUR }), { mode: "auto" }));

  assert.equal(result.mode, "auto");
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.firmClaim.claimType, "firm");
  assert.equal(result.firmClaim.crd, 10603);
  assert.equal(result.individualClaims.length, 4);
  assert.ok(result.individualClaims.every((c) => c.claimType === "individual" && c.claimable === true));
  assert.deepEqual(result.claimTargets.individuals.sort(), [8100, 8101, 8102, 8103]);
  assert.equal(result.claimTargets.firm, 10603);
});

test("mode=firm NAMES NOBODY, and does not even fetch the roster", async () => {
  const firm = firmRecord({ effectiveAdviserCount: 4 });
  const iapd = fakeIapdWithFirm({ individuals: FOUR });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd, { mode: "firm" }));

  assert.equal(result.outcome, "firm_only");
  assert.equal(result.nextStep, "confirm_firm");
  assert.deepEqual(result.individualClaims, []);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(namesDisclosed(result), []);
  assert.equal(
    iapd.calls.filter(([kind]) => kind === "roster").length,
    0,
    "the fast path must not spend a roster call it will not use",
  );
});

test("mode=individual discloses EXACTLY what mode=auto discloses — never more, never less", async () => {
  const firm = firmRecord({ effectiveAdviserCount: 4 });
  const auto = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: FOUR }), { mode: "auto" }));
  const individual = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: FOUR }), { mode: "individual" }));

  assert.deepEqual(namesDisclosed(individual), namesDisclosed(auto));
  assert.equal(individual.nextStep, "pick_person", "mode=individual keeps the person-oriented step");
  assert.equal(individual.personNextStep, "pick_person");
  // The firm is still a claim target; it is just not enriched from live IAPD.
  assert.equal(individual.firmClaim.crd, 10603);
  assert.equal(individual.firmClaim.enriched, false);
  assert.equal(individual.firmClaim.registrations, null, "null means NOT READ, never 'none on file'");
  assert.match(individual.firmClaim.enrichmentNote, /never 'none on file'/);
});

test("THE DISCLOSURE INVARIANT: across every scenario, firm mode names nobody and individual mode matches auto", async () => {
  const scenarios = [
    ["a sole adviser", firmRecord(), [person("Allan Glen Lyle", { crd: 7001 })]],
    ["four advisers", firmRecord({ effectiveAdviserCount: 4 }), FOUR],
    [
      "a big firm with one Schedule A officer on the roster",
      firmRecord({ crd: 400, phone10: "2125550100", effectiveAdviserCount: 40, scheduleAPersons: [{ name: "REED, SUSAN", title: "PRESIDENT", ownershipCode: "E" }] }),
      ["Susan Reed", "Adam One", "Beth Two", "Carl Three", "Dana Four", "Eli Five", "Fay Six"].map((n, i) => person(n, { crd: 500 + i })),
    ],
    [
      "a switchboard at a firm with nobody on Schedule A",
      firmRecord({ crd: 401, phone10: "9142251000", scheduleAPersons: [] }),
      Array.from({ length: 60 }, (_, i) => person(`Adviser Number${i}`, { crd: 9000 + i })),
    ],
    [
      "ZERO advisory staff, 14 disclosed officers — the AllianceBernstein shape",
      firmRecord({
        crd: 402,
        phone10: "2129691000",
        name: "ALLIANCEBERNSTEIN CORPORATION",
        advisoryEmployees: 0,
        effectiveAdviserCount: 0,
        scheduleAPersons: Array.from({ length: 14 }, (_, i) => ({ name: `BOARD, MEMBER${i}`, title: "DIRECTOR", ownershipCode: "A" })),
      }),
      [],
    ],
  ];

  for (const [label, firm, individuals] of scenarios) {
    const phone = firm.phone10;
    const run = (mode) =>
      resolveByPhone(phone, depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals }), { mode }));
    const [auto, firmMode, individualMode] = await Promise.all([run("auto"), run("firm"), run("individual")]);

    assert.deepEqual(namesDisclosed(firmMode), [], `${label}: mode=firm must name nobody`);
    assert.deepEqual(
      namesDisclosed(individualMode),
      namesDisclosed(auto),
      `${label}: mode=individual must disclose exactly what mode=auto discloses`,
    );
    // And no mode may name anyone the default would not.
    for (const name of namesDisclosed(individualMode)) {
      assert.ok(namesDisclosed(auto).includes(name), `${label}: ${name} leaked in mode=individual`);
    }
  }
});

test("the zero-advisory-staff gate holds in ALL THREE modes — 212-969-1000 names nobody anywhere", async () => {
  const firm = firmRecord({
    crd: 402,
    phone10: "2129691000",
    name: "ALLIANCEBERNSTEIN CORPORATION",
    advisoryEmployees: 0,
    effectiveAdviserCount: 0,
    scheduleAPersons: Array.from({ length: 14 }, (_, i) => ({ name: `BOARD, MEMBER${i}`, title: "DIRECTOR", ownershipCode: "A" })),
  });
  for (const mode of ["auto", "firm", "individual"]) {
    const result = await resolveByPhone("212-969-1000", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [] }), { mode }));
    assert.deepEqual(result.candidates, [], `mode=${mode} named someone`);
    assert.deepEqual(result.individualClaims, [], `mode=${mode} named someone`);
    assert.equal(result.firmClaim.scheduleAPersonCount, 14, `mode=${mode} should still report the COUNT`);
    assert.equal(result.firmClaim.scheduleAPersons, undefined, `mode=${mode} must not carry the array`);
  }
});

test("mode=firm cannot reach the Schedule A fallback, which is the one path that names people from a firm record", async () => {
  // A one-person shop whose IAPD roster is empty: in auto mode the single Schedule A owner IS
  // the answer, and is named. In firm mode nobody is, because the roster is never consulted.
  const firm = firmRecord({ effectiveAdviserCount: 1 });
  const auto = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [] }), { mode: "auto" }));
  const firmMode = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [] }), { mode: "firm" }));

  assert.equal(auto.candidates.length, 1, "auto still names the one disclosed owner");
  assert.equal(auto.candidates[0].name, "ALLAN GLEN LYLE");
  assert.deepEqual(namesDisclosed(firmMode), []);
});

test("firmClaim carries the filing metadata and the human-checkable report URLs", async () => {
  const firm = firmRecord();
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [person("Allan Glen Lyle", { crd: 7001 })] }), { mode: "auto" }));

  const claim = result.firmClaim;
  assert.equal(claim.enriched, true);
  assert.deepEqual(claim.registrations, [{ status: "Approved", date: "2001-04-02" }]);
  assert.deepEqual(claim.noticeFilings, [{ state: "CA", status: "Approved" }]);
  assert.equal(claim.brochures[0].versionId, 987654);
  assert.match(claim.brochures[0].url, /BRCHR_VRSN_ID=987654$/);
  assert.equal(claim.formAdvPdfUrl, "https://reports.adviserinfo.sec.gov/reports/ADV/10603/PDF/10603.pdf");
  assert.equal(claim.formCrsUrl, "https://reports.adviserinfo.sec.gov/crs/crs_10603.pdf");
  assert.equal(claim.reportUrl, "https://adviserinfo.sec.gov/firm/summary/10603");
});

test("a failed firm-detail read costs the enrichment, never the answer", async () => {
  const firm = firmRecord();
  const iapd = fakeIapdWithFirm({ individuals: [person("Allan Glen Lyle", { crd: 7001 })] }, new Error("IAPD firm detail timed out"));
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), iapd, { mode: "auto" }));

  assert.equal(result.outcome, "single_person");
  assert.equal(result.firmClaim.enriched, false);
  assert.match(result.firmClaim.enrichmentError, /timed out/);
  assert.equal(result.individualClaims.length, 1, "the people are unaffected");
});

test("individualClaims carry the name parts and the individual report URL", async () => {
  const firm = firmRecord();
  const people = [person("Robert David MacRae", { crd: 6844196, firstName: "Robert", middleName: "David", lastName: "MacRae" })];
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: people }), { mode: "auto" }));

  const claim = result.individualClaims[0];
  assert.equal(claim.firstName, "Robert");
  assert.equal(claim.middleName, "David");
  assert.equal(claim.lastName, "MacRae");
  assert.equal(claim.otherNames, null, "the roster endpoint does not carry other names; [] would be a lie");
  assert.equal(claim.reportUrl, "https://reports.adviserinfo.sec.gov/reports/individual/individual_6844196.pdf");
  assert.equal(claim.profileUrl, "https://adviserinfo.sec.gov/individual/summary/6844196");
});

test("a Schedule A fallback entry is published as NOT claimable — there is no profile behind it", async () => {
  const firm = firmRecord({ effectiveAdviserCount: 1 });
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [] }), { mode: "auto" }));

  assert.equal(result.individualClaims.length, 1);
  assert.equal(result.individualClaims[0].claimable, false);
  assert.equal(result.individualClaims[0].individualCrd, null);
  assert.deepEqual(result.claimTargets.individuals, [], "nothing without a CRD may be offered as a claim target");
});

test("no firm resolved means no firmClaim, in every mode", async () => {
  for (const mode of ["auto", "firm", "individual"]) {
    const miss = await resolveByPhone("415-492-9240", depsFor(makeStore([]), fakeIapdWithFirm({}), { mode, places: makePlaces({}), placesOpts: { apiKey: null } }));
    assert.equal(miss.outcome, "no_match");
    assert.equal(miss.firmClaim, null, `mode=${mode}`);
    assert.deepEqual(miss.individualClaims, [], `mode=${mode}`);
    assert.equal(miss.nextStep, "enter_name", `mode=${mode}`);

    const bad = await resolveByPhone("banana", depsFor(makeStore([]), fakeIapdWithFirm({}), { mode }));
    assert.equal(bad.outcome, "invalid_phone");
    assert.equal(bad.firmClaim, null, `mode=${mode}`);
  }
});

test("an ambiguous firm match stays FIRMS ONLY and offers no firmClaim to confirm", async () => {
  const a = firmRecord({ crd: 1, name: "FIRM A", phone10: "4154929240" });
  const b = firmRecord({ crd: 2, name: "FIRM B", phone10: "4154929240" });
  for (const mode of ["auto", "firm", "individual"]) {
    const result = await resolveByPhone("415-492-9240", depsFor(makeStore([a, b]), fakeIapdWithFirm({ individuals: FOUR }), { mode }));
    assert.equal(result.outcome, "ambiguous_firm");
    assert.equal(result.nextStep, "pick_firm", `mode=${mode} must still ask which firm first`);
    assert.equal(result.firmClaim, null, `mode=${mode}: there is no single firm to claim yet`);
    assert.deepEqual(namesDisclosed(result), [], `mode=${mode}: naming people across several firms is the disclosure this branch exists to prevent`);
  }
});

test("modeOf defaults an unknown value rather than throwing — query.mjs is where a typo becomes a 400", async () => {
  const firm = firmRecord();
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: [person("Allan Glen Lyle", { crd: 7001 })] }), { mode: "FIRMS" }));
  assert.equal(result.mode, "auto");
});

test("THE ROBINSWOOD SIZE: seven advisers on one line is a pick-list, not a large firm", async () => {
  // The measured case that moved config.lookup.fewCandidatesMax from 5 to 8. At 5 this firm
  // fell into large_firm and the response named NOBODY, so all seven of the people the service
  // exists to serve were told their own office number identifies no one. The threshold here is
  // injected (these tests carry their own config), so this test pins the BEHAVIOUR at the
  // shipped value rather than re-reading whatever config.mjs happens to say.
  const firm = firmRecord({ effectiveAdviserCount: 7 });
  const seven = [
    "ROBERT WARD GUILD", "EDWARD LEE WARD", "JANET HARRIS WEISMAN", "Robert David MacRae",
    "Christopher Edward Simon-Wallace", "Colleen M Bracy", "Kelsey Ann Curtis",
  ].map((name, i) => person(name, { crd: 6000 + i }));

  const deps = depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: seven }), { mode: "auto" });
  deps.config.lookup.fewCandidatesMax = 8;
  const result = await resolveByPhone("415-492-9240", deps);

  assert.equal(result.outcome, "few_candidates");
  assert.equal(result.nextStep, "choose_identity");
  assert.equal(result.individualClaims.length, 7, "all seven, or five real advisers are told they do not exist");
  assert.equal(result.claimTargets.firm, 10603);
});

test("raising the threshold to 8 did NOT weaken the large-firm gate", async () => {
  // The gate's purpose is unchanged: a switchboard must not return a list of strangers. Nine
  // advisers with nobody on Schedule A still names nobody.
  const firm = firmRecord({ crd: 403, phone10: "9142251000", scheduleAPersons: [] });
  const nine = Array.from({ length: 9 }, (_, i) => person(`Stranger Number${i}`, { crd: 9500 + i }));
  const deps = depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: nine }), { mode: "auto" });
  deps.config.lookup.fewCandidatesMax = 8;
  const result = await resolveByPhone("914-225-1000", deps);

  assert.equal(result.outcome, "large_firm");
  assert.deepEqual(result.individualClaims, []);
  assert.equal(result.nextStep, "confirm_firm");
  assert.equal(result.personNextStep, "enter_name");
});

test("explain() has a sentence for mode=firm — the generic fallback was wrong copy for it", async () => {
  // Found by running it, not by a test: outcome "firm_only" fell through to "we could not
  // narrow that number down to one adviser — tell us your name instead", which is the opposite
  // of what happened. The number narrowed perfectly; the caller asked us not to look at people.
  const firm = firmRecord();
  const result = await resolveByPhone("415-492-9240", depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: FOUR }), { mode: "firm" }));
  const sentence = explain(result);
  assert.match(sentence, /is that your firm\?$/);
  assert.doesNotMatch(sentence, /tell us your name/i);
});

// ---------------------------------------------------------------------------
// loadClaimContext — the Schedule A read that makes adv_officer possible
//
// The Cloud SQL firm table carries no Schedule A at all, so `adv_officer` — the only signal
// that proves AUTHORITY over the entity — could never fire. The firm's own Form ADV Part 1 PDF
// carries it, and these tests pin WHEN we are allowed to go and read it.
//
// Fixtures are synthetic: what is under test is the plumbing, not anyone's filing.
// ---------------------------------------------------------------------------

const SCHEDULE_A_ROWS = [
  {
    name: "DOE, JANE, Q",
    nameNormalized: "JANE Q DOE",
    individualCrd: 9999001,
    isIndividual: true,
    title: "MANAGING MEMBER/CHIEF COMPLIANCE OFFICER",
    dateAcquired: "02/2007",
    ownershipCode: "E",
    isControlPerson: true,
    isPublicReporting: false,
  },
  {
    name: "Roe, Samuel, T",
    nameNormalized: "SAMUEL T ROE",
    individualCrd: 9999002,
    isIndividual: true,
    title: "CO-COMPLIANCE OFFICER",
    dateAcquired: "06/2025",
    ownershipCode: "NA",
    isControlPerson: false,
    isPublicReporting: false,
  },
];

/** A getScheduleA double. Records every call, so "was the PDF fetched at all?" is assertable —
 *  which is the whole point: this is a multi-megabyte download on a latency-sensitive path. */
function fakeScheduleA(result = SCHEDULE_A_ROWS) {
  const fn = async (crd, opts) => {
    fn.calls.push([Number(crd), opts]);
    if (result instanceof Error) throw result;
    return result;
  };
  fn.calls = [];
  return fn;
}

const claimDeps = (getScheduleA, extra = {}) => ({
  ...depsFor(makeStore([firmRecord({ crd: 9990001, phone10: "2065550142", scheduleAPersons: undefined })]),
    fakeIapdWithFirm({ individuals: FOUR })),
  getScheduleA,
  cache: { firm: { name: "firm", persisted: true, wrap: async (_k, produce) => produce() } },
  ...extra,
});

test("loadClaimContext: a FIRM claim reads Schedule A and populates it for the evidence engine", async () => {
  const getScheduleA = fakeScheduleA();
  const context = await loadClaimContext(9990001, claimDeps(getScheduleA), { claimType: "firm" });

  assert.equal(getScheduleA.calls.length, 1, "exactly one PDF read, for exactly one firm");
  assert.equal(getScheduleA.calls[0][0], 9990001);
  assert.deepEqual(context.firm.scheduleAPersons, SCHEDULE_A_ROWS);
  assert.equal(context.sources.advScheduleA.consulted, true);
  assert.equal(context.sources.advScheduleA.present, true);
  assert.equal(context.sources.advScheduleA.count, 2);
  assert.equal(context.sources.advScheduleA.error, null);
  // A COUNT reaches the wire, never the people.
  assert.equal(context.firmSummary.scheduleAPersonCount, 2);
  assert.equal("scheduleAPersons" in context.firmSummary, false);
});

test("loadClaimContext: the read is cached in the PERSISTED firm cache — it is SEC public record", async () => {
  const getScheduleA = fakeScheduleA();
  const deps = claimDeps(getScheduleA);
  await loadClaimContext(9990001, deps, { claimType: "firm" });
  assert.equal(getScheduleA.calls[0][1].cache, deps.cache.firm, "must reuse the 30-day persisted firm cache");
});

test("loadClaimContext: an INDIVIDUAL claim never pays for the PDF", async () => {
  // Schedule A answers "may this person act for the entity". The individual arm never asks it,
  // so fetching would be seconds of latency bought for nothing.
  const getScheduleA = fakeScheduleA();
  const context = await loadClaimContext(9990001, claimDeps(getScheduleA), { claimType: "individual" });

  assert.equal(getScheduleA.calls.length, 0);
  assert.equal(context.firm.scheduleAPersons, null);
  assert.equal(context.sources.advScheduleA.consulted, false);
  assert.equal(context.sources.advScheduleA.count, null);
});

test("loadClaimContext: a caller that says nothing gets NO PDF read — the default is the cheap path", async () => {
  const getScheduleA = fakeScheduleA();
  const context = await loadClaimContext(9990001, claimDeps(getScheduleA));
  assert.equal(getScheduleA.calls.length, 0);
  assert.equal(context.sources.advScheduleA.consulted, false);
  assert.equal(context.firm.scheduleAPersons, null);
});

test("loadClaimContext: a Schedule A we could not read stays NULL, never []", async () => {
  // null is "we could not look" and claim.mjs reports it as no_schedule_a_available. An empty
  // array would mean "this firm discloses nobody", which is a finding we have not earned.
  const getScheduleA = fakeScheduleA(null);
  const context = await loadClaimContext(9990001, claimDeps(getScheduleA), { claimType: "firm" });

  assert.equal(context.firm.scheduleAPersons, null);
  assert.equal(context.sources.advScheduleA.consulted, true);
  assert.equal(context.sources.advScheduleA.present, false);
  assert.ok(context.sources.advScheduleA.error, "the caller must be told we tried and failed");
});

test("loadClaimContext: a firm that filed a Schedule A listing NOBODY is [] and is not an error", async () => {
  const context = await loadClaimContext(9990001, claimDeps(fakeScheduleA([])), { claimType: "firm" });
  assert.deepEqual(context.firm.scheduleAPersons, []);
  assert.equal(context.sources.advScheduleA.present, true);
  assert.equal(context.sources.advScheduleA.count, 0);
});

test("loadClaimContext: a THROWING Schedule A reader degrades to null and never breaks the claim", async () => {
  const getScheduleA = fakeScheduleA(new Error("SEC on fire"));
  const context = await loadClaimContext(9990001, claimDeps(getScheduleA), { claimType: "firm" });
  assert.equal(context.firm.scheduleAPersons, null);
  assert.equal(context.firm.crd, 9990001, "the rest of the context still loaded");
  assert.match(context.sources.advScheduleA.error, /SEC on fire/);
});

test("loadClaimContext: the database keeps precedence if it ever starts carrying Schedule A", async () => {
  const fromDb = [{ name: "OTHER, PERSON", title: "MEMBER", ownershipCode: "A" }];
  const getScheduleA = fakeScheduleA();
  const deps = claimDeps(getScheduleA, {
    store: makeStore([firmRecord({ crd: 9990001, phone10: "2065550142", scheduleAPersons: fromDb })]),
  });
  const context = await loadClaimContext(9990001, deps, { claimType: "firm" });
  assert.deepEqual(context.firm.scheduleAPersons, fromDb);
});

test("the ANONYMOUS lookup path never reads a Form ADV PDF", async () => {
  // The gate that keeps a ~1-3.5MB SEC download off the path anyone can reach by typing a
  // phone number. If this ever fails, every candidate firm on an ambiguous lookup costs a
  // multi-second download to name officers the disclosure rules then withhold.
  const getScheduleA = fakeScheduleA();
  const firm = firmRecord();
  const deps = depsFor(makeStore([firm]), fakeIapdWithFirm({ individuals: FOUR }), { mode: "auto", getScheduleA });
  const result = await resolveByPhone("415-492-9240", deps);

  assert.equal(getScheduleA.calls.length, 0);
  assert.equal(result.claimTargets.firm, 10603, "the lookup still answered");
});
