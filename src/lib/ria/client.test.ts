import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDashboardIntelligence } from "./client";
import type { OneSubjectInput } from "./types";

const input: OneSubjectInput = {
  name: "Ankit Kumar Singh",
  email: "ankit@example.com",
  latitude: 18.5643,
  longitude: 73.7398,
  consentAttestation: true,
  purpose: "self_audit",
};

describe("RIA client", () => {
  beforeEach(() => {
    vi.stubEnv("PERSON_INTELLIGENCE_API_KEY", "test-key");
    vi.stubEnv("RIA_INTELLIGENCE_API_BASE_URL", "https://ria.test");
    vi.stubEnv("ONE_RIA_RETRIES", "0");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to the footprint endpoint when dashboard is temporarily unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "quota" }), { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            report: "LinkedIn public profile signal. AIT Pune education source.",
            sources: [{ url: "https://aitpune.com" }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchDashboardIntelligence(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://ria.test/v1/person-intelligence/dashboard");
    expect(fetchMock.mock.calls[1][0]).toBe("https://ria.test/v1/person-intelligence/footprint");
    expect(result.summary).toContain("LinkedIn");
    expect(result.categorizedData.otherFootprints[0]).toContain("LinkedIn");
    expect(result.categorizedData.connectedIdentities).toContain("https://aitpune.com");
  });
});
