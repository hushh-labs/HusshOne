import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDualTemplate } from "./template-response.mjs";

test("builds the raw templates One expects", () => {
  const profileUrl = "https://www.linkedin.com/in/example/";
  const raw = {
    userProfile: {
      fullName: "Example User",
      title: "Founder",
      location: { city: "San Francisco", country: "United States" },
      url: profileUrl,
      photo: "https://media.licdn.com/example.jpg",
      description: "Building useful things.",
    },
    experiences: [{ title: "Founder", company: "Example AI" }],
    education: [{ schoolName: "Example University", degreeName: "BS" }],
    skills: [{ skillName: "Product" }],
  };

  const templates = buildDualTemplate(profileUrl, raw);

  assert.equal(templates.linkedinProfileScraper.profileUrl, profileUrl);
  assert.equal(templates.linkedinProfileScraper.userProfile.fullName, "Example User");
  assert.equal(templates.staffSpyStyle.profile_id, "example");
  assert.equal(templates.staffSpyStyle.company, "Example AI");
  assert.equal(templates.staffSpyStyle.school1, "Example University");
  assert.equal(templates.staffSpyStyle.skill1, "Product");
});
