import assert from "node:assert/strict";
import test from "node:test";
import { normalizeThreadsProfileUrl, threadsUsernameFromUrl, usernameToUrl } from "./threads-url.mjs";

test("normalizes direct Threads profile URLs", () => {
  assert.equal(normalizeThreadsProfileUrl("threads.com/@threads?hl=en"), "https://www.threads.com/@threads");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/@Threads/#x"), "https://www.threads.com/@threads");
  assert.equal(normalizeThreadsProfileUrl("www.threads.net/@hushh.one"), "https://www.threads.com/@hushh.one");
  assert.equal(usernameToUrl("@threads"), "https://www.threads.com/@threads");
  assert.equal(threadsUsernameFromUrl("https://www.threads.com/@threads?hl=en"), "threads");
});

test("rejects non-profile Threads routes", () => {
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/login"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/@threads/post/ABC"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/t/ABC"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/search?q=x"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.instagram.com/threads"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/@bad..name"), "");
  assert.equal(normalizeThreadsProfileUrl("https://www.threads.com/threads"), "");
});
