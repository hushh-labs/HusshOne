import { describe, expect, it } from "vitest";
import { buildDeepBatchQuestion, buildPersonDossierQuestion, DEEP_BATCHES, mapResearchResult, parseHeadlineSpine, structuredSpine } from "./dossier";
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

function extractSocialPromptJson(question: string): Array<Record<string, unknown>> {
  const match = question.match(/SOCIAL_ENRICHED_PROFILES_JSON[\s\S]*?```json\n([\s\S]*?)\n```/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Array<Record<string, unknown>>;
}

function extractSubjectPromptJson(question: string): Record<string, unknown> {
  const match = question.match(/SUBJECT_INTELLIGENCE_CONTEXT_JSON[\s\S]*?```json\n([\s\S]*?)\n```/);
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
    // adaptive fast-mode strategy bounds the agent without a brittle hard cap
    expect(q).toContain("FAST-MODE ADAPTIVE SEARCH STRATEGY");
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
    // adaptive budget, no hard cap
    expect(q).toContain("FAST-MODE ADAPTIVE SEARCH STRATEGY");
    expect(q).not.toContain("HARD CAP 12");
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
    expect(q).toContain("FAST-MODE ADAPTIVE SEARCH STRATEGY");
    expect(q).not.toContain("HARD CAP 12");
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
    expect(q).toContain("Source hierarchy");
    expect(q).toContain("user-provided JSON, including LinkedIn when present = locked ground truth");
    expect(q).toContain("SUBJECT_INTELLIGENCE_CONTEXT_JSON");
    expect(q).toContain("ONE INTELLIGENCE OPERATING PROTOCOL");
    expect(q).toContain("LinkedIn ground truth");
    expect(q).toContain("public web evidence");
    expect(q).toContain("Unknown beats guessing");
    expect(q).not.toContain("linkedinProfileScraper");
    expect(q).not.toContain("staffSpyStyle");
    expect(q).not.toContain("templates");
    expect(q).not.toContain("li_at");
    expect(JSON.stringify(json)).not.toContain("cookie");
    expect(q).toContain("tokens, cookies");
    expect(q).not.toContain("session.pkl");
  });

  it("adds Instagram and Threads as optional supporting social context, not identity ground truth", () => {
    const input = scraperInput();
    input.socialProfiles = [
      {
        platform: "Instagram",
        username: "ankit_ya_i_am",
        displayName: "Ankit Kumar Singh",
        bio: "Builder at Hushh",
        avatarUrl: "https://cdn.example.com/avatar.jpg",
        externalUrl: "https://ankit.example.com/",
        profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
        isVerified: false,
        isPrivate: false,
        stats: { posts: "42", followers: "1,234", following: "567" },
        recentPublicPosts: [{ url: "https://www.instagram.com/p/abc/", kind: "post", caption: "Demo" }],
        source: "scraper",
      },
      {
        platform: "Threads",
        username: "threads",
        displayName: "Threads",
        bio: "Say more with Threads.",
        avatarUrl: "https://cdn.example.com/threads-avatar.jpg",
        externalUrl: "https://about.example.com/",
        profileUrl: "https://www.threads.com/@threads",
        isVerified: true,
        isPrivate: false,
        stats: { followers: "6.5M", threads: "1.2K" },
        recentThreads: [{ url: "https://www.threads.com/@threads/post/Cabc123", text: "Visible post", contentSeed: "Visible post", feedPhotoUrl: "https://cdn.example.com/feed.jpg", likeCount: "126" }],
        source: "scraper",
      },
    ];

    const q = buildPersonDossierQuestion(input);
    const social = extractSocialPromptJson(q);

    expect(social[0]).toMatchObject({
      platform: "Instagram",
      username: "ankit_ya_i_am",
      profileUrl: "https://www.instagram.com/ankit_ya_i_am/",
      source: "scraper",
    });
    expect(social[1]).toMatchObject({
      platform: "Threads",
      username: "threads",
      profileUrl: "https://www.threads.com/@threads",
      sampleVisibleItems: [{ url: "https://www.threads.com/@threads/post/Cabc123", text: "Visible post", hasMedia: true, likeCount: "126" }],
      source: "scraper",
    });
    expect(JSON.stringify(social)).not.toContain("feedPhotoUrl");
    expect(JSON.stringify(social)).not.toContain("https://cdn.example.com/feed.jpg");
    expect(q).toContain("Optional social-profile JSON is supporting context only");
    expect(q).toContain("Instagram/Threads handles");
    expect(q).toContain("supporting cross-platform context only");
    expect(q).toContain("not as proof of identity, employment, education, or private activity");
    expect(q).toContain("Treat this JSON as LOCKED GROUND TRUTH");
    expect(q).not.toContain("li_at");
    expect(q).not.toContain("session.pkl");
  });

  it("keeps large social payloads under the Deep Research question limit without changing LinkedIn ground truth", () => {
    const input = scraperInput();
    input.socialProfiles = [
      {
        platform: "Instagram",
        username: "sundarpichai",
        displayName: "Sundar Pichai",
        bio: "CEO of Google and Alphabet.",
        avatarUrl: "https://cdn.example.com/avatar.jpg",
        externalUrl: "https://google.com/",
        profileUrl: "https://www.instagram.com/sundarpichai/",
        isVerified: true,
        isPrivate: false,
        stats: { posts: "400", followers: "5M", following: "100" },
        recentPublicPosts: Array.from({ length: 120 }, (_, index) => ({
          url: `https://www.instagram.com/p/${index}/`,
          kind: "post",
          caption: `Long visible caption ${index} `.repeat(40),
          mediaUrls: [`https://cdn.example.com/full-resolution-${index}.jpg`],
          likeCount: String(1000 + index),
        })),
        source: "scraper",
      },
      {
        platform: "Threads",
        username: "sundarpichai",
        displayName: "Sundar Pichai",
        bio: "Google.",
        avatarUrl: null,
        externalUrl: null,
        profileUrl: "https://www.threads.com/@sundarpichai",
        isVerified: true,
        isPrivate: false,
        stats: { followers: "1M", threads: "300" },
        recentThreads: Array.from({ length: 120 }, (_, index) => ({
          url: `https://www.threads.com/@sundarpichai/post/${index}`,
          text: `Long visible thread ${index} `.repeat(40),
          mediaUrls: [`https://cdn.example.com/thread-${index}.jpg`],
          likeCount: String(500 + index),
        })),
        source: "scraper",
      },
    ];

    const q = buildPersonDossierQuestion(input);
    const linkedin = extractLinkedInPromptJson(q);
    const subject = extractSubjectPromptJson(q);
    const social = extractSocialPromptJson(q);

    expect(q.length).toBeLessThan(40_000);
    expect(linkedin.experience).toEqual(input.linkedinProfile?.experience);
    expect(JSON.stringify(subject)).not.toContain("recentPublicPosts");
    expect(JSON.stringify(subject)).not.toContain("recentThreads");
    expect(JSON.stringify(social)).not.toContain("full-resolution-119");
    expect(social[0].promptBudget).toMatchObject({
      totalVisibleItems: 120,
      omittedVisibleItems: expect.any(Number),
      mediaUrlsOmitted: true,
    });
  });
});

