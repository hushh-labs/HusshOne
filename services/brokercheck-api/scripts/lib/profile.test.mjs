import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFinraDate,
  yearsInIndustry,
  deriveYearsExperience,
  deriveFirmCount,
  deriveFirmHistory,
  deriveExams,
  deriveDisclosures,
  deriveBranches,
  buildProfile,
} from "./profile.mjs";
import { GEO_PRECISION } from "./geo.mjs";

const NOW = new Date("2026-08-04T00:00:00Z");

test("parseFinraDate accepts BOTH endpoint formats", () => {
  // detail endpoint: M/D/YYYY
  assert.equal(parseFinraDate("12/18/1989").toISOString(), "1989-12-18T00:00:00.000Z");
  // search endpoint: ISO — a real difference between the two, and a live bug we hit
  assert.equal(parseFinraDate("1990-12-17").toISOString(), "1990-12-17T00:00:00.000Z");
});

test("parseFinraDate rejects junk rather than returning Invalid Date", () => {
  for (const bad of ["", "not a date", "2/31/2020", "13/1/2020", null, undefined, 42]) {
    assert.equal(parseFinraDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("yearsInIndustry prefers the day count when present (inactive individuals)", () => {
  assert.equal(yearsInIndustry({ days: 13161 }, NOW), 36.1); // 13161/365 = 36.06
  // The day count wins even when an entry date is also present.
  assert.equal(yearsInIndustry({ days: 3650, sinceDate: "1/1/1970" }, NOW), 10);
});

test("yearsInIndustry falls back to the entry date (active individuals)", () => {
  assert.equal(yearsInIndustry({ sinceDate: "8/4/2006" }, NOW), 20);
});

test("yearsInIndustry returns null when neither signal is usable", () => {
  assert.equal(yearsInIndustry({}, NOW), null);
  assert.equal(yearsInIndustry({ days: 0, sinceDate: "garbage" }, NOW), null);
});

test("yearsInIndustry rejects a future start date instead of returning negative years", () => {
  assert.equal(yearsInIndustry({ sinceDate: "1/1/2030" }, NOW), null);
});

test("deriveYearsExperience reads the detail payload's basicInformation block", () => {
  assert.equal(deriveYearsExperience({ daysInIndustryCalculatedDate: "12/18/1989" }, NOW), 36.7);
  assert.equal(deriveYearsExperience({ daysInIndustry: 3650 }, NOW), 10);
});

const DETAIL = {
  basicInformation: { firstName: "JANE", lastName: "DOE", bcScope: "Active", iaScope: "Active", daysInIndustry: 7300 },
  currentEmployments: [
    {
      firmId: 100,
      firmName: "ALPHA",
      branchOfficeLocations: [
        { branchOfficeId: "b1", street1: "1 Main St", city: "Kirkland", state: "WA", zipCode: "98033", latitude: "47.673156", longitude: "-122.197628" },
      ],
    },
  ],
  // Same firm again under the IA array — must NOT double-count.
  currentIAEmployments: [{ firmId: 100, firmName: "ALPHA" }],
  previousEmployments: [
    { firmId: 200, firmName: "BETA", registrationBeginDate: "1/1/2000", registrationEndDate: "1/1/2010" },
    { firmId: 300, firmName: "GAMMA" },
  ],
  previousIAEmployments: [],
  disclosureFlag: "Y",
  disclosures: [
    { eventDate: "11/4/1999", disclosureType: "Regulatory", disclosureResolution: "Final", disclosureDetail: { Allegations: "x" } },
  ],
  examsCount: { stateExamCount: 1, principalExamCount: 0, productExamCount: 1 },
  stateExamCategory: [{ examCategory: "Series 63", examName: "Uniform Securities Agent", examTakenDate: "12/19/1989", examScope: "BC" }],
  productExamCategory: [{ examCategory: "SIE", examName: "Securities Industry Essentials", examTakenDate: "10/1/2018", examScope: "BC" }],
  principalExamCategory: [],
  registrationCount: { approvedFinraRegistrationCount: 2 },
  registeredStates: [{ state: "Washington", regScope: "BC", status: "APPROVED", regDate: "1/1/1990" }],
  registeredSROs: [{ sro: "FINRA", status: "APPROVED", CategoriesList: ["GS"] }],
};

test("deriveFirmCount counts DISTINCT firms across all four employment arrays", () => {
  // ALPHA appears in both current arrays; it must count once. 100/200/300 = 3.
  assert.equal(deriveFirmCount(DETAIL), 3);
});

test("deriveFirmHistory de-dupes and puts current employers first", () => {
  const history = deriveFirmHistory(DETAIL);
  assert.equal(history.length, 3);
  assert.equal(history[0].firmName, "ALPHA");
  assert.equal(history[0].current, true);
  assert.deepEqual(
    history.map((f) => f.firmName).sort(),
    ["ALPHA", "BETA", "GAMMA"],
  );
  assert.equal(history.find((f) => f.firmName === "BETA").registrationEndDate, "1/1/2010");
});

test("deriveExams flattens all three category arrays", () => {
  const exams = deriveExams(DETAIL);
  assert.equal(exams.length, 2);
  assert.deepEqual(exams.map((e) => e.category).sort(), ["SIE", "Series 63"]);
});

test("deriveDisclosures passes the open detail bag through verbatim", () => {
  const [d] = deriveDisclosures(DETAIL);
  assert.equal(d.type, "Regulatory");
  // disclosureDetail has no fixed schema, so it must survive untouched.
  assert.deepEqual(d.detail, { Allegations: "x" });
});

test("deriveBranches labels FINRA coordinates as zip_centroid, never rooftop", () => {
  const [branch] = deriveBranches(DETAIL);
  assert.equal(branch.branchOfficeId, "b1");
  assert.equal(branch.street1, "1 Main St");
  assert.equal(branch.geoPrecision, GEO_PRECISION.ZIP_CENTROID);
});

test("deriveBranches marks a location with no coordinates as unknown", () => {
  const [branch] = deriveBranches({
    currentEmployments: [{ firmId: 1, branchOfficeLocations: [{ branchOfficeId: "x", street1: "2 Oak" }] }],
  });
  assert.equal(branch.geoPrecision, GEO_PRECISION.UNKNOWN);
});

test("buildProfile assembles the full record", () => {
  const p = buildProfile("123", DETAIL, NOW);
  assert.equal(p.crd, "123");
  assert.equal(p.name, "JANE DOE");
  assert.equal(p.yearsExperience, 20);
  assert.equal(p.firmCount, 3);
  assert.equal(p.exams.length, 2);
  assert.equal(p.hasDisclosures, true);
  assert.equal(p.isBroker, true);
  assert.equal(p.isInvestmentAdvisor, true);
  assert.equal(p.isBarred, false);
  assert.equal(p.reportUrl, "https://files.brokercheck.finra.org/individual/individual_123.pdf");
});

test("buildProfile survives an empty/garbage payload without throwing", () => {
  const p = buildProfile("999", {}, NOW);
  assert.equal(p.crd, "999");
  assert.equal(p.yearsExperience, null);
  assert.equal(p.firmCount, 0);
  assert.deepEqual(p.exams, []);
  assert.deepEqual(p.branches, []);
});

// --- SEC IAPD enrichment ------------------------------------------------------
// BrokerCheck genuinely holds no experience or disclosures for adviser-only individuals;
// its own site renders "For Disclosures and Years of Experience visit SEC" for them.
// Caught from real data: CRD 1203266 (MICHAEL LAWRENCE THAYER).
import { mergeIapdProfile } from "./profile.mjs";

const IAPD = {
  basicInformation: {
    individualId: 1203266, firstName: "MICHAEL", lastName: "THAYER",
    bcScope: "NotInScope", iaScope: "Active",
    daysInIndustryCalculatedDateIAPD: "9/17/1996", // the THIRD spelling
  },
  currentIAEmployments: [
    { firmId: 108815, firmName: "PRIVATE ASSET MANAGEMENT INC",
      branchOfficeLocations: [{ branchOfficeId: "z1", street1: "3740 CARILLON POINT", city: "KIRKLAND", state: "WA", zipCode: "98033" }] },
  ],
  previousIAEmployments: [{ firmId: 222, firmName: "OLD IA FIRM" }],
  iaDisclosureFlag: "N",
  disclosures: [], iaDisclosures: [],
  examsCount: { stateExamCount: 2, principalExamCount: 1, productExamCount: 1 },
  stateExamCategory: [{ examCategory: "Series 65", examName: "Uniform IA Law", examTakenDate: "9/17/1996", examScope: "IA" }],
  registeredStates: [{ state: "Washington", regScope: "IA", status: "APPROVED", regDate: "9/17/1996" }],
};

test("IAPD supplies experience via daysInIndustryCalculatedDateIAPD", () => {
  const bare = buildProfile("1203266", { basicInformation: { bcScope: "NotInScope", iaScope: "Active" } }, NOW);
  assert.equal(bare.yearsExperience, null, "BrokerCheck alone has nothing");
  const merged = mergeIapdProfile(bare, IAPD, NOW);
  assert.ok(merged.yearsExperience > 29 && merged.yearsExperience < 31, `got ${merged.yearsExperience}`);
});

test("IAPD fills firm history, exams, branches and states when BrokerCheck has none", () => {
  const bare = buildProfile("1203266", { basicInformation: { bcScope: "NotInScope" } }, NOW);
  const merged = mergeIapdProfile(bare, IAPD, NOW);
  assert.equal(merged.firmCount, 2);
  assert.equal(merged.firmHistory[0].firmName, "PRIVATE ASSET MANAGEMENT INC");
  assert.equal(merged.exams.length, 1);
  assert.equal(merged.branches[0].street1, "3740 CARILLON POINT");
  assert.equal(merged.registeredStates[0].state, "Washington");
  assert.deepEqual(merged.dataSources, ["brokercheck", "sec_iapd"]);
});

test("IAPD merge NEVER overwrites data BrokerCheck already provided", () => {
  // A dual-registered broker must not have their richer BrokerCheck record clobbered.
  const rich = buildProfile("999", DETAIL, NOW);
  const merged = mergeIapdProfile(rich, IAPD, NOW);
  assert.equal(merged.yearsExperience, rich.yearsExperience);
  assert.equal(merged.firmCount, rich.firmCount);
  assert.deepEqual(merged.exams, rich.exams);
  assert.deepEqual(merged.branches, rich.branches);
});

test("a null IAPD payload leaves the profile untouched", () => {
  const bare = buildProfile("1", { basicInformation: {} }, NOW);
  assert.deepEqual(mergeIapdProfile(bare, null, NOW), bare);
});
