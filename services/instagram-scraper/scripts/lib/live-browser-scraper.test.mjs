import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractInstagramProfileFromDom } from "./live-browser-scraper.mjs";

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

test("extracts a public Instagram profile from DOM fixtures", () => {
  const dom = withDom(
    "https://www.instagram.com/ankit_ya_i_am/",
    `<!doctype html>
    <html>
      <head>
        <title>Ankit Kumar Singh (@ankit_ya_i_am) • Instagram photos and videos</title>
        <meta property="og:title" content="Ankit Kumar Singh (@ankit_ya_i_am) • Instagram photos and videos" />
        <meta property="og:description" content="1,234 Followers, 567 Following, 42 Posts - Builder at Hushh" />
        <meta property="og:image" content="https://cdn.example.com/avatar.jpg" />
      </head>
      <body>
        <main>
          <header>
            <a href="https://ankit.example.com/?utm_source=ig">ankit.example.com</a>
            <svg aria-label="Verified"></svg>
          </header>
          <div role="button"><img src="https://cdn.example.com/bengaluru.jpg" alt="Bengaluru" /><span>Bengaluru</span></div>
          <a href="/ankit_ya_i_am/p/ABC123/" aria-label="126 likes, 3 comments">
            <svg aria-label="Carousel"></svg>
            <img src="https://cdn.example.com/post.jpg" srcset="https://cdn.example.com/post-small.jpg 320w, https://cdn.example.com/post-large.jpg 1080w" alt="Launch demo" />
            <time datetime="2026-06-15T10:00:00.000Z"></time>
          </a>
          <a href="/reel/XYZ789/"><img src="https://cdn.example.com/reel.jpg" alt="Reel demo" /></a>
        </main>
      </body>
    </html>`,
    [
      "Ankit Kumar Singh",
      "@ankit_ya_i_am",
      "Builder at Hushh Instagram Lite Meta AI Contact uploading and non-users English (UK)",
      "42 posts",
      "1,234 followers",
      "567 following",
    ].join("\n"),
  );

  const profile = extractInstagramProfileFromDom();
  assert.equal(profile.username, "ankit_ya_i_am");
  assert.equal(profile.profileUrl, "https://www.instagram.com/ankit_ya_i_am/");
  assert.equal(profile.displayName, "Ankit Kumar Singh");
  assert.equal(profile.bio, "Builder at Hushh");
  assert.equal(profile.avatarUrl, "https://cdn.example.com/avatar.jpg");
  assert.equal(profile.externalUrl, "https://ankit.example.com/");
  assert.equal(profile.isVerified, true);
  assert.equal(profile.isPrivate, false);
  assert.deepEqual(profile.stats, { followers: "1,234", following: "567", posts: "42" });
  assert.equal(profile.highlights.length, 1);
  assert.equal(profile.highlights[0].title, "Bengaluru");
  assert.equal(profile.recentPublicPosts.length, 2);
  assert.equal(profile.recentPublicPosts[0].kind, "post");
  assert.equal(profile.recentPublicPosts[0].url, "https://www.instagram.com/p/ABC123");
  assert.equal(profile.recentPublicPosts[0].position, 1);
  assert.equal(profile.recentPublicPosts[0].isCarousel, true);
  assert.equal(profile.recentPublicPosts[0].thumbnailUrl, "https://cdn.example.com/post.jpg");
  assert.deepEqual(profile.recentPublicPosts[0].cdnUrls, [
    "https://cdn.example.com/post.jpg",
    "https://cdn.example.com/post-small.jpg",
    "https://cdn.example.com/post-large.jpg",
  ]);
  assert.equal(profile.recentPublicPosts[0].timestamp, "2026-06-15T10:00:00.000Z");
  assert.equal(profile.recentPublicPosts[0].likes, "126");
  assert.equal(profile.recentPublicPosts[0].comments, "3");
  assert.equal(profile.recentPublicPosts[1].kind, "reel");
  assert.equal(profile.recentPublicPosts[1].isVideo, true);
  assert.equal(profile.access.state, "public_visible");
  assert.equal(profile.access.canScrapePosts, true);
  assert.ok(profile.visibleProfileText.includes("Builder at Hushh"));
  assert.equal(profile.visibleProfileText.some((line) => /Instagram Lite/.test(line)), false);
  assert.equal(profile.scrapeMeta.authwall, false);
  dom.window.close();
});

