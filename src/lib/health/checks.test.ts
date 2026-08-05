import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Guards the two properties that make the scraper probes safe to keep:
   1. they are RATE-LIMITED — a healthy session is not re-inspected on every sweep (each probe drives a live
      browser inspection on the VM, so probing per-sweep was ~144 synthetic inspections/day for nothing);
   2. they never count toward the paging signal (criticalDownCount). */

vi.mock("@/lib/db/prisma", () => ({ getPrismaClient: () => ({ $queryRaw: async () => [{ "?column?": 1 }] }) }));
vi.mock("@/lib/gcp/auth", () => ({ vertexConfig: () => ({ project: "p", location: "l" }), adcAccessToken: async () => "token" }));
vi.mock("@/lib/research/client", () => ({ deepResearchBaseUrl: () => "https://deep-research.test" }));

const SCRAPER_ENV = {
  INSTAGRAM_SCRAPER_URL: "http://ig.test:8080",
  TWITTER_SCRAPER_URL: "http://x.test:8080",
  THREADS_SCRAPER_URL: "http://th.test:8080",
  LINKEDIN_SCRAPER_URL: "http://li.test:8080",
};

/** 200 + ok:true for status endpoints; 400 for /scrape-posts (which is how that probe reads as "wired"). */
function stubFetch() {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/scrape-posts")) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ ok: true, liveBrowser: true, usableForDeepScrape: true }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const scraperCalls = (mock: ReturnType<typeof stubFetch>) =>
  mock.mock.calls.filter((c) => /ig\.test|x\.test|th\.test|li\.test/.test(String(c[0]))).length;

beforeEach(() => {
  for (const [k, v] of Object.entries(SCRAPER_ENV)) vi.stubEnv(k, v);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runHealthChecks", () => {
  it("probes each scraper once, then serves the cached verdict on later sweeps", async () => {
    const fetchMock = stubFetch();
    const { runHealthChecks, __resetScraperCache } = await import("./checks");
    __resetScraperCache();

    const first = await runHealthChecks();
    const afterFirst = scraperCalls(fetchMock);
    expect(afterFirst).toBe(5); // 4 VMs + the linkedin-posts capability probe
    expect(first.filter((c) => c.name.startsWith("scraper_")).every((c) => c.status === "up")).toBe(true);

    const second = await runHealthChecks();
    expect(scraperCalls(fetchMock)).toBe(afterFirst); // no new VM traffic
    expect(second.filter((c) => c.name.startsWith("scraper_")).every((c) => c.cached === true)).toBe(true);
  });

  it("still probes the critical deps on every sweep (they are the ones that page)", async () => {
    stubFetch();
    const { runHealthChecks, __resetScraperCache } = await import("./checks");
    __resetScraperCache();

    const checks = await runHealthChecks();
    const critical = checks.filter((c) => c.critical).map((c) => c.name);
    expect(critical).toEqual(["database", "vertex", "deep_research_api"]);
    expect(checks.filter((c) => c.critical).every((c) => c.cached === undefined)).toBe(true);
  });

  it("includeScrapers:false runs the critical deps only and touches no VM", async () => {
    const fetchMock = stubFetch();
    const { runHealthChecks, __resetScraperCache } = await import("./checks");
    __resetScraperCache();

    const checks = await runHealthChecks({ includeScrapers: false });
    expect(checks).toHaveLength(3);
    expect(scraperCalls(fetchMock)).toBe(0);
  });
});

describe("readiness sweep → alerting", () => {
  it("a logged-out session raises the human-actionable signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes("ig.test")) {
          return new Response(JSON.stringify({ ok: true, liveBrowser: true, usableForDeepScrape: false, requiresHumanLogin: true }), { status: 200 });
        }
        if (String(url).includes("/scrape-posts")) return new Response("{}", { status: 400 });
        return new Response(JSON.stringify({ ok: true, usableForDeepScrape: true }), { status: 200 });
      }),
    );
    const errors: Record<string, unknown>[] = [];
    vi.spyOn(console, "error").mockImplementation((l) => void errors.push(JSON.parse(String(l)) as Record<string, unknown>));

    const { runHealthChecks, __resetScraperCache } = await import("./checks");
    __resetScraperCache();
    const checks = await runHealthChecks();

    expect(checks.find((c) => c.name === "scraper_instagram")?.status).toBe("degraded");
    const blocked = errors.filter((e) => e.event === "one.scraper.session_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ platform: "instagram", needsHuman: true, source: "readiness_probe" });
  });

  it("an UNREACHABLE scraper stays silent — slow/down is not human-actionable (the old false alarm)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway timeout", { status: 504 })));
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((l) => void errors.push(l));

    const { runHealthChecks, __resetScraperCache } = await import("./checks");
    __resetScraperCache();
    const checks = await runHealthChecks();

    expect(checks.find((c) => c.name === "scraper_instagram")?.status).toBe("down");
    expect(errors.filter((e) => String(e).includes("one.scraper.session_blocked"))).toHaveLength(0);
  });
});

describe("criticalDownCount", () => {
  it("counts critical outages only — a down scraper never pages", async () => {
    const { criticalDownCount } = await import("./checks");
    const mk = (name: string, status: "up" | "degraded" | "down", critical: boolean) => ({ name, status, critical, detail: "", latencyMs: 0 });

    expect(criticalDownCount([mk("database", "up", true), mk("scraper_instagram", "down", false)])).toBe(0);
    expect(criticalDownCount([mk("database", "down", true), mk("scraper_instagram", "down", false)])).toBe(1);
    expect(criticalDownCount([mk("database", "degraded", true)])).toBe(0); // degraded ≠ down
  });
});
