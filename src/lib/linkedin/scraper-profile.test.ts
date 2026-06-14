import { describe, expect, it } from "vitest";
import {
  LinkedInScraperError,
  mapScraperResponseToLinkedInProfile,
  mapScraperResultToLinkedInProfile,
  type LinkedInScraperResponse,
} from "./scraper-profile";

const anilResponse: LinkedInScraperResponse = {
  ok: true,
  count: 1,
  results: [
    {
      ok: true,
      profileId: "anilsachdev",
      profileUrl: "https://www.linkedin.com/in/anilsachdev/",
      templates: {
        linkedinProfileScraper: {
          userProfile: {
            fullName: "Anil Sachdev",
            title: "· 3rd",
            location: "Dubai, United Arab Emirates",
            photo: "https://media.licdn.com/photo.jpg",
            description: "Strategic operations executive with 18+ years of experience.",
            url: "https://www.linkedin.com/in/anilsachdev/",
          },
          experiences: [
            {
              title: "Chief Operating Officer",
              company: "OTS Capital · Full-time",
              dateRange: "Jan 2024 - Present · 2 yrs 6 mos",
              location: "Dubai, United Arab Emirates · On-site",
            },
            {
              title: "Head of Fund Operations",
              company: "VINKEFUND · Full-time",
              dateRange: "Jun 2022 - Dec 2023 · 1 yr 7 mos",
              location: "Dubai, United Arab Emirates · Remote",
            },
          ],
          education: [
            { schoolName: "University of Wales, UK", degreeName: "MBA, Finance", dateRange: "2004 – 2005" },
            { schoolName: "Indian School Muscat", degreeName: "High School, Commerce", dateRange: "2000 – 2002" },
          ],
          skills: [
            { skillName: "Interpersonal Skills" },
            { skillName: "10 endorsements" },
            { skillName: "Financial Markets" },
          ],
        },
        staffSpyStyle: { full_name: "Anil Sachdev" },
      },
    },
  ],
};

describe("mapScraperResponseToLinkedInProfile", () => {
  it("maps a verified scraper response into LinkedInProfileFull", () => {
    const { profile, raw } = mapScraperResponseToLinkedInProfile(
      anilResponse,
      "https://www.linkedin.com/in/anilsachdev",
      "Anil@Example.com",
    );

    expect(raw.templates?.staffSpyStyle).toEqual({ full_name: "Anil Sachdev" });
    expect(profile).toMatchObject({
      sub: "anilsachdev",
      name: "Anil Sachdev",
      givenName: "Anil",
      familyName: "Sachdev",
      email: "anil@example.com",
      emailVerified: false,
      profileUrl: "https://www.linkedin.com/in/anilsachdev",
      pictureUrl: "https://media.licdn.com/photo.jpg",
      location: "Dubai, United Arab Emirates",
      headline: "Chief Operating Officer at OTS Capital",
      source: "scraper",
    });
    expect(profile.about).toContain("Strategic operations executive");
    expect(profile.experience).toHaveLength(2);
    expect(profile.experience?.[0]).toMatchObject({
      title: "Chief Operating Officer",
      company: "OTS Capital",
      employmentType: "Full-time",
      startDate: "Jan 2024",
      current: true,
    });
    expect(profile.education).toHaveLength(2);
    expect(profile.skills).toEqual(["Interpersonal Skills", "Financial Markets"]);
  });

  it("handles a sparse but successful payload without crashing", () => {
    const profile = mapScraperResultToLinkedInProfile(
      {
        ok: true,
        profileId: "sparse",
        templates: { linkedinProfileScraper: { userProfile: { fullName: "Sparse User", title: "· 3rd" } } },
      },
      null,
    );

    expect(profile.name).toBe("Sparse User");
    expect(profile.headline).toBeNull();
    expect(profile.experience).toEqual([]);
    expect(profile.education).toEqual([]);
    expect(profile.skills).toEqual([]);
  });

  it("turns authwall-style scraper failures into recoverable errors", () => {
    expect(() =>
      mapScraperResponseToLinkedInProfile(
        { ok: false, results: [{ ok: false, type: "LinkedInAuthwall", error: "LinkedIn returned authwall/login" }] },
        "https://www.linkedin.com/in/anilsachdev",
      ),
    ).toThrow(LinkedInScraperError);
  });
});

