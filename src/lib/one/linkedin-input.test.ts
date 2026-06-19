import { describe, expect, it } from "vitest";
import { validateLinkedInProfileInput } from "./linkedin-input";

const degraded = {
  sub: "ankit",
  name: "",
  givenName: "",
  familyName: "",
  email: null,
  emailVerified: false,
  locale: null,
  pictureUrl: null,
  profileUrl: "https://www.linkedin.com/in/ankit",
  headline: null,
  verifications: [],
  grantedScopes: ["scraper:linkedin-handshake"],
  source: "scraper",
  enriched: false,
};

const rich = { ...degraded, name: "Ankit", enriched: undefined, skills: ["AI"] };

describe("validateLinkedInProfileInput (resilient guest gate)", () => {
  it("accepts a degraded URL-only connection for a guest (does not throw)", () => {
    const out = validateLinkedInProfileInput(degraded, { requireLinkedIn: true });
    expect(out).toBeTruthy();
    expect(out?.source).toBe("scraper");
    expect(out?.enriched).toBe(false);
    expect(out?.profileUrl).toBe("https://www.linkedin.com/in/ankit");
  });

  it("accepts a rich profile (unchanged best case)", () => {
    const out = validateLinkedInProfileInput(rich, { requireLinkedIn: true });
    expect(out?.name).toBe("Ankit");
  });

  it("still rejects a guest with no profile", () => {
    expect(() => validateLinkedInProfileInput(undefined, { requireLinkedIn: true })).toThrow(/required/i);
  });

  it("rejects a non-/in/ (company) URL", () => {
    expect(() =>
      validateLinkedInProfileInput({ ...degraded, profileUrl: "https://www.linkedin.com/company/hushh" }, { requireLinkedIn: true }),
    ).toThrow();
  });

  it("returns undefined for a non-guest with no profile (optional)", () => {
    expect(validateLinkedInProfileInput(undefined, { requireLinkedIn: false })).toBeUndefined();
  });
});
