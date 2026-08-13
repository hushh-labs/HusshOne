import assert from "node:assert/strict";
import test from "node:test";

import { resetIndex, setIndex } from "./index-store.mjs";

process.env.NODE_ENV = "test";
process.env.INSIDER_API_KEY = "";
const { server } = await import("../../server.mjs");

function seedCofilers() {
  const issuers = new Map([
    ["100", {
      cik: "100",
      name: "Example Public Co",
      address: { city: "Chicago", state: "IL", street1: "1 PUBLIC WAY", zip: "60637" },
      phone: "555-0100",
      lat: 41.782504,
      lng: -87.602734,
      geoTier: "zip_centroid",
    }],
  ]);
  const sharedPosition = {
    issuerCik: "100",
    issuerName: "Example Public Co",
    ticker: "EX",
    security: "Common Stock",
    shares: 100,
    pricePerShare: 10,
    value: 1000,
    marketValue: 1000,
    asOf: "2026-08-01",
    formType: "4",
    title: null,
  };
  const people = new Map([
    ["1", {
      cik: "1",
      name: "ALPHA PERSON",
      roles: ["Director"],
      positionsValued: 1,
      positions: [{ ...sharedPosition, relationship: "Director" }],
    }],
    ["2", {
      cik: "2",
      name: "BETA PERSON",
      roles: ["Officer"],
      positionsValued: 1,
      positions: [{ ...sharedPosition, relationship: "Officer" }],
    }],
  ]);
  setIndex({
    people,
    issuers,
    meta: { built: true, builtAt: new Date().toISOString(), partial: false },
  });
}

async function startServer() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("around professional mode declares non-financial ranking and keeps people separate", async () => {
  seedCofilers();
  const base = await startServer();
  try {
    const common = "lat=41.782504&lng=-87.602734&radiusMi=25&limit=10&stream=json";
    const defaultResponse = await fetch(`${base}/v1/around?${common}`);
    const defaultBody = await defaultResponse.json();
    assert.equal(defaultResponse.status, 200);
    assert.equal(defaultBody.holders.length, 1, "the default still collapses a co-filed position");
    assert.equal("ranking" in defaultBody, false, "the default response contract is unchanged");

    const professionalResponse = await fetch(
      `${base}/v1/around?${common}&ranking=professional&subjectType=person`,
    );
    const professionalBody = await professionalResponse.json();
    assert.equal(professionalResponse.status, 200);
    assert.equal(professionalBody.holders.length, 2, "professional mode keeps both people");
    assert.deepEqual(professionalBody.holders.map((row) => row.name), [
      "BETA PERSON",
      "ALPHA PERSON",
    ]);
    assert.equal(professionalBody.duplicatesRemoved, 0);
    assert.equal(professionalBody.ranking.mode, "professional");
    assert.equal(professionalBody.ranking.relationshipScope, "selected_position");
    assert.deepEqual(professionalBody.ranking.excludes, ["disclosed_value", "market_value"]);
    assert.equal(professionalBody.summary.valueUsedForSelectionOrRanking, false);
    assert.equal(professionalBody.index.built, true);
    assert.equal(professionalBody.index.stale, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    resetIndex();
  }
});