const kavyaResult = {
  ok: true,
  profileId: "kavya-chauhan-6290bb239",
  profileUrl: "https://www.linkedin.com/in/kavya-chauhan-6290bb239/",
  templates: {
    linkedinProfileScraper: {
      userProfile: {
        fullName: "Kavya Chauhan",
        title: "· 2nd",
        location: "Pune District, Maharashtra, India",
        description:
          "Currently, I work at Oracle, where I contribute to real-world systems and collaborate across teams to deliver high-impact improvements.\nAlways open to learning.\n… more",
        url: "https://www.linkedin.com/in/kavya-chauhan-6290bb239/",
      },
      experiences: [
        {
          title: "Developer",
          company: "Oracle · Full-time",
          dateRange: "Jul 2025 - Present · 1 yr",
          location: "Pune District, Maharashtra, India · On-site",
          description: "Front-End Development and Back-End Web Development",
        },
        {
          title: "Mobile Engineer",
          company: "Mercari, Inc. · Internship",
          dateRange: "Mar 2025 - May 2025 · 3 mos",
          location: "Minato, Tokyo, Japan · On-site",
          description: "Android Development and iOS Development",
        },
        {
          title: "Mentee",
          company: "Codess.Cafe · Apprenticeship",
          dateRange: "Jan 2023 - Apr 2025 · 2 yrs 4 mos",
          description: "LinkedIn helped me get this job\nhelped me get this job",
        },
        {
          title: "Software Engineer",
          company: "hushh.ai · Apprenticeship",
          dateRange: "Dec 2023 - May 2024 · 6 mos",
          location: "Pune District, Maharashtra, India · Remote",
          description: "LinkedIn helped me get this job\nhelped me get this job\nMobile Application Development",
        },
        {
          title: "Event Coordinator",
          company: "Techfest, IIT Bombay · Part-time",
          dateRange: "Oct 2022 - Dec 2022 · 3 mos",
          location: "Mumbai, Maharashtra, India",
          description: "Event Production\nMore profiles for you",
        },
        { title: "Ankit Kumar Singh", company: "· 2nd", description: "Product Engineer hushh | Ex CRED | Ex Google Mentee\nFollow" },
      ],
      education: [
        {
          schoolName: "Army Institute of Technology, Pune",
          degreeName: "Bachelor of Engineering - BE, Information Technology",
          dateRange: "Oct 2021 – Jun 2025",
          grade: "Grade: 9.24",
          description: "More profiles for you\nAnkit Kumar Singh\n· 2nd",
        },
        { schoolName: "· 2nd", dateRange: "Associate @Oracle | Summer of Bitcoin 2024", description: "Connect" },
      ],
      skills: [
        { skillName: "Back-End Web Development" },
        { skillName: "Front-End Development" },
        { skillName: "iOS Development" },
        { skillName: "Android Development" },
        { skillName: "Mobile Application Development" },
        { skillName: "Event Production" },
        { skillName: "More profiles for you" },
        { skillName: "Ankit Kumar Singh" },
        { skillName: "· 2nd" },
      ],
    },
    staffSpyStyle: {
      profile_id: "kavya-chauhan-6290bb239",
      name: "Kavya Chauhan",
      first_name: "Kavya",
      last_name: "Chauhan",
      position: "· 2nd",
      company: "Oracle · Full-time",
      profile_link: "https://www.linkedin.com/in/kavya-chauhan-6290bb239/",
      skill1: "Back-End Web Development",
      skill2: "Front-End Development",
      skill3: "More profiles for you",
      skill4: "Ankit Kumar Singh",
    },
  },
};

