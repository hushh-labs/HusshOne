import assert from "node:assert/strict";
import test from "node:test";
import { buildThreadsTemplate } from "./template-response.mjs";

test("builds bounded Threads template payload", () => {
  const template = buildThreadsTemplate("https://www.threads.com/@threads", {
    displayName: "Threads",
    stats: { followers: "6.5M", threads: "1.2K" },
    recentThreads: Array.from({ length: 1030 }, (_, index) => ({ url: `https://www.threads.com/@threads/post/${index}` })),
    visibleProfileText: Array.from({ length: 90 }, (_, index) => `line ${index}`),
    access: { state: "public_visible" },
  });

  assert.equal(template.username, "threads");
  assert.equal(template.displayName, "Threads");
  assert.deepEqual(template.stats, { followers: "6.5M", threads: "1.2K", following: null });
  assert.equal(template.recentThreads.length, 1024);
  assert.equal(template.visibleProfileText.length, 80);
  assert.equal(template.scrapeMeta.accessState, "public_visible");
});
