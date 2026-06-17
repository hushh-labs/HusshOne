# Twitter/X Scraper Service

Standalone VM-backed scraper for visible Twitter/X profile enrichment. It mirrors the Instagram/Threads worker shape, but it is standalone-only for this phase: no One API route, no `SocialConnection`, and no prompt handoff.

## API

- `GET /health`
- `GET /login-intent` local-only helper for noVNC login
- `GET /session/status` bearer-protected
- `POST /scrape` bearer-protected, read-only profile scrape
- `POST /access-request` bearer-protected, one-time Follow/Request when the protected profile page exposes it
- `POST /access-check` bearer-protected, read-only access-state check

Only direct profile URLs are accepted. `twitter.com` and `x.com` are treated as the same platform and canonicalized to `https://x.com/{handle}`.

```bash
curl -H "Authorization: Bearer $TWITTER_SCRAPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://x.com/sundarpichai"}' \
  http://127.0.0.1:8080/scrape
```

Post/status URLs, login routes, search/internal routes, and non-Twitter/X hosts are rejected.

## Runtime

The production VM path uses persistent Chromium on `127.0.0.1:9222`, noVNC on `127.0.0.1:6080`, and sanitized output snapshots under `/var/lib/twitter-scraper/outputs`.

The service returns only profile/page data visible to that browser session. It incrementally scrolls Posts and Replies until X stops exposing new visible items or `TWITTER_MAX_POSTS_PER_PROFILE=1024` unique timeline items are collected. Per item it captures text, `contentSeed`, status URL/id, timestamp, media URLs/thumbnails, primary feed photo, external links, visible reply/repost/quote/like/view counters, visible labels, and reply context when visible. `scrapeMeta` includes scroll timing/stop fields such as `scrollPasses`, `scrollStopReason`, `stableScrollPasses`, and `lastNewItemAtPass` so operators can distinguish target cap, stable feed, auth/rate limits, and other stops.

It does not return cookies, session state, DMs, likes/bookmarks, follower/following lists, hidden protected posts, or browser secrets.

## Local Tests

```bash
npm test
```
