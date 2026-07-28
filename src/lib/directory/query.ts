/* Proximity queries for the directory API. One parameterized query per vertical, all built on the same
   GIST-backed PostGIS primitive:

     WHERE geog IS NOT NULL AND ST_DWithin(geog, ST_MakePoint($lng,$lat)::geography, $radiusM)
     ORDER BY geog <-> ST_MakePoint($lng,$lat)::geography       -- KNN, index-assisted, distance in metres
     LIMIT $limit

   The four verticals are separate DATABASES on one instance, so there is no cross-DB SQL join: each query
   runs against its own Pool (see ./db.ts) and the route merges + re-sorts by distance in JS. Table and
   column names are fixed literals (never user input); the coordinates/radius/limit are the only bound
   parameters. Every row is tagged with a `geoPrecision` flag — `rooftop` for hotels (own Places/OSM
   coords), `zip_centroid` for the three ZIP-centroid verticals — so "nearest first" is honest until the
   Phase-2 geocoding backfill upgrades them in place. */
import { getDirectoryPool, type DirectoryVertical } from "./db";

export type GeoPrecision = "rooftop" | "zip_centroid";

/** Unified result row across all verticals. `fields` carries the vertical-specific columns. */
export interface DirectoryRow {
  vertical: DirectoryVertical;
  id: string;
  name: string;
  subtitle: string | null;
  distanceM: number;
  geoPrecision: GeoPrecision;
  lat: number | null;
  lng: number | null;
  fields: Record<string, unknown>;
}

/** Per-vertical outcome. `error` is set (and `rows` empty) when that vertical's query failed — the route
 *  records it in `warnings` and still returns the other verticals (isolated failure). */
export interface VerticalQueryResult {
  vertical: DirectoryVertical;
  rows: DirectoryRow[];
  error?: string;
}

export interface ProximityParams {
  lat: number;
  lng: number;
  radiusM: number;
  limit: number;
}

// --- small coercions (pg returns NUMERIC/BIGINT as strings; float8 already comes back as a number) ---
const str = (v: unknown): string => (v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Join `a · b · c`, dropping empties — used to compose a human subtitle. */
const dot = (...parts: (string | null | undefined)[]): string | null => {
  const s = parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" · ");
  return s || null;
};

/** Build the shared SELECT. `cols` is a fixed literal list; params are bound as [$1=lng, $2=lat, $3=radiusM, $4=limit]. */
function proximitySql(table: string, cols: string): string {
  return `SELECT ${cols},
       ST_Y(geog::geometry) AS _lat,
       ST_X(geog::geometry) AS _lng,
       ST_Distance(geog, ST_MakePoint($1, $2)::geography) AS _distance_m
     FROM ${table}
     WHERE geog IS NOT NULL
       AND ST_DWithin(geog, ST_MakePoint($1, $2)::geography, $3)
     ORDER BY geog <-> ST_MakePoint($1, $2)::geography
     LIMIT $4`;
}

type RawRow = Record<string, unknown>;

async function run(vertical: DirectoryVertical, sql: string, p: ProximityParams): Promise<RawRow[]> {
  const pool = getDirectoryPool(vertical);
  if (!pool) return []; // guarded by the route via hasDirectoryDb(); belt-and-braces
  const { rows } = await pool.query(sql, [p.lng, p.lat, p.radiusM, p.limit]);
  return rows as RawRow[];
}

function geoOf(r: RawRow): { lat: number | null; lng: number | null; distanceM: number } {
  return { lat: num(r._lat), lng: num(r._lng), distanceM: num(r._distance_m) ?? Number.POSITIVE_INFINITY };
}

// ---------------------------------------------------------------------------
// hotels — rooftop precision (Google Places / OSM own coordinates)
// ---------------------------------------------------------------------------
const HOTELS_COLS =
  "id, name, formatted_address, zip, state, rating, user_ratings_total, price_level, phone, website, google_maps_uri, primary_type, photos_count";

