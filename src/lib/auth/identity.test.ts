import { describe, expect, it } from "vitest";
import {
  initialsForName,
  isValidEmail,
  normalizeEmail,
  normalizeName,
  normalizeLinkedInUrl,
  isLinkedInUrl,
  linkedinHandleFromUrl,
} from "./identity";

describe("identity helpers", () => {
  it("normalizes Google profile fields", () => {
    expect(normalizeName("  Ankit   Kumar Singh  ")).toBe("Ankit Kumar Singh");
    expect(normalizeEmail("  Ankit@Example.COM ")).toBe("ankit@example.com");
  });

  it("validates emails and creates stable initials", () => {
    expect(isValidEmail("ankit@example.com")).toBe(true);
    expect(isValidEmail("ankit")).toBe(false);
    expect(initialsForName("Ankit Kumar Singh")).toBe("AK");
  });
});

describe("LinkedIn pivot helpers", () => {
  it("canonicalizes valid profile URLs (protocol/host/trailing-slash/query agnostic)", () => {
    const canonical = "https://www.linkedin.com/in/ankit-singh";
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ankit-singh")).toBe(canonical);
    expect(normalizeLinkedInUrl("linkedin.com/in/ankit-singh")).toBe(canonical);
    expect(normalizeLinkedInUrl("  HTTP://IN.LinkedIn.com/in/ankit-singh/  ")).toBe(canonical);
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ankit-singh?trk=abc#section")).toBe(canonical);
  });

  it("rejects non-profile and non-LinkedIn URLs", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/company/hushh")).toBe("");
    expect(normalizeLinkedInUrl("https://linkedin.com")).toBe("");
    expect(normalizeLinkedInUrl("https://notlinkedin.com/in/ankit")).toBe("");
    expect(normalizeLinkedInUrl("https://example.com/in/ankit")).toBe("");
    expect(normalizeLinkedInUrl("ankit-singh")).toBe("");
    expect(normalizeLinkedInUrl("")).toBe("");
    expect(normalizeLinkedInUrl(null)).toBe("");
  });

  it("derives the validity flag and vanity handle", () => {
    expect(isLinkedInUrl("linkedin.com/in/ankit-singh")).toBe(true);
    expect(isLinkedInUrl("https://www.linkedin.com/company/hushh")).toBe(false);
    expect(linkedinHandleFromUrl("https://www.linkedin.com/in/ankit-singh")).toBe("ankit-singh");
    expect(linkedinHandleFromUrl("linkedin.com/in/ankit%20singh/")).toBe("ankit singh");
    expect(linkedinHandleFromUrl("not-a-url")).toBe("");
  });
});
