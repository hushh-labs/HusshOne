import assert from "node:assert/strict";
import test from "node:test";

import { buildPhysicians, extractPercent, isPhysicianHeld, parseOwnership, scrubFreeText } from "./cms-ownership.mjs";

/** Real row shape from the 2025 dataset (800aed1b…). */
const ROW = {
  physician_profile_id: "752056",
  physician_npi: "1649393182",
  physician_first_name: "BARRY",
  physician_middle_name: "",
  physician_last_name: "MUSIKANT",
  physician_name_suffix: "",
  recipient_primary_business_street_address_line1: "89 LEUNING STREET",
  recipient_city: "SOUTH HACKENSACK",
  recipient_state: "NJ",
  recipient_zip_code: "07606",
  physician_primary_type: "Doctor of Dentistry",
  physician_specialty: "Dental Providers|Dentist|Oral and Maxillofacial Surgery",
  total_amount_invested_usdollars: "1246788.00",
  value_of_interest: "2493577.00",
  terms_of_interest: "50 PERCENT OWNER IN REPORTING ENTITY",
  submitting_applicable_manufacturer_or_applicable_gpo_name: "ESSENTIAL DENTAL SYSTEMS INCORPORATED",
  dispute_status_for_publication: "No",
  interest_held_by_physician_or_an_immediate_family_member: "Physician Covered Recipient",
};

test("a physician's own interest is parsed with exact dollars", () => {
  const p = parseOwnership(ROW);
  assert.equal(p.name, "BARRY MUSIKANT");
  assert.equal(p.npi, "1649393182");
  assert.equal(p.interest.valueOfInterest, 2493577);
  assert.equal(p.interest.amountInvested, 1246788);
  assert.equal(p.interest.inCompany, "ESSENTIAL DENTAL SYSTEMS INCORPORATED");
});

test("the street address never survives — only city and state", () => {
  // The field is labelled "primary business address" but for a solo practitioner it is
  // routinely the practice, which is routinely a home. No flag separates the two.
  const serialised = JSON.stringify(parseOwnership(ROW));
  for (const leak of ["89 LEUNING", "LEUNING STREET", "07606", "street_address"]) {
    assert.equal(serialised.includes(leak), false, `${leak} leaked`);
  }
  assert.equal(parseOwnership(ROW).city, "SOUTH HACKENSACK");
  assert.equal(parseOwnership(ROW).state, "NJ");
});

test("an immediate family member is never indexed", () => {
  // The physician accepted a disclosure duty with the role; their relative did not.
  const family = { ...ROW, interest_held_by_physician_or_an_immediate_family_member: "Immediate family member" };
  assert.equal(isPhysicianHeld(family), false);
  assert.equal(parseOwnership(family), null);
});

test("a stated ownership percentage is extracted, and absence is null not zero", () => {
  assert.equal(extractPercent("50 PERCENT OWNER IN REPORTING ENTITY"), 50);
  assert.equal(extractPercent("holds 12.5% of the entity"), 12.5);
  // Only ~3% of rows state a figure; the rest must say nothing rather than imply 0%.
  assert.equal(extractPercent("STOCK OPTIONS"), null);
  assert.equal(extractPercent(""), null);
  assert.equal(extractPercent(null), null);
  assert.equal(extractPercent("owns 150 percent"), null, "an impossible figure is refused");
});

test("a missing dollar value is null, never zero", () => {
  const blank = { ...ROW, value_of_interest: "", total_amount_invested_usdollars: "" };
  assert.equal(parseOwnership(blank), null, "a row with no figure at all is skipped");

  const partial = { ...ROW, value_of_interest: "" };
  assert.equal(parseOwnership(partial).interest.valueOfInterest, null, "not 0");
  assert.equal(parseOwnership(partial).interest.amountInvested, 1246788);
});

test("specialties split on the pipe delimiter", () => {
  assert.deepEqual(parseOwnership(ROW).specialties,
    ["Dental Providers", "Dentist", "Oral and Maxillofacial Surgery"]);
});

test("a disputed disclosure is flagged rather than dropped", () => {
  const disputed = { ...ROW, dispute_status_for_publication: "Yes" };
  assert.equal(parseOwnership(disputed).interest.disputed, true);
});

test("an address in the manufacturer's free text is redacted, not republished", () => {
  // terms_of_interest is prose written by a third party. Today's file contains no
  // address in it — checked across all 2,646 rows of 2025 — but the field is unbounded,
  // so the guarantee comes from a rule rather than from luck.
  const dirty = "Owns 45% of the clinic at 89 Leuning Street, Suite 400, 07606 per agreement.";
  const clean = scrubFreeText(dirty);

  assert.equal(clean.includes("89 Leuning"), false);
  assert.equal(clean.includes("Suite 400"), false);
  assert.equal(clean.includes("07606"), false);
  assert.ok(clean.includes("45%"), "the useful content survives");
  assert.ok(clean.includes("[address redacted]"), "the redaction is visible, not silent");
});

test("scrubbing does not damage dollar figures or percentages", () => {
  const text = "The total settled amount was $2,550,000; therefore we report the 2025 interest value less $1,275,000 for 45 percent ownership.";
  const clean = scrubFreeText(text);
  assert.ok(clean.includes("$2,550,000"));
  assert.ok(clean.includes("$1,275,000"));
  assert.ok(clean.includes("45 percent"));
  assert.equal(clean.includes("redacted"), false, "nothing here is an address");
});

test("the percentage is read before scrubbing, so redaction cannot hide it", () => {
  const row = { ...ROW, terms_of_interest: "50 PERCENT OWNER, offices at 12 Oak Ave" };
  const parsed = parseOwnership(row);
  assert.equal(parsed.interest.percentOwned, 50);
  assert.equal(parsed.interest.terms.includes("12 Oak Ave"), false);
});

test("several stakes held by one physician merge on NPI and sum honestly", () => {
  // Unlike Form 144 these are concurrent stakes in DIFFERENT entities, each valued
  // once, so a sum is meaningful here where it would double-count there.
  const second = { ...ROW, value_of_interest: "500000.00",
    submitting_applicable_manufacturer_or_applicable_gpo_name: "OTHER DEVICE CO" };
  const [person] = buildPhysicians([ROW, second]);

  assert.equal(person.interestCount, 2);
  assert.equal(person.totalDisclosedInterest, 2993577);
  assert.equal(person.npi, "1649393182");
});

test("family rows are excluded from the roster entirely", () => {
  const family = { ...ROW, physician_npi: "999", interest_held_by_physician_or_an_immediate_family_member: "Immediate family member" };
  const people = buildPhysicians([ROW, family]);
  assert.equal(people.length, 1);
  assert.equal(people[0].npi, "1649393182");
});
