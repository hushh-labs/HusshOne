import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractThreadsProfileFromDom } from "./live-browser-scraper.mjs";

function withDom(url, html, text) {
  const dom = new JSDOM(html, { url });
  Object.defineProperty(dom.window.document.body, "innerText", {
    configurable: true,
    value: text,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "location", { configurable: true, value: dom.window.location });
  return dom;
}

test("extracts a public Threads profile and visible timeline posts", () => {
  const dom = withDom(
    "https://www.threads.com/@threads?hl=en",
    `<!doctype html>
    <html>
      <head>
        <title>Threads (@threads) • Threads, Say more</title>
        <meta property="og:title" content="Threads (@threads) • Threads, Say more" />
        <meta property="og:description" content="6.5M Followers • 1.2K Threads • Say more with Threads." />
        <meta property="og:image" content="https://cdn.example.com/avatar.jpg" />
      </head>
      <body>
        <main>
          <header>
            <a href="https://about.example.com/?utm_source=threads">about.example.com</a>
            <svg aria-label="Verified"></svg>
          </header>
          <article>
            <a href="/@threads/post/Cabc123">
              <time datetime="2026-06-15T10:00:00.000Z"></time>
              <span>Shipping visible public context.</span>
              <span>126 likes</span>
              <span>3 replies</span>
              <span>2 reposts</span>
              <img src="https://cdn.example.com/post.jpg" srcset="https://cdn.example.com/post-small.jpg 320w, https://cdn.example.com/post-large.jpg 1080w" alt="Launch demo" />
            </a>
            <a href="https://example.com/article?ref=threads">article</a>
          </article>
        </main>
      </body>
    </html>`,
    [
      "Threads",
      "@threads",
      "Say more with Threads.",
      "Shipping visible public context.",
      "126 likes",
      "3 replies",
      "2 reposts",
      "About Help Privacy Terms",
    ].join("\n"),
  );

  const profile = extractThreadsProfileFromDom();
  assert.equal(profile.username, "threads");
  assert.equal(profile.profileUrl, "https://www.threads.com/@threads");
  assert.equal(profile.displayName, "Threads");
  assert.equal(profile.bio, "Say more with Threads.");
  assert.equal(profile.avatarUrl, "https://cdn.example.com/avatar.jpg");
  assert.equal(profile.externalUrl, "https://about.example.com");
  assert.equal(profile.isVerified, true);
  assert.equal(profile.isPrivate, false);
  assert.deepEqual(profile.stats, { followers: "6.5M", threads: "1.2K", following: null });
  assert.equal(profile.recentThreads.length, 1);
  assert.equal(profile.recentThreads[0].url, "https://www.threads.com/@threads/post/Cabc123");
  assert.equal(profile.recentThreads[0].position, 1);
  assert.equal(profile.recentThreads[0].timestamp, "2026-06-15T10:00:00.000Z");
  assert.equal(profile.recentThreads[0].likeCount, "126");
  assert.equal(profile.recentThreads[0].replyCount, "3");
  assert.equal(profile.recentThreads[0].repostCount, "2");
  assert.equal(profile.recentThreads[0].contentSeed.includes("Shipping visible public context."), true);
  assert.equal(profile.recentThreads[0].feedPhotoUrl, "https://cdn.example.com/post.jpg");
  assert.deepEqual(profile.recentThreads[0].mediaUrls, [
    "https://cdn.example.com/post.jpg",
    "https://cdn.example.com/post-small.jpg",
    "https://cdn.example.com/post-large.jpg",
  ]);
  assert.deepEqual(profile.recentThreads[0].externalLinks, ["https://example.com/article"]);
  assert.equal(profile.access.state, "public_visible");
  assert.equal(profile.access.canScrapePosts, true);
  assert.equal(profile.scrapeMeta.authwall, false);
  assert.equal(profile.scrapeMeta.targetPostCount, 1024);
  assert.equal(profile.scrapeMeta.extractedThreadCount, 1);
  assert.equal(profile.scrapeMeta.postsWithText, 1);
  assert.equal(profile.scrapeMeta.postsWithMedia, 1);
  assert.equal(profile.scrapeMeta.postsWithExternalLinks, 1);
  assert.equal(profile.scrapeMeta.postsWithVisibleCounters, 1);
  dom.window.close();
});

test("marks private profiles without scraping hidden posts", () => {
  const dom = withDom(
    "https://www.threads.com/@private_user",
    `<!doctype html><html><head><title>Private User (@private_user)</title></head><body><main><button>Follow</button></main></body></html>`,
    [
      "Private User",
      "@private_user",
      "This profile is private",
      "Only approved followers can see private_user's threads.",
      "About Help Privacy Terms",
    ].join("\n"),
  );

  const profile = extractThreadsProfileFromDom();
  assert.equal(profile.username, "private_user");
  assert.equal(profile.isPrivate, true);
  assert.equal(profile.access.state, "private_not_following");
  assert.equal(profile.access.canRequest, true);
  assert.equal(profile.access.outgoingRequest, false);
  assert.deepEqual(profile.recentThreads, []);
  dom.window.close();
});

test("marks an existing request as pending approval", () => {
  const dom = withDom(
    "https://www.threads.com/@private_user",
    `<!doctype html><html><head><title>Private User (@private_user)</title></head><body><main><button>Requested</button></main></body></html>`,
    ["Private User", "@private_user", "This profile is private", "Requested"].join("\n"),
  );

  const profile = extractThreadsProfileFromDom();
  assert.equal(profile.access.state, "pending_approval");
  assert.equal(profile.access.outgoingRequest, true);
  assert.equal(profile.access.canRequest, false);
  dom.window.close();
});

test("detects login walls and checkpoints", () => {
  const loginDom = withDom(
    "https://www.threads.com/login",
    `<!doctype html><html><head><title>Log in • Threads</title></head><body><main></main></body></html>`,
    "Log in to Threads",
  );
  const loginProfile = extractThreadsProfileFromDom();
  assert.equal(loginProfile.scrapeMeta.authwall, true);
  assert.equal(loginProfile.access.state, "login_required");
  loginDom.window.close();

  const checkpointDom = withDom(
    "https://www.threads.com/challenge",
    `<!doctype html><html><head><title>Checkpoint • Threads</title></head><body><main></main></body></html>`,
    "Help us confirm it's you before continuing.",
  );
  const checkpointProfile = extractThreadsProfileFromDom();
  assert.equal(checkpointProfile.access.state, "checkpoint_required");
  checkpointDom.window.close();
});

test("detects missing and rate-limited profiles", () => {
  const missingDom = withDom(
    "https://www.threads.com/@missing_user",
    `<!doctype html><html><head><title>Page Not Found • Threads</title></head><body><main></main></body></html>`,
    "This page isn't available.",
  );
  const missing = extractThreadsProfileFromDom();
  assert.equal(missing.scrapeMeta.notFound, true);
  assert.equal(missing.access.state, "not_found");
  missingDom.window.close();

  const limitedDom = withDom(
    "https://www.threads.com/@threads",
    `<!doctype html><html><head><title>Threads (@threads)</title></head><body><main></main></body></html>`,
    "Try again later. We limit how often you can do certain things.",
  );
  const limited = extractThreadsProfileFromDom();
  assert.equal(limited.access.state, "rate_limited");
  limitedDom.window.close();
});