async function queryHotels(p: ProximityParams): Promise<DirectoryRow[]> {
  const rows = await run("hotels", proximitySql("hotels", HOTELS_COLS), p);
  return rows.map((r) => {
    const g = geoOf(r);
    return {
      vertical: "hotels" as const,
      id: str(r.id),
      name: str(r.name),
      subtitle: dot(strOrNull(r.formatted_address), num(r.rating) != null ? `${num(r.rating)}★` : null),
      distanceM: g.distanceM,
      geoPrecision: "rooftop" as const,
      lat: g.lat,
      lng: g.lng,
      fields: {
        address: strOrNull(r.formatted_address),
        zip: strOrNull(r.zip),
        state: strOrNull(r.state),
        rating: num(r.rating),
        userRatingsTotal: num(r.user_ratings_total),
        priceLevel: num(r.price_level),
        phone: strOrNull(r.phone),
        website: strOrNull(r.website),
        googleMapsUri: strOrNull(r.google_maps_uri),
        primaryType: strOrNull(r.primary_type),
        photosCount: num(r.photos_count),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// healthcare providers — zip_centroid precision (NPPES has no lat/lng)
// ---------------------------------------------------------------------------
const HEALTHCARE_COLS = `npi, entity_type,
       COALESCE(organization_name, NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')) AS name,
       credential, primary_taxonomy_desc AS specialty, status, address_line1, city, state, zip, phone`;

async function queryHealthcare(p: ProximityParams): Promise<DirectoryRow[]> {
  const rows = await run("healthcare", proximitySql("providers", HEALTHCARE_COLS), p);
  return rows.map((r) => {
    const g = geoOf(r);
    return {
      vertical: "healthcare" as const,
      id: str(r.npi),
      name: str(r.name),
      subtitle: dot(strOrNull(r.specialty), strOrNull(r.credential)),
      distanceM: g.distanceM,
      geoPrecision: "zip_centroid" as const,
      lat: g.lat,
      lng: g.lng,
      fields: {
        npi: strOrNull(r.npi),
        entityType: strOrNull(r.entity_type),
        credential: strOrNull(r.credential),
        specialty: strOrNull(r.specialty),
        status: strOrNull(r.status),
        addressLine1: strOrNull(r.address_line1),
        city: strOrNull(r.city),
        state: strOrNull(r.state),
        zip: strOrNull(r.zip),
        phone: strOrNull(r.phone),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// ria — zip_centroid precision. FIRMS only: advisers usually lack a mappable address (geog NULL).
// ---------------------------------------------------------------------------
const RIA_COLS =
  "crd, firm_name, street1, city, state, zip, phone, website, aum, total_employees, registration_status";

async function queryRia(p: ProximityParams): Promise<DirectoryRow[]> {
  const rows = await run("ria", proximitySql("firms", RIA_COLS), p);
  return rows.map((r) => {
    const g = geoOf(r);
    const aum = num(r.aum);
    return {
      vertical: "ria" as const,
      id: str(r.crd),
      name: str(r.firm_name),
      subtitle: dot(aum != null ? `AUM $${aum.toLocaleString("en-US")}` : null, strOrNull(r.registration_status)),
      distanceM: g.distanceM,
      geoPrecision: "zip_centroid" as const,
      lat: g.lat,
      lng: g.lng,
      fields: {
        crd: strOrNull(r.crd),
        street1: strOrNull(r.street1),
        city: strOrNull(r.city),
        state: strOrNull(r.state),
        zip: strOrNull(r.zip),
        phone: strOrNull(r.phone),
        website: strOrNull(r.website),
        aum,
        totalEmployees: num(r.total_employees),
        registrationStatus: strOrNull(r.registration_status),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// insurance producers — zip_centroid precision
// ---------------------------------------------------------------------------
const INSURANCE_COLS = `id, source_state, license_no, npn, full_name, entity_type,
       array_to_string(license_types, '|') AS license_types,
       array_to_string(lines_of_authority, '|') AS lines_of_authority,
       status, address_line1, city, state, zip, phone`;

const splitPipe = (v: unknown): string[] => (v == null || v === "" ? [] : String(v).split("|").filter(Boolean));

async function queryInsurance(p: ProximityParams): Promise<DirectoryRow[]> {
  const rows = await run("insurance", proximitySql("producers", INSURANCE_COLS), p);
  return rows.map((r) => {
    const g = geoOf(r);
    return {
      vertical: "insurance" as const,
      id: str(r.id),
      name: str(r.full_name),
      subtitle: dot(strOrNull(r.entity_type), splitPipe(r.license_types).join(", ") || null, strOrNull(r.status)),
      distanceM: g.distanceM,
      geoPrecision: "zip_centroid" as const,
      lat: g.lat,
      lng: g.lng,
      fields: {
        sourceState: strOrNull(r.source_state),
        licenseNo: strOrNull(r.license_no),
        npn: strOrNull(r.npn),
        entityType: strOrNull(r.entity_type),
        licenseTypes: splitPipe(r.license_types),
        linesOfAuthority: splitPipe(r.lines_of_authority),
        status: strOrNull(r.status),
        addressLine1: strOrNull(r.address_line1),
        city: strOrNull(r.city),
        state: strOrNull(r.state),
        zip: strOrNull(r.zip),
        phone: strOrNull(r.phone),
      },
    };
  });
}

const RUNNERS: Record<DirectoryVertical, (p: ProximityParams) => Promise<DirectoryRow[]>> = {
  hotels: queryHotels,
  healthcare: queryHealthcare,
  ria: queryRia,
  insurance: queryInsurance,
};

/** Run one vertical's proximity query. Never throws — a query failure is captured in `error` so the route
 *  can isolate it (return the other verticals + a warning) instead of failing the whole request. */
export async function queryVertical(vertical: DirectoryVertical, p: ProximityParams): Promise<VerticalQueryResult> {
  try {
    const rows = await RUNNERS[vertical](p);
    return { vertical, rows };
  } catch (error) {
    return { vertical, rows: [], error: error instanceof Error ? error.message : "query failed" };
  }
}

/** Resolve a ZIP to its centroid (lat/lng) from the canonical `zips` table (GeoNames ~42k, present in
 *  every DB — we read the hotels DB's copy). Returns null when the ZIP is unknown. Backward-compat only:
 *  used when a caller sends `zip` instead of coordinates. */
export async function resolveZipCentroid(zip: string): Promise<{ lat: number; lng: number } | null> {
  const pool = getDirectoryPool("hotels");
  if (!pool) return null;
  const { rows } = await pool.query(
    "SELECT lat, lng FROM zips WHERE zip = $1 AND lat IS NOT NULL AND lng IS NOT NULL LIMIT 1",
    [zip],
  );
  if (!rows.length) return null;
  const lat = num(rows[0].lat);
  const lng = num(rows[0].lng);
  return lat != null && lng != null ? { lat, lng } : null;
}
