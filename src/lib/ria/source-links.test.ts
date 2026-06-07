import { describe, it, expect, vi, beforeEach } from "vitest";
import { isGroundingRedirect, categorizeSource, buildSourceCards } from "./source-links";

describe("isGroundingRedirect", () => {
  it("detects vertex grounding redirects", () => {
    expect(
      isGroundingRedirect("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123"),
    ).toBe(true);
  });
  it("rejects normal and malformed URLs", () => {
    expect(isGroundingRedirect("https://github.com/ankit")).toBe(false);
    expect(isGroundingRedirect("https://vertexaisearch.cloud.google.com/other")).toBe(false);
    expect(isGroundingRedirect("not a url")).toBe(false);
  });
});

describe("categorizeSource", () => {
  it("personalizes GitHub", () => {
    const c = categorizeSource("https://github.com/ankitkumarsingh1702", "Ankit Kumar Singh");
    expect(c.domain).toBe("github.com");
    expect(c.category).toBe("Code");
    expect(c.label).toBe("Ankit's GitHub");
    expect(c.favicon).toContain("github.com");
  });
  it("personalizes LinkedIn (strips www)", () => {
    const c = categorizeSource("https://www.linkedin.com/in/ankit", "Ankit Kumar Singh");
    expect(c.domain).toBe("linkedin.com");
    expect(c.category).toBe("Professional");
    expect(c.label).toBe("Ankit on LinkedIn");
  });
  it("labels education domains", () => {
    expect(categorizeSource("https://www.aitpune.com/", "Ankit").category).toBe("Education");
  });
  it("falls back to clean domain for generic sources", () => {
    const c = categorizeSource("https://example.com/path?token=secret", "Ankit");
    expect(c.domain).toBe("example.com");
    expect(c.category).toBe("Public web");
  });
});

describe("buildSourceCards", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves grounding links, dedupes by domain, counts unresolved", async () => {
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/grounding-api-redirect/A")) return { url: "https://github.com/ankit" } as Response;
      throw new Error("timeout");
    }) as unknown as typeof fetch;

    const { cards, verifiedWebCount } = await buildSourceCards(
      [
        "https://github.com/ankit", // clean, named
        "https://vertexaisearch.cloud.google.com/grounding-api-redirect/A", // → github.com (dup)
        "https://vertexaisearch.cloud.google.com/grounding-api-redirect/B", // fails → unnamed
      ],
      "Ankit",
    );

    expect(cards.filter((c) => c.domain === "github.com")).toHaveLength(1);
    expect(verifiedWebCount).toBe(1);
  });

  it("returns empty cleanly for no urls", async () => {
    const { cards, verifiedWebCount } = await buildSourceCards([], "Ankit");
    expect(cards).toEqual([]);
    expect(verifiedWebCount).toBe(0);
  });
});
