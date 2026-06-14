import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLinkedInProfileUrl, profileIdFromUrl, profileIdToUrl } from "./linkedin-url.mjs";

test("normalizes LinkedIn personal profile URLs only", () => {
  assert.equal(normalizeLinkedInProfileUrl("linkedin.com/in/ankit-kumar-886428288"), "https://www.linkedin.com/in/ankit-kumar-886428288/");
  assert.equal(normalizeLinkedInProfileUrl("https://www.linkedin.com/in/someone/?trk=public-profile"), "https://www.linkedin.com/in/someone/");
  assert.equal(normalizeLinkedInProfileUrl("https://www.linkedin.com/company/hushh"), "");
  assert.equal(normalizeLinkedInProfileUrl("https://example.com/in/person"), "");
});

test("extracts and builds profile IDs", () => {
  assert.equal(profileIdFromUrl("https://www.linkedin.com/in/ankit-kumar-886428288/"), "ankit-kumar-886428288");
  assert.equal(profileIdToUrl("ankit-kumar-886428288"), "https://www.linkedin.com/in/ankit-kumar-886428288/");
});
