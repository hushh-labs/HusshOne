#!/usr/bin/env node
/**
 * Upgrade a built index from postcode centroids to street-level coordinates.
 *
 *   node scripts/geocode-index.mjs [--data ./data]
 *
 * Runs as a separate pass over an existing index.json rather than inside the build, so
 * improving accuracy costs ~50 seconds instead of re-fetching every issuer from the SEC.
 *
 * It CASCADES: an issuer that fails to geocode keeps the ZIP centroid it already had.
 * A straight replacement would lose coverage — street-level places fewer issuers than
 * centroids do, because centroids only need a postcode while geocoding needs a real
 * street that TIGER knows about.
 */

import fs from "node:fs";
import path from "node:path";

import { config } from "./lib/config.mjs";
import { geocodeAll } from "./lib/geocode.mjs";
import { isUsAddress } from "./lib/geo-us.mjs";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const log = (...parts) => console.log("[geocode-index]", ...parts);

async function main() {
  const dataDir = path.resolve(arg("data", config.dataDir));
  const file = path.join(dataDir, "index.json");

  if (!fs.existsSync(file)) throw new Error(`No index at ${file}. Run build-index.mjs first.`);

  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  log(`loaded ${index.issuers.length} issuers`);

  // Only US issuers with a real street line are worth sending. A company-name-only
  // street ("ULTRA CLEAN HOLDINGS, INC.") or a PO box cannot geocode by definition.
  const candidates = index.issuers
    .filter((issuer) => isUsAddress(issuer.address) && issuer.address.street1)
    .filter((issuer) => !/^\s*(P\.?\s?O\.?\s+BOX|POST OFFICE BOX)/i.test(issuer.address.street1))
    .map((issuer) => ({
      id: issuer.cik,
      street: issuer.address.street1,
      city: issuer.address.city,
      state: issuer.address.state,
      zip: issuer.address.zip,
    }));

  log(`geocoding ${candidates.length} US business addresses`);

  const matched = await geocodeAll(candidates, {
    onProgress: ({ benchmark, done, total }) => log(`${benchmark}: ${done}/${total} matched`),
  });

  let upgraded = 0;
  let keptCentroid = 0;

  for (const issuer of index.issuers) {
    const point = matched.get(String(issuer.cik));
    if (point) {
      issuer.lat = point.lat;
      issuer.lng = point.lng;
      issuer.geoTier = "street";
      issuer.geocodedAddress = point.matchedAddress;
      upgraded += 1;
    } else if (issuer.lat != null) {
      issuer.geoTier = issuer.geoTier || "zip_centroid";
      keptCentroid += 1;
    }
  }

  index.meta.geocodedAt = new Date().toISOString();
  index.meta.issuersStreetLevel = upgraded;
  index.meta.issuersZipCentroid = keptCentroid;

  // How many PEOPLE benefit, which is the number that actually matters for the product.
  const streetCiks = new Set(index.issuers.filter((i) => i.geoTier === "street").map((i) => i.cik));
  const peopleHelped = index.people.filter((p) => p.positions.some((q) => streetCiks.has(q.issuerCik))).length;
  index.meta.peopleStreetLevel = peopleHelped;

  fs.writeFileSync(file, JSON.stringify(index));
  log(`street-level ${upgraded} | kept centroid ${keptCentroid} | people improved ${peopleHelped}`);
}

main().catch((error) => {
  console.error("[geocode-index] failed:", error.message);
  process.exit(1);
});
