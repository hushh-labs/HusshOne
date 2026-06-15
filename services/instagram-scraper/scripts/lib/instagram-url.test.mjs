import assert from "node:assert/strict";
import { test } from "node:test";
import { instagramUsernameFromUrl, normalizeInstagramProfileUrl, usernameToUrl } from "./instagram-url.mjs";

test("normalizes Instagram profile URLs", () => {
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/ankit_ya_i_am/"), "https://www.instagram.com/ankit_ya_i_am/");
  assert.equal(normalizeInstagramProfileUrl("instagram.com/Ankit.Ya.I.Am?hl=en"), "https://www.instagram.com/ankit.ya.i.am/");
  assert.equal(normalizeInstagramProfileUrl("https://m.instagram.com/ankit_ya_i_am/#x"), "https://www.instagram.com/ankit_ya_i_am/");
});

test("rejects non-profile Instagram URLs", () => {
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/p/ABC/"), "");
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/reel/ABC/"), "");
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/stories/ankit/1"), "");
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/explore/"), "");
  assert.equal(normalizeInstagramProfileUrl("https://www.instagram.com/accounts/login/"), "");
  assert.equal(normalizeInstagramProfileUrl("https://example.com/ankit_ya_i_am/"), "");
  assert.equal(normalizeInstagramProfileUrl("ankit_ya_i_am"), "");
});

test("extracts and builds usernames", () => {
  assert.equal(instagramUsernameFromUrl("https://www.instagram.com/ankit_ya_i_am/"), "ankit_ya_i_am");
  assert.equal(usernameToUrl("@ankit_ya_i_am"), "https://www.instagram.com/ankit_ya_i_am/");
});
