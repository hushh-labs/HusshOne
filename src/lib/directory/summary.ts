/* Rich summary for the public /localfinder panel — a demo-shaped view over the same directory data the
   Bearer API (GET /api/v1/directory) serves, but aggregated instead of a raw firehose:

     • per-vertical COUNT within the radius (how many hotels / providers / firms / producers are near you),
     • a small SAMPLE of the nearest rows per vertical (name + subtitle + distance, capped), and
     • a healthcare SPECIALTY histogram (top taxonomies within the radius).

   It reuses ./db (the per-vertical Pools + hasDirectoryDb guard) and ./query (queryVertical for the
   samples, so sample rows share the exact same column mapping as the real API). Only the COUNT and the
   GROUP BY are new SQL here. Table/column names are fixed literals; coordinates/radius/limit are the only
   bound parameters. Every helper is failure-isolated per vertical — one bad query becomes a warning, not a
   500, mirroring the route's own posture. */
import { getDirectoryPool, type DirectoryVertical } from "./db";
import { queryVertical, type DirectoryRow, type GeoPrecision } from "./query";

/** vertical → physical table queried for the proximity COUNT (matches ./query's per-vertical tables). */
const TABLE: Record<DirectoryVertical, string> = {
  hotels: "hotels",
  healthcare: "providers",
  ria: "firms",
  insurance: "producers",
};

/** Human label shown in the panel. */
export const VERTICAL_LABEL: Record<DirectoryVertical, string> = {
  hotels: "Hotels",
  healthcare: "Healthcare",
  ria: "RIA firms",
  insurance: "Insurance",
};

/** A compact sample row for the panel (the full field bag lives behind the Bearer API). */
export interface SampleRow {
  id: string;
  name: string;
  subtitle: string | null;
  location: string | null;
  distanceM: number;
  geoPrecision: GeoPrecision;
}

export interface VerticalSummary {
  vertical: DirectoryVertical;
  label: string;
  count: number;
  sample: SampleRow[];
  error?: string;
}

export interface SpecialtyBucket {
  specialty: string;
  count: number;
}

export interface DirectorySummary {
  totals: { records: number; verticals: number };
  verticals: VerticalSummary[];
  healthcareSpecialties: SpecialtyBucket[];
  warnings: string[];
}

export interface SummaryParams {
  lat: number;
  lng: number;
  radiusM: number;
  /** How many sample rows to return per vertical (nearest first). */
  sampleLimit?: number;
  /** How many specialty buckets to return for healthcare. */
  specialtyLimit?: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Compose a short human location from whatever geographic fields a vertical's row carries. */
function locationOf(row: DirectoryRow): string | null {
  const f = row.fields;
  const city = (f.city as string) || "";
  const state = (f.state as string) || "";
  const cityState = [city, state].map((s) => s.trim()).filter(Boolean).join(", ");
  if (cityState) return cityState;
  const street =
    (f.address as string) || (f.addressLine1 as string) || (f.street1 as string) || "";
  return street.trim() || null;
}

function toSample(row: DirectoryRow): SampleRow {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    location: locationOf(row),
    distanceM: row.distanceM,
    geoPrecision: row.geoPrecision,
  };
}

/** COUNT(*) of a vertical's rows within the radius. Never throws — returns { count, error? }. */
async function countVertical(
  vertical: DirectoryVertical,
  p: SummaryParams,
): Promise<{ count: number; error?: string }> {
  try {
    const pool = getDirectoryPool(vertical);
    if (!pool) return { count: 0 };
    const sql = `SELECT COUNT(*)::bigint AS n
       FROM ${TABLE[vertical]}
       WHERE geog IS NOT NULL
         AND ST_DWithin(geog, ST_MakePoint($1, $2)::geography, $3)`;
    const { rows } = await pool.query(sql, [p.lng, p.lat, p.radiusM]);
    return { count: num(rows[0]?.n) };
  } catch (error) {
    return { count: 0, error: error instanceof Error ? error.message : "count failed" };
  }
}

/** Top healthcare specialties (taxonomy descriptions) within the radius. Never throws. */
async function healthcareSpecialties(
  p: SummaryParams,
): Promise<{ buckets: SpecialtyBucket[]; error?: string }> {
  try {
    const pool = getDirectoryPool("healthcare");
    if (!pool) return { buckets: [] };
    const sql = `SELECT primary_taxonomy_desc AS specialty, COUNT(*)::bigint AS n
       FROM providers
       WHERE geog IS NOT NULL
         AND ST_DWithin(geog, ST_MakePoint($1, $2)::geography, $3)
         AND primary_taxonomy_desc IS NOT NULL AND primary_taxonomy_desc <> ''
       GROUP BY 1
       ORDER BY n DESC, specialty ASC
       LIMIT $4`;
    const { rows } = await pool.query(sql, [p.lng, p.lat, p.radiusM, p.specialtyLimit ?? 8]);
    return { buckets: rows.map((r) => ({ specialty: String(r.specialty), count: num(r.n) })) };
  } catch (error) {
    return { buckets: [], error: error instanceof Error ? error.message : "specialty query failed" };
  }
}

/** Build the panel summary for a point: per-vertical count + nearest sample, plus the healthcare
 *  specialty histogram. `verticals` defaults to all four; each is failure-isolated into `warnings`. */
export async function directorySummary(
  p: SummaryParams,
  verticals: DirectoryVertical[],
): Promise<DirectorySummary> {
  const sampleLimit = p.sampleLimit ?? 5;
  const warnings: string[] = [];

  const perVertical = await Promise.all(
    verticals.map(async (vertical): Promise<VerticalSummary> => {
      const [countRes, sampleRes] = await Promise.all([
        countVertical(vertical, p),
        queryVertical(vertical, { lat: p.lat, lng: p.lng, radiusM: p.radiusM, limit: sampleLimit }),
      ]);
      const error = countRes.error ?? sampleRes.error;
      if (error) warnings.push(`${vertical}: ${error}`);
      return {
        vertical,
        label: VERTICAL_LABEL[vertical],
        count: countRes.count,
        sample: sampleRes.rows.map(toSample),
        error,
      };
    }),
  );

  let healthcareBuckets: SpecialtyBucket[] = [];
  if (verticals.includes("healthcare")) {
    const spec = await healthcareSpecialties(p);
    healthcareBuckets = spec.buckets;
    if (spec.error) warnings.push(`healthcare specialties: ${spec.error}`);
  }

  const records = perVertical.reduce((sum, v) => sum + v.count, 0);
  return {
    totals: { records, verticals: perVertical.length },
    verticals: perVertical,
    healthcareSpecialties: healthcareBuckets,
    warnings,
  };
}
