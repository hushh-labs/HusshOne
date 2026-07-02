import { describe, expect, it, vi } from "vitest";

type Status = "up" | "degraded" | "down";
const check = (name: string, status: Status, critical = false, detail = "internal detail", latencyMs = 5) => ({ name, status, critical, detail, latencyMs });

const ALL_UP = [
  check("database", "up", true),
  check("vertex", "up", true),
  check("deep_research_api", "up", true),
  check("scraper_instagram", "up"),
  check("scraper_x", "up"),
  check("scraper_threads", "up"),
  check("scraper_linkedin", "up"),
  check("scraper_linkedin_posts", "up"),
];

// Fresh module (resets the 30s in-memory cache) with a controllable runHealthChecks mock.
async function load(checks: ReturnType<typeof check>[]) {
  vi.resetModules();
  const runHealthChecks = vi.fn().mockResolvedValue(checks);
  vi.doMock("@/lib/health/checks", () => ({ runHealthChecks }));
  const mod = await import("./route");
  return { mod, runHealthChecks };
}

describe("GET /api/v1/health (public)", () => {
  it("all up → operational, 200, four components in order", async () => {
    const { mod } = await load(ALL_UP);
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = (await res.json()) as { ok: boolean; status: string; components: { id: string; status: string; description: string }[] };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("operational");
    expect(body.components.map((c) => c.id)).toEqual(["api", "database", "research", "scrapers"]);
  });

  it("critical DB down → overall down, 503", async () => {
    const { mod } = await load([check("database", "down", true), ...ALL_UP.slice(1)]);
    const res = await mod.GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; status: string; components: { id: string; status: string }[] };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("down");
    expect(body.components.find((c) => c.id === "database")?.status).toBe("down");
  });

  it("one scraper down → degraded, 200, scrapers shows 4/5", async () => {
    const { mod } = await load([...ALL_UP.slice(0, 3), check("scraper_instagram", "down"), ...ALL_UP.slice(4)]);
    const res = await mod.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; components: { id: string; status: string; description: string }[] };
    expect(body.status).toBe("degraded");
    const scrapers = body.components.find((c) => c.id === "scrapers")!;
    expect(scrapers.status).toBe("degraded");
    expect(scrapers.description).toContain("4/5");
  });

  it("never leaks internal detail (env names, error strings, the `detail` field)", async () => {
    const { mod } = await load([
      { name: "database", status: "down", critical: true, detail: "SECRET_DSN=postgres://u:p@host SUPER_SECRET", latencyMs: 3 },
      ...ALL_UP.slice(1).map((c) => ({ ...c, detail: "INSTAGRAM_SCRAPER_URL unset TOKEN=abc123" })),
    ]);
    const res = await mod.GET();
    const text = await res.text();
    expect(text).not.toContain("SUPER_SECRET");
    expect(text).not.toContain("TOKEN=abc123");
    expect(text).not.toContain("INSTAGRAM_SCRAPER_URL");
    expect(text).not.toContain("\"detail\"");
  });

  it("caches (~30s) so repeated hits don't stampede dependencies", async () => {
    const { mod, runHealthChecks } = await load(ALL_UP);
    await mod.GET();
    await mod.GET();
    await mod.GET();
    expect(runHealthChecks).toHaveBeenCalledTimes(1);
  });

  it("OPTIONS preflight is 204", () => {
    // OPTIONS is static; import from the same module graph as the last load.
    return load(ALL_UP).then(({ mod }) => expect(mod.OPTIONS().status).toBe(204));
  });
});