describe("Kavya-style connection-degree headline fallback", () => {
  const { profile } = mapScraperResponseToLinkedInProfile(
    { ok: true, count: 1, results: [kavyaResult] },
    "https://www.linkedin.com/in/kavya-chauhan-6290bb239",
    "signed-in@example.com",
  );

  it("does not keep connection degree as a headline, but derives one from the real current role", () => {
    expect(profile.headline).toBe("Developer at Oracle");
  });

  it("keeps richer LinkedIn row details while cutting sidebar recommendations", () => {
    expect(profile.experience).toHaveLength(5);
    expect(profile.experience?.[0]).toMatchObject({
      title: "Developer",
      company: "Oracle",
      employmentType: "Full-time",
      startDate: "Jul 2025",
      current: true,
      description: "Front-End Development and Back-End Web Development",
    });
    expect(profile.experience?.[3]).toMatchObject({
      title: "Software Engineer",
      company: "hushh.ai",
      employmentType: "Apprenticeship",
      description: "Mobile Application Development",
    });
    expect(profile.experience?.map((e) => e.title)).not.toContain("Ankit Kumar Singh");
  });

  it("keeps education grade and real skills without recommended-profile leakage", () => {
    expect(profile.education).toEqual([
      {
        school: "Army Institute of Technology, Pune",
        degree: "Bachelor of Engineering - BE, Information Technology",
        startDate: "Oct 2021",
        endDate: "Jun 2025",
        grade: "Grade: 9.24",
      },
    ]);
    expect(profile.skills).toEqual([
      "Back-End Web Development",
      "Front-End Development",
      "iOS Development",
      "Android Development",
      "Mobile Application Development",
      "Event Production",
    ]);
  });
});

// The real scraper appends LinkedIn's "More profiles for you" rail into experiences/skills/
// education. This must be stripped before it reaches Phase-1, or recommended people become
// fake jobs and UI text becomes skills. Mirrors the exact shape seen in production.
const messyResult = {
  ok: true,
  profileId: "anilsachdev",
  profileUrl: "https://www.linkedin.com/in/anilsachdev/",
  templates: {
    linkedinProfileScraper: {
      userProfile: {
        fullName: "Anil Sachdev",
        title: "· 3rd",
        location: "Dubai, United Arab Emirates",
        description: "Strategic operations executive with 18+ years of experience…",
        url: "https://www.linkedin.com/in/anilsachdev/",
      },
      experiences: [
        { title: "Chief Operating Officer", company: "OTS Capital · Full-time", dateRange: "Jan 2024 - Present · 2 yrs 6 mos" },
        { title: "Head of Fund Operations", company: "VINKEFUND · Full-time", dateRange: "Jun 2022 - Dec 2023 · 1 yr 7 mos" },
        { title: "Manager – Trading & Operations", company: "VGEO (Dubai) · Full-time", dateRange: "Jan 2018 - Feb 2022 · 4 yrs 2 mos" },
        { title: "Manager – Trading & Operations", company: "BlueKite Group · Full-time", dateRange: "Feb 2012 - Dec 2017 · 5 yrs 11 mos" },
        { title: "Trading Operations & Market Analyst", company: "Swissquote · Full-time", dateRange: "Oct 2008 - Sep 2011 · 3 yrs" },
        { title: "Junior Trader", company: "Invictus Trading DMCC · Full-time", dateRange: "Aug 2006 - Mar 2008 · 1 yr 8 mos", description: "More profiles for you" },
        { title: "Ali H. Askar, CQF", company: "· 3rd", description: "Helping Trading Teams Build Production-Grade Research & Execution Systems" },
        { title: "Jamie Morris", company: "· 3rd", description: "Chief Executive Officer & Co Chief Investment Officer @ OTS Capital" },
        { title: "David Watters", company: "· 3rd+", description: "Finance and Investments" },
        { title: "Merijn Verhagen", company: "· 3rd", location: "Operator & Entrepreneur", description: "Message" },
        { title: "Lidya Berhane", company: "· 3rd", description: "Global Talent Acquisition" },
      ],
      education: [
        { schoolName: "University of Wales, UK", degreeName: "MBA, Finance", dateRange: "2004 – 2005" },
        { schoolName: "BA (Hons.), Finance", dateRange: "2002 – 2004", description: "Indian School Muscat" },
        { schoolName: "High School, Commerce", dateRange: "2000 – 2002", description: "Indian School Muscat" },
        { schoolName: "High School, Commerce", dateRange: "2000 – 2002", description: "More profiles for you\nAli H. Askar, CQF\n· 3rd" },
      ],
      skills: [
        { skillName: "Interpersonal Skills" }, { skillName: "Currency" }, { skillName: "10 endorsements" },
        { skillName: "Financial Markets" }, { skillName: "24 endorsements" }, { skillName: "Trading" },
        { skillName: "Commodity" }, { skillName: "Trading Strategies" }, { skillName: "Traders" },
        { skillName: "Foreign Exchange" }, { skillName: "Fundamental Analysis" }, { skillName: "FX trading" },
        { skillName: "FX Options" }, { skillName: "20 endorsements" },
        { skillName: "More profiles for you" }, { skillName: "Ali H. Askar, CQF" }, { skillName: "· 3rd" },
        { skillName: "Helping Trading Teams Build Production-Grade Research" }, { skillName: "Follow" },
        { skillName: "Jamie Morris" }, { skillName: "Message" }, { skillName: "Show more" },
      ],
    },
  },
};

