import puppeteer from "puppeteer";

const defaultBrowserUrl = process.env.LINKEDIN_BROWSER_URL || "http://127.0.0.1:9222";

export async function scrapeWithLiveBrowser(profileUrl) {
  const browser = await puppeteer.connect({
    browserURL: defaultBrowserUrl,
    defaultViewport: null,
  });
  let page;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1365, height: 768 });
    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: Number(process.env.LINKEDIN_PROFILE_SCRAPER_TIMEOUT_MS || 120_000) });
    await page.waitFor(4000);
    await autoScroll(page);
    await page.waitFor(2000);
    const profile = await page.evaluate(extractProfileFromDom);
    if (profile?.scrapeMeta?.authwall) return profile;

    const baseUrl = profileUrl.replace(/\/+$/, "");
    profile.experiences = await scrapeDetailsPage(page, `${baseUrl}/details/experience/`, "experience");
    profile.education = await scrapeDetailsPage(page, `${baseUrl}/details/education/`, "education");
    profile.skills = await scrapeDetailsPage(page, `${baseUrl}/details/skills/`, "skills");
    profile.scrapeMeta = {
      ...profile.scrapeMeta,
      detailPages: {
        experience: `${baseUrl}/details/experience/`,
        education: `${baseUrl}/details/education/`,
        skills: `${baseUrl}/details/skills/`,
      },
    };
    return profile;
  } finally {
    if (page) await page.close().catch(() => undefined);
    await browser.disconnect();
  }
}

async function scrapeDetailsPage(page, url, kind) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: Number(process.env.LINKEDIN_PROFILE_SCRAPER_TIMEOUT_MS || 120_000) });
  await page.waitFor(3500);
  await autoScroll(page);
  await page.waitFor(1000);
  return await page.evaluate(extractDetailsFromDom, kind);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let previousHeight = 0;
    let stablePasses = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      for (let y = window.scrollY; y < height; y += Math.max(500, Math.floor(window.innerHeight * 0.75))) {
        window.scrollTo(0, y);
        await delay(300);
      }
      window.scrollTo(0, height);
      await delay(800);
      const nextHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      stablePasses = nextHeight === previousHeight ? stablePasses + 1 : 0;
      previousHeight = nextHeight;
      if (stablePasses >= 2) break;
    }
    window.scrollTo(0, 0);
  });
}

