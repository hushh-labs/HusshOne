import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pick,
  mapHealthcareRow,
  mapRiaAdviserRow,
  mapRiaFirmRow,
  mapInsuranceRow,
  mapHotelRow,
  mapSocialRecord,
  extractSocialRecords,
} from "./source-connectors.mjs";

test("pick is case-insensitive and skips empties", () => {
  const row = { First_Name: "Jane", last_name: "", NPI: 123 };
  assert.equal(pick(row, ["first_name"]), "Jane");
  assert.equal(pick(row, ["last_name", "npi"]), 123, "empty string skipped, next candidate used");
  assert.equal(pick(row, ["missing"]), null);
});

test("mapHealthcareRow maps npi+name, needs a key and a name", () => {
  const e = mapHealthcareRow({ npi: "1558", first_name: "Jane", last_name: "Smith", business_zip: "98033", state: "WA" });
  assert.equal(e.sourceVertical, "healthcare");
  assert.equal(e.kind, "person");
  assert.equal(e.profession, "healthcare");
  assert.equal(e.sourceKey, "1558");
  assert.equal(e.firstName, "Jane");
  assert.equal(e.zip, "98033");
  assert.equal(mapHealthcareRow({ first_name: "Jane" }), null, "no npi -> null");
  assert.equal(mapHealthcareRow({ npi: "1" }), null, "no name -> null");
});

test("mapRiaAdviserRow (person) vs mapRiaFirmRow (org)", () => {
  const adv = mapRiaAdviserRow({ crd: "42", full_name: "John Doe", firm_name: "Acme" });
  assert.equal(adv.kind, "person");
  assert.equal(adv.sourceKey, "42");
  assert.equal(adv.org, "Acme");

  const firm = mapRiaFirmRow({ crd: "99", firm_name: "Acme Advisors LLC", state: "NY" });
  assert.equal(firm.kind, "org");
  assert.equal(firm.name, "Acme Advisors LLC");
  assert.equal(firm.org, "Acme Advisors LLC");
  assert.equal(mapRiaFirmRow({ crd: "99" }), null, "firm needs a name");
});

test("mapInsuranceRow uses license_no as the key", () => {
  const e = mapInsuranceRow({ license_no: "L-7", name: "Jane Smith", license_state: "CA" });
  assert.equal(e.sourceVertical, "insurance");
  assert.equal(e.sourceKey, "L-7");
  assert.equal(e.attributes.licenseState, "CA");
});

test("mapHotelRow is an org keyed by dedup_key", () => {
  const e = mapHotelRow({ dedup_key: "d1", name: "Grand Hotel", formatted_address: "1 Main St", zip: "98033", state: "WA", place_id: "p1" });
  assert.equal(e.kind, "org");
  assert.equal(e.profession, "hospitality");
  assert.equal(e.sourceKey, "d1");
  assert.equal(e.address, "1 Main St");
  assert.equal(e.attributes.placeId, "p1");
  assert.equal(mapHotelRow({ name: "x" }), null, "hotel needs a key");
});

test("mapSocialRecord builds an entity + tagged relations", () => {
  const { entity, relations } = mapSocialRecord("instagram", {
    username: "Jane",
    fullName: "Jane Q",
    stats: { followers: 10, following: 5 },
    follows: [{ username: "Bob" }, "carol"],
    mentions: ["dave"],
  });
  assert.equal(entity.sourceVertical, "instagram");
  assert.equal(entity.sourceKey, "jane", "handle lowercased for a stable key");
  assert.equal(entity.attributes.followers, 10);
  assert.deepEqual(relations, [
    { vertical: "instagram", srcHandle: "jane", dstHandle: "bob", type: "follow" },
    { vertical: "instagram", srcHandle: "jane", dstHandle: "carol", type: "follow" },
    { vertical: "instagram", srcHandle: "jane", dstHandle: "dave", type: "mention" },
  ]);
  assert.deepEqual(mapSocialRecord("twitter", {}), { entity: null, relations: [] }, "no handle -> nothing");
});

test("extractSocialRecords unwraps arrays / results / template envelopes", () => {
  assert.equal(extractSocialRecords({ results: [{ template: { username: "a" } }, { username: "b" }] }).length, 2);
  assert.equal(extractSocialRecords([{ username: "c" }]).length, 1);
  assert.equal(extractSocialRecords({ username: "d" }).length, 1);
  assert.equal(extractSocialRecords({ foo: 1 }).length, 0, "no handle-bearing record -> empty");
  assert.equal(extractSocialRecords(null).length, 0);
});
