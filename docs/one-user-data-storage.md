# One User Data Storage

This document maps the One intake flow to the exact storage locations used by the app. It covers the current LinkedIn, Instagram, Threads, X, scan, and preference-intelligence paths.

## Storage Backend

Production One (`one` Cloud Run service in project `hushone-app`, region `us-central1`) uses Prisma/Postgres through:

```text
DATABASE_URL -> Secret Manager secret ONE_DATABASE_URL
```

The app does not store scraper API keys in user rows. Scraper service API keys are separate Cloud Run/VM secrets such as `linkedin-scraper-api-key`, `instagram-scraper-api-key`, `threads-scraper-api-key`, and `twitter-scraper-api-key`.

## URL Connect Flow

When a user adds a profile URL in the connector UI:

```text
Browser connector row
  -> One API route with Firebase bearer auth
  -> standalone scraper service
  -> normalized sanitized profile
  -> Postgres persistence
  -> UID-scoped browser cache for fast reload
```

The browser shows `Adding...` while the API call is in flight. This is a foreground request, not a detached queue job.

## Table Map

### `OneUser`

Primary account row keyed by Firebase UID.

Stores:

- `firebaseUid`
- `email`
- `name`
- `photoUrl`
- `provider` (`google`, `guest`, `dev`)

Written by:

- guest-session creation
- LinkedIn connect
- Instagram/Threads/X connect or access-state update
- scan start
- OpenAI connector OAuth/context flows

Purpose:

- owner key for all scans, connections, preferences, notifications, and deletion cascade
- restored identity for returning sessions

### `LinkedInConnection`

One row per user for the trusted identity/career anchor.

Stores:

- `userId`
- `profile` JSON containing the normalized `LinkedInProfileFull`
- `publicId`
- `sessionValid`
- `connectedAt`
- `refreshedAt`

Written by:

```text
POST /api/linkedin/enrich-url
  -> scrapeLinkedInProfileUrl(...)
  -> persistConnectedProfile(...)
  -> upsertLinkedInConnection(...)
```

Purpose:

- stores the rich LinkedIn profile used as identity/career ground truth
- lets returning users recover the LinkedIn anchor without reconnecting immediately

### `SocialConnection`

Shared table for optional social profile connections.

Platforms currently used:

```text
instagram
threads
x
```

Stores:

- `userId`
- `platform`
- `publicId` (usually username/handle)
- `profile` JSON containing the normalized scraper profile
- `sessionValid`
- `connectedAt`
- `refreshedAt`

Written by:

```text
POST /api/instagram/enrich-url -> persistInstagramProfile(...)
POST /api/threads/enrich-url   -> persistThreadsProfile(...)
POST /api/x/enrich-url         -> persistXProfile(...)
```

Purpose:

- remembers connected optional socials
- powers the connector page after refresh
- supplies supporting social context to scans and preference intelligence

### `SocialAccessRequest`

Durable access lifecycle table for optional private/protected/social access states.

Stores:

- `userId`
- `platform`
- `publicId`
- `profileUrl`
- `status`
- `profileSnapshot`
- `requestedAt`
- `approvedAt`
- `lastCheckedAt`
- `nextCheckAt`
- `attemptCount`
- `lastError`

Written when the scraper returns access-state information, including:

```text
private_not_following
protected_not_following
follow_requested
pending_approval
approved_visible
public_visible
login_required
checkpoint_required
rate_limited
blocked
not_found
```

Purpose:

- tracks pending/private/protected lifecycle without bypassing platform approval
- allows optional social failures to be visible without blocking the main One scan

### `ConsentEvent`

Created when a One scan starts.

Stores:

- `userId`
- `purpose`
- `consentVersion`
- `locationMode`
- optional `latitude`, `longitude`, `zipCode`
- hashed IP and hashed user-agent

Written by:

```text
POST /api/one/research
  -> createConsentAndScan(...)
```

Purpose:

- records that the user initiated the scan and what consent/purpose/version applied

### `ScanRun`

One row per One research run.

Stores:

- `userId`
- `status`
- `mode`
- `purpose`
- `input` JSON
- `normalizedResult` JSON after completion
- `summary`
- `error`
- timing/outcome fields when available
- deep research job/session IDs

Written by:

```text
POST /api/one/research
  -> upsertOneUser(...)
  -> createConsentAndScan(...)
```

Updated by:

- research completion
- failure/deadline handling
- recovery routes
- preference/deep/image progressive patches

Important:

`ScanRun.input` is the snapshot of what One knew when the scan started. It can include the LinkedIn profile, connected social profiles, consent flags, and the upstream research job ID. This is why a refresh or recovery can resume a running scan.

### `UserPreferenceProfile`

Latest synthesized preference-intelligence profile for a user.

Stores:

