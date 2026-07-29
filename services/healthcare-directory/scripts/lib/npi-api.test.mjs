import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildApiUrl,
  entityTypeFromEnumeration,
  mapApiResultToProvider,
  searchProviders,
} from "./npi-api.mjs";

test("buildApiUrl sets version, filters, and clamps limit/skip to API ceilings", () => {
  const u = new URL(buildApiUrl({ state: "wa", postalCode: "98033", limit: 999, skip: 5000 }));
  assert.equal(u.searchParams.get("version"), "2.1");
  assert.equal(u.searchParams.get("state"), "WA");
  assert.equal(u.searchParams.get("postal_code"), "98033");
  assert.equal(u.searchParams.get("limit"), "200"); // clamped from 999
  assert.equal(u.searchParams.get("skip"), "1000"); // clamped from 5000
});

test("entityTypeFromEnumeration maps NPI-1/NPI-2", () => {
  assert.equal(entityTypeFromEnumeration("NPI-1"), "individual");
  assert.equal(entityTypeFromEnumeration("NPI-2"), "organization");
  assert.equal(entityTypeFromEnumeration("other"), null);
});

test("mapApiResultToProvider uses LOCATION address, primary taxonomy, and keeps raw", () => {
  const result = {
    number: "1234567890",
    enumeration_type: "NPI-1",
    basic: {
      first_name: "JANE",
      last_name: "SMITH",
      middle_name: "A",
      credential: "MD",
      status: "A",
      enumeration_date: "2007-05-23",
    },
    taxonomies: [
      { code: "207R00000X", desc: "Internal Medicine", primary: false },
      { code: "207Q00000X", desc: "Family Medicine", primary: true },
    ],
    addresses: [
      { address_purpose: "MAILING", address_1: "PO BOX 1", city: "SEATTLE", state: "WA", postal_code: "98101" },
      { address_purpose: "LOCATION", address_1: "123 MAIN ST", address_2: "STE 4", city: "KIRKLAND", state: "wa", postal_code: "98033-2145", telephone_number: "4255551234" },
    ],
  };
  const rec = mapApiResultToProvider(result);
  assert.equal(rec.npi, "1234567890");
  assert.equal(rec.entityType, "individual");
  assert.equal(rec.primaryTaxonomyCode, "207Q00000X");
  assert.equal(rec.primaryTaxonomyDesc, "Family Medicine");
  assert.equal(rec.addressLine1, "123 MAIN ST"); // LOCATION, not MAILING
  assert.equal(rec.city, "KIRKLAND");
  assert.equal(rec.state, "WA");
  assert.equal(rec.zip, "98033");
  assert.equal(rec.phone, "4255551234");
  assert.equal(rec.status, "active");
  assert.equal(rec.source, "npi_api");
  assert.equal(rec.raw, result);
});

test("mapApiResultToProvider returns null without a valid 10-digit number", () => {
  assert.equal(mapApiResultToProvider({ number: "123" }), null);
  assert.equal(mapApiResultToProvider(null), null);
});

test("searchProviders pages by skip and stops on a short final page", async () => {
  const origFetch = global.fetch;
  const seenSkips = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    const skip = Number(u.searchParams.get("skip"));
    seenSkips.push(skip);
    const page = skip === 0 ? [{ number: "1" }, { number: "2" }] : [{ number: "3" }];
    return { ok: true, status: 200, json: async () => ({ results: page }) };
  };
  try {
    const { results, calls, capped } = await searchProviders({ state: "WA" }, { pageSize: 2 });
    assert.equal(results.length, 3);
    assert.equal(calls, 2);
    assert.equal(capped, false);
    assert.deepEqual(seenSkips, [0, 2]);
  } finally {
    global.fetch = origFetch;
  }
});