test("marks private profiles without scraping private posts", () => {
  const dom = withDom(
    "https://www.instagram.com/private_user/",
    `<!doctype html><html><head><title>Private User (@private_user)</title></head><body><main><button>Follow</button></main></body></html>`,
    [
      "Private User",
      "@private_user",
      "This profile is private",
      "Already follow private_user? Log in to see their photos and videos.",
      "Instagram Lite Meta AI Contact uploading and non-users",
    ].join("\n"),
  );

  const profile = extractInstagramProfileFromDom();
  assert.equal(profile.username, "private_user");
  assert.equal(profile.isPrivate, true);
  assert.equal(profile.access.state, "private_not_following");
  assert.equal(profile.access.canRequest, true);
  assert.equal(profile.access.outgoingRequest, false);
  assert.equal(profile.bio, null);
  assert.deepEqual(profile.recentPublicPosts, []);
  dom.window.close();
});

test("marks private profiles with existing follow request as pending", () => {
  const dom = withDom(
    "https://www.instagram.com/private_user/",
    `<!doctype html><html><head><title>Private User (@private_user)</title></head><body><main><button>Requested</button></main></body></html>`,
    [
      "Private User",
      "@private_user",
      "This profile is private",
      "Requested",
      "Instagram Lite Meta AI Contact uploading and non-users",
    ].join("\n"),
  );

  const profile = extractInstagramProfileFromDom();
  assert.equal(profile.username, "private_user");
  assert.equal(profile.isPrivate, true);
  assert.equal(profile.access.state, "pending_approval");
  assert.equal(profile.access.outgoingRequest, true);
  assert.equal(profile.access.canRequest, false);
  dom.window.close();
});

test("detects login walls and checkpoints as authwall states", () => {
  const dom = withDom(
    "https://www.instagram.com/accounts/login/",
    `<!doctype html><html><head><title>Login • Instagram</title></head><body><main></main></body></html>`,
    "Log in to Instagram",
  );

  const profile = extractInstagramProfileFromDom();
  assert.equal(profile.username, "");
  assert.equal(profile.scrapeMeta.authwall, true);
  assert.equal(profile.access.state, "login_required");
  dom.window.close();
});

test("detects Chrome HTTP 429 pages as rate-limited instead of public-visible", () => {
  const dom = withDom(
    "https://www.instagram.com/sundarpichai/",
    `<!doctype html><html><head><title>www.instagram.com</title></head><body><main></main></body></html>`,
    ["This page isn't working", "If the problem continues, contact the site owner.", "HTTP ERROR 429", "Reload"].join("\n"),
  );

  const profile = extractInstagramProfileFromDom({ maxPosts: 120 });
  assert.equal(profile.username, "sundarpichai");
  assert.equal(profile.access.state, "rate_limited");
  assert.equal(profile.access.canScrapePosts, false);
  assert.equal(profile.access.reason, "Instagram asked the VM browser session to slow down.");
  assert.equal(profile.access.evidenceText, "HTTP ERROR 429");
  assert.equal(profile.scrapeMeta.chromeError, true);
  assert.equal(profile.scrapeMeta.httpErrorCode, "429");
  assert.equal(profile.scrapeMeta.rateLimited, true);
  assert.deepEqual(profile.recentPublicPosts, []);
  dom.window.close();
});

test("detects sparse or blocked not-found pages", () => {
  const dom = withDom(
    "https://www.instagram.com/missing_user/",
    `<!doctype html><html><head><title>Page Not Found • Instagram</title></head><body><main></main></body></html>`,
    "Sorry, this page isn't available.",
  );

  const profile = extractInstagramProfileFromDom();
  assert.equal(profile.username, "missing_user");
  assert.equal(profile.scrapeMeta.notFound, true);
  assert.equal(profile.access.state, "not_found");
  assert.equal(profile.bio, "Sorry, this page isn't available.");
  dom.window.close();
});
