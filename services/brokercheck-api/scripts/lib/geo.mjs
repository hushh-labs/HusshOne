// Pure geo helpers. No I/O, no deps — unit-tested without network or DB.

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean earth radius
export const METERS_PER_MILE = 1609.344;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. This is what produces the TRUE ordering — FINRA
 *  exposes no distance field and silently ignores `sort=distance+asc`, so "nearest"
 *  is always synthesized here, never trusted from upstream. */
export function haversineMeters(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every((n) => Number.isFinite(n))) return null;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const milesToMeters = (mi) => mi * METERS_PER_MILE;
export const metersToMiles = (m) => m / METERS_PER_MILE;

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Standard geohash. Used to SNAP query coordinates onto a grid before using them as a
 *  cache key: two users 50 m apart would otherwise each trigger a completely cold run.
 *  Precision 6 ≈ 1.2 km × 0.6 km, which is the right trade for a 10-mile search. */
export function geohash(lat, lng, precision = 6) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = "";
  let bits = 0;
  let bit = 0;
  let even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        bit = (bit << 1) + 1;
        lngMin = mid;
      } else {
        bit <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bit = (bit << 1) + 1;
        latMin = mid;
      } else {
        bit <<= 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bits === 5) {
      hash += BASE32[bit];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

/** How precisely a coordinate locates a real place. The repo's standing rule is that a
 *  distance must never look more exact than its input, so this rides with every record.
 *   - rooftop      : geocoded from a street address
 *   - zip_centroid : FINRA's own coordinates (their geo index is ZIP-centroid based —
 *                    three different Kirkland buildings all return 47.673156,-122.197628)
 *   - unknown      : no coordinate resolved */
export const GEO_PRECISION = {
  ROOFTOP: "rooftop",
  ZIP_CENTROID: "zip_centroid",
  UNKNOWN: "unknown",
};

/** Round a distance so the rendered number cannot imply more precision than we have.
 *  ZIP-centroid coordinates carry 57–864 m of error (measured against published
 *  centroids), so anything derived from them is floored to 500 m and rounded to 100 m. */
export function presentDistance(meters, precision) {
  if (!Number.isFinite(meters)) return null;
  if (precision === GEO_PRECISION.ROOFTOP) return Math.round(meters);
  return Math.max(500, Math.round(meters / 100) * 100);
}
