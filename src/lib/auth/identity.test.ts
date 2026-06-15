import { describe, expect, it } from "vitest";
import {
  initialsForName,
  isValidEmail,
  normalizeEmail,
  normalizeName,
  normalizeLinkedInUrl,
  isLinkedInUrl,
  linkedinHandleFromUrl,
  normalizeInstagramUrl,
  isInstagramUrl,
  instagramHandleFromUrl,
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

describe("Instagram profile helpers", () => {
  it("canonicalizes valid profile URLs", () => {
    const canonical = "https://www.instagram.com/ankit_ya_i_am/";
    expect(normalizeInstagramUrl("https://www.instagram.com/ankit_ya_i_am/")).toBe(canonical);
    expect(normalizeInstagramUrl("instagram.com/ankit_ya_i_am")).toBe(canonical);
    expect(normalizeInstagramUrl("  HTTP://m.instagram.com/Ankit.Ya.I.Am/?hl=en#x  ")).toBe("https://www.instagram.com/ankit.ya.i.am/");
  });

  it("rejects non-profile Instagram URLs", () => {
    expect(normalizeInstagramUrl("https://www.instagram.com/p/abc/")).toBe("");
    expect(normalizeInstagramUrl("https://www.instagram.com/reel/abc/")).toBe("");
    expect(normalizeInstagramUrl("https://www.instagram.com/stories/ankit/123")).toBe("");
    expect(normalizeInstagramUrl("https://www.instagram.com/explore/")).toBe("");
    expect(normalizeInstagramUrl("https://www.instagram.com/accounts/login/")).toBe("");
    expect(normalizeInstagramUrl("https://example.com/ankit_ya_i_am")).toBe("");
    expect(normalizeInstagramUrl("ankit_ya_i_am")).toBe("");
  });

  it("derives the validity flag and handle", () => {
    expect(isInstagramUrl("instagram.com/ankit_ya_i_am")).toBe(true);
    expect(isInstagramUrl("https://www.instagram.com/p/abc/")).toBe(false);
    expect(instagramHandleFromUrl("https://www.instagram.com/ankit_ya_i_am/")).toBe("ankit_ya_i_am");
  });
});

describe("LinkedIn pivot helpers", () => {
  it("canonicalizes valid profile URLs (protocol/host/trailing-slash/query agnostic)", () => {
    const canonical = "https://www.linkedin.com/in/ankit-singh";
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ankit-singh")).toBe(canonical);
    expect(normalizeLinkedInUrl("linkedin.com/in/ankit-singh")).toBe(canonical);
    expect(normalizeLinkedInUrl("linkedin.com/in/anilsachdev")).toBe("https://www.linkedin.com/in/anilsachdev");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ankit-kumar-886428288/")).toBe("https://www.linkedin.com/in/ankit-kumar-886428288");
    expect(normalizeLinkedInUrl("  HTTP://IN.LinkedIn.com/in/ankit-singh/  ")).toBe(canonical);
    expect(normalizeLinkedInUrl("https://www.linkedin.com/in/ankit-singh?trk=abc#section")).toBe(canonical);
  });

  it("rejects non-profile and non-LinkedIn URLs", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/company/hushh")).toBe("");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/jobs/view/123")).toBe("");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/feed/")).toBe("");
    expect(normalizeLinkedInUrl("https://www.linkedin.com/search/results/people/?keywords=ankit")).toBe("");
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
