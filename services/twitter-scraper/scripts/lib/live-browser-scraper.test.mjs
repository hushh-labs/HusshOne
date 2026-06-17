import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { extractTwitterProfileFromDom, mergeTwitterTimelineItems } from "./live-browser-scraper.mjs";

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

test("extracts a public Twitter/X profile and visible posts", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html>
    <html>
      <head>
        <title>Sundar Pichai (@sundarpichai) / X</title>
        <meta property="og:title" content="Sundar Pichai (@sundarpichai) / X" />
        <meta property="og:description" content="5.4M Followers • 329 Following • 2,412 Posts • CEO of Google and Alphabet." />
        <meta property="og:image" content="https://pbs.twimg.com/profile_images/avatar.jpg" />
      </head>
      <body>
        <main>
          <header>
            <a href="https://abc.xyz/?utm_source=x">abc.xyz</a>
            <svg aria-label="Verified account"></svg>
          </header>
          <article data-testid="tweet">
            <a href="/sundarpichai/status/1800000000000000000">
              <time datetime="2026-06-15T10:00:00.000Z"></time>
            </a>
            <div data-testid="tweetText">Building helpful AI for everyone.</div>
            <span>12 replies</span>
            <span>34 reposts</span>
            <span>56 likes</span>
            <span>7.8K views</span>
            <img src="https://pbs.twimg.com/media/GQabc123?format=jpg&name=small" srcset="https://pbs.twimg.com/media/GQabc123?format=jpg&name=large 1080w" alt="Demo" />
            <a href="https://blog.google/technology/ai/?utm_source=x">blog</a>
          </article>
        </main>
      </body>
    </html>`,
    [
      "Sundar Pichai",
      "@sundarpichai",
      "CEO of Google and Alphabet.",
      "Mountain View, CA",
      "Joined March 2008",
      "5.4M Followers",
      "329 Following",
      "2,412 Posts",
      "Building helpful AI for everyone.",
      "12 replies",
      "34 reposts",
      "56 likes",
      "7.8K views",
    ].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 1024, tab: "posts" });
  assert.equal(profile.username, "sundarpichai");
  assert.equal(profile.profileUrl, "https://x.com/sundarpichai");
  assert.equal(profile.displayName, "Sundar Pichai");
  assert.equal(profile.bio, "CEO of Google and Alphabet.");
  assert.equal(profile.avatarUrl, "https://pbs.twimg.com/profile_images/avatar.jpg");
  assert.equal(profile.externalUrl, "https://abc.xyz");
  assert.equal(profile.location, "Mountain View, CA");
  assert.equal(profile.joinedDate, "March 2008");
  assert.equal(profile.isVerified, true);
  assert.equal(profile.isProtected, false);
  assert.deepEqual(profile.stats, { followers: "5.4M", following: "329", posts: "2,412" });
  assert.equal(profile.timelineItems.length, 1);
  assert.equal(profile.timelineItems[0].id, "1800000000000000000");
  assert.equal(profile.timelineItems[0].url, "https://x.com/sundarpichai/status/1800000000000000000");
  assert.equal(profile.timelineItems[0].tab, "posts");
  assert.equal(profile.timelineItems[0].timestamp, "2026-06-15T10:00:00.000Z");
  assert.equal(profile.timelineItems[0].timestampLabel, null);
  assert.equal(profile.timelineItems[0].text, "Building helpful AI for everyone.");
  assert.equal(profile.timelineItems[0].replyCount, "12");
  assert.equal(profile.timelineItems[0].repostCount, "34");
  assert.equal(profile.timelineItems[0].likeCount, "56");
  assert.equal(profile.timelineItems[0].viewCount, "7.8K");
  assert.equal(profile.timelineItems[0].feedPhotoUrl, "https://pbs.twimg.com/media/GQabc123?format=jpg&name=small");
  assert.deepEqual(profile.timelineItems[0].mediaUrls, [
    "https://pbs.twimg.com/media/GQabc123?format=jpg&name=small",
    "https://pbs.twimg.com/media/GQabc123?format=jpg&name=large",
  ]);
  assert.deepEqual(profile.timelineItems[0].externalLinks, ["https://blog.google/technology/ai"]);
  assert.equal(profile.access.state, "public_visible");
  assert.equal(profile.access.canScrapePosts, true);
  assert.equal(profile.scrapeMeta.authwall, false);
  assert.equal(profile.scrapeMeta.targetPostCount, 1024);
  assert.equal(profile.scrapeMeta.extractedCount, 1);
  assert.equal(profile.scrapeMeta.countsByTab.posts, 1);
  assert.equal(profile.scrapeMeta.postsWithText, 1);
  assert.equal(profile.scrapeMeta.postsWithMedia, 1);
  assert.equal(profile.scrapeMeta.postsWithExternalLinks, 1);
  assert.equal(profile.scrapeMeta.postsWithVisibleCounters, 1);
  dom.window.close();
});

test("marks replies tab posts and reply context", () => {
  const dom = withDom(
    "https://x.com/sundarpichai/with_replies",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main><article>
        <a href="/sundarpichai/status/1800000000000000001"><time datetime="2026-06-16T10:00:00.000Z"></time></a>
        <div>Replying to @google</div>
        <div data-testid="tweetText">Thanks for the update.</div>
      </article></main></body></html>`,
    ["Sundar Pichai", "@sundarpichai", "Replying to @google", "Thanks for the update."].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "replies" });
  assert.equal(profile.timelineItems.length, 1);
  assert.equal(profile.timelineItems[0].tab, "replies");
  assert.equal(profile.timelineItems[0].isReply, true);
  assert.equal(profile.timelineItems[0].replyContext, "Replying to @google");
  dom.window.close();
});

