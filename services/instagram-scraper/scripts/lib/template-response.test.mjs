import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInstagramTemplate } from "./template-response.mjs";

test("builds the Instagram template One expects", () => {
  const profileUrl = "https://www.instagram.com/ankit_ya_i_am/";
  const template = buildInstagramTemplate(profileUrl, {
    username: "ankit_ya_i_am",
    displayName: "Ankit Kumar Singh",
    bio: "Building One.",
    avatarUrl: "https://cdn.example/avatar.jpg",
    externalUrl: "https://hushh.ai",
    isVerified: false,
    isPrivate: false,
    stats: { posts: "12", followers: "1,234", following: "321" },
    highlights: [{ title: "Bengaluru", thumbnailUrl: "https://cdn.example/highlight.jpg" }],
    recentPublicPosts: [{ url: "https://www.instagram.com/p/abc/", caption: "Demo", position: 1, isCarousel: true }],
    access: { state: "public_visible", canScrapePosts: true },
    visibleProfileText: ["Builder at Hushh"],
  });

  assert.equal(template.username, "ankit_ya_i_am");
  assert.equal(template.profileUrl, profileUrl);
  assert.equal(template.displayName, "Ankit Kumar Singh");
  assert.equal(template.stats.followers, "1,234");
  assert.equal(template.highlights[0].title, "Bengaluru");
  assert.equal(template.recentPublicPosts.length, 1);
  assert.equal(template.recentPublicPosts[0].isCarousel, true);
  assert.deepEqual(template.access, { state: "public_visible", canScrapePosts: true });
  assert.equal(template.scrapeMeta.accessState, "public_visible");
  assert.deepEqual(template.visibleProfileText, ["Builder at Hushh"]);
});
