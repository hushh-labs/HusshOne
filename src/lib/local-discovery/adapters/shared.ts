/* Shared adapter plumbing (deliverable #3): the seed → enrich → merge → rank pipeline that EVERY category
   adapter runs. A category differs only in two knobs:
     • which directory vertical it seeds from (and whether that seed is valid for the search country), and
     • which Google Places types it enriches with.
   Everything else — proximity seed, budget-gated live enrichment, dedupe/merge, quality-aware ranking, and
   per-source failure isolation (`Promise.allSettled`) — lives here, so adding a category is ~20 lines.

   Failure isolation contract: the two data sources (stored seed + live Places) run independently; either can
   fail without failing the other or the adapter. `degraded` is true whenever no FRESH live enrichment ran
   (we fell back to seed/cache only) — the frontend uses it to show a "showing saved results" indicator. */

import { hasDirectoryDb } from "@/lib/directory/db";
import type { DirectoryVertical } from "@/lib/directory/db";
import { queryVertical } from "@/lib/directory/query";
import type {
  DiscoveryAdapterResult,
  DiscoveryCategory,
  DiscoverySearchContext,
  SourceKind,
  UnifiedProfile,
} from "../types";
import { directoryRowToProfile, placeToProfile } from "../normalize";
import { hasPlacesProvider, searchPlaces } from "../providers/places";
import { dedupeAndMerge } from "../merge";
import { rankProfiles } from "../rank";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Over-fetch seed rows so merge/dedupe + ranking have headroom, but cap for query cost. */
function seedLimit(ctx: DiscoverySearchContext): number {
  return Math.min(Math.max(ctx.limit * 2, 20), 60);
}

interface SeedOutcome {
  profiles: UnifiedProfile[];
  warning?: string;
  /** True when the query actually ran and succeeded — so "0 rows" can be told apart from "never asked". */
  queried: boolean;
}

/** Proximity seed from our own PostGIS directory. Never throws (queryVertical already isolates failures);
 *  a missing DB or a per-vertical error degrades to zero seed rows + a warning. */
async function seed(
  ctx: DiscoverySearchContext,
  vertical: DirectoryVertical,
  category: DiscoveryCategory,
): Promise<SeedOutcome> {
  if (!hasDirectoryDb()) return { profiles: [], queried: false }; // no seed DB wired → live-only
  const res = await queryVertical(vertical, {
    lat: ctx.lat,
    lng: ctx.lng,
    radiusM: ctx.radiusMeters,
    limit: seedLimit(ctx),
  });
  if (res.error) {
    return { profiles: [], warning: `directory seed unavailable (${vertical}): ${res.error}`, queried: false };
  }
  return { profiles: res.rows.map((r) => directoryRowToProfile(r, ctx, category)), queried: true };
}

interface EnrichOutcome {
  profiles: UnifiedProfile[];
  warning?: string;
  /** True only when a live Places search actually reached the provider (even if it returned 0 rows). */
  live: boolean;
}

/** Compose the Places free-text query. `cfg.textQuery` is the category's own baseline (set only when no
 *  Table A type describes the category); the user's refine is APPENDED to it, never replaces it — dropping
 *  the baseline would silently turn "investment adviser" into an untyped search for whatever they typed. */
function composeTextQuery(cfg: AdapterConfig, ctx: DiscoverySearchContext): string | undefined {
  const refine = ctx.filters.query?.trim();
  if (!cfg.textQuery) return refine || undefined;
  return [cfg.textQuery, refine].filter(Boolean).join(" ");
}

/** Budget-gated live enrichment via Google Places (New). Returns `live:false` (with a reason warning) when
 *  paid calls are off, no key is configured, or the provider was skipped/failed — the caller then degrades. */
