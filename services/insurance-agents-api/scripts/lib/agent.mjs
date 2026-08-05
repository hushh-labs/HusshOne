// Map a Nationwide locator `location` entry into our unified agency shape.
//
// Each entry is { loc: {...agency...}, url, containedLocations }. The agency data lives in
// `loc`; its field names are known (schema read live). Two things worth noting:
//  - `milesToQueryLocation` is a distance in MILES, pre-computed by the API — authoritative,
//    since it's what the locator itself renders ("4.31 mi").
//  - custom fields (Agency Type = "Elite", Agency Tier, product lists) live under
//    `customByName`, keyed by human display names that can vary, so those are read from a
//    list of candidate keys and coerced defensively.

import { GEO_PRECISION, presentDistance, METERS_PER_MILE } from "./geo.mjs";

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length) {
      const s = firstString(...v);
      if (s) return s;
    }
    if (v && typeof v === "object") {
      const s = v.url || v.value || v.label || v.name;
      if (typeof s === "string" && s.trim()) return s.trim();
    }
  }
  return null;
}

/** Read a custom field by any of its candidate display-name keys, coerced to a clean value. */
function custom(loc, keys) {
  const bag = loc?.customByName;
  if (!bag || typeof bag !== "object") return null;
  for (const key of keys) {
    const v = bag[key];
    if (v == null || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v)) return v.value ?? v.name ?? v.label ?? null;
    return v;
  }
  return null;
}

/** Product / lines-of-business list, however this record models it. */
function products(loc) {
  const raw =
    (Array.isArray(loc?.products) && loc.products.length && loc.products) ||
    (Array.isArray(loc?.services) && loc.services.length && loc.services) ||
    custom(loc, ["Agency Product Information", "Products"]) ||
    loc?.specialties ||
    [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,;|]/);
  return [...new Set(list.map((p) => (typeof p === "string" ? p : p?.name || p?.label)).filter(Boolean).map((s) => s.trim()))];
}

function address(loc) {
  const street = [loc?.address1, loc?.address2].filter(Boolean).join(", ");
  return {
    line1: loc?.address1 || null,
    line2: loc?.address2 || null,
    city: loc?.city || null,
    region: loc?.state || null,
    postalCode: loc?.postalCode || null,
    countryCode: loc?.country || null,
    formatted:
      firstString(loc?.displayAddress) ||
      [street, loc?.city, [loc?.state, loc?.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") ||
      null,
  };
}

/** Build a unified agency from one `locations[]` entry. */
export function mapAgency(entry) {
  const loc = entry?.loc || entry;
  if (!loc || (!loc.id && !loc.name)) return null;

  const lat = Number(loc.latitude ?? loc.routableLatitude);
  const lng = Number(loc.longitude ?? loc.routableLongitude);
  const hasCoord = Number.isFinite(lat) && Number.isFinite(lng);

  const miles = Number(loc.milesToQueryLocation);
  const meters = Number.isFinite(miles) ? miles * METERS_PER_MILE : null;
  const geoPrecision = hasCoord ? GEO_PRECISION.GEOCODED : GEO_PRECISION.UNKNOWN;

  return {
    id: String(loc.id || `${loc.name}|${loc.postalCode || ""}`),
    name: loc.name || null,
    address: address(loc),
    phone: firstString(loc.phone, loc.phones),
    fax: loc.fax || null,
    email: firstString(loc.emails),
    website: firstString(loc.website, loc.urls) || (entry?.url ? `https://agency.nationwide.com/${String(entry.url).replace(/^\//, "")}` : null),
    products: products(loc),
    // The "ELITE STATUS" badge from the screenshot maps to Agency Type = "Elite".
    agencyType: custom(loc, ["Agency Type"]),
    tier: custom(loc, ["Agency Tier"]),
    hours: loc.hours || null,
    description: loc.description || null,
    yearEstablished: loc.yearEstablished || null,
    social: {
      facebook: loc.facebookPageUrl || null,
      instagram: loc.instagramHandle || null,
      twitter: loc.twitterHandle || null,
    },
    location: hasCoord ? { lat, lng } : null,
    distanceMeters: presentDistance(meters, geoPrecision),
    distanceMiles: Number.isFinite(miles) ? Math.round(miles * 100) / 100 : null,
    distanceApproximate: geoPrecision !== GEO_PRECISION.ROOFTOP,
    geoPrecision,
    source: "nationwide",
  };
}
