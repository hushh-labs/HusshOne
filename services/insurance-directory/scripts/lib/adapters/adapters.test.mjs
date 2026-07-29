import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL, getAdapter, selectedAdapters } from "./index.mjs";
import { TX } from "./tx.mjs";
import { WA } from "./wa.mjs";
import { CA } from "./ca.mjs";
import { FL } from "./fl.mjs";
import { NY } from "./ny.mjs";

const csv = (header, rows) =>
  [header.join(","), ...rows.map((r) => header.map((c) => r[c] ?? "").join(","))].join("\n");

test("registry exposes the configured adapters and looks them up case-insensitively", () => {
  assert.deepEqual(ALL.map((a) => a.code), ["TX", "WA", "CA", "FL", "NY"]);
  assert.equal(getAdapter("tx"), TX);
  assert.equal(getAdapter(" ny "), NY);
  assert.equal(getAdapter("ZZ"), null);
});

test("selectedAdapters resolves known codes and reports unknown ones as missing", () => {
  const { adapters, missing } = selectedAdapters(["TX", "wa", "ZZ"]);
  assert.deepEqual(adapters.map((a) => a.code), ["TX", "WA"]);
  assert.deepEqual(missing, ["ZZ"]);
});

test("every blocked adapter yields nothing and documents an unblock path", async () => {
  for (const a of [WA, CA, FL, NY]) {
    assert.equal(a.kind, "blocked");
    assert.deepEqual(a.datasets, []);
    assert.ok(typeof a.note === "string" && a.note.length > 20, `${a.code} needs a note`);
    assert.match(a.note, /NIPR|records|request/i);
    const out = [];
    for await (const rec of a.records()) out.push(rec);
    assert.deepEqual(out, [], `${a.code} must yield no records`);
  }
});

test("TX is a working download adapter that yields normalized individuals + agencies", async () => {
  const individuals = csv(
    ["npn", "license_number", "name", "license_type", "qualification", "expiration_date", "city", "state", "pstl_cd"],
    [{ npn: "1", license_number: "IND-1", name: "SMITH, JOHN", license_type: "Agent", qualification: "Life", expiration_date: "2027-01-01", city: "Austin", state: "TX", pstl_cd: "78701" }],
  );
  const agencies = csv(
    ["npn", "agency_license_number", "org_name", "agency_type", "license_type", "qualification", "expiration_date", "city", "state", "pstl_cd"],
    [{ npn: "2", agency_license_number: "AG-1", org_name: "ACME LLC", agency_type: "Corp", license_type: "General Lines", qualification: "Property", expiration_date: "2027-01-01", city: "Dallas", state: "TX", pstl_cd: "75201" }],
  );
  const fetchImpl = async (url) => {
    const body = url.includes("kxv3-diwf") ? individuals : agencies;
    return { ok: true, status: 200, async text() { return body; } };
  };

  const out = [];
  for await (const rec of TX.records({ fetchImpl })) out.push(rec);
  assert.equal(out.length, 2);

  const ind = out.find((r) => r.entityType === "individual");
  const agy = out.find((r) => r.entityType === "agency");
  assert.equal(ind.sourceState, "TX");
  assert.equal(ind.licenseNo, "IND-1");
  assert.deepEqual(ind.sources, ["data.texas.gov/kxv3-diwf"]);
  assert.equal(agy.licenseNo, "AG-1");
  assert.equal(agy.fullName, "ACME LLC");
  assert.deepEqual(agy.sources, ["data.texas.gov/3yqc-fcdt"]);
});
