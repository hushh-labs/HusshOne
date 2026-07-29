/* Search orchestration for the real-time Local Discovery feed (deliverable #2).

   One /search request becomes one in-memory SESSION that fans out to the country-aware category adapters,
   emits progressive `DiscoveryEvent`s as each category resolves, and finishes with a cross-category merged +
   ranked `search_complete`. The SSE route (GET .../{searchId}/events) attaches to a session, replays its
   buffered events, and subscribes for new ones.

   Failure isolation is the core contract: a single category (or provider) failing NEVER fails the whole
   search — it becomes a `category_error` event and the other categories still stream. One shared
   `RequestBudget` flows through location resolution AND every adapter, so all paid calls for the request are
   capped together.

   State model (Phase 1): sessions live on `globalThis` (per-instance, TTL-bounded) — the same conservative
   posture as spend.ts / cache.ts. A shared cross-instance store is deferred to Phase 3. To stay robust when
   a client's SSE lands on a different instance than its POST (or after TTL expiry), the GET route can rebuild
   an equivalent session from the query parameters the client carries — see `createDiscoverySearch(..., {searchId})`
   and `searchParamsToBody`. Because of this, the search work is driven LAZILY by the SSE connection
   (`ensureSearchStarted`), not by POST — so a POST that is never streamed spends nothing. */

import { randomUUID } from "node:crypto";

import { adaptersForCountry } from "./adapters";
import { getCachedSearch, searchCacheKey, setCachedSearch } from "./cache";
import { resolveLocation, type LocationInput } from "./location";
import { dedupeAndMerge } from "./merge";
import { rankProfiles } from "./rank";
import { RequestBudget } from "./spend";
import {
  DISCOVERY_CATEGORIES,
  SORT_ORDERS,
  type CategoryStatus,
  type DiscoveryCategory,
  type DiscoveryEvent,
  type DiscoveryFilters,
  type DiscoverySearchContext,
  type ResolvedQuery,
  type SortOrder,
  type UnifiedProfile,
} from "./types";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Soft wall-clock budget for the whole search; adapters treat it as a deadline and return what they have. */
const SEARCH_DEADLINE_MS = 20_000;
/** How long a completed/in-flight session stays resolvable for SSE (re)attachment + replay. */
const SESSION_TTL_MS = 15 * 60 * 1000;
/** Bound the registry so a burst of searches can't grow it without limit. */
const MAX_SESSIONS = 2_000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// Session model + per-instance registry
// ---------------------------------------------------------------------------

export interface DiscoverySession {
  readonly searchId: string;
  readonly query: ResolvedQuery;
  readonly createdAt: number;
  readonly deadlineAt: number;
  expiresAt: number;
  /** Ordered event buffer — the source of truth for SSE replay. */
  readonly events: DiscoveryEvent[];
  /** True once the terminal `search_complete` has been emitted. */
  done: boolean;
  /** Shared per-request paid-call budget (location geocode + every adapter draw from this one instance). */
  readonly budget: RequestBudget;
  /** Global paid-calls kill switch for this request (LOCAL_DISCOVERY_ALLOW_PAID). */
  readonly allowPaid: boolean;
  /** Guards single execution of the fan-out regardless of how many SSE clients attach. */
  started: boolean;
  /** Live SSE subscribers, notified on every emit. */
  readonly listeners: Set<(event: DiscoveryEvent) => void>;
  /** Warnings gathered before the fan-out (location resolution + input parsing). */
  readonly preludeWarnings: string[];
}

interface SessionGlobal {
  map: Map<string, DiscoverySession>;
}

const g = globalThis as typeof globalThis & { __oneLdSessions?: SessionGlobal };

function registry(): Map<string, DiscoverySession> {
  if (!g.__oneLdSessions) g.__oneLdSessions = { map: new Map() };
  return g.__oneLdSessions.map;
}

