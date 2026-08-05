# insurance-agents-api

A **standalone, public, read-only HTTP API**. Send a location, get distance-ranked
**insurance agencies** near it, streamed — with address, phone, insurable products, and
agency tier. Same shape and edge-case handling as the `brokercheck-api` service.

Data source: the **Nationwide agency locator** (`agency.nationwide.com`). We call the
locator's own backend, **`search-api`** — which is **keyless** (a bare GET returns the full
JSON). So there is no upstream key; the only secret is OUR bearer key that gates callers.

> **Scope:** Nationwide agencies only (that's what the locator covers), not a carrier-neutral
> "all insurance agents" feed.

## The key — where it is and how to get it

| | |
|---|---|
| GCP project | `hushh-tech-prod` |
| Secret name | `insurance-agents-api-key` |
| Header | `Authorization: Bearer <key>` |

```bash
gcloud secrets versions access latest --secret=insurance-agents-api-key --project hushh-tech-prod
```

Any Hushh project calls it with that one key — **no domain allow-list**. `/health` is open;
`/v1/*` returns `401` without the key. The deploy **auto-creates** this secret (random) if it
doesn't exist yet.

## `GET /v1/agents`

| Param | Default | Notes |
|---|---|---|
| `postalCode` | — | A ZIP or "City, ST". Alias: `zip`, `q`. **Or** send `lat`+`lng`. |
| `lat` + `lng` | — | The locator geocodes `"lat,lng"` server-side (`resolvedLocation` echoes what it resolved). |
| `radiusMi` | — | Optional client-side filter on the API's own per-result miles. |
| `limit` | `25` | Results per page, 1–200. |
| `offset` | `0` | Page cursor. Send `meta.nextOffset` for "show more". |
| `stream` | `ndjson` | `ndjson` · `sse` · `off`. |
| `batchSize` | `10` | Rows per streamed frame. |

### The stream (NDJSON — one object per line)

```jsonc
{"type":"meta","query":"98033","resolvedFrom":"postal",
 "resolvedLocation":{"city":"Kirkland","state":"WA","zip":"98033","lat":47.66,"lng":-122.19},
 "estimatedTotal":704,"available":150,"offset":0,"limit":10,"returned":10,
 "hasMore":true,"nextOffset":10,"pagesFetched":3,"radiusMi":null,"cache":"warm", ...}

{"type":"batch","seq":1,"items":[ /* agencies, nearest first */ ]}
{"type":"done","ms":180,"returned":10,"hasMore":true,"nextOffset":10}
```

`stream=sse` → `text/event-stream`; `stream=off` → one buffered `{ok, meta, agents}` doc.

### An agency

```json
{
  "id": "12345",
  "name": "B G I Agency Network Inc.",
  "address": { "line1": "10829 NE 68th St", "line2": "Ste 202", "city": "Kirkland",
               "region": "WA", "postalCode": "98033",
               "formatted": "10829 NE 68th St, Ste 202, Kirkland, WA 98033" },
  "phone": "(206) 726-0906",
  "email": "…", "website": "https://…",
  "products": ["Auto","Commercial","Farm","Home","Renters"],
  "agencyType": "Elite",  "tier": "Tier 1",
  "hours": { … }, "yearEstablished": "1998",
  "social": { "facebook": "…", "instagram": "…", "twitter": "…" },
  "location": { "lat": 47.6812, "lng": -122.1934 },
  "distanceMeters": 354, "distanceMiles": 0.22,
  "distanceApproximate": true, "geoPrecision": "geocoded",
  "source": "nationwide"
}
```

The screenshot's **ELITE STATUS ★** badge is `agencyType: "Elite"`.

## Why this is simple

The `search-api` does the hard parts for us: it returns a **per-result `milesToQueryLocation`**
(distance, already sorted) and **full agency data inline** — so there is no distance to
synthesize and **no per-record detail fetch**. One request per page, mapped and ranked.

Everything else mirrors brokercheck: offset pagination over a frozen, cached ranking; de-dupe
by id; per-IP rate limit; a disk-snapshot cache with a schema version; errors that can arrive
mid-stream as a terminal `{"type":"error"}` frame.

## ⚠️ Operational reality: Akamai

The locator sits behind **Akamai + Cloudflare bot protection**. A bare programmatic request
gets challenged (a non-JSON interstitial), so the client sends a **browser-shaped User-Agent +
Referer** and paces itself: **sequential** paging with a 300 ms gap and low concurrency. The
24 h query cache means a given area is fetched at most once per day, which keeps us well under
any threshold.

**Unverified until deployed:** whether a **GCE datacenter IP** is challenged more aggressively
than a residential one. This is the one thing to watch on first deploy (`/v1/stats` + a live
query). If the VM gets bot-blocked, the fix is a residential/mobile **proxy egress**, exactly
like the Instagram scraper's `SCRAPER_PROXY_URL`. The client already surfaces a bot challenge
distinctly (`NationwideError.botChallenge`) so it's easy to diagnose.

## Caching

One cache: query (`q` + ceiling) → ranked agency list, 24 h TTL. Persisted to disk, restored
on boot, discarded on a schema bump. `GET /v1/stats` shows hit rate + snapshot state.

## Develop / deploy

```bash
npm test                                   # 37 unit + integration tests, no network
PROJECT=hushh-tech-prod ./scripts/gcp-vm/deploy-gcp-vm.sh
./scripts/gcp-vm/test-vm-api.sh
```

Deploy creates `insurance-agents-vm` (e2-medium, debian-12, static IP) with `insurance-agents-api`
on loopback:8080 and Caddy terminating TLS on `insurance-agents.<ip>.sslip.io`. No browser
stack, no database, **no upstream secret** (the source is keyless).

| Env override | Default |
|---|---|
| `INSURANCE_AGENTS_API_KEY` | *(from Secret Manager; empty = open)* |
| `NATIONWIDE_UA` `NATIONWIDE_REFERER` | browser-shaped defaults (for Akamai) |
| `NATIONWIDE_CONCURRENCY` `NATIONWIDE_GAP_MS` | `3` `300` (polite pacing) |
| `CANDIDATE_CEILING` | `150` |
| `RATE_LIMIT_PER_MINUTE` `RATE_LIMIT_BURST` | `30` `10` |
