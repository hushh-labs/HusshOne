# Twitter/X Standalone Scraper

Twitter/X scraping is a standalone VM-backed service for visible profile feed capture. This phase does not add One app routes, UI, `SocialConnection` persistence, or prompt handoff. Twitter and X are treated as the same platform.

## Architecture

- The scraper service lives in `services/twitter-scraper`.
- The worker runs on a VM with persistent Chromium exposed to the scraper at `127.0.0.1:9222`.
- Operators use noVNC at `127.0.0.1:6080` through an SSH tunnel for manual Twitter/X login, 2FA, CAPTCHA, or checkpoint handling.
- The worker writes redacted JSON snapshots to `/var/lib/twitter-scraper/outputs`.
- No One app persistence is performed in this phase.

## Supported URLs

Accepted and canonicalized to `https://x.com/{handle}`:

```text
https://x.com/sundarpichai
https://twitter.com/sundarpichai?lang=en
x.com/@sundarpichai
```

Rejected:

```text
https://x.com/i/flow/login
https://x.com/sundarpichai/status/1800000000000000000
https://x.com/search?q=hushh
https://x.com/messages
https://x.com/settings/account
https://twitter.com/intent/tweet
```

## Data Boundary

The worker extracts visible profile-page data only:

- handle, display name, bio, avatar, banner, profile URL
- verified/protected/access state
- location/website/joined date when visible through page text or metadata
- follower/following/post counts when visible
- Posts and Replies timeline items until X stops exposing new visible items or `TWITTER_MAX_POSTS_PER_PROFILE` is reached
- per item: status URL/id, text, `contentSeed`, timestamp, media URLs/thumbnails, `feedPhotoUrl`, external links, visible reply/repost/quote/like/view counters, visible labels, `isReply`, and reply context when visible
- scroll metadata: `scrollPasses`, `scrollStopReason`, `stableScrollPasses`, `lastNewItemAtPass`, `lastScrollY`, `lastScrollHeight`, and per-tab scroll metadata when Posts and Replies are both scraped

The worker must not return DMs, likes/bookmarks, follower/following lists, hidden protected posts, cookies, local storage, bearer tokens, session IDs, or raw browser state.

## Access Lifecycle

Supported states:

```text
public_visible
protected_not_following
follow_requested
pending_approval
approved_visible
login_required
checkpoint_required
rate_limited
blocked
not_found
suspended_or_unavailable
```

`POST /scrape` is read-only. `POST /access-request` may click one visible Follow/Request button when the profile is protected and the VM account has not already requested access. It never bypasses owner approval, checkpoints, login walls, rate limits, protected content, or blocked states.

## VM Operator Flow

Deploy/update the VM from `services/twitter-scraper`:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/deploy-gcp-vm.sh
```

Open the login browser:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/open-login-browser.sh
```

Keep a local tunnel running:

```bash
gcloud compute ssh twitter-scraper-vm \
  --project hushh-tech-prod \
  --zone us-central1-c \
  -- -N -L 6080:localhost:6080 -L 8080:localhost:8080
```

Open:

```text
http://127.0.0.1:8080/login-intent
http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080
```

After login, leave Chromium open. Normal `/scrape` calls reuse the same VM browser session.

## Smoke Commands

Health:

```bash
curl http://127.0.0.1:8080/health
```

Session status:

```bash
curl -H "Authorization: Bearer $TWITTER_SCRAPER_API_KEY" \
  http://127.0.0.1:8080/session/status
```

Public profile scrape:

```bash
curl -H "Authorization: Bearer $TWITTER_SCRAPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://x.com/sundarpichai"}' \
  http://127.0.0.1:8080/scrape
```

Remote smoke helper:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/test-vm-api.sh https://x.com/sundarpichai
```

## Environment

Future One app integration names are reserved but not wired in this phase:

- `TWITTER_SCRAPER_URL`
- `TWITTER_SCRAPER_API_KEY`
- `TWITTER_SCRAPER_TIMEOUT_MS`
- `TWITTER_MAX_POSTS_PER_PROFILE` (default `1024`; service/archive output only until a later integration pass)

Scraper VM:

- `TWITTER_SCRAPER_API_KEY`
- `TWITTER_LIVE_BROWSER=true`
- `TWITTER_BROWSER_URL=http://127.0.0.1:9222`
- `TWITTER_NOVNC_URL=http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080`
- `TWITTER_SCRAPER_TIMEOUT_MS=120000`
- `TWITTER_MAX_POSTS_PER_PROFILE=1024`
- `TWITTER_MAX_SCROLL_PASSES=1300`
- `TWITTER_STABLE_SCROLL_PASSES=35`
- `TWITTER_SCROLL_STEP_PX=850`
- `TWITTER_SCROLL_DELAY_MS=750`
- `OUTPUT_DIR=/var/lib/twitter-scraper/outputs`

## Performance Notes

X uses a virtualized feed. The worker scrolls incrementally instead of jumping straight to the document bottom, because older items may only enter the DOM during normal scroll movement. A public profile can still stop below `1024` items when X stops exposing older visible items, asks for login/checkpoint, rate-limits the browser session, or returns a stable feed. In those cases the response keeps the sanitized items it captured and reports the stop reason in `scrapeMeta`.

Default Secret Manager name:

```text
twitter-scraper-api-key
```
