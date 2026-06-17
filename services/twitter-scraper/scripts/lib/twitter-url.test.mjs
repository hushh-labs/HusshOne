import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTwitterProfileUrl, twitterUsernameFromUrl, usernameToUrl } from "./twitter-url.mjs";

test("normalizes direct Twitter/X profile URLs", () => {
  assert.equal(normalizeTwitterProfileUrl("x.com/sundarpichai"), "https://x.com/sundarpichai");
  assert.equal(normalizeTwitterProfileUrl("https://twitter.com/SundarPichai?lang=en"), "https://x.com/sundarpichai");
  assert.equal(normalizeTwitterProfileUrl("www.x.com/@Hushh_AI/#profile"), "https://x.com/hushh_ai");
  assert.equal(usernameToUrl("@sundarpichai"), "https://x.com/sundarpichai");
  assert.equal(twitterUsernameFromUrl("https://twitter.com/sundarpichai?lang=en"), "sundarpichai");
});

test("rejects non-profile Twitter/X routes", () => {
  assert.equal(normalizeTwitterProfileUrl("https://x.com/login"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/i/flow/login"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/sundarpichai/status/1800000000000000000"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/search?q=hushh"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/messages"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/notifications"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/settings/account"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/compose/post"), "");
  assert.equal(normalizeTwitterProfileUrl("https://twitter.com/intent/tweet"), "");
  assert.equal(normalizeTwitterProfileUrl("https://instagram.com/sundarpichai"), "");
  assert.equal(normalizeTwitterProfileUrl("https://x.com/handle-too-long-123456"), "");
});
