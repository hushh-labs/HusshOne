import { describe, expect, it } from "vitest";
import { extractSocialArchive, ARCHIVE_MAX_ITEMS_PER_PROFILE, sha256 } from "./archive";
import type { ArchiveSocialProfile, SocialProfileFull } from "@/lib/ria/types";

function instagram(posts: number): SocialProfileFull {
  return {
    platform: "Instagram",
    username: "sundarpichai",
    displayName: "Sundar Pichai",
    bio: "CEO",
    avatarUrl: null,
    externalUrl: null,
    profileUrl: "https://www.instagram.com/sundarpichai/",
    isVerified: true,
    isPrivate: false,
    stats: { posts: String(posts) },
    recentPublicPosts: Array.from({ length: posts }, (_, i) => ({
      url: `https://www.instagram.com/p/${i}/`,
      kind: i % 5 === 0 ? "reel" : "post",
      caption: `Caption ${i}`,
      cdnUrls: [`https://cdn.example.com/ig-${i}.jpg`],
      thumbnailUrl: `https://cdn.example.com/ig-thumb-${i}.jpg`,
      likes: String(100 + i),
      comments: String(i),
    })),
    source: "scraper",
  };
}

describe("extractSocialArchive", () => {
  it("indexes Instagram posts with media assets, typing reels and capping at the rolling window (512)", () => {
    const archive = extractSocialArchive([instagram(2000)]);
    expect(archive.content).toHaveLength(ARCHIVE_MAX_ITEMS_PER_PROFILE);
    expect(archive.perPlatform.instagram.items).toBe(ARCHIVE_MAX_ITEMS_PER_PROFILE);
    // post 0 is a reel with two media assets (cdn image + thumbnail), deduped + hashed
    const first = archive.content[0];
    expect(first.itemType).toBe("reel");
    expect(first.platform).toBe("instagram");
    expect(first.media?.primaryUrl).toBe("https://cdn.example.com/ig-0.jpg");
    expect(first.media?.assetHashes).toContain(sha256("https://cdn.example.com/ig-0.jpg"));
    expect(first.mediaAssets.map((m) => m.mediaType)).toEqual(["video", "thumbnail"]);
    expect(first.metrics).toEqual({ likes: "100", comments: "0" });
  });

  it("dedupes media globally by (platform, assetHash) so a reused image is one asset", () => {
    const shared = "https://cdn.example.com/shared.jpg";
    const profile: SocialProfileFull = {
      platform: "Threads",
      username: "t",
      displayName: "T",
      bio: null,
      avatarUrl: null,
      externalUrl: null,
      profileUrl: "https://www.threads.com/@t",
      stats: {},
      recentThreads: [
        { url: "https://www.threads.com/@t/post/1", text: "a", mediaUrls: [shared] },
        { url: "https://www.threads.com/@t/post/2", text: "b", mediaUrls: [shared] },
      ],
      source: "scraper",
    };
    const archive = extractSocialArchive([profile]);
    expect(archive.content).toHaveLength(2);
    expect(archive.media).toHaveLength(1); // shared image deduped
    expect(archive.media[0].assetHash).toBe(sha256(shared));
  });

  it("types X replies vs tweets and skips non-scraper / unknown platforms", () => {
    const x: SocialProfileFull = {
      platform: "X",
      username: "x",
      handle: "x",
      displayName: "X",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      externalUrl: null,
      profileUrl: "https://x.com/x",
      stats: {},
      timelineItems: [
        { url: "https://x.com/x/status/1", text: "tweet", mediaUrls: ["https://cdn.example.com/x.jpg"] },
        { url: "https://x.com/x/status/2", text: "reply", isReply: true },
      ],
      source: "scraper",
    };
    const archive = extractSocialArchive([x]);
    expect(archive.content.map((c) => c.itemType)).toEqual(["tweet", "reply"]);
    expect(archive.media).toHaveLength(1);
    expect(archive.perPlatform.x).toEqual({ items: 2, media: 1 });
  });

  it("indexes LinkedIn posts as a feed platform (types post/reshare/reply/article + reaction metrics)", () => {
    const linkedin: ArchiveSocialProfile = {
      platform: "LinkedIn",
      username: "ankit-kumar-singh",
      profileUrl: "https://www.linkedin.com/in/ankit-kumar-singh/",
      source: "scraper",
      recentPosts: [
        {
          urn: "urn:li:activity:111",
          url: "https://www.linkedin.com/feed/update/urn:li:activity:111/",
          type: "post",
          text: "Shipping a new AI feature today.",
          timestamp: "2d",
          reactions: "120",
          comments: "8",
          reposts: "3",
          media: ["https://media.licdn.com/post-111.jpg"],
        },
        { urn: "urn:li:activity:222", url: "https://www.linkedin.com/feed/update/urn:li:activity:222/", type: "reshare", text: "Great read", reactions: "5" },
      ],
    };
    const archive = extractSocialArchive([linkedin]);
    expect(archive.content.map((c) => c.itemType)).toEqual(["post", "reshare"]);
    expect(archive.content[0].platform).toBe("linkedin");
    expect(archive.content[0].text).toBe("Shipping a new AI feature today.");
    expect(archive.content[0].metrics).toEqual({ reactions: "120", comments: "8", reposts: "3" });
    expect(archive.content[0].media?.primaryUrl).toBe("https://media.licdn.com/post-111.jpg");
    expect(archive.perPlatform.linkedin.items).toBe(2);
  });

  it("returns an empty archive for no profiles", () => {
    expect(extractSocialArchive(undefined)).toEqual({ content: [], media: [], perPlatform: {} });
  });
});
