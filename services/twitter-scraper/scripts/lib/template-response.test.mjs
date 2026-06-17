import assert from "node:assert/strict";
import test from "node:test";
import { buildTwitterTemplate } from "./template-response.mjs";

test("builds bounded Twitter/X template payload", () => {
  const template = buildTwitterTemplate("https://x.com/sundarpichai", {
    displayName: "Sundar Pichai",
    location: "Mountain View, CA",
    joinedDate: "March 2008",
    stats: { followers: "5.4M", following: "329", posts: "2,412" },
    timelineItems: Array.from({ length: 1100 }, (_, index) => ({ url: `https://x.com/sundarpichai/status/${100000 + index}` })),
    visibleProfileText: Array.from({ length: 140 }, (_, index) => `line ${index}`),
    access: { state: "public_visible" },
  });

  assert.equal(template.username, "sundarpichai");
  assert.equal(template.profileUrl, "https://x.com/sundarpichai");
  assert.equal(template.displayName, "Sundar Pichai");
  assert.equal(template.location, "Mountain View, CA");
  assert.equal(template.joinedDate, "March 2008");
  assert.deepEqual(template.stats, { followers: "5.4M", following: "329", posts: "2,412" });
  assert.equal(template.timelineItems.length, 1024);
  assert.equal(template.recentPosts.length, 1024);
  assert.equal(template.visibleProfileText.length, 120);
  assert.equal(template.scrapeMeta.accessState, "public_visible");
});
