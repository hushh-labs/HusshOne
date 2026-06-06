import { describe, expect, it } from "vitest";
import { cleanUrlList, hasUnsafeRawContactData, normalizeDashboardPayload } from "./sanitize";

describe("RIA dashboard sanitizer", () => {
  it("redacts private contact data and marks risky unsupported claims", () => {
    const result = normalizeDashboardPayload({
      scanRunId: "scan-1",
      mode: "precise",
      subject: { name: "Ankit Kumar Singh", email: "ankit@example.com" },
      dashboard: {
        entityId: "Ankit Kumar Singh",
        summary: "Public profile includes +1 415 555 1212 and ankit@example.com.",
        categorizedData: {
          newsAndMedia: ["Source https://example.com/profile"],
          socials: ["GitHub profile"],
          education: [],
          government: ["Dark web voter claim without source"],
          otherFootprints: [],
          connectedIdentities: [],
        },
        privateDataEstimation: ["Possible data broker record with phone 9876543210"],
        locationIntelligence: "Near a public campus",
      },
    });

    expect(result.summary).toContain("[redacted-phone]");
    expect(result.summary).toContain("[redacted-email]");
    expect(result.redactions).toEqual(expect.arrayContaining(["email", "phone"]));
    expect(result.categories.government[0]).toContain("Dark web");
    expect(result.privateDataEstimation[0].confidence).toBe("possible");
  });

  it("detects unsafe raw payloads before rendering", () => {
    expect(hasUnsafeRawContactData({ value: "Call 415-555-1212" })).toBe(true);
    expect(hasUnsafeRawContactData({ value: "Only source-backed profile" })).toBe(false);
  });

  it("preserves source URLs while dropping mailto and duplicates", () => {
    const urls = cleanUrlList([
      "https://github.com/ankit",
      "https://github.com/ankit",
      "mailto:ankit@example.com",
      "",
      "https://linkedin.com/in/ankit",
    ]);
    expect(urls).toEqual(["https://github.com/ankit", "https://linkedin.com/in/ankit"]);
  });

  it("sets person_intelligence source and null rich on the legacy path", () => {
    const result = normalizeDashboardPayload({
      mode: "limited",
      subject: { name: "A", email: "a@example.com" },
      dashboard: { summary: "ok" },
    });
    expect(result.source).toBe("person_intelligence");
    expect(result.rich).toBeNull();
  });
});
