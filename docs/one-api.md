# One Developer API (v1)

Give One a person's identity + (optional) profile URLs; One scrapes each provided profile, runs its
Deep-Research dossier, and returns **both** the scraped per-platform data **and** the dossier result.

Two calls: **`POST /api/v1/scan`** to start (returns immediately with the scraped contracts), then
**`GET /api/v1/scan/{id}`** to poll for the dossier.

- Base URL: `https://one.hushh.ai`
- Auth: `Authorization: Bearer <YOUR_API_KEY>` on every request.
- Async: the dossier takes a few minutes — poll the GET every ~10s until `status` is `completed`.
- For **live streaming progress** plus the **preference + lifestyle layer**, see [Streaming + preferences](one-api-streaming.md) — this page covers the basic two-call poll flow.

---

## 1. Start a scan — `POST /api/v1/scan`

**Required:** `name`, `email`, and a location (`latitude`+`longitude`, or `zipCode`).
**Optional:** `linkedinUrl`, `xUrl`, `threadsUrl`, `instagramUrl` (any subset).

```bash
curl -X POST https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "subject@example.com",
    "latitude": 37.42,
    "longitude": -122.08,
    "linkedinUrl": "https://www.linkedin.com/in/sundarpichai",
    "xUrl": "https://x.com/sundarpichai",
    "threadsUrl": "https://www.threads.com/@sundarpichai",
    "instagramUrl": "https://www.instagram.com/sundarpichai/"
  }'
```

**202 Accepted** — scraping runs during this call, so the contracts come back right away:
```json
{
  "ok": true,
  "scanId": "8f3c…",
  "status": "running",
  "statusUrl": "/api/v1/scan/8f3c…",
  "profiles": {
    "linkedin":  { "...": "LinkedInProfileFull (see contracts)" },
    "x":         { "...": "XProfileFull" },
    "threads":   null,
    "instagram": { "access": "private_not_following", "profileUrl": "https://www.instagram.com/…/" }
  }
}
```

Per-platform value in `profiles`:
- full profile object (see contracts) when scraped,
- `null` when the URL wasn't provided,
- `{ "access": "<state>", "profileUrl": "…" }` for a private/protected profile,
- `{ "status": "failed", "error": "…" }` or `{ "status": "too_thin", "profileUrl": "…" }` on failure.

A failed/private/thin profile **does not** fail the request — it's flagged here and the scan proceeds.

**Errors:** `401` invalid/missing key · `400` missing `name`/`email`/location · `502` scan couldn't start.
> The POST does live browser scraping (VM) per platform — use a client timeout ≥ 120s.

---

## 2. Poll for the dossier — `GET /api/v1/scan/{id}`

```bash
curl https://one.hushh.ai/api/v1/scan/8f3c… -H "Authorization: Bearer $ONE_API_KEY"
```

While running: `{ "ok": false, "status": "running", "profiles": { … }, "result": null }` → poll again.

**200 — completed:**
```json
{
  "ok": true,
  "scanId": "8f3c…",
  "status": "completed",
  "profiles": { "linkedin": { … }, "x": { … }, "threads": null, "instagram": { … } },
  "result": {
    "scanRunId": "8f3c…",
    "subject": { "name": "Sundar Pichai", "email": "subject@example.com" },
    "summary": "One-line synthesized summary.",
    "report": "# Who they are …",        // dossier (markdown)
    "rawReport": "…",                     // Phase-1 raw (audit)
    "citations": [ { "title": "…", "url": "…" } ],
    "intelligenceVersion": "2026-06-18-full-social-media-v3",
    "deepStatus": "completed",  "deepReport": "## Professional depth …",
    "imageStatus": "completed", "imageReport": "## Image intelligence …"
  }
}
```
On failure: `{ "ok": false, "status": "failed", "error": "…", "result": null }`.
**Errors:** `401` invalid key · `404` unknown id / not owned by your key.

---

## Platform data contracts (`profiles.*`)

`source` is always `"scraper"`. Visible/public data only — no DMs, no private posts, no cookies/tokens.

### `profiles.linkedin` — LinkedInProfileFull
```
name, givenName, familyName, email, profileUrl, headline, location, about,
experience: [{ title, company, employmentType, location, startDate, endDate, current, description }],
education:  [{ school, degree, field, startDate, endDate, grade }],
skills: [string],
certifications: [{ name, authority, date }],
profileStats: { followers, connections, premium, creator },
verifications: [string], pictureUrl, source
```

### `profiles.instagram` — InstagramProfileFull
```
platform:"Instagram", username, displayName, bio, avatarUrl, externalUrl, profileUrl,
isVerified, isPrivate,
stats: { posts, followers, following },
highlights: [{ title, url, thumbnailUrl }],
recentPublicPosts: [{ url, kind, caption, thumbnailUrl, cdnUrls:[string], likes, comments, timestamp, isVideo }],
visibleProfileText: [string], access: { state, … }, source
```

### `profiles.threads` — ThreadsProfileFull
```
platform:"Threads", username, displayName, bio, avatarUrl, externalUrl, profileUrl,
isVerified, isPrivate,
stats: { followers, threads, following },
recentThreads: [{ url, text, contentSeed, timestamp, mediaUrls:[string], feedPhotoUrl, likeCount, replyCount, repostCount }],
visibleProfileText: [string], access: { state, … }, source
```

### `profiles.x` — XProfileFull
```
platform:"X", username, handle, displayName, bio, avatarUrl, bannerUrl, externalUrl, profileUrl,
location, joinedDate, isVerified, isProtected, isPrivate,
stats: { followers, following, posts },
timelineItems: [{ url, tab, text, timestamp, mediaUrls:[string], likeCount, repostCount, replyCount, viewCount, isReply }],
scrapeMeta: { extractedCount, … }, visibleProfileText: [string], access: { state, … }, source
```

`access.state` values include `public_visible`, `private_not_following` / `protected_not_following`,
`follow_requested`, `pending_approval`, `login_required`, `checkpoint_required`, `rate_limited`,
`blocked`, `not_found`.

---

## Notes for integrators
- Keys are issued out-of-band (set in `ONE_DEV_API_KEYS`). A scan is owned by the key that created it;
  another key cannot read it (`404`).
- All four profile URLs are optional — a scan with just `name`+`email`+location is valid (the dossier
  runs on the provided identity, like signing into One with Google and skipping LinkedIn).
- `result` is One's native dossier object; new dossier fields may be added over time (additive).