test("does not treat normal timeline challenge text as checkpoint", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main><article>
        <a href="/sundarpichai/status/1800000000000100000"><time datetime="2026-06-16T10:00:00.000Z"></time></a>
        <div data-testid="tweetText">This is a great challenge for builders.</div>
      </article></main></body></html>`,
    ["Sundar Pichai", "@sundarpichai", "This is a great challenge for builders."].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "posts" });
  assert.equal(profile.access.state, "public_visible");
  assert.equal(profile.scrapeMeta.accessState, "public_visible");
  dom.window.close();
});

test("does not treat normal timeline retry wording as rate limit", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main><article>
        <a href="/sundarpichai/status/1800000000000100001"><time datetime="2026-06-16T10:00:00.000Z"></time></a>
        <div data-testid="tweetText">If the first idea does not land, try again later with better context.</div>
      </article></main></body></html>`,
    ["Sundar Pichai", "@sundarpichai", "If the first idea does not land, try again later with better context."].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "posts" });
  assert.equal(profile.access.state, "public_visible");
  assert.equal(profile.scrapeMeta.accessState, "public_visible");
  dom.window.close();
});

test("parses split-line profile stats and timestamp labels from visible text", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main>
        <article>
          <a href="/sundarpichai/status/1800000000000000002"></a>
          <span>Jun 16</span>
          <div data-testid="tweetText">Visible timestamp fallback.</div>
        </article>
      </main></body></html>`,
    [
      "Sundar Pichai",
      "@sundarpichai",
      "CEO, Google and Alphabet",
      "Joined March 2008",
      "194",
      "Following",
      "8.1M",
      "Followers",
      "2,726 posts",
      "Jun 16",
      "Visible timestamp fallback.",
    ].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "posts" });
  assert.deepEqual(profile.stats, { followers: "8.1M", following: "194", posts: "2,726" });
  assert.equal(profile.joinedDate, "March 2008");
  assert.equal(profile.timelineItems[0].timestamp, "Jun 16");
  assert.equal(profile.timelineItems[0].timestampLabel, "Jun 16");
  dom.window.close();
});

test("prefers profile header selectors over logged-in page chrome", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main>
        <section>
          <div data-testid="UserName">Sundar Pichai\\n@sundarpichai\\n2,726 posts</div>
          <div data-testid="UserDescription">CEO, Google and Alphabet</div>
          <a href="/sundarpichai/following"><span>194</span><span>Following</span></a>
          <a href="/sundarpichai/verified_followers"><span>8.1M</span><span>Followers</span></a>
        </section>
        <article>
          <a href="/sundarpichai/status/1800000000000000005"></a>
          <div data-testid="tweetText">A clean profile scrape should not use nav text as bio.</div>
        </article>
      </main></body></html>`,
    [
      "To view keyboard shortcuts, press question mark",
      "Notifications",
      "Chat",
      "Grok",
      "ankit kumar",
      "@ankitxhushh",
      "Sundar Pichai",
      "@sundarpichai",
      "CEO, Google and Alphabet",
      "194",
      "Following",
      "8.1M",
      "Followers",
      "A clean profile scrape should not use nav text as bio.",
    ].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "posts" });
  assert.equal(profile.bio, "CEO, Google and Alphabet");
  assert.deepEqual(profile.stats, { followers: "8.1M", following: "194", posts: "2,726" });
  dom.window.close();
});

