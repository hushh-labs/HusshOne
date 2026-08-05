import { afterEach, describe, expect, it, vi } from "vitest";

/* Paging semantics for the watchdog probe.

   The one_health_dep_down alert reads `criticalDown` from this route's structured log. The regression this
   guards: it used to key off `summary.down`, which counts NON-critical scrapers too — so a scraper whose
   status endpoint was merely slow paged a human every 20 minutes while the product was fully healthy.
   `summary` is still emitted (dashboards/history), it just must not be the paging signal.

   summarize / overallOk / criticalDownCount are the REAL implementations; only the probe itself is mocked. */

type Status = "up" | "degraded" | "down";
const check = (name: string, status: Status, critical = false) => ({ name, status, critical, detail: "d", latencyMs: 1 });

const CRITICAL = [check("database", "up", true), check("vertex", "up", true), check("deep_research_api", "up", true)];
const SCRAPERS = [
  check("scraper_instagram", "up"),
  check("scraper_x", "up"),
  check("scraper_threads", "up"),
  check("scraper_linkedin", "up"),
  check("scraper_linkedin_posts", "up"),
];

async function load(checks: ReturnType<typeof check>[]) {
  vi.resetModules();
  const runHealthChecks = vi.fn().mockResolvedValue(checks);
  const actual = await vi.importActual<typeof import("@/lib/health/checks")>("@/lib/health/checks");
  vi.doMock("@/lib/health/checks", () => ({ ...actual, runHealthChecks }));
  vi.doMock("@/lib/auth/internal", () => ({ verifyInternalJobRequest: () => undefined }));
  const mod = await import("./route");
  return { mod, runHealthChecks };
}

function logs(): Record<string, unknown>[] {
  const spy = vi.mocked(console.log);
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

afterEach(() => vi.restoreAllMocks());

describe("GET /api/internal/health", () => {
  it("slow scraper does NOT page: criticalDown stays 0 while summary.down records it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { mod } = await load([...CRITICAL, check("scraper_instagram", "down"), ...SCRAPERS.slice(1)]);
    const res = await mod.GET(new Request("https://one.hushh.ai/api/internal/health"));

    expect(res.status).toBe(200); // non-critical dep down → app still healthy
    const logged = logs().find((l) => l.event === "one.health.check")!;
    expect(logged.criticalDown).toBe(0); // ← the alert signal: quiet
    expect(logged.summary).toMatchObject({ down: 1 }); // ← history still records it
    expect(logged.notUp).toEqual(["scraper_instagram:down"]);
  });

  it("real outage pages: a critical dep down sets criticalDown and returns 503", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { mod } = await load([check("database", "down", true), ...CRITICAL.slice(1), ...SCRAPERS]);
    const res = await mod.GET(new Request("https://one.hushh.ai/api/internal/health"));

    expect(res.status).toBe(503);
    const logged = logs().find((l) => l.event === "one.health.check")!;
    expect(logged.criticalDown).toBe(1);
    expect(logged.ok).toBe(false);
  });

  it("?scope=critical skips the expensive scraper probes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { mod, runHealthChecks } = await load(CRITICAL);
    const res = await mod.GET(new Request("https://one.hushh.ai/api/internal/health?scope=critical"));

    expect(runHealthChecks).toHaveBeenCalledWith({ includeScrapers: false });
    const body = (await res.json()) as { scope: string; criticalDown: number };
    expect(body.scope).toBe("critical");
    expect(logs().find((l) => l.event === "one.health.check")!.scope).toBe("critical");
  });

  it("defaults to the full sweep (health-e2e harness and the public status page rely on it)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { mod, runHealthChecks } = await load([...CRITICAL, ...SCRAPERS]);
    const res = await mod.GET(new Request("https://one.hushh.ai/api/internal/health"));

    expect(runHealthChecks).toHaveBeenCalledWith({ includeScrapers: true });
    const body = (await res.json()) as { scope: string; checks: unknown[] };
    expect(body.scope).toBe("full");
    expect(body.checks).toHaveLength(8);
  });
});
