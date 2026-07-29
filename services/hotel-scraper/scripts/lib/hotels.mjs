// Map raw records from each data source (Google Places + OpenStreetMap) onto one
// hotel shape, and compute the stable dedup_key that merges the two sources.

import { normalizeZip } from "./zip.mjs";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

// Standard geohash. Precision 6 ≈ a ~1.2km × 0.6km cell — coarse enough that the
// same hotel from OSM vs Places lands in the same cell, fine enough that distinct
// buildings usually don't. Combined with a normalized name it forms the dedup key.
export function geohashEncode(lat, lng, precision = 6) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let hash = "";
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lonMin = mid;
      } else {
        idx *= 2;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx *= 2;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

// Fold a hotel name to a comparison key: strip diacritics, lowercase, drop
// punctuation, collapse whitespace. "Hôtel Déjà-Vu!" → "hotel deja vu".
// NFKD splits accented letters into base + combining mark (U+0300–U+036F), which
// the second replace then removes.
export function normalizeName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function dedupKey(name, lat, lng) {
  return `${normalizeName(name)}|${geohashEncode(lat, lng, 6)}`;
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

// --- Google Places (New) -> hotel ------------------------------------------
function componentByType(components, type) {
  if (!Array.isArray(components)) return null;
  return components.find((c) => Array.isArray(c.types) && c.types.includes(type)) || null;
}

export function mapPlaceToHotel(place, queryZip = null) {
  if (!place) return null;
  const name = place.displayName?.text || place.displayName || null;
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (!name || !isFiniteNum(lat) || !isFiniteNum(lng)) return null;

  const components = place.addressComponents;
  const postal = componentByType(components, "postal_code");
  const admin1 = componentByType(components, "administrative_area_level_1");
  const zip = normalizeZip(postal?.longText || postal?.shortText);
  const state = (admin1?.shortText || "").toUpperCase().slice(0, 2) || null;

  // Photo resource names ("places/{id}/photos/{ref}"). Kept only in photo_refs
  // as a short-lived resolver hint; stripped from `raw` so names live in exactly
  // one place (ToS §3.2.3(b): photo names are not for long-term storage).
  const photoRefs = Array.isArray(place.photos)
    ? place.photos.map((p) => p?.name).filter(Boolean)
    : [];
  const { photos: _photos, ...rawWithoutPhotos } = place;

  return {
    dedupKey: dedupKey(name, lat, lng),
    source: "places",
    placeId: place.id || null,
    osmId: null,
    name,
    formattedAddress: place.formattedAddress || null,
    zip: zip || null,
    queryZip: queryZip ? normalizeZip(queryZip) : null,
    state,
    lat,
    lng,
    rating: isFiniteNum(place.rating) ? place.rating : null,
    userRatingsTotal: Number.isInteger(place.userRatingCount) ? place.userRatingCount : null,
    priceLevel: place.priceLevel || null,
    phone: place.nationalPhoneNumber || null,
    website: place.websiteUri || null,
    googleMapsUri: place.googleMapsUri || null,
    primaryType: place.primaryType || null,
    types: Array.isArray(place.types) ? place.types : null,
    businessStatus: place.businessStatus || null,
    photoRefs,
    raw: rawWithoutPhotos,
  };
}

// --- OpenStreetMap (Overpass element) -> hotel -----------------------------
export function mapOsmElementToHotel(el, queryZip = null) {
  if (!el) return null;
  const tags = el.tags || {};
  const name = tags.name || tags["name:en"] || null;
  // Ways/relations return their centroid under `center` when queried with `out center`.
  const lat = isFiniteNum(el.lat) ? el.lat : el.center?.lat;
  const lng = isFiniteNum(el.lon) ? el.lon : el.center?.lon;
  if (!name || !isFiniteNum(lat) || !isFiniteNum(lng)) return null;

  const zip = normalizeZip(tags["addr:postcode"]);
  const state = (tags["addr:state"] || "").toUpperCase().slice(0, 2) || null;

  return {
    dedupKey: dedupKey(name, lat, lng),
    source: "osm",
    placeId: null,
    osmId: el.type && el.id != null ? `${el.type}/${el.id}` : null,
    name,
    formattedAddress: buildOsmAddress(tags),
    zip: zip || null,
    queryZip: queryZip ? normalizeZip(queryZip) : null,
    state,
    lat,
    lng,
    rating: null,
    userRatingsTotal: null,
    priceLevel: null,
    phone: tags.phone || tags["contact:phone"] || null,
    website: tags.website || tags["contact:website"] || null,
    googleMapsUri: null,
    primaryType: tags.tourism || (tags.building === "hotel" ? "hotel" : null),
    types: tags.tourism ? [tags.tourism] : null,
    businessStatus: null,
    raw: el,
  };
}

function buildOsmAddress(tags) {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:city"],
    tags["addr:state"],
    tags["addr:postcode"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}
