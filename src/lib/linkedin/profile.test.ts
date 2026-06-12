import { describe, expect, it } from "vitest";
import { buildLinkedInProfile, hasUrlEnrichedLinkedInProfile, type LinkedInProfileFull } from "./profile";
import type { ProbeResult, RawApiResult } from "./oauth";

function probe(key: string, ok: boolean, data: unknown): ProbeResult {
  return {
    key,
    label: key,
    description: "",
    kind: "read",
    requiredAnyScope: [],
    method: "GET",
    url: "",
    granted: true,
    attempted: true,
    result: { ok, status: ok ? 200 : 403, data },
  };
}

const IDENTITY_ME = {
  basicInfo: {
    firstName: { localized: { en_US: "Ankit Kumar" } },
    lastName: { localized: { en_US: "Singh" } },
    primaryEmailAddress: "legacy@example.com",
    profileUrl: "https://www.linkedin.com/profile-thirdparty-redirect/abc",
    // headline is a MultiLocaleString (current + past companies) — the key anchor.
    headline: { localized: { en_US: "Product Engineer hushh | Ex CRED | Ex Google" } },
    profilePicture: { croppedImage: { downloadUrl: "https://media.licdn.com/cropped.jpg" } },
  },
};

describe("buildLinkedInProfile", () => {
  it("normalizes userinfo + identityMe + verificationReport into one clean object", () => {
    const userinfo: RawApiResult = {
      ok: true,
      status: 200,
      data: {
        sub: "oidcSub",
        name: "Ankit Kumar Singh",
        given_name: "Ankit Kumar",
        family_name: "Singh",
        picture: "https://media.licdn.com/oidc.jpg",
        email: "ankit@example.com",
        email_verified: true,
        locale: { country: "US", language: "en" },
      },
    };
    const probes = [probe("identity_me", true, IDENTITY_ME), probe("verification_report", true, { verifications: ["WORKPLACE"] })];

    const p = buildLinkedInProfile({ userinfo, probes, idTokenClaims: { sub: "oidcSub" }, grantedScopes: ["openid", "profile"] });

    expect(p.sub).toBe("oidcSub");
    expect(p.name).toBe("Ankit Kumar Singh");
    expect(p.givenName).toBe("Ankit Kumar");
    expect(p.familyName).toBe("Singh");
    expect(p.email).toBe("ankit@example.com");
    expect(p.emailVerified).toBe(true);
    expect(p.locale).toBe("en-US");
    expect(p.pictureUrl).toBe("https://media.licdn.com/cropped.jpg"); // identityMe (bigger) preferred
    expect(p.profileUrl).toBe("https://www.linkedin.com/profile-thirdparty-redirect/abc");
    expect(p.headline).toBe("Product Engineer hushh | Ex CRED | Ex Google"); // MultiLocaleString extracted
    expect(p.verifications).toEqual(["WORKPLACE"]);
    expect(p.grantedScopes).toEqual(["openid", "profile"]);
  });

  it("degrades to identityMe fields when OIDC userinfo failed, and to the id_token sub", () => {
    const userinfo: RawApiResult = { ok: false, status: 401, data: { code: "REVOKED" } };
    const probes = [probe("identity_me", true, IDENTITY_ME)];

    const p = buildLinkedInProfile({ userinfo, probes, idTokenClaims: { sub: "fromIdToken" }, grantedScopes: [] });

    expect(p.sub).toBe("fromIdToken");
    expect(p.name).toBe("Ankit Kumar Singh"); // built from given+family
    expect(p.email).toBe("legacy@example.com"); // primaryEmailAddress fallback
    expect(p.emailVerified).toBe(false);
    expect(p.pictureUrl).toBe("https://media.licdn.com/cropped.jpg"); // croppedImage fallback
    expect(p.profileUrl).toBe("https://www.linkedin.com/profile-thirdparty-redirect/abc");
    expect(p.headline).toBe("Product Engineer hushh | Ex CRED | Ex Google");
    expect(p.verifications).toEqual([]); // no verification probe
  });

  it("ignores a failed (403) probe's body", () => {
    const userinfo: RawApiResult = { ok: true, status: 200, data: { sub: "s", name: "N", picture: "p" } };
    const probes = [probe("identity_me", false, { status: 403, code: "ACCESS_DENIED" })];
    const p = buildLinkedInProfile({ userinfo, probes, idTokenClaims: null, grantedScopes: [] });
    expect(p.profileUrl).toBeNull();
    expect(p.name).toBe("N");
  });
});

describe("hasUrlEnrichedLinkedInProfile", () => {
  const base: LinkedInProfileFull = {
    sub: "anilsachdev",
    name: "Anil Sachdev",
    givenName: "Anil",
    familyName: "Sachdev",
    email: "anil@example.com",
    emailVerified: false,
    locale: null,
    pictureUrl: null,
    profileUrl: "https://www.linkedin.com/in/anilsachdev",
    headline: "Chief Operating Officer",
    verifications: [],
    grantedScopes: ["scraper:linkedin-profile-url"],
    source: "scraper",
  };

  it("accepts URL-scraper profiles with rich LinkedIn sections", () => {
    expect(hasUrlEnrichedLinkedInProfile({ ...base, skills: ["Fund Operations"] })).toBe(true);
    expect(hasUrlEnrichedLinkedInProfile({ ...base, experience: [{ title: "COO", company: "OTS Capital" }] })).toBe(true);
  });

  it("rejects OAuth-lite, non-/in/, and sparse scraper profiles", () => {
    expect(hasUrlEnrichedLinkedInProfile({ ...base, source: "oauth", skills: ["Fund Operations"] })).toBe(false);
    expect(hasUrlEnrichedLinkedInProfile({ ...base, profileUrl: "https://www.linkedin.com/company/hushh", skills: ["AI"] })).toBe(false);
    expect(hasUrlEnrichedLinkedInProfile(base)).toBe(false);
  });
});
