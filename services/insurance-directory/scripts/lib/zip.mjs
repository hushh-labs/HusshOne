// US ZIP + geo helpers: validation, GeoNames parsing, and great-circle distance
// (used to order the crawl queue outward from Kirkland).

import { KIRKLAND } from "./config.mjs";

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg) => (deg * Math.PI) / 180;

export function isValidUsZip(value) {
  return /^\d{5}$/.test(String(value ?? "").trim());
}

// Extract a clean 5-digit ZIP from a string/number ("98033-1234" → "98033", 2138 → "02138").
export function normalizeZip(value) {
  if (value == null) return null;
  const digits = String(value).trim().replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.length >= 5) return digits.slice(0, 5);
  return digits.padStart(5, "0");
}

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceFromKirklandKm(lat, lng) {
  return haversineKm(KIRKLAND, { lat, lng });
}

// Parse one line of the GeoNames US postal export (US.txt), a tab-separated file:
//   country, postal_code, place_name, admin1_name(state), admin1_code(WA),
//   admin2_name(county), admin2_code, admin3_name, admin3_code, lat, lng, accuracy
// Returns null for blank/malformed lines or non-5-digit ZIPs (some territories differ).
export function parseGeoNamesLine(line) {
  if (!line || !line.trim()) return null;
  const cols = line.split("\t");
  if (cols.length < 11) return null;
  const zip = normalizeZip(cols[1]);
  if (!isValidUsZip(zip)) return null;
  const lat = Number(cols[9]);
  const lng = Number(cols[10]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const state = String(cols[4] || "").trim().toUpperCase().slice(0, 2) || null;
  return {
    zip,
    city: (cols[2] || "").trim() || null,
    state,
    county: (cols[5] || "").trim() || null,
    lat,
    lng,
    distKm: distanceFromKirklandKm(lat, lng),
  };
}
