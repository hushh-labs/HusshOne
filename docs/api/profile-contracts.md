# Profile data contracts

Reference for the `profiles` map returned by every scan — the per-platform data One scrapes from the profile URLs you supply.

Every scan response (`POST /api/v1/scan` and `GET /api/v1/scan/{id}`) carries a `profiles` object with one key per platform: `linkedin`, `instagram`, `threads`, and `x`. One scrapes only public/visible data — no DMs, no private posts, no cookies or tokens. `source` on a scraped profile is always `"scraper"`.

A failed, private, or thin profile does not fail the request. It is flagged in `profiles` and the scan proceeds on whatever else was provided. For how these URLs feed the scan, see [Start a scan](/docs/start-a-scan) and [Choosing inputs](/docs/choosing-inputs).

- Base URL: `https://one.hushh.ai`
- Auth: `Authorization: Bearer $ONE_API_KEY` on every request.

## Value variants per key

Each of `profiles.linkedin`, `profiles.instagram`, `profiles.threads`, and `profiles.x` is one of the following:

| Variant | Shape | Meaning |
| --- | --- | --- |
| Full profile | Platform object (see below) | The URL was scraped successfully. |
| Not provided | `null` | You did not supply a URL for this platform. |
| Private / gated | `{ "access": "<state>", "profileUrl": "…" }` | The profile is reachable but access is blocked (private, protected, login/checkpoint required, etc.). See [access states](#access-states). |
| Failed | `{ "status": "failed", "error": "…" }` | The scrape threw an error. |
| Too thin | `{ "status": "too_thin", "profileUrl": "…" }` | The profile was reachable but returned too little usable data to enrich the scan. |

Example `profiles` map mixing all variants:

```json
{
  "linkedin":  { "...": "LinkedInProfileFull" },
  "x":         { "...": "XProfileFull" },
  "threads":   null,
  "instagram": { "access": "private_not_following", "profileUrl": "https://www.instagram.com/…/" }
}
```

## Platform shapes

### LinkedInProfileFull — `profiles.linkedin`

```
name, givenName, familyName, email, profileUrl, headline, location, about,
experience: [{ title, company, employmentType, location, startDate, endDate, current, description }],
education:  [{ school, degree, field, startDate, endDate, grade }],
skills: [string],
certifications: [{ name, authority, date }],
profileStats: { followers, connections, premium, creator },
verifications: [string], pictureUrl, source
```

### InstagramProfileFull — `profiles.instagram`

```
platform:"Instagram", username, displayName, bio, avatarUrl, externalUrl, profileUrl,
isVerified, isPrivate,
stats: { posts, followers, following },
highlights: [{ title, url, thumbnailUrl }],
recentPublicPosts: [{ url, kind, caption, thumbnailUrl, cdnUrls:[string], likes, comments, timestamp, isVideo }],
visibleProfileText: [string], access: { state, … }, source
```

### ThreadsProfileFull — `profiles.threads`

```
platform:"Threads", username, displayName, bio, avatarUrl, externalUrl, profileUrl,
isVerified, isPrivate,
stats: { followers, threads, following },
recentThreads: [{ url, text, contentSeed, timestamp, mediaUrls:[string], feedPhotoUrl, likeCount, replyCount, repostCount }],
visibleProfileText: [string], access: { state, … }, source
```

### XProfileFull — `profiles.x`

```
platform:"X", username, handle, displayName, bio, avatarUrl, bannerUrl, externalUrl, profileUrl,
location, joinedDate, isVerified, isProtected, isPrivate,
stats: { followers, following, posts },
timelineItems: [{ url, tab, text, timestamp, mediaUrls:[string], likeCount, repostCount, replyCount, viewCount, isReply }],
scrapeMeta: { extractedCount, … }, visibleProfileText: [string], access: { state, … }, source
```

## Access states

On a scraped social profile, `access.state` reports how reachable the profile was. When the profile is gated, the same value is returned as the top-level `access` of the private/gated variant (`{ "access": "<state>", "profileUrl": "…" }`).

| State | Meaning |
| --- | --- |
| `public_visible` | Public profile; data was scraped. |
| `private_not_following` | Instagram/Threads profile is private and One is not a follower. |
| `protected_not_following` | X profile is protected and One is not a follower. |
| `follow_requested` | A follow request has been sent. |
| `pending_approval` | Awaiting the profile owner's approval. |
| `login_required` | The platform required a logged-in session to view. |
| `checkpoint_required` | The platform raised a verification checkpoint. |
| `rate_limited` | The platform throttled the request. |
| `blocked` | Access was blocked. |
| `not_found` | No profile exists at the URL. |

## Notes

- All four profile URLs are optional. A scan with just `name` + `email` + location is valid; every `profiles` key that had no URL comes back `null`.
- New fields may be added to these shapes over time (additive) — parse defensively and ignore keys you do not recognise.
- The `profiles` map is separate from the dossier `result`. See [Start a scan](/docs/start-a-scan) for the full response envelope and [Error handling](/docs/error-handling) for request-level failures.