- `userId`
- optional `scanRunId`
- `status`
- `version`
- `inputHash`
- `profile` JSON
- `generatedAt`
- `staleAfter`

Written by:

```text
POST /api/one/research/{id}/preferences
  -> buildUserPreferenceProfile(...)
  -> saveUserPreferenceProfile(...)
```

Purpose:

- stores the current preference layer shown on the dashboard
- uses `inputHash` for idempotency so repeated polling does not regenerate the same profile
- marks stale timing for future refresh behavior

### `SocialContentItem`

Indexed visible social evidence rows generated by the preference layer.

Stores:

- `userId`
- `platform`
- `publicId`
- `itemId`
- `itemUrl`
- `itemType`
- optional `text`
- optional `timestamp`
- optional `media`
- `metrics`
- `features`

Written by:

```text
POST /api/one/research/{id}/preferences
  -> indexSocialPreferenceEvidence(...)
```

Current behavior:

- indexes the evidence emitted by the preference v2 fast pass
- skips LinkedIn evidence because LinkedIn remains the identity/career anchor
- does not yet represent a full historical post warehouse for every raw scraped item

### `SocialMediaAsset`

Safe media-analysis metadata table.

Stores:

- `userId`
- `platform`
- `assetHash`
- `sourceUrl`
- optional `cacheUri`
- `analysis` JSON

Current behavior:

- created for evidence items with media URLs
- initial analysis status is `pending`
- provider metadata points toward the Vertex/Gemini/Cloud Vision media pass

Important:

This table must never contain cookies, localStorage, browser secrets, scraper API keys, or raw private fetch material.

### `SocialRefreshJob`

Queue/lock table for future recurring social refreshes.

Stores:

- `userId`
- `platform`
- `publicId`
- `status`
- `priority`
- `attempts`
- `lockedAt`
- `nextRunAt`
- `lastError`
- `metadata`

Current behavior:

- schema exists as the refresh foundation
- full recurring job orchestration is still a later slice

### `SocialPreferenceRunLog`

Per-run audit trail for preference intelligence.

Stores:

- `userId`
- optional `scanRunId`
- `status`
- `event`
- `version`
- `inputHash`
- platform/count metadata
- selected evidence IDs
- selected signal IDs
- duration
- error text when relevant

Purpose:

- answers "what did the preference layer select, skip, reuse, or fail on?"
- keeps debug metadata out of the main dossier blob

## Standalone Scraper VM Artifacts

Each standalone scraper service may also write sanitized output artifacts on its VM:

```text
/var/lib/instagram-scraper/outputs
/var/lib/threads-scraper/outputs
/var/lib/twitter-scraper/outputs
```

Those files are worker-side artifacts, not the app database. They are useful for operator debugging and smoke checks. They should contain sanitized scraper outputs, not cookies or browser session material.

## What Is Not Stored

One app user tables must not store:

- browser cookies
- localStorage
- bearer tokens
- scraper API keys
- noVNC credentials
- persistent Chromium session data
- DMs
- hidden/private posts
- follower/following lists
- bookmarks/likes tabs
- raw platform session secrets

The browser may keep UID-scoped local cache keys such as `one_li_full`, `one_ig_full`, `one_threads_full`, and `one_x_full` to make refreshes feel instant. Those are client cache copies, not the system-of-record.

## Current Reliability Caveat

The connect routes do call the persistence helpers on success. However, several connection writes are intentionally best-effort: helpers catch and swallow DB errors so an optional social connection cannot break the main One flow if a migration or DB table is temporarily unavailable.

Practically:

- If the DB is configured and migrations are present, the data is saved to the tables above.
- If a defensive DB write fails, the API may still return the normalized profile and the client cache may still show it as connected for that browser session.
- For production-grade confidence, add explicit persistence failure logs/metrics around the swallowed helper errors so operators can alert on failed `LinkedInConnection` / `SocialConnection` / `SocialAccessRequest` writes.

## Quick Example

User enters:

```text
https://x.com/sundarpichai
```

Flow:

```text
OneExperience connector
  -> POST /api/x/enrich-url
  -> verifyOneRequest(Firebase bearer)
  -> scrapeXProfileUrl(...)
  -> POST {TWITTER_SCRAPER_URL}/scrape
  -> normalize visible X profile/timeline
  -> persistXProfile(...)
  -> OneUser + SocialConnection(platform="x")
  -> optional SocialAccessRequest if access metadata exists
  -> client receives normalized profile and stores UID-scoped local cache
```

When the user taps `Send One` after consent:

```text
POST /api/one/research
  -> OneUser upsert
  -> ConsentEvent insert
  -> ScanRun insert with socialProfiles in input JSON
  -> Phase 1 dossier starts
  -> preference polling can create UserPreferenceProfile, SocialContentItem, SocialMediaAsset, and SocialPreferenceRunLog
```
