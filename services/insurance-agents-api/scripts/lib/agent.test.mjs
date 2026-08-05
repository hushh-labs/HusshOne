import test from "node:test";
import assert from "node:assert/strict";
import { mapAgency } from "./agent.mjs";
import { GEO_PRECISION } from "./geo.mjs";

// Shaped after the real locations[0] for ZIP 98033 (B G I Agency Network, 0.22 mi) plus the
// custom fields the schema exposes.
const ENTRY = {
  url: "wa/kirkland/98033/b-g-i-agency-network-inc",
  loc: {
    id: "12345",
    name: "B G I Agency Network Inc.",
    address1: "10829 NE 68th St",
    address2: "Ste 202",
    city: "Kirkland",
    state: "WA",
    postalCode: "98033",
    country: "US",
    latitude: 47.6812,
    longitude: -122.1934,
    milesToQueryLocation: 0.22,
    phone: "(206) 726-0906",
    emails: ["bgi@example.com"],
    website: "https://bgiagency.example",
    products: ["Auto", "Commercial", "Farm", "Home", "Renters"],
    customByName: { "Agency Type": "Elite", "Agency Tier": "Tier 1" },
    hours: { monday: { openIntervals: [{ start: "09:00", end: "17:00" }] } },
    yearEstablished: "1998",
  },
};

test("maps the core fields a card needs", () => {
  const a = mapAgency(ENTRY);
  assert.equal(a.name, "B G I Agency Network Inc.");
  assert.equal(a.address.formatted, "10829 NE 68th St, Ste 202, Kirkland, WA 98033");
  assert.equal(a.phone, "(206) 726-0906");
  assert.equal(a.email, "bgi@example.com");
  assert.equal(a.website, "https://bgiagency.example");
  assert.deepEqual(a.products.slice(0, 3), ["Auto", "Commercial", "Farm"]);
});

test("uses the locator's own miles as the distance", () => {
  const a = mapAgency(ENTRY);
  assert.equal(a.distanceMiles, 0.22);
  assert.equal(a.distanceMeters, 354); // 0.22 * 1609.344, geocoded precision → rounded not floored
  assert.equal(a.geoPrecision, GEO_PRECISION.GEOCODED);
  assert.deepEqual(a.location, { lat: 47.6812, lng: -122.1934 });
});

test("surfaces Agency Type (the ELITE STATUS badge) and tier from customByName", () => {
  const a = mapAgency(ENTRY);
  assert.equal(a.agencyType, "Elite");
  assert.equal(a.tier, "Tier 1");
});

test("falls back to the entry url for website when loc has none", () => {
  const { website, ...loc } = ENTRY.loc;
  const a = mapAgency({ url: ENTRY.url, loc });
  assert.equal(a.website, "https://agency.nationwide.com/wa/kirkland/98033/b-g-i-agency-network-inc");
});

test("degrades to unknown precision when there is no coordinate", () => {
  const a = mapAgency({ loc: { id: "x", name: "No Coords Agency" } });
  assert.equal(a.geoPrecision, GEO_PRECISION.UNKNOWN);
  assert.equal(a.location, null);
  assert.equal(a.distanceMiles, null);
});

test("reads products from customByName when the top-level list is absent", () => {
  const a = mapAgency({
    loc: { id: "y", name: "Alt", customByName: { "Agency Product Information": ["Life", "Farm"] } },
  });
  assert.deepEqual(a.products, ["Life", "Farm"]);
});

test("accepts a bare loc (no wrapper) and returns null for empty input", () => {
  assert.equal(mapAgency({ id: "z", name: "Flat" }).name, "Flat");
  assert.equal(mapAgency({ loc: {} }), null);
  assert.equal(mapAgency(null), null);
});
