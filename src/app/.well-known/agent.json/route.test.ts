import { describe, expect, it } from "vitest";
import { GET } from "./route";

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/.well-known/agent.json", { headers });
}

describe("GET /.well-known/agent.json", () => {
  it("serves a cacheable A2A agent card", async () => {
    const response = await GET(makeRequest({ origin: "https://one.hushh.ai" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/max-age=3600/);
    const card = await response.json();
    expect(card.protocolVersion).toBeTruthy();
    expect(card.url).toBe("https://one.hushh.ai/api/one/burst");
    expect(card.skills.map((s: { id: string }) => s.id)).toContain("burst-compute");
  });

  it("derives the origin from forwarded headers in production", async () => {
    const response = await GET(makeRequest({ "x-forwarded-proto": "https", "x-forwarded-host": "preview.hushh.ai" }));
    const card = await response.json();
    expect(card.url).toBe("https://preview.hushh.ai/api/one/burst");
  });
});