async function enrich(ctx: DiscoverySearchContext, cfg: AdapterConfig): Promise<EnrichOutcome> {
  if (!ctx.allowPaid) return { profiles: [], warning: "live enrichment off (paid calls disabled)", live: false };
  if (!hasPlacesProvider()) return { profiles: [], warning: "live enrichment off (no Places API key)", live: false };

  const textQuery = composeTextQuery(cfg, ctx);
  // A category with neither a Table A type nor a baseline text query would issue an untyped Nearby search
  // and return every business in the radius. Refuse instead of returning junk.
  if (!cfg.placeTypes.length && !textQuery) {
    return { profiles: [], warning: "live enrichment off (no place types or text query configured)", live: false };
  }

  const out = await searchPlaces(
    {
      lat: ctx.lat,
      lng: ctx.lng,
      radiusMeters: ctx.radiusMeters,
      includedTypes: cfg.placeTypes,
      textQuery,
      regionCode: ctx.countryCode || undefined,
      maxResults: Math.min(ctx.limit, 20),
      openNow: ctx.filters.openNow,
      minRating: ctx.filters.minRating,
      deadlineAt: ctx.deadlineAt,
    },
    ctx.budget,
  );

  if (out.skipped) return { profiles: [], warning: `live enrichment skipped (${out.skipped})`, live: false };
  return { profiles: out.results.map((r) => placeToProfile(r, ctx, cfg.category)), live: true };
}

export interface AdapterConfig {
  category: DiscoveryCategory;
  /** Directory vertical to seed from, or `null` when this category has no valid seed for the search country
   *  (e.g. a US-only registry for a non-US search — never seed misleading/irrelevant data). */
  seedVertical: DirectoryVertical | null;
  /** Google Places (New) **Table A** types to enrich with (e.g. ["lodging"], ["insurance_agency"]). Only
   *  Table A is accepted by `includedTypes`; an invalid type is a hard 400 from searchNearby. Leave empty
   *  when no Table A type describes the category — then `textQuery` is mandatory. */
  placeTypes: string[];
  /** Baseline free-text query, for categories Table A does not cover (there is no investment-adviser type).
   *  Setting it routes enrichment through Text Search instead of Nearby Search. */
  textQuery?: string;
  /** Adapter-computed warnings prepended to the result (e.g. registry-country-mismatch notes). */
  extraWarnings?: string[];
  /** Note appended when the seed query RAN and returned zero rows — for registries whose coverage is
   *  partial (state-by-state insurance licensing), so "no results here" reads as a coverage gap rather
   *  than as "there are none". Not emitted when the seed was skipped or errored (those warn already). */
  seedEmptyWarning?: string;
}

/** Run one category's full search: seed + live in parallel, merge/dedupe, rank, and report attribution. */
export async function runAdapter(ctx: DiscoverySearchContext, cfg: AdapterConfig): Promise<DiscoveryAdapterResult> {
  const warnings: string[] = [...(cfg.extraWarnings ?? [])];
  const sources = new Set<SourceKind>();
  const all: UnifiedProfile[] = [];
  let liveRan = false;

  const [seedRes, liveRes] = await Promise.allSettled([
    cfg.seedVertical
      ? seed(ctx, cfg.seedVertical, cfg.category)
      : Promise.resolve<SeedOutcome>({ profiles: [], queried: false }),
    enrich(ctx, cfg),
  ]);

  if (seedRes.status === "fulfilled") {
    all.push(...seedRes.value.profiles);
    if (seedRes.value.warning) warnings.push(seedRes.value.warning);
    if (cfg.seedEmptyWarning && seedRes.value.queried && !seedRes.value.profiles.length) {
      warnings.push(cfg.seedEmptyWarning);
    }
    for (const p of seedRes.value.profiles) sources.add(p.sources[0]?.kind ?? "directory");
  } else {
    warnings.push(`directory seed failed: ${errMsg(seedRes.reason)}`);
  }

  if (liveRes.status === "fulfilled") {
    all.push(...liveRes.value.profiles);
    if (liveRes.value.warning) warnings.push(liveRes.value.warning);
    if (liveRes.value.live) {
      liveRan = true;
      if (liveRes.value.profiles.length) sources.add("google_places");
    }
  } else {
    warnings.push(`live enrichment failed: ${errMsg(liveRes.reason)}`);
  }

  const merged = dedupeAndMerge(all);
  const profiles = rankProfiles(merged, {
    sort: "recommended",
    radiusMeters: ctx.radiusMeters,
    limit: ctx.limit,
    filters: ctx.filters,
  });

  return {
    category: cfg.category,
    profiles,
    warnings,
    sourcesUsed: [...sources],
    // degraded = we never got fresh live data (seed/cache only). Even a 0-row live search counts as fresh.
    degraded: !liveRan,
  };
}
