# Threads Enrichment

Threads enrichment is an optional social-context layer for One. LinkedIn remains the mandatory identity and career anchor; Threads can add public/visible profile and timeline context when the user provides a Threads profile URL.

## Architecture

- One browser sends a pasted Threads profile URL to `POST /api/threads/enrich-url`.
- The One route verifies Firebase auth, normalizes the URL, and calls the standalone scraper server with `THREADS_SCRAPER_URL` plus `THREADS_SCRAPER_API_KEY`.
- The scraper runs on a VM with persistent Chromium exposed only to the worker at `127.0.0.1:9222`.
- Operators use noVNC at `127.0.0.1:6080` through an SSH tunnel for manual Threads login, 2FA, CAPTCHA, or checkpoint handling.
- The worker writes redacted JSON snapshots to `/var/lib/threads-scraper/outputs`.
- One persists successful profiles in `SocialConnection` with `platform="threads"`.
- Private/pending access states are persisted in `SocialAccessRequest` with `platform="threads"`.

## Supported URLs

Accepted:

```text
https://www.threads.com/@threads
https://www.threads.com/@threads?hl=en
threads.com/@threads
```

Rejected:

```text
https://www.threads.com/login
https://www.threads.com/@threads/post/ABC
https://www.threads.com/search?q=threads
```

## Data Boundary

The worker extracts visible profile-page data only:

- username, display name, bio, avatar, profile URL
- verified/private/access state
- follower/thread/following counts when visible
- visible profile timeline posts up to `THREADS_MAX_POSTS_PER_PROFILE` (default `1024`)
- per post: URL, text, `contentSeed`, timestamp, media URLs/thumbnails, `feedPhotoUrl`, external links, visible reply/repost/like/quote counters, visible labels

The worker must not return DMs, follower/following lists, hidden/private posts, cookies, local storage, bearer tokens, session IDs, or raw browser state.

## Access Lifecycle

Supported states:

```text
public_visible
private_not_following
follow_requested
pending_approval
approved_visible
login_required
checkpoint_required
rate_limited
blocked
not_found
```

`POST /scrape` is read-only. `POST /access-request` may click one visible Follow/Request button when the profile is private and the VM account has not already requested access. It never bypasses owner approval, checkpoints, login walls, rate limits, or blocked states.

## VM Operator Flow

Deploy/update the VM from `services/threads-scraper`:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/deploy-gcp-vm.sh
```

Open the login browser:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/open-login-browser.sh
```

Keep a local tunnel running:

```bash
gcloud compute ssh threads-scraper-vm \
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
curl -H "Authorization: Bearer $SCRAPER_API_KEY" \
  http://127.0.0.1:8080/session/status
```

Public profile scrape:

```bash
curl -H "Authorization: Bearer $SCRAPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.threads.com/@threads?hl=en"}' \
  http://127.0.0.1:8080/scrape
```

Remote smoke helper:

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/test-vm-api.sh https://www.threads.com/@threads
```

## Environment

One app:

- `THREADS_SCRAPER_URL`
- `THREADS_SCRAPER_API_KEY`
- `THREADS_SCRAPER_TIMEOUT_MS`
- `THREADS_MAX_POSTS_PER_PROFILE` (default `1024`; archive/service output only until the later integration pass)

Scraper VM:

- `SCRAPER_API_KEY`
- `THREADS_LIVE_BROWSER=true`
- `THREADS_BROWSER_URL=http://127.0.0.1:9222`
- `THREADS_NOVNC_URL=http://127.0.0.1:6080/vnc.html?host=127.0.0.1&port=6080`
- `THREADS_PROFILE_SCRAPER_TIMEOUT_MS=120000`
- `THREADS_MAX_POSTS_PER_PROFILE=1024`
- `OUTPUT_DIR=/var/lib/threads-scraper/outputs`

Default Secret Manager name:

```text
threads-scraper-api-key
```