function registerSession(session: DiscoverySession): void {
  const map = registry();
  const now = Date.now();
  for (const [id, s] of map) if (s.expiresAt <= now) map.delete(id); // opportunistic sweep
  map.set(session.searchId, session);
  while (map.size > MAX_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Resolve a session by id, honoring TTL expiry. */
export function getDiscoverySession(searchId: string): DiscoverySession | null {
  const map = registry();
  const s = map.get(searchId);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    map.delete(searchId);
    return null;
  }
  return s;
}

/** Subscribe to future events; returns an unsubscribe fn. */
export function subscribeToSession(session: DiscoverySession, onEvent: (event: DiscoveryEvent) => void): () => void {
  session.listeners.add(onEvent);
  return () => {
    session.listeners.delete(onEvent);
  };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

export interface ParsedDiscoveryInput {
  location: LocationInput;
  categories: DiscoveryCategory[];
  limit: number;
  sort: SortOrder;
  filters: DiscoveryFilters;
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toNum(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toStr(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s.length ? s : undefined;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/** Accept a JS array or a comma-separated string; trim + drop blanks. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = toStr(value);
  return s ? s.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

function parseCategories(value: unknown, warnings: string[]): DiscoveryCategory[] {
  const requested = toList(value).map((c) => c.toLowerCase());
  if (!requested.length) return [...DISCOVERY_CATEGORIES];
  const valid: DiscoveryCategory[] = [];
  for (const c of requested) {
    if ((DISCOVERY_CATEGORIES as readonly string[]).includes(c)) {
      if (!valid.includes(c as DiscoveryCategory)) valid.push(c as DiscoveryCategory);
    } else {
      warnings.push(`unknown category "${c}" ignored`);
    }
  }
  if (!valid.length) {
    warnings.push("no supported categories requested; defaulting to all");
    return [...DISCOVERY_CATEGORIES];
  }
  return valid;
}

function parseSort(value: unknown): SortOrder {
  const s = toStr(value)?.toLowerCase();
  return s && (SORT_ORDERS as readonly string[]).includes(s) ? (s as SortOrder) : "recommended";
}

function parseLimit(value: unknown): number {
  const n = toNum(value);
  if (n === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

function parseFilters(body: Record<string, unknown>): DiscoveryFilters {
  // Filters may arrive nested (`filters: {...}`) or flattened at the top level (query-string form).
  const nested = body.filters && typeof body.filters === "object" ? asRecord(body.filters) : body;
  const filters: DiscoveryFilters = {};

  const minRating = toNum(nested.minRating);
  if (minRating !== undefined) filters.minRating = Math.min(5, Math.max(0, minRating));

  if (toBool(nested.openNow)) filters.openNow = true;

  const query = toStr(nested.query ?? nested.q);
  if (query) filters.query = query;

  const subcategories = toList(nested.subcategories);
  if (subcategories.length) filters.subcategories = subcategories;

  return filters;
}

/** Parse a raw request body (or a query-param-derived object) into validated discovery input. Location
 *  validity itself is enforced later by `resolveLocation` (which throws `V1InputError`). */
export function parseDiscoverySearchInput(body: unknown): ParsedDiscoveryInput {
  const b = asRecord(body);
  const warnings: string[] = [];

  const location: LocationInput = {
    latitude: (b.latitude ?? b.lat ?? null) as LocationInput["latitude"],
    longitude: (b.longitude ?? b.lng ?? null) as LocationInput["longitude"],
    postalCode: (b.postalCode ?? b.zip ?? b.zipCode ?? null) as LocationInput["postalCode"],
    countryCode: (b.countryCode ?? b.country ?? null) as LocationInput["countryCode"],
    radiusMeters: (b.radiusMeters ?? b.radius ?? null) as LocationInput["radiusMeters"],
  };

  return {
    location,
    categories: parseCategories(b.categories, warnings),
    limit: parseLimit(b.limit),
    sort: parseSort(b.sort),
    filters: parseFilters(b),
    warnings,
  };
}

/** Flatten a URLSearchParams into the plain object `parseDiscoverySearchInput` understands. */
export function searchParamsToBody(sp: URLSearchParams): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of [
    "latitude",
    "lat",
    "longitude",
    "lng",
    "postalCode",
    "zip",
    "zipCode",
    "countryCode",
    "country",
    "radiusMeters",
    "radius",
    "categories",
    "limit",
    "sort",
    "minRating",
    "openNow",
    "query",
    "q",
    "subcategories",
  ]) {
    const v = sp.get(key);
    if (v != null) body[key] = v;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

export interface CreateSearchResult {
  session: DiscoverySession;
  query: ResolvedQuery;
  warnings: string[];
}

/** Validate input, resolve the location, and register a session ready to run. Throws `V1InputError` on bad
 *  or missing location (mapped to a 4xx by the caller). Pass `opts.searchId` to rebuild an equivalent session
 *  under a known id (SSE cross-instance / TTL fallback). */
export async function createDiscoverySearch(
  body: unknown,
  opts: { searchId?: string } = {},
): Promise<CreateSearchResult> {
  const parsed = parseDiscoverySearchInput(body);
  const allowPaid = process.env.LOCAL_DISCOVERY_ALLOW_PAID !== "false";
  const budget = new RequestBudget();
  const createdAt = Date.now();
  const deadlineAt = createdAt + SEARCH_DEADLINE_MS;

  // Location resolution can spend a (budgeted) geocode call; it throws V1InputError on invalid/missing input.
  const loc = await resolveLocation(parsed.location, budget, deadlineAt);

  const query: ResolvedQuery = {
    lat: loc.lat,
    lng: loc.lng,
    radiusMeters: loc.radiusMeters,
    countryCode: loc.countryCode,
    city: loc.city,
    state: loc.state,
    postalCode: loc.postalCode,
    approximateOrigin: loc.approximateOrigin,
    categories: parsed.categories,
    limit: parsed.limit,
    sort: parsed.sort,
    filters: parsed.filters,
    resolvedFrom: loc.resolvedFrom,
  };

  const session: DiscoverySession = {
    searchId: opts.searchId || randomUUID(),
    query,
    createdAt,
    deadlineAt,
    expiresAt: createdAt + SESSION_TTL_MS,
    events: [],
    done: false,
    budget,
    allowPaid,
    started: false,
    listeners: new Set(),
    preludeWarnings: [...loc.warnings, ...parsed.warnings],
  };

  registerSession(session);
  return { session, query, warnings: session.preludeWarnings };
}

// ---------------------------------------------------------------------------
// Fan-out execution
// ---------------------------------------------------------------------------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function emit(session: DiscoverySession, event: DiscoveryEvent): void {
  session.events.push(event);
  for (const listener of [...session.listeners]) {
    try {
      listener(event);
    } catch {
      /* a broken subscriber must never break the fan-out */
    }
  }
}

function contextFor(session: DiscoverySession): DiscoverySearchContext {
  const q = session.query;
  return {
    lat: q.lat,
    lng: q.lng,
    radiusMeters: q.radiusMeters,
    countryCode: q.countryCode,
    city: q.city,
    state: q.state,
    postalCode: q.postalCode,
    approximateOrigin: q.approximateOrigin,
    limit: q.limit,
    filters: q.filters,
    allowPaid: session.allowPaid,
    budget: session.budget,
    deadlineAt: session.deadlineAt,
  };
}

/** Run the whole search: adapter selection → parallel per-category fan-out (each isolated) → final
 *  cross-category dedupe + rank → terminal `search_complete`. Never throws. */
async function runSearch(session: DiscoverySession): Promise<void> {
  const { query } = session;
  emit(session, { type: "search_started", searchId: session.searchId, query });

  const adapters = adaptersForCountry(query.categories, query.countryCode);
  const covered = new Set(adapters.map((a) => a.category));
  const finalWarnings = [...session.preludeWarnings];

  // Any requested category with no adapter for this country is surfaced (never silently dropped).
  for (const category of query.categories) {
    if (!covered.has(category)) {
      const msg = `no live provider for ${category}${query.countryCode ? ` in ${query.countryCode}` : ""}`;
      emit(session, { type: "category_error", category, error: msg });
      finalWarnings.push(msg);
    }
  }

  const ctx = contextFor(session);
  const collected: UnifiedProfile[] = [];

  await Promise.allSettled(
    adapters.map(async (adapter) => {
      const category = adapter.category;
      emit(session, { type: "category_started", category });
      try {
        const cacheKey = searchCacheKey({
          countryCode: query.countryCode,
          lat: query.lat,
          lng: query.lng,
          radiusMeters: query.radiusMeters,
          category,
          filters: query.filters,
        });

        const cached = getCachedSearch(cacheKey);
        if (cached) {
          const ranked = rankProfiles(cached, {
            sort: query.sort,
            filters: query.filters,
            radiusMeters: query.radiusMeters,
            limit: query.limit,
          });
          collected.push(...ranked);
          emit(session, {
            type: "category_results",
            category,
            profiles: ranked,
            status: "done",
            warnings: ["served from cache"],
          });
          return;
        }

        const result = await adapter.search(ctx);
        setCachedSearch(cacheKey, result.profiles);
        collected.push(...result.profiles);

        const status: CategoryStatus = result.degraded ? "degraded" : "done";
        emit(session, {
          type: "category_results",
          category,
          profiles: result.profiles,
          status,
          warnings: result.warnings,
        });
        for (const w of result.warnings) finalWarnings.push(`${category}: ${w}`);
      } catch (error) {
        const msg = errMsg(error);
        emit(session, { type: "category_error", category, error: msg });
        finalWarnings.push(`${category}: ${msg}`);
      }
    }),
  );

  // Authoritative cross-category order: dedupe across categories, then rank + cap to the global limit.
  const merged = dedupeAndMerge(collected);
  const results = rankProfiles(merged, {
    sort: query.sort,
    filters: query.filters,
    radiusMeters: query.radiusMeters,
    limit: query.limit,
  });

  emit(session, { type: "search_complete", count: results.length, results, warnings: finalWarnings });
  session.done = true;
}

/** Start the fan-out exactly once for a session, whatever triggers it (idempotent). On a catastrophic
 *  failure it still emits a terminal `search_complete` so no SSE client hangs. */
export function ensureSearchStarted(session: DiscoverySession): void {
  if (session.started) return;
  session.started = true;
  void runSearch(session).catch((error) => {
    const terminal: DiscoveryEvent = {
      type: "search_complete",
      count: 0,
      results: [],
      warnings: [...session.preludeWarnings, `search failed: ${errMsg(error)}`],
    };
    session.done = true;
    emit(session, terminal);
  });
}

/** Build the SSE `events` URL carrying the resolved query so a client can (re)attach on any instance. */
export function streamPathForQuery(searchId: string, query: ResolvedQuery): string {
  const sp = new URLSearchParams();
  sp.set("lat", String(query.lat));
  sp.set("lng", String(query.lng));
  sp.set("radius", String(query.radiusMeters));
  if (query.countryCode) sp.set("country", query.countryCode);
  sp.set("categories", query.categories.join(","));
  sp.set("sort", query.sort);
  sp.set("limit", String(query.limit));
  if (query.filters.minRating !== undefined) sp.set("minRating", String(query.filters.minRating));
  if (query.filters.openNow) sp.set("openNow", "true");
  if (query.filters.query) sp.set("query", query.filters.query);
  if (query.filters.subcategories?.length) sp.set("subcategories", query.filters.subcategories.join(","));
  return `/api/local-discovery/search/${searchId}/events?${sp.toString()}`;
}

/** TEST-ONLY: clear the in-memory session registry. */
export function __resetSessionsForTests(): void {
  registry().clear();
}
