import assert from "node:assert/strict";
import test from "node:test";

import { collapseCoFiled, looksLikeEntity, subjectType, summarise } from "./orchestrate.mjs";

const row = (cik, name, { issuerCik = "1", shares = 1000, asOf = "2026-06-16", value = 5000 } = {}) => ({
  cik, name, roles: ["Officer"], title: null,
  position: { issuerCik, issuerName: "Co", shares, asOf, disclosedValue: value, kind: "direct" },
});

test("one position filed by many entities collapses to one row", () => {
  // Modelled on the real group of 37 filers all reporting 1,650,000 shares.
  const rows = [
    row("1", "Lightspeed SPV II, LLC"),
    row("2", "Lightspeed SPV II-B, LLC"),
    row("3", "Lightspeed Venture Partners"),
  ];
  const collapsed = collapseCoFiled(rows);

  assert.equal(collapsed.length, 1, "one economic position, one row");
  assert.equal(collapsed[0].filerCount, 3);
  assert.equal(collapsed[0].filers.length, 3, "every filer is still listed — nothing hidden");
});

test("genuinely different positions are not merged", () => {
  const rows = [
    row("1", "A", { shares: 1000 }),
    row("2", "B", { shares: 2000 }),
    row("3", "C", { issuerCik: "2" }),
    row("4", "D", { asOf: "2026-01-01" }),
  ];
  assert.equal(collapseCoFiled(rows).length, 4);
});

test("options and shares in the same company stay separate", () => {
  const shares = row("1", "A");
  const options = { ...row("1", "A"), position: { ...row("1", "A").position, kind: "derivative" } };
  assert.equal(collapseCoFiled([shares, options]).length, 2, "different holdings, not duplicates");
});

test("a natural person is preferred as the headline name over a fund entity", () => {
  // A fund stack usually lists its LLCs first; the human is the more useful label.
  const collapsed = collapseCoFiled([row("1", "TC Group VII S1, L.L.C."), row("2", "Rubenstein David")]);
  assert.equal(collapsed[0].name, "Rubenstein David");
  assert.equal(collapsed[0].filerCount, 2, "the entity is still counted and listed");
});

test("the first person named wins — a later entity does not displace them", () => {
  const collapsed = collapseCoFiled([row("1", "Rubenstein David"), row("2", "TC Group VII S1, L.L.C.")]);
  assert.equal(collapsed[0].name, "Rubenstein David");
});

test("repeated filings by one entity do not inflate the filer list", () => {
  // The real "37 filers" contained the same entities on several filings.
  const collapsed = collapseCoFiled([row("1", "FINCO I LLC"), row("1", "FINCO I LLC"), row("2", "FIG Buyer GP, LLC")]);
  assert.equal(collapsed[0].filers.length, 2, "deduped by CIK");
});

test("entity detection covers the common corporate suffixes", () => {
  for (const name of ["Lightspeed SPV II, LLC", "TC Group VII S1, L.P.", "Deutsche Telekom AG",
                      "Acme Holdings", "Foo Capital", "Bar Partners", "Baz Trust"]) {
    assert.equal(looksLikeEntity(name), true, `${name} should read as an entity`);
  }
  for (const name of ["Rubenstein David", "Jassy Andrew R", "BEZOS JEFFREY P"]) {
    assert.equal(looksLikeEntity(name), false, `${name} should read as a person`);
  }
});

test("every collapsed row is labelled person or entity", () => {
  const rows = collapseCoFiled([row("1", "BEZOS JEFFREY P"), row("2", "DEUTSCHE TELEKOM AG", { shares: 5 })]);
  assert.equal(rows.find((r) => r.name === "BEZOS JEFFREY P").subjectType, "person");
  assert.equal(rows.find((r) => r.name === "DEUTSCHE TELEKOM AG").subjectType, "entity");
});

test("real filer names from the live index classify correctly", () => {
  // Every one of these appears in the deployed index around Kirkland.
  for (const name of ["DEUTSCHE TELEKOM AG", "SVF Investments (UK) Ltd", "Lightspeed SPV II, LLC",
                      "TC Group VII S1, L.P.", "FINCO I LLC", "Carlyle Mozart Coinvestment Holdings, L.P."]) {
    assert.equal(subjectType(name), "entity", `${name} should be an entity`);
  }
  for (const name of ["BEZOS JEFFREY P", "Jassy Andrew R", "CLAURE RAUL MARCELO", "Nadella Satya",
                      "Hood Amy", "HOVDE STEVEN D", "SMITH BRADFORD L", "Ehrlichman Matt"]) {
    assert.equal(subjectType(name), "person", `${name} should be a person`);
  }
});

