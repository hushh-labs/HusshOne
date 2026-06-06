import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchShadowReport, mapShadowReport } from "./shadow";
import type { OneSubjectInput, ShadowReport } from "./types";

const input: OneSubjectInput = {
  name: "Test Subject",
  email: "subject@example.com",
  latitude: 18.5643,
  longitude: 73.7398,
  consentAttestation: true,
  purpose: "self_audit",
};

function fullReport(): ShadowReport {
  return {
    title: "Intelligence Report: Test Subject",
    status: "completed",
    summary: "Public footprint with a phone 415-555-1212 inside the text.",
    confidence: { overall: "medium", sourceCount: 7 },
    subject: { name: "Test Subject", location: "Pune", sourceUrls: ["https://example.com/profile"] },
    professional: {
      currentRole: "Product engineer",
      validatedClaims: ["Engineering role appears publicly", "Engineering role appears publicly"],
      unverifiedClaims: ["Leadership scope unconfirmed"],
      confidence: "medium",
    },
    education: { summary: "Engineering background", validatedClaims: ["University listed"], confidence: "low" },
    digitalFootprint: {
      profiles: [{ platform: "GitHub", url: "https://github.com/example", confidence: "medium" }],
      handles: ["example"],
      confidence: "medium",
    },
    network: { associates: [{ name: "Collaborator", relation: "Co-contributor", confidence: "low" }] },
    preferenceSignals: { supported: ["Open source"], inferred: ["Dev tooling interest"], unknown: ["Lifestyle"] },
    evidence: [
      {
        claim: "Public code presence",
        category: "public_work",
        confidence: "medium",
        support: "Active repos",
        sources: ["https://github.com/example"],
      },
    ],
    discovery: {
      summary: "Broad grounding plus expansion.",
      queryExpansion: ['"Test Subject" engineer'],
      sourceMap: [{ title: "Profile", url: "https://example.com/profile", usedFor: ["identity"] }],
    },
    conflicts: [],
    missingEvidence: ["No confirmed contact details"],
    sourceUrls: ["https://example.com/profile", "https://github.com/example"],
  };
}

describe("mapShadowReport", () => {
  it("maps a full report into rich + legacy fields and redacts free text", () => {
    const result = mapShadowReport(fullReport(), input, "precise", "scan-1", "completed");

    expect(result.source).toBe("shadow");
    expect(result.scanRunId).toBe("scan-1");
    // legacy categories populated for the existing cards + email
    expect(result.categories.socials.join(" ")).toContain("GitHub");
    expect(result.categories.education.join(" ")).toContain("University listed");
    // rich
    expect(result.rich?.overallConfidence).toBe("medium");
    expect(result.rich?.sourceCount).toBe(7);
    expect(result.rich?.professional?.currentRole).toBe("Product engineer");
    // dedupe inside lists
    expect(result.rich?.professional?.validatedClaims).toEqual(["Engineering role appears publicly"]);
    expect(result.rich?.digitalFootprint?.profiles[0]?.url).toBe("https://github.com/example");
    expect(result.rich?.evidence[0]?.claim).toBe("Public code presence");
    // free-text redaction
    expect(result.summary).toContain("[redacted-phone]");
    expect(result.redactions).toContain("phone");
    // URLs survive redaction
    expect(result.rich?.sourceUrls).toContain("https://github.com/example");
  });

  it("never throws on a sparse report and falls back gracefully", () => {
    const result = mapShadowReport({}, input, "limited", null, "completed");
    expect(result.source).toBe("shadow");
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.rich?.professional).toBeNull();
    expect(result.rich?.evidence).toEqual([]);
    expect(result.rich?.sourceUrls).toEqual([]);
  });

  it("adds a partial warning when the run was partial", () => {
    const result = mapShadowReport(fullReport(), input, "precise", "scan-1", "partial");
    expect(result.warnings.some((w) => w.toLowerCase().includes("partial"))).toBe(true);
  });
});

describe("fetchShadowReport", () => {
  beforeEach(() => {
    vi.stubEnv("ONE_ENABLE_MOCK_RIA", "false");
    vi.stubEnv("HUSHH_SHADOW_API_KEY", "shadow-test-key");
    vi.stubEnv("ONE_SHADOW_RETRIES", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the mock report when ONE_ENABLE_MOCK_RIA=true", async () => {
    vi.stubEnv("ONE_ENABLE_MOCK_RIA", "true");
    vi.stubEnv("ONE_MOCK_RIA_DELAY_MS", "0");
    const res = await fetchShadowReport(input);
    expect(res.success).toBe(true);
    expect(res.status).toBe("completed");
    expect(res.report?.professional?.currentRole).toBeTruthy();
  });

  it("posts the report and returns the parsed body on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: "completed", report: { title: "ok" } }),
    }));
    vi.stubGlobal("fetch", fetchMock as never);

    const res = await fetchShadowReport(input);
    expect(res.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.latitude).toBe(18.5643);
    expect(body.longitude).toBe(73.7398);
  });

  it("never sends a lone coordinate", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: "completed", report: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock as never);

    await fetchShadowReport({ ...input, longitude: undefined });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(call[1].body as string);
    expect(body.latitude).toBeUndefined();
    expect(body.longitude).toBeUndefined();
  });

  it("throws a 401 upstream status without retrying", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock as never);

    await expect(fetchShadowReport(input)).rejects.toMatchObject({ upstreamStatus: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a 400 upstream status (validation) without retrying", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ detail: "bad" }) }));
    vi.stubGlobal("fetch", fetchMock as never);
    await expect(fetchShadowReport(input)).rejects.toMatchObject({ upstreamStatus: 400 });
  });

  it("does not retry a 429 when retries=0", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock as never);
    await expect(fetchShadowReport(input)).rejects.toMatchObject({ upstreamStatus: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted request to a 504 timeout", async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    vi.stubGlobal("fetch", fetchMock as never);
    await expect(fetchShadowReport(input)).rejects.toMatchObject({ statusCode: 504 });
  });

  it("fails clearly when the API key is missing", async () => {
    vi.stubEnv("HUSHH_SHADOW_API_KEY", "");
    vi.stubEnv("PERSON_INTELLIGENCE_API_KEY", "");
    await expect(fetchShadowReport(input)).rejects.toMatchObject({ statusCode: 503 });
  });
});
