import { profileIdFromUrl } from "./linkedin-url.mjs";

export function toStaffSpyTemplate(profileUrl, scraperResult) {
  const userProfile = scraperResult?.userProfile || {};
  const experiences = Array.isArray(scraperResult?.experiences) ? scraperResult.experiences : [];
  const education = Array.isArray(scraperResult?.education) ? scraperResult.education : [];
  const skills = Array.isArray(scraperResult?.skills) ? scraperResult.skills : [];

  const current = experiences[0] || {};
  const past = experiences.slice(1).filter((item) => item?.company);
  const row = {
    profile_id: profileIdFromUrl(profileUrl),
    name: userProfile.fullName || null,
    first_name: firstName(userProfile.fullName),
    last_name: lastName(userProfile.fullName),
    location: flattenLocation(userProfile.location),
    position: userProfile.title || current.title || null,
    followers: null,
    connections: null,
    company: current.company || null,
    profile_link: userProfile.url || profileUrl,
    profile_photo: userProfile.photo || null,
    bio: userProfile.description || null,
    is_connection: null,
    premium: null,
    creator: null,
    potential_email: null,
  };

  past.slice(0, 5).forEach((item, index) => {
    row[`past_company${index + 1}`] = item.company || null;
  });
  education.slice(0, 5).forEach((item, index) => {
    row[`school${index + 1}`] = item.schoolName || null;
    row[`degree${index + 1}`] = [item.degreeName, item.fieldOfStudy].filter(Boolean).join(", ") || null;
  });
  skills.slice(0, 20).forEach((item, index) => {
    row[`skill${index + 1}`] = item.skillName || null;
  });

  return row;
}

export function buildDualTemplate(profileUrl, scraperResult) {
  return {
    linkedinProfileScraper: {
      ok: true,
      profileUrl,
      ...scraperResult,
    },
    staffSpyStyle: toStaffSpyTemplate(profileUrl, scraperResult),
  };
}

function firstName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts[0] || null;
}

function lastName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join(" ") : null;
}

function flattenLocation(location) {
  if (!location || typeof location !== "object") return null;
  return [location.city, location.province, location.country].filter(Boolean).join(", ") || null;
}