function extractProfileFromDom() {
  const text = document.body.innerText || "";
  const url = location.href;
  if (url.includes("/authwall") || url.includes("/login") || /\bJoin LinkedIn\b/i.test(text)) {
    return {
      userProfile: {
        fullName: null,
        title: null,
        location: null,
        photo: null,
        description: null,
        url,
      },
      experiences: [],
      education: [],
      volunteerExperiences: [],
      skills: [],
      scrapeMeta: { parser: "live-browser-dom", authwall: true },
    };
  }

  const main = document.querySelector("main") || document.body;
  const allLines = lines(main.innerText);
  const topSection = document.querySelector("main section") || main;
  const topLines = lines(topSection.innerText);
  const fullName = firstText([
    "main h1",
    "h1",
    ".pv-text-details__left-panel h1",
  ]) || topLines.find((line) => !isTopCardChrome(line) && !isPronoun(line)) || null;

  const title = firstNonMatching(topLines, [
    fullName,
    /^he\/him$|^she\/her$|^they\/them$/i,
    /^View .* profile$/i,
    /^open profile verification/i,
    /^premium/i,
    /^follow$/i,
    /^message$/i,
    /^connect$/i,
  ]);

  const profileLocation = firstText([".text-body-small.inline.t-black--light.break-words"]) ||
    topLines.find((line) => isLikelyLocation(line)) ||
    null;

  const photo =
    document.querySelector("img.pv-top-card-profile-picture__image--show")?.src ||
    document.querySelector("img.profile-photo-edit__preview")?.src ||
    document.querySelector("main img")?.src ||
    null;

  const about = sectionLines("About").filter((line) => !/^About$/i.test(line)).join("\n") || null;

  return {
    userProfile: {
      fullName,
      title,
      location: profileLocation,
      photo,
      description: about,
      url: stripQuery(url),
    },
    experiences: parseSection("Experience", parseExperienceItem),
    education: parseSection("Education", parseEducationItem),
    volunteerExperiences: parseSection("Volunteering", parseExperienceItem),
    skills: parseSkills(),
    scrapeMeta: {
      parser: "live-browser-dom",
      title: document.title,
      url: stripQuery(url),
      lineCount: allLines.length,
    },
  };

  function firstText(selectors) {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.innerText?.trim();
      if (value) return value;
    }
    return null;
  }

  function sectionLines(name) {
    const heading = [...main.querySelectorAll("h2, h3, span, div")]
      .find((element) => normalize(element.innerText) === normalize(name));
    const section = heading?.closest("section");
    const fromSection = lines(section?.innerText || "");
    if (fromSection.length) return fromSection;

    const start = allLines.findIndex((line) => normalize(line) === normalize(name));
    if (start < 0) return [];
    const headings = [
      "About",
      "Activity",
      "Experience",
      "Education",
      "Volunteering",
      "Licenses & certifications",
      "Skills",
      "Projects",
      "Recommendations",
      "Interests",
      "Profile language",
      "Public profile & URL",
      "Who your viewers also viewed",
      "People you may know",
      "You might like",
    ].map(normalize);
    let end = allLines.length;
    for (let index = start + 1; index < allLines.length; index += 1) {
      if (headings.includes(normalize(allLines[index]))) {
        end = index;
        break;
      }
    }
    return allLines.slice(start, end);
  }

  function parseSection(name, mapper) {
    const raw = sectionLines(name).filter((line) => !isSectionChrome(line, name));
    const items = splitItems(raw).map(mapper).filter(Boolean);
    return items;
  }

  function parseExperienceItem(item) {
    const clean = item.filter(Boolean);
    if (!clean.length) return null;
    return {
      title: clean[0] || null,
      company: clean[1] || null,
      dateRange: clean.find((line) => /\d{4}|Present|mos|yrs/i.test(line)) || null,
      location: clean.find((line) => /,/.test(line) && !/\d{4}|Present|mos|yrs/i.test(line)) || null,
      description: clean.slice(2).join("\n") || null,
    };
  }

  function parseEducationItem(item) {
    const clean = item.filter(Boolean);
    if (!clean.length) return null;
    return {
      schoolName: clean[0] || null,
      degreeName: clean[1] || null,
      fieldOfStudy: null,
      dateRange: clean.find((line) => /\d{4}|Present/i.test(line)) || null,
    };
  }

  function parseSkills() {
    return sectionLines("Skills")
      .filter((line) => !isSectionChrome(line, "Skills"))
      .filter((line) => !/endorsement|Show all|profile/i.test(line))
      .slice(0, 50)
      .map((skillName) => ({ skillName }));
  }

  function splitItems(rawLines) {
    const items = [];
    let current = [];
    for (const line of rawLines) {
      if (/^\d+\s+/.test(line) && current.length) {
        items.push(current);
        current = [line.replace(/^\d+\s+/, "")];
      } else if (/^(Company Name|School)$/i.test(line) && current.length) {
        items.push(current);
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length) items.push(current);
    return items.length ? items : rawLines.length ? [rawLines] : [];
  }

  function isSectionChrome(line, name) {
    return normalize(line) === normalize(name) ||
      /^Show all/i.test(line) ||
      /^See more/i.test(line) ||
      /^See less/i.test(line) ||
      /^Loading/i.test(line) ||
      /^Add/i.test(line) ||
      /^Edit/i.test(line);
  }

  function firstNonMatching(values, blocked) {
    return values.find((line) => line && !blocked.some((rule) => {
      if (!rule) return false;
      return rule instanceof RegExp ? rule.test(line) : normalize(rule) === normalize(line);
    }) && !isTopCardChrome(line) && !isLikelyLocation(line)) || null;
  }

  function isPronoun(line) {
    return /^(he\/him|she\/her|they\/them|he\/they|she\/they)$/i.test(line);
  }

  function isLikelyLocation(line) {
    return /,\s*[A-Za-z ]+$/.test(line) && !/connection|follower|sharechat|institute|university|college/i.test(line);
  }

  function isTopCardChrome(line) {
    return /^·$/.test(line) ||
      /^Contact info$/i.test(line) ||
      /^Open to$/i.test(line) ||
      /^Add section$/i.test(line) ||
      /^Enhance profile$/i.test(line) ||
      /^Open to work$/i.test(line) ||
      /^Show details$/i.test(line) ||
      /^Get started$/i.test(line) ||
      /^Add services$/i.test(line) ||
      /^Suggested for you$/i.test(line) ||
      /^Private to you$/i.test(line) ||
      /^Analytics$/i.test(line) ||
      /^Show all$/i.test(line) ||
      /connections$/i.test(line);
  }

  function lines(value) {
    return String(value || "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function stripQuery(value) {
    try {
      const parsed = new URL(value);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return value;
    }
  }
}

function extractDetailsFromDom(kind) {
  const heading = kind === "experience" ? "Experience" : kind === "education" ? "Education" : "Skills";
  const rows = detailRows(heading);
  if (kind === "experience") return parseExperience(rows);
  if (kind === "education") return parseEducation(rows);
  return parseSkills(rows);

  function parseExperience(values) {
    const items = [];
    for (let index = 0; index < values.length;) {
      const title = values[index++];
      if (!title) continue;
      const company = values[index] && /·/.test(values[index]) ? values[index++] : null;
      const dateRange = values[index] && /\d{4}|Present|mos|yrs/i.test(values[index]) ? values[index++] : null;
      const itemLocation = values[index] && /,|Remote|Hybrid|On-site/i.test(values[index]) ? values[index++] : null;
      const details = [];
      while (index < values.length && !(values[index + 1] && /·/.test(values[index + 1]))) {
        details.push(values[index++]);
      }
      items.push({
        title,
        company,
        dateRange,
        location: itemLocation,
        description: details.join("\n") || null,
      });
    }
    return items;
  }

  function parseEducation(values) {
    const items = [];
    for (let index = 0; index < values.length;) {
      const schoolName = values[index++];
      if (!schoolName) continue;
      const degreeName = values[index] && !/\d{4}|Grade:/i.test(values[index]) ? values[index++] : null;
      const dateRange = values[index] && /\d{4}|Present/i.test(values[index]) ? values[index++] : null;
      const grade = values[index] && /^Grade:/i.test(values[index]) ? values[index++] : null;
      const details = [];
      while (index < values.length && !/^Grade:/i.test(values[index]) && !(values[index + 1] && /\d{4}|Present/i.test(values[index + 1]))) {
        details.push(values[index++]);
      }
      items.push({
        schoolName,
        degreeName,
        fieldOfStudy: null,
        dateRange,
        grade,
        description: details.join("\n") || null,
      });
    }
    return items;
  }

  function parseSkills(values) {
    return values
      .filter((line) => !/^(All|Industry Knowledge|Tools & Technologies)$/i.test(line))
      .filter((line) => !/\bat\b.+/i.test(line))
      .slice(0, 100)
      .map((skillName) => ({ skillName }));
  }

  function detailRows(name) {
    const main = document.querySelector("main") || document.body;
    const lines = String(main.innerText || "")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const start = lines.findIndex((line) => normalizeDetail(line) === normalizeDetail(name));
    if (start < 0) return [];
    const stopHeadings = [
      "Profile language",
      "Who your viewers also viewed",
      "People you may know",
      "You might like",
      "About",
      "Accessibility",
    ].map(normalizeDetail);
    const values = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      if (stopHeadings.includes(normalizeDetail(lines[index]))) break;
      values.push(lines[index]);
    }
    return values.filter((line) => !/^Show all|^See more|^See less|^Edit|^Add/i.test(line));
  }

  function normalizeDetail(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }
}