test("a person is never misread as a company by a loose marker", () => {
  // Misclassifying a person is the worse error: a subjectType=person filter would then
  // silently hide a real human. These are the near-misses the markers must not catch.
  for (const name of ["Grant Coe", "Angela Ltda", "Colin Trustman", "Agnes Miller", "Lipman Corey"]) {
    assert.equal(subjectType(name), "person", `${name} must not read as an entity`);
  }
});

test("the summary splits value between people and corporations", () => {
  const rows = collapseCoFiled([
    row("1", "BEZOS JEFFREY P", { value: 200 }),
    row("2", "DEUTSCHE TELEKOM AG", { shares: 5, value: 128 }),
  ]);
  const s = summarise(rows);

  assert.equal(s.holders, 2);
  assert.equal(s.naturalPersons, 1);
  assert.equal(s.entities, 1);
  assert.equal(s.heldByNaturalPersons, 200);
  assert.equal(s.heldByEntities, 128, "a single total would hide that this is corporate");
  assert.equal(s.sumOfLargestPositionsAtMarket, 328);
});

test("the summary counts a co-filed position once, not once per filer", () => {
  const collapsed = collapseCoFiled([
    row("1", "A LLC", { value: 1000000 }),
    row("2", "B LLC", { value: 1000000 }),
    row("3", "C", { issuerCik: "2", shares: 99, value: 500 }),
  ]);
  const s = summarise(collapsed);

  assert.equal(s.holders, 2, "two distinct positions");
  assert.equal(s.companies, 2);
  assert.equal(s.sumOfLargestPositionsAtMarket, 1000500, "the $1m position is counted ONCE");
});

test("unpriced positions are counted, not silently dropped", () => {
  const s = summarise([row("1", "A", { value: null }), row("2", "B", { shares: 7, value: 100 })]);
  assert.equal(s.positionsPriced, 1);
  assert.equal(s.positionsUnpriced, 1);
  assert.equal(s.sumOfLargestPositionsAtMarket, 100);
});

test("an empty area summarises to zeroes rather than throwing", () => {
  const s = summarise([]);
  assert.equal(s.holders, 0);
  assert.equal(s.companies, 0);
  assert.equal(s.sumOfLargestPositionsAtMarket, 0);
  assert.deepEqual(s.topEmployersByValue, []);
});

/** A row carrying both a filed value and a re-priced market value. */
const priced = (cik, name, { filed, market, at = "2026-06-16", issuerCik = "1" }) => ({
  cik, name, roles: ["Officer"], title: null,
  position: {
    issuerCik, issuerName: "Co", shares: 1000, asOf: "2026-01-05", kind: "direct",
    disclosedValue: filed, marketValue: market, marketPriceAsOf: at,
    repricedFrom: market != null && filed != null ? 1 : null,
  },
});

test("the headline total uses market values, not filed ones", () => {
  // A holder who last filed in January is valued at June's price like everyone else.
  const s = summarise([
    priced("1", "A", { filed: 100, market: 130 }),
    priced("2", "B", { filed: 200, market: 260 }),
  ]);
  assert.equal(s.sumOfLargestPositionsAtMarket, 390);
  assert.equal(s.sumOfLargestPositionsAsFiled, 300, "the filed total is kept, not overwritten");
  assert.equal(s.positionsRepriced, 2);
});

test("a security with no market price falls back to its filed value", () => {
  const s = summarise([
    priced("1", "A", { filed: 100, market: 130 }),
    { ...priced("2", "B", { filed: 70, market: null }), },
  ]);
  assert.equal(s.sumOfLargestPositionsAtMarket, 200, "130 + the unrepriced 70");
  assert.equal(s.positionsPriced, 2, "still priced, just not repriced");
});

test("pricedThrough reports the OLDEST price, not the newest", () => {
  // The weakest link bounds how current the whole answer is. Reporting the newest would
  // flatter a total that contains a year-old price.
  const s = summarise([
    priced("1", "A", { filed: 1, market: 1, at: "2026-06-30" }),
    priced("2", "B", { filed: 1, market: 1, at: "2025-08-22" }),
  ]);
  assert.equal(s.pricedThrough, "2025-08-22");
});

test("a filed value with no market price still contributes to the filed total", () => {
  const s = summarise([{ ...priced("1", "A", { filed: 500, market: null }) }]);
  assert.equal(s.sumOfLargestPositionsAsFiled, 500);
  assert.equal(s.positionsRepriced, 0, "nothing was repriced");
});
