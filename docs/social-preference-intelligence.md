# Social Preference Intelligence

Social Preference Intelligence is the optional layer that reads a user's connected visible social profiles and turns them into a structured preference profile for One. LinkedIn remains the identity and career anchor. Instagram, Threads, and X are supporting social context.

## Product Flow

1. The user signs in with Google.
2. The user connects LinkedIn as the core profile.
3. The user may connect Instagram, Threads, and X profile URLs.
4. Before social preference analysis starts, the user must check the consent box on the social URL page.
5. One starts the existing Phase 1 research flow without changing the LinkedIn payload contract.
6. Once `/api/one/research` returns a `scanRunId`, the dashboard opens as a progressive shell.
7. Preference Intelligence and the Phase 1 dossier run as two independent layers. Whichever finishes first renders first; the other continues with a clear loading state.
8. The dashboard renders the preference section above the dossier when both are available.

## What Gets Synthesized

The first implementation produces a deterministic preference profile from visible text, media URLs, links, and platform metadata. It groups evidence into these domains:

- travel and stay preferences
- food and drinks
- colors and style
- brands and devices
- work interests
- language
- communication style
- social behavior
- digital wellbeing
- relationship preferences
- unknowns and follow-up questions

Each signal carries a confidence level, source pointers, and evidence text. Sensitive or high-risk assumptions are marked as needing confirmation unless the user explicitly self-declared them.

## Selection Tracking

Every generated preference profile includes a `selection` block so the product can explain and debug what happened:

- total evidence pool size
- selected evidence IDs
- selected signal IDs
- collage evidence IDs
- dropped evidence count when caps apply
- evidence counts by platform
- selected evidence counts by platform
- signal counts by domain
- active selection rules and caps

The dashboard renders a compact tracking strip with selected evidence count, pool size, caps, selected platforms, and strongest domains.

## Data Boundaries

This layer only uses data that the user connected and the platform scraper returned as visible profile context. It does not read DMs, hidden/private posts, follower/following lists, cookies, local storage, bearer tokens, session IDs, or raw browser state.

The full scraper archive can be larger than the prompt context. One keeps the prompt handoff bounded through `SOCIAL_PROMPT_POST_LIMIT`, currently defaulting to `300`, while standalone services can retain deeper sanitized archives for later refresh and indexing.

## Routes

X connection:

```text
POST /api/x/enrich-url
GET /api/x/profile
```

Preference synthesis:

```text
POST /api/one/research/{id}/preferences
```

The preference route requires Firebase auth, loads the existing research job, checks consent, builds the preference profile when social context exists, and stores the latest profile for the user. It can build from `ScanRun.input` while Phase 1 is still running. If the main dossier result is not saved yet, it returns `preferenceProfile` directly without patching `normalizedResult`; once the dossier exists, it also merges the preference fields into the saved dashboard blob.

## Progressive Dashboard

The dashboard is a two-layer aggregator:

- Preference Intelligence: built from connected visible social profiles and consented social context.
- Phase 1 Dossier: built through the existing LinkedIn-anchored Deep Research stream.

These layers do not wait for each other. If preferences finish first, the preference card renders while the dossier section keeps showing live Phase 1 progress. If Phase 1 finishes first, the dossier renders while preference polling continues. Deep and image intelligence still wait for the base dossier because they depend on the Phase 1 report.

## Storage

The schema now includes indexing tables for the longer-lived preference layer:

- `SocialContentItem`
- `SocialMediaAsset`
- `SocialRefreshJob`
- `UserPreferenceProfile`
- `SocialPreferenceRunLog`

These tables give us a path to refresh social content over time without disturbing the Phase 1 research contract. The current slice saves the synthesized preference profile and leaves full recurring refresh orchestration for the next implementation pass.

`SocialPreferenceRunLog` stores one row per preference-layer event. It records status, event name, profile version, input hash, platform list, counts, selected evidence IDs, selected signal IDs, duration, and error text when relevant. It does not store cookies, tokens, local storage, browser state, or raw session data.

## Logs And Events

Server logs:

```text
one.preference.started
one.preference.completed
one.preference.skipped
one.preference.failed
```

Client analytics events:

```text
social_preference_consent_changed
preference_started
preference_completed
preference_failed
preference_poll_timeout
```

Connect analytics now also includes X:

```text
x_connect_started
x_connected
x_connect_pending
x_connect_failed
```

## Refresh Direction

The durable architecture should keep social intelligence fresh like this:

1. Store connected social profiles with platform, handle, canonical URL, and last scrape metadata.
2. Schedule refresh jobs per connected profile using `SocialRefreshJob`.
3. Fetch only new visible content since the last successful scrape when the scraper supports it; otherwise run a bounded visible-profile refresh.
4. Upsert normalized posts and media into `SocialContentItem` and `SocialMediaAsset`.
5. Recompute `UserPreferenceProfile` when enough new evidence arrives or when the user opens One after a stale interval.
6. Show the user what was inferred, confidence, and source evidence, with a way to correct or remove wrong preferences.

## Environment

One app X integration:

```text
TWITTER_SCRAPER_URL
TWITTER_SCRAPER_API_KEY
TWITTER_SCRAPER_TIMEOUT_MS
X_SCRAPER_URL
X_SCRAPER_API_KEY
X_SCRAPER_TIMEOUT_MS
X_PROMPT_POST_LIMIT
SOCIAL_PROMPT_POST_LIMIT
```

`TWITTER_*` is the preferred production naming because the standalone service already uses it. `X_*` is accepted as a shorter alias for app-side configuration.

## Guardrails

- LinkedIn remains the source of truth for identity and career facts.
- Social platforms enrich preferences, interests, behavior, and media signals.
- Private/protected content is never bypassed.
- Preferences are evidence-backed and confidence-scored.
- Relationship, personality, emotion, and lifestyle claims should be presented as inferred or needs-confirmation unless explicitly self-declared.