test("does not double-count quoted status links in the same timeline article", () => {
  const dom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head>
      <body><main>
        <article>
          <a href="/sundarpichai/status/1800000000000000003"></a>
          <div data-testid="tweetText">Quoting another visible post.</div>
          <a href="/google/status/1800000000000000004">quoted status</a>
        </article>
      </main></body></html>`,
    ["Sundar Pichai", "@sundarpichai", "Quoting another visible post.", "Google", "@google"].join("\n"),
  );

  const profile = extractTwitterProfileFromDom({ maxPosts: 10, tab: "posts" });
  assert.equal(profile.timelineItems.length, 1);
  assert.equal(profile.timelineItems[0].url, "https://x.com/sundarpichai/status/1800000000000000003");
  dom.window.close();
});

test("marks protected profiles without scraping hidden posts", () => {
  const dom = withDom(
    "https://x.com/private_user",
    `<!doctype html><html><head><title>Private User (@private_user) / X</title></head><body><main><button>Follow</button></main></body></html>`,
    [
      "Private User",
      "@private_user",
      "These posts are protected",
      "Only approved followers can see @private_user's posts.",
    ].join("\n"),
  );

  const profile = extractTwitterProfileFromDom();
  assert.equal(profile.username, "private_user");
  assert.equal(profile.isProtected, true);
  assert.equal(profile.access.state, "protected_not_following");
  assert.equal(profile.access.canRequest, true);
  assert.equal(profile.access.outgoingRequest, false);
  assert.deepEqual(profile.timelineItems, []);
  dom.window.close();
});

test("marks an existing request as pending approval", () => {
  const dom = withDom(
    "https://x.com/private_user",
    `<!doctype html><html><head><title>Private User (@private_user) / X</title></head><body><main><button>Requested</button></main></body></html>`,
    ["Private User", "@private_user", "These posts are protected", "Requested"].join("\n"),
  );

  const profile = extractTwitterProfileFromDom();
  assert.equal(profile.access.state, "pending_approval");
  assert.equal(profile.access.outgoingRequest, true);
  assert.equal(profile.access.canRequest, false);
  dom.window.close();
});

test("detects login walls and checkpoints", () => {
  const loginDom = withDom(
    "https://x.com/i/flow/login",
    `<!doctype html><html><head><title>Sign in to X</title></head><body><main></main></body></html>`,
    "Sign in to X",
  );
  const loginProfile = extractTwitterProfileFromDom();
  assert.equal(loginProfile.scrapeMeta.authwall, true);
  assert.equal(loginProfile.access.state, "login_required");
  loginDom.window.close();

  const checkpointDom = withDom(
    "https://x.com/account/access",
    `<!doctype html><html><head><title>Account access</title></head><body><main></main></body></html>`,
    "Verify your identity before continuing.",
  );
  const checkpointProfile = extractTwitterProfileFromDom();
  assert.equal(checkpointProfile.access.state, "checkpoint_required");
  checkpointDom.window.close();
});

test("detects missing, suspended, blocked, and rate-limited profiles", () => {
  const missingDom = withDom(
    "https://x.com/missing_user",
    `<!doctype html><html><head><title>Profile / X</title></head><body><main></main></body></html>`,
    "This account doesn't exist. Try searching for another.",
  );
  const missing = extractTwitterProfileFromDom();
  assert.equal(missing.scrapeMeta.notFound, true);
  assert.equal(missing.access.state, "not_found");
  missingDom.window.close();

  const suspendedDom = withDom(
    "https://x.com/suspended_user",
    `<!doctype html><html><head><title>Profile / X</title></head><body><main></main></body></html>`,
    "Account suspended. This account is unavailable.",
  );
  const suspended = extractTwitterProfileFromDom();
  assert.equal(suspended.access.state, "suspended_or_unavailable");
  suspendedDom.window.close();

  const blockedDom = withDom(
    "https://x.com/blocked_user",
    `<!doctype html><html><head><title>Profile / X</title></head><body><main></main></body></html>`,
    "You are blocked from following @blocked_user and viewing posts.",
  );
  const blocked = extractTwitterProfileFromDom();
  assert.equal(blocked.access.state, "blocked");
  blockedDom.window.close();

  const limitedDom = withDom(
    "https://x.com/sundarpichai",
    `<!doctype html><html><head><title>Sundar Pichai (@sundarpichai) / X</title></head><body><main></main></body></html>`,
    "Rate limit exceeded. Please try again later.",
  );
  const limited = extractTwitterProfileFromDom();
  assert.equal(limited.access.state, "rate_limited");
  limitedDom.window.close();
});

test("mergeTwitterTimelineItems de-dupes and stops at cap", () => {
  const raw = {
    access: { state: "public_visible", canScrapePosts: true },
    timelineItems: [
      { url: "https://x.com/a/status/1", tab: "posts" },
      { url: "https://x.com/a/status/2", tab: "posts" },
    ],
    scrapeMeta: { tab: "posts" },
  };
  const merged = mergeTwitterTimelineItems(
    raw,
    [
      { url: "https://x.com/a/status/1", tab: "posts" },
      { url: "https://x.com/a/status/3", tab: "replies" },
    ],
    2,
    {
      scrollPasses: 7,
      selectedTabs: ["posts", "replies"],
      stopReason: "stable_feed",
      stableScrollPasses: 35,
      lastNewItemAtPass: 4,
      lastScrollY: 8200,
      lastScrollHeight: 12000,
    },
  );

  assert.equal(merged.timelineItems.length, 2);
  assert.deepEqual(
    merged.timelineItems.map((item) => item.url),
    ["https://x.com/a/status/1", "https://x.com/a/status/3"],
  );
  assert.equal(merged.scrapeMeta.reachedItemCap, true);
  assert.equal(merged.scrapeMeta.scrollPasses, 7);
  assert.equal(merged.scrapeMeta.scrollStopReason, "stable_feed");
  assert.equal(merged.scrapeMeta.stableScrollPasses, 35);
  assert.equal(merged.scrapeMeta.lastNewItemAtPass, 4);
  assert.deepEqual(merged.scrapeMeta.countsByTab, { posts: 1, replies: 1 });
});