describe("deep batch prompts", () => {
  function deepInput(): OneSubjectInput {
    const input = baseInput([
      { platform: "LinkedIn", handle: "anilsachdev", url: "https://www.linkedin.com/in/anilsachdev", category: "Professional" },
      { platform: "GitHub", handle: "anil", url: "https://github.com/anil", category: "Dev/code" },
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
      verifications: ["WORKPLACE"],
      grantedScopes: ["scraper:linkedin-profile-url"],
      source: "scraper",
      location: "Dubai, United Arab Emirates",
      about: "Strategic operations executive building regulated fund operations.",
      experience: [
        { title: "Chief Operating Officer", company: "OTS Capital", current: true },
        { title: "Head of Fund Operations", company: "VINKEFUND", endDate: "Dec 2023" },
      ],
      education: [{ school: "University of Wales, UK", degree: "MBA, Finance" }],
      skills: ["Financial Markets", "Fund Operations", "Compliance"],
    };
    return input;
  }

  it("carries the full subject context and intelligence protocol into deep batches", () => {
    const q = buildDeepBatchQuestion(deepInput(), "Tier-1 finding: Anil is COO at OTS Capital.", DEEP_BATCHES[0]);
    expect(q).toContain("SUBJECT_INTELLIGENCE_CONTEXT_JSON");
    expect(q).toContain("LINKEDIN_ENRICHED_PROFILE_JSON");
    expect(q).toContain('"profileUrl": "https://www.linkedin.com/in/anilsachdev"');
    expect(q).toContain('"skills": [');
    expect(q).toContain("Fund Operations");
    expect(q).toContain("Tier-1 finding: Anil is COO at OTS Capital.");
    expect(q).toContain("IDENTITY IS ALREADY CONFIRMED");
    expect(q).toContain("do NOT re-investigate");
    expect(q).toContain("FAST-MODE ADAPTIVE SEARCH STRATEGY");
    expect(q).toContain("LinkedIn ground truth");
    expect(q).toContain("public web evidence");
    expect(q).toContain("inference");
    expect(q).not.toContain("linkedinProfileScraper");
    expect(q).not.toContain("li_at");
    expect(q).not.toContain("session.pkl");
  });
});
