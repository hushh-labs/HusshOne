/**
 * Geography. ZIP centroids from the Census Bureau's ZCTA gazetteer, plus haversine.
 *
 * The gazetteer is a free federal file (33,791 ZCTAs) that ships with the service, so
 * resolving a postcode costs no network call and no vendor. The trade-off is precision:
 * a ZCTA centroid is the centre of a postcode area, so every address in one postcode
 * collapses to one point. Distances are labelled `zip_centroid` and floored so they
 * never imply accuracy the source cannot support.
 */

import fs from "node:fs";
import path from "node:path";

const EARTH_RADIUS_MI = 3958.7613;

/** Below this, a distance is reported as "same postcode" rather than a false precision. */
export const MIN_MEANINGFUL_MI = 0.5;

/**
 * ZIP -> {lat, lng}. Loaded once from the bundled gazetteer.
 * @type {Map<string, {lat: number, lng: number}>}
 */
let centroids = null;

export function loadCentroids(dataDir) {
  if (centroids) return centroids;

  const file = path.join(dataDir, "zcta-centroids.tsv");
  centroids = new Map();

  if (!fs.existsSync(file)) return centroids;

  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [zip, lat, lng] = line.split("\t");
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!zip || !Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) continue;
    centroids.set(zip.padStart(5, "0"), { lat: parsedLat, lng: parsedLng });
  }
  return centroids;
}

/** Reset between tests. */
export function resetCentroids() {
  centroids = null;
}

/**
 * Resolve a postcode to coordinates.
 *
 * ZIP+4 is truncated to its 5-digit prefix — the gazetteer is keyed on 5 digits, and
 * silently returning nothing for "94105-1234" would look like an unknown postcode
 * rather than a format we can handle.
 */
export function resolveZip(zip, dataDir) {
  const map = loadCentroids(dataDir);
  const five = String(zip || "").trim().slice(0, 5).padStart(5, "0");
  if (!/^\d{5}$/.test(five)) return null;
  return map.get(five) || null;
}

/** Great-circle distance in miles. */
export function haversineMi(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Distance as it should be reported to a caller.
 *
 * The precision label must state where the coordinate ACTUALLY came from. It was
 * previously hardcoded to "zip_centroid", which survived unnoticed until street-level
 * geocoding landed and every row still claimed to be a centroid — under-reporting
 * 4,303 companies and, worse, leaving a caller no way to tell a precise row from an
 * approximate one.
 *
 * The half-mile floor exists because a centroid puts every address in a postcode on
 * one point, so "0.2 miles" there is an artefact rather than a measurement. That
 * reasoning does not apply to a geocoded street address, where 0.2 miles is real — so
 * the floor is applied only to centroid-placed issuers.
 */
export function describeDistance(miles, tier = "zip_centroid") {
  const isCentroid = tier !== "street";
  const rounded = isCentroid && miles < MIN_MEANINGFUL_MI ? 0 : Math.round(miles * 10) / 10;

  return {
    distanceMiles: rounded,
    // Street coordinates are interpolated along TIGER address ranges, so they are
    // accurate to tens of metres rather than rooftop-exact. Still approximate, but
    // approximate at a different order of magnitude — hence the tier, not just a flag.
    distanceApproximate: true,
    geoPrecision: isCentroid ? "zip_centroid" : "street_interpolated",
  };
}
