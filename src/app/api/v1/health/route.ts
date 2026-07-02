/* Developer API — GET /api/v1/health  (public, no auth)
   A sanitized status report for the One Developer API: the same dependency sweep as the internal probe
   (@/lib/health/checks), but collapsed into four public components (api / database / research / scrapers)
   with friendly descriptions and NO internal detail (env names, hostnames, error strings never leak).
   Result is cached ~30s in-memory so hammering this endpoint can't stampede the real dependencies.
   200 when operational|degraded, 503 when a critical component is down. CORS-open for status dashboards. */
import { runHealthChecks, type HealthStatus, type HealthCheck } from "@/lib/health/checks";
import { apiJson, corsPreflight, withCors } from "@/lib/api/http";

export const runtime = "nodejs";
export const maxDuration = 30;

export function OPTIONS() {
  return corsPreflight();
}

type PublicStatus = "operational" | "degraded" | "down";

interface PublicComponent {
  id: string;
  name: string;
  status: PublicStatus;
  description: string;
  latencyMs: number;
}

interface PublicHealth {
  ok: boolean;
  status: PublicStatus;
  checkedAt: string;
  components: PublicComponent[];
}

const CACHE_MS = 30_000;
let cache: { at: number; health: PublicHealth } | null = null;

const toPublic = (s: HealthStatus): PublicStatus => (s === "up" ? "operational" : s === "degraded" ? "degraded" : "down");

/** Both members critical → worst wins (down if either down, else degraded if either degraded). */
function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  if (a === "down" || b === "down") return "down";
  if (a === "degraded" || b === "degraded") return "degraded";
  return "up";
}

/** Non-critical group: all down → down; some-not-up → degraded; all up → up. */
function aggregate(statuses: HealthStatus[]): { status: HealthStatus; up: number; total: number } {
  const total = statuses.length;
  const up = statuses.filter((s) => s === "up").length;
  const status: HealthStatus = up === 0 ? "down" : up < total ? "degraded" : "up";
  return { status, up, total };
}

function buildPublicHealth(checks: HealthCheck[]): PublicHealth {
  const by = (name: string): HealthCheck | undefined => checks.find((c) => c.name === name);
  const st = (name: string): HealthStatus => by(name)?.status ?? "down";
  const lat = (...names: string[]) => Math.max(0, ...names.map((n) => by(n)?.latencyMs ?? 0));

  const dbStatus = st("database");
  const researchStatus = worst(st("vertex"), st("deep_research_api"));
  const scraperNames = ["scraper_instagram", "scraper_x", "scraper_threads", "scraper_linkedin", "scraper_linkedin_posts"];
  const scraperAgg = aggregate(scraperNames.map((n) => st(n)));

  const components: PublicComponent[] = [
    { id: "api", name: "API", status: "operational", description: "Developer API request handling", latencyMs: 0 },
    { id: "database", name: "Database", status: toPublic(dbStatus), description: "Scan storage & retrieval", latencyMs: lat("database") },
    { id: "research", name: "Research engine", status: toPublic(researchStatus), description: "Deep-research dossier (Vertex + Deep Research)", latencyMs: lat("vertex", "deep_research_api") },
    {
      id: "scrapers",
      name: "Profile scrapers",
      status: toPublic(scraperAgg.status),
      description: `Public-profile scrapers — ${scraperAgg.up}/${scraperAgg.total} sources operational`,
      latencyMs: lat(...scraperNames),
    },
  ];

  // Overall: critical (database, research) down → down; any critical degraded or scrapers not fully up → degraded.
  let status: PublicStatus = "operational";
  if (dbStatus === "down" || researchStatus === "down") status = "down";
  else if (dbStatus === "degraded" || researchStatus === "degraded" || scraperAgg.status !== "up") status = "degraded";

  return { ok: status !== "down", status, checkedAt: new Date().toISOString(), components };
}

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    const checks = await runHealthChecks();
    cache = { at: now, health: buildPublicHealth(checks) };
  }
  const health = cache.health;
  return apiJson(health, health.status === "down" ? 503 : 200, withCors({ "Cache-Control": "public, max-age=15" }));
}