describe("scraper sidebar/junk filtering", () => {
  const { profile } = mapScraperResponseToLinkedInProfile(
    { ok: true, count: 1, results: [messyResult] },
    "https://www.linkedin.com/in/anilsachdev",
    "anil@example.com",
  );

  it("keeps only the 6 real jobs and drops 'More profiles for you' people", () => {
    expect(profile.experience).toHaveLength(6);
    expect(profile.experience?.map((e) => e.company)).toEqual([
      "OTS Capital", "VINKEFUND", "VGEO (Dubai)", "BlueKite Group", "Swissquote", "Invictus Trading DMCC",
    ]);
    expect(profile.experience?.[0]).toMatchObject({ title: "Chief Operating Officer", current: true });
    const titles = (profile.experience ?? []).map((e) => e.title).join(" | ");
    for (const name of ["Ali H. Askar", "Jamie Morris", "David Watters", "Merijn Verhagen", "Lidya Berhane"]) {
      expect(titles).not.toContain(name);
    }
  });

  it("keeps only real skills (no endorsements, button text, sidebar people, or sentinel)", () => {
    expect(profile.skills).toEqual([
      "Interpersonal Skills", "Currency", "Financial Markets", "Trading", "Commodity",
      "Trading Strategies", "Traders", "Foreign Exchange", "Fundamental Analysis", "FX trading", "FX Options",
    ]);
    for (const junk of ["More profiles for you", "Message", "Follow", "Show more", "· 3rd", "Jamie Morris", "Ali H. Askar, CQF"]) {
      expect(profile.skills).not.toContain(junk);
    }
    expect(profile.skills?.some((s) => /endorsement/i.test(s))).toBe(false);
  });

  it("de-dupes education down to the 3 real schools", () => {
    expect(profile.education).toHaveLength(3);
    expect(profile.education?.map((e) => e.school)).toEqual([
      "University of Wales, UK", "BA (Hons.), Finance", "High School, Commerce",
    ]);
  });

  it("captures the rich about + location signals", () => {
    expect(profile.about).toContain("Strategic operations executive");
    expect(profile.location).toBe("Dubai, United Arab Emirates");
  });
});
