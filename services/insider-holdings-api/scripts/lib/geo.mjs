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
 * Anything under half a mile is a centroid artefact rather than a measurement, so it
 * is reported as 0 with `approximate: true` instead of a decimal that invites the
 * reader to believe we know which building someone is in.
 */
export function describeDistance(miles) {
  const rounded = miles < MIN_MEANINGFUL_MI ? 0 : Math.round(miles * 10) / 10;
  return {
    distanceMiles: rounded,
    distanceApproximate: true,
    geoPrecision: "zip_centroid",
  };
}
