import { describe, expect, it } from "vitest";
import { buildPersonDossierQuestion, mapResearchResult, parseHeadlineSpine, structuredSpine } from "./dossier";
import { INTELLIGENCE_VERSION } from "./version";
import type { ConfirmedProfile, OneSubjectInput } from "@/lib/ria/types";

function baseInput(confirmedProfiles?: ConfirmedProfile[]): OneSubjectInput {
  return {
    name: "Ankit Singh",
    email: "ankit@example.com",
    latitude: 18.52,
    longitude: 73.85,
    confirmedProfiles,
    consentAttestation: true,
    purpose: "self_audit",
  };
}

function extractLinkedInPromptJson(question: string): Record<string, unknown> {
  const match = question.match(/LINKEDIN_ENRICHED_PROFILE_JSON[\s\S]*?```json\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Record<string, unknown>;
}

describe("buildPersonDossierQuestion", () => {
  it("defuses a LinkedIn anchor into a load-reducer (identity pre-confirmed, budgeted, lean)", () => {
    const url = "https://www.linkedin.com/in/ankit-kumar-singh-001";
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "LinkedIn", handle: "ankit-kumar-singh-001", url, category: "Professional" }]),
    );
    expect(q).toContain("IDENTITY IS ALREADY CONFIRMED");
    expect(q).toContain(url);
    // explicit search budget bounds the agent's runtime
    expect(q).toMatch(/8.{0,3}12 targeted web searches/);
    // heavy derived sections that ballooned search work were cut
    expect(q).not.toContain("Net Worth Signal Score");
    expect(q).not.toContain("Breach Exposure");
    expect(q).not.toContain("SUBJECT — resolve identity");
  });

  it("falls back to name+email anchoring when the only pivot is not LinkedIn", () => {
    const q = buildPersonDossierQuestion(
      baseInput([{ platform: "GitHub", handle: "ankit", url: "https://github.com/ankit", category: "Dev/code" }]),
    );
    expect(q).toContain("SUBJECT — resolve identity");
    expect(q).toContain("https://github.com/ankit");
    expect(q).not.toContain("IDENTITY IS ALREADY CONFIRMED");
  });

  it("uses the name+email block when no profiles are confirmed", () => {
    const q = buildPersonDossierQuestion(baseInput());
    expect(q).toContain("SUBJECT — resolve identity");
    expect(q).not.toContain("IDENTITY IS ALREADY CONFIRMED");
  });

  it("parses the verified headline into a current/former spine and seeds searches off it (never fetching the redirect URL)", () => {
    const redirect = "https://www.linkedin.com/profile-thirdparty-redirect/AgFZ";
    const input = baseInput([
      { platform: "LinkedIn", handle: "ankit", url: redirect, category: "Professional" },
    ]);
    input.linkedinProfile = {
      sub: "vWFDS7ns0j",
      name: "Ankit Kumar Singh",
      givenName: "Ankit Kumar",
      familyName: "Singh",
      email: "ankitkumarsingh97593@gmail.com",
      emailVerified: true,
      locale: "en-US",
      pictureUrl: "https://media.licdn.com/dms/image/v2/photo.jpg",
      profileUrl: redirect,
      headline: "Product Engineer hushh | Ex CRED | Ex Google Mentee | Ex JAR | Ex IAF",
      verifications: ["WORKPLACE"],
      grantedScopes: ["openid", "profile", "email", "r_profile_basicinfo", "r_verify"],
    };
    const q = buildPersonDossierQuestion(input);
    // identity framed as solved ground truth
    expect(q).toContain("IDENTITY IS SOLVED");
    expect(q).toMatch(/never re-confirm/i);
    // photo + verification + email local-part as a handle seed all reach Phase-1
    expect(q).toContain("https://media.licdn.com/dms/image/v2/photo.jpg");
    expect(q).toContain("WORKPLACE");
    expect(q).toContain("ankitkumarsingh97593"); // email local-part handle seed
    // headline parsed into current vs former — current/past correctly split
    expect(q).toContain("CURRENT (who they are today): Product Engineer hushh");
    expect(q).toContain("CRED, Google Mentee, JAR, IAF"); // FORMER, in order
    // the unfetchable redirect URL must NOT be "read", and the old broken instruction is gone
    expect(q).toMatch(/do NOT open, fetch/i);
    expect(q).not.toContain("Read this ONE LinkedIn profile");
    // bounded budget
    expect(q).toContain("HARD CAP 12");
  });
});

describe("structured spine (MCP full profile)", () => {
  it("builds the spine from structured experience and seeds the budget off real orgs", () => {
    const input = baseInput();
    input.linkedinProfile = {
      sub: "ada-lovelace",
      name: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      email: "ada@analytical.com",
      emailVerified: false,
      locale: null,
      pictureUrl: null,
      profileUrl: "https://www.linkedin.com/in/ada-lovelace",
      headline: "Founder & CEO at Analytical Engines",
      verifications: [],
      grantedScopes: ["mcp:get_my_profile"],
      source: "mcp",
      experience: [
        { title: "Founder & CEO", company: "Analytical Engines", current: true },
        { title: "Staff Engineer", company: "Google", endDate: "2021" },
        { title: "Intern", company: "Stanford Lab", endDate: "2014" },
      ],
      education: [{ school: "Stanford University", degree: "MS", field: "Computer Science" }],
      skills: ["Rust", "Distributed Systems"],
    };
    const q = buildPersonDossierQuestion(input);
    expect(q).toContain("IDENTITY IS SOLVED");
    // spine sourced from the verified work history, not the headline string
    expect(q).toContain("the subject's verified LinkedIn work history");
    expect(q).toContain("CURRENT (who they are today): Founder & CEO at Analytical Engines");
    expect(q).toContain("Google, Stanford Lab"); // FORMER orgs in order
    // education + skills anchors injected
    expect(q).toContain("Stanford University");
    expect(q).toContain("Distributed Systems");
    expect(q).toContain("HARD CAP 12");
  });

  it("returns null with no experience so callers fall back to the headline parser", () => {
    expect(structuredSpine(undefined)).toBeNull();
    expect(structuredSpine({ sub: "x", name: "x", givenName: "", familyName: "", email: null, emailVerified: false, locale: null, pictureUrl: null, profileUrl: null, headline: "CEO at Foo", verifications: [], grantedScopes: [] })).toBeNull();
  });

  it("picks the current-flagged role as current and dedupes the former orgs", () => {
    const s = structuredSpine({
      sub: "x", name: "x", givenName: "", familyName: "", email: null, emailVerified: false, locale: null, pictureUrl: null, profileUrl: null, headline: null, verifications: [], grantedScopes: [],
      experience: [
        { title: "Advisor", company: "Acme", current: false, endDate: "2020" },
        { title: "CTO", company: "Beta", current: true },
        { title: "Engineer", company: "Acme", endDate: "2019" },
      ],
    });
    expect(s).toEqual({ current: "CTO at Beta", past: ["Acme"] });
  });
});

describe("parseHeadlineSpine", () => {
  it("splits current vs former and strips the Ex prefix", () => {
    const s = parseHeadlineSpine("Product Engineer hushh | Ex CRED | Ex Google Mentee | Ex JAR | Ex IAF");
    expect(s.current).toBe("Product Engineer hushh");
    expect(s.past).toEqual(["CRED", "Google Mentee", "JAR", "IAF"]);
  });

  it("caps former affiliations at 4 so a long headline can't blow the search budget", () => {
    const s = parseHeadlineSpine("Now Co | Ex A | Ex B | Ex C | Ex D | Ex E");
    expect(s.past).toEqual(["A", "B", "C", "D"]);
  });

  it("handles a 'Former' prefix and a headline with no former roles", () => {
    expect(parseHeadlineSpine("Founder at hussh")).toEqual({ current: "Founder at hussh", past: [] });
    expect(parseHeadlineSpine("CEO | Former Acme").past).toEqual(["Acme"]);
  });
});

describe("mapResearchResult", () => {
  it("stamps the current intelligence version onto the result", () => {
    const result = mapResearchResult("# Report\n\nSome body text long enough to summarize.", [], baseInput(), "precise", "scan-1");
    expect(result.intelligenceVersion).toBe(INTELLIGENCE_VERSION);
    expect(result.source).toBe("deep_research");
  });
});

describe("scraper (URL-enrichment) profile → Phase-1 prompt", () => {
  function scraperInput(): OneSubjectInput {
    const input = baseInput([
      { platform: "LinkedIn", handle: "anilsachdev", url: "https://www.linkedin.com/in/anilsachdev", category: "Professional" },
    ]);
    input.name = "Anil Sachdev";
    input.email = "anil@example.com";
    input.linkedinProfile = {
      sub: "anilsachdev",
      name: "Anil Sachdev",
      givenName: "Anil",
      familyName: "Sachdev",
      email: "anil@example.com",
      emailVerified: false,
      locale: null,
      pictureUrl: null,
      profileUrl: "https://www.linkedin.com/in/anilsachdev",
      headline: null,
      verifications: [],
      grantedScopes: ["scraper:linkedin-profile-url"],
      source: "scraper",
      location: "Dubai, United Arab Emirates",
      about: "Strategic operations executive — COO of OTS Capital — building CSSF- and FSCA-compliant AML/KYC frameworks.",
      experience: [
        { title: "Chief Operating Officer", company: "OTS Capital", startDate: "Jan 2024", current: true },
        { title: "Head of Fund Operations", company: "VINKEFUND", endDate: "Dec 2023" },
        { title: "Managing Director", company: "SkyBridge", endDate: "2020" },
        { title: "Director", company: "Redwood Capital", endDate: "2017" },
        { title: "Analyst", company: "Atlas Bank", endDate: "2012" },
        { title: "Associate", company: "Delta Markets", endDate: "2009" },
      ],
      education: [
        { school: "University of Wales, UK", degree: "MBA, Finance" },
        { school: "Delhi University", degree: "BCom" },
        { school: "Executive Institute", degree: "Risk Leadership Certificate" },
      ],
      skills: [
        "Financial Markets",
        "FX Options",
        "Fund Operations",
        "AML",
        "KYC",
        "Risk Management",
        "Capital Markets",
        "Operations",
        "Leadership",
        "Compliance",
        "Derivatives",
        "Trading",
        "Investor Relations",
      ],
      certifications: [{ name: "Certified AML Specialist", authority: "ACAMS", date: "2022" }],
    };
    return input;
  }

  it("injects the About + stated location and builds the spine from structured roles", () => {
    const q = buildPersonDossierQuestion(scraperInput());
    expect(q).toContain("IDENTITY IS SOLVED");
    // rich About is injected via the complete normalized LinkedIn JSON block
    expect(q).toContain("LINKEDIN_ENRICHED_PROFILE_JSON");
    expect(q).toContain("CSSF");
    // stated location surfaces alongside the coordinates
    expect(q).toContain("Stated location (from their LinkedIn): Dubai, United Arab Emirates");
    // spine from real roles
    expect(q).toContain("CURRENT (who they are today): Chief Operating Officer at OTS Capital");
    expect(q).toContain("VINKEFUND");
  });

  it("forces the no-fetch posture even with a clean /in/ URL (LinkedIn is bot-blocked)", () => {
    const q = buildPersonDossierQuestion(scraperInput());
    expect(q).toMatch(/do NOT open, fetch/i);
    expect(q).not.toContain("Read that ONE public /in/ profile");
  });

  it("sends the complete normalized LinkedIn profile JSON to Phase-1 without raw scraper internals", () => {
    const q = buildPersonDossierQuestion(scraperInput());
    const json = extractLinkedInPromptJson(q);
    expect(json.name).toBe("Anil Sachdev");
    expect(json.profileUrl).toBe("https://www.linkedin.com/in/anilsachdev");
    expect(json.source).toBe("scraper");
    expect(json.about).toContain("CSSF- and FSCA-compliant AML/KYC frameworks");

    const skills = json.skills as string[];
    expect(skills).toHaveLength(13);
    expect(skills).toContain("Investor Relations");

    const experience = json.experience as Array<Record<string, unknown>>;
    expect(experience).toHaveLength(6);
    expect(experience.at(-1)?.company).toBe("Delta Markets");

    const education = json.education as Array<Record<string, unknown>>;
    expect(education).toHaveLength(3);
    expect(education.at(-1)?.school).toBe("Executive Institute");

    const certifications = json.certifications as Array<Record<string, unknown>>;
    expect(certifications).toEqual([{ name: "Certified AML Specialist", authority: "ACAMS", date: "2022" }]);

    expect(q).toContain("Treat this JSON as LOCKED GROUND TRUTH");
    expect(q).toContain("distinguish LinkedIn-provided ground truth from public web evidence and inference");
    expect(q).not.toContain("linkedinProfileScraper");
    expect(q).not.toContain("staffSpyStyle");
    expect(q).not.toContain("templates");
  });
});
