import { describe, expect, it } from "vitest";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_VERSION, buildAgentCard } from "./agent-card";

describe("buildAgentCard (A2A)", () => {
  it("produces a spec-conformant card with required top-level fields", () => {
    const card = buildAgentCard("https://one.hushh.ai");
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.version).toBe(AGENT_CARD_VERSION);
    expect(card.name).toMatch(/Xtreme Compute Burst/);
    expect(card.url).toBe("https://one.hushh.ai/api/one/burst");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.defaultOutputModes).toContain("application/x-ndjson");
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
  });

  it("declares both the Hushh session and BYOC security schemes as required (AND)", () => {
    const card = buildAgentCard("https://one.hushh.ai");
    expect(Object.keys(card.securitySchemes)).toEqual(expect.arrayContaining(["hushhSession", "byocGcp"]));
    expect(card.security[0]).toMatchObject({ hushhSession: [], byocGcp: [] });
  });

  it("exposes a burst-compute skill with discoverable tags", () => {
    const card = buildAgentCard("https://one.hushh.ai");
    const skill = card.skills.find((s) => s.id === "burst-compute");
    expect(skill).toBeTruthy();
    expect(skill?.tags).toEqual(expect.arrayContaining(["gpu", "byoc", "apple-silicon"]));
  });

  it("derives every URL from the given origin and strips trailing slashes", () => {
    const card = buildAgentCard("https://preview.example.com/");
    expect(card.url.startsWith("https://preview.example.com/")).toBe(true);
    expect(card.url).not.toContain("//api"); // no double slash from the trailing-slash origin
    expect(card.documentationUrl).toContain("preview.example.com");
  });
});
