import assert from "node:assert/strict";
import test from "node:test";

import { collapseCoFiled, looksLikeEntity, summarise } from "./orchestrate.mjs";

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

test("the summary counts a co-filed position once, not once per filer", () => {
  const collapsed = collapseCoFiled([
    row("1", "A LLC", { value: 1000000 }),
    row("2", "B LLC", { value: 1000000 }),
    row("3", "C", { issuerCik: "2", shares: 99, value: 500 }),
  ]);
  const s = summarise(collapsed);

  assert.equal(s.people, 2, "two distinct positions");
  assert.equal(s.companies, 2);
  assert.equal(s.sumOfLargestDisclosedPositions, 1000500, "the $1m position is counted ONCE");
});

test("unpriced positions are counted, not silently dropped", () => {
  const s = summarise([row("1", "A", { value: null }), row("2", "B", { shares: 7, value: 100 })]);
  assert.equal(s.positionsPriced, 1);
  assert.equal(s.positionsUnpriced, 1);
  assert.equal(s.sumOfLargestDisclosedPositions, 100);
});

test("an empty area summarises to zeroes rather than throwing", () => {
  const s = summarise([]);
  assert.equal(s.people, 0);
  assert.equal(s.companies, 0);
  assert.equal(s.sumOfLargestDisclosedPositions, 0);
  assert.deepEqual(s.topEmployersByDisclosedValue, []);
});
