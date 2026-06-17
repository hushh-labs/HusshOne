# Threads Scraper Service

Standalone VM-backed scraper for public/visible Threads profile enrichment. It mirrors the Instagram worker shape but uses Threads-specific URL validation and DOM extraction.

## API

- `GET /health`
- `GET /login-intent` local-only helper for noVNC login
- `GET /session/status` bearer-protected
- `POST /scrape` bearer-protected, read-only profile scrape
- `POST /access-request` bearer-protected, one-time Follow/Request when the page exposes it
- `POST /access-check` bearer-protected, read-only access-state check

Only direct profile URLs are accepted, for example:

```bash
curl -H "Authorization: Bearer $SCRAPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.threads.com/@threads"}' \
  http://127.0.0.1:8080/scrape
```

Post URLs, login routes, search/internal routes, and non-Threads hosts are rejected.

## Runtime

The production VM path uses persistent Chromium on `127.0.0.1:9222`, noVNC on `127.0.0.1:6080`, and output snapshots under `/var/lib/threads-scraper/outputs`.

The service returns only profile/page data visible to that browser session. It targets up to `THREADS_MAX_POSTS_PER_PROFILE=1024` visible profile timeline posts by default, including post text, `contentSeed`, feed photo/media URLs, external links, timestamps, and visible counters. It does not return cookies, session state, DMs, follower/following lists, or hidden/private posts.

## Local Tests

```bash
npm test
```
