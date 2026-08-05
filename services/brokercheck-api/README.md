# brokercheck-api

A **standalone, public, read-only HTTP API**. Send coordinates, get distance-ranked
financial advisers with full profiles, streamed as they resolve.

```
https://brokercheck.35.253.255.106.sslip.io
```

## The key — where it is and how to get it

**Everything you need is below. You don't have to ask anyone.**

| | |
|---|---|
| **GCP project** | `hushh-tech-prod` |
| **Secret name** | `brokercheck-api-key` |
| **Format** | 64-character hex token |
| **Header** | `Authorization: Bearer <key>` |

```bash
gcloud secrets versions access latest --secret=brokercheck-api-key --project hushh-tech-prod
```

That's the whole authentication story. The service holds **no other credentials** — FINRA's
API needs none and there's no database — so this single key exists only to decide who may
call the endpoint. No SDK, no OAuth, no request signing, no client config beyond a URL and
this token.

`/health` is open on purpose so uptime probes work without a credential. Everything under
`/v1/*` returns `401` without the key.

**If `gcloud` says permission denied**, you need `roles/secretmanager.secretAccessor` on that
secret:

```bash
gcloud secrets add-iam-policy-binding brokercheck-api-key \
  --member="user:YOU@hushh.ai" --role="roles/secretmanager.secretAccessor" \
  --project hushh-tech-prod
```

**Using it from another service?** Don't copy the value into that service's config — mount
the same secret. On Cloud Run:

```bash
gcloud run services update YOUR_SERVICE --project YOUR_PROJECT --region YOUR_REGION \
  --set-secrets=BROKERCHECK_API_KEY=projects/hushh-tech-prod/secrets/brokercheck-api-key:latest
```
(The consuming project's service account needs `secretAccessor` on it, same binding as above.)

**Rotating:**
```bash
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets versions add brokercheck-api-key --data-file=- --project hushh-tech-prod
PROJECT=hushh-tech-prod ./scripts/gcp-vm/deploy-gcp-vm.sh   # picks up the new version
```
Anything pinned to `:latest` picks the new key up on its next restart; anything holding a
copied literal breaks — which is the reason to mount rather than copy.

Fully open endpoint instead (no key at all): `SECRET_API_KEY='' ./scripts/gcp-vm/deploy-gcp-vm.sh`.

Data comes from **FINRA BrokerCheck**, the public regulatory registry of US brokers and
investment advisers. This service exists because BrokerCheck's own API has a geo search but
**no distance sort and no distance field** — so "the 10 nearest advisers" has to be
synthesized. That is what this does.

---

## Quick start

```bash
BASE=https://brokercheck.35.253.255.106.sslip.io
BC_KEY=$(gcloud secrets versions access latest --secret=brokercheck-api-key --project hushh-tech-prod)
AUTH="Authorization: Bearer $BC_KEY"

# is it up (no key needed)
curl $BASE/health

# 10 nearest investment advisers to Kirkland, WA — streamed as NDJSON
curl -N -H "$AUTH" "$BASE/v1/advisors?lat=47.6769&lng=-122.2060&radiusMi=10&limit=10"

# by ZIP code instead of coordinates — both work
curl -H "$AUTH" "$BASE/v1/advisors?postalCode=98033&radiusMi=10&limit=10"

# just the list, no streaming, no per-profile detail (fastest)
curl -H "$AUTH" "$BASE/v1/advisors?lat=47.6769&lng=-122.2060&limit=10&detail=false&stream=off"

# one adviser, and one firm
curl -H "$AUTH" $BASE/v1/advisors/1781753
curl -H "$AUTH" $BASE/v1/firms/149777
```

### Location input: coordinates *or* ZIP

Both are first-class. Coordinates are better and the response says which you used:

| Input | `resolvedFrom` | Resolves to |
|---|---|---|
| `lat=47.6769&lng=-122.2060` | `coordinates` | exactly what you sent |
| `postalCode=98033` (or `zip=`) | `postal` | `47.6732,-122.1976` — the ZIP **centroid** |

An unresolvable ZIP is a `400` with a clear message, never a silent empty result.

---

## `GET /v1/advisors`

| Param | Default | Notes |
|---|---|---|
| `lat`, `lng` | — | Required (`lon` also accepted). Or send `postalCode` instead. |
| `postalCode` | — | Resolved to coordinates via FINRA's own resolver. Weaker than lat/lng — reported as `resolvedFrom: "postal"`. |
| `radiusMi` | `10` | Statute miles, 0.1–100. May be auto-tightened — see [Density](#density). |
| `limit` | `50` | 1–500 results per page. |
| `offset` | `0` | Page cursor. Send `meta.nextOffset` for "show 10 more". |
| `firmContact` | `true` | Joins employer phone + office address onto each row. `false` skips it. |
| `type` | `ia` | `ia` (investment advisers) · `broker` · `both`. |
| `status` | `active` | `active` · `previous` · `all`. |
| `minExperienceYears` | — | Pushed server-side to FINRA, so it costs nothing. |
| `groupBy` | `auto` | `person` · `branch` · `auto`. See [Density](#density). |
| `detail` | `true` | `false` skips per-profile hydration — much faster, stubs only. |
| `stream` | `ndjson` | `ndjson` · `sse` · `off`. |
| `batchSize` | `10` | Results per streamed frame. |

### Response: a stream of frames

NDJSON — one JSON object per line. Use `curl -N`, or `fetch` + `ReadableStream`.

```jsonc
{"type":"meta","estimatedTotal":2099,"ranked":1688,"available":1688,"uniqueLocations":10,
 "offset":0,"limit":10,"returned":10,"hasMore":true,"nextOffset":10,"pagesFetched":21,
 "radiusMi":10,"radiusRequested":10,"radiusAdjusted":false,
 "grouped":false,"cache":"warm","truncatedBy":null, ...}

{"type":"batch","seq":1,"items":[ /* 10 stubs, nearest first */ ]}
{"type":"batch","seq":2,"items":[ /* ... */ ]}
{"type":"ranking_final","total":10,"mode":"person"}   // ordering is now frozen

{"type":"detail","crd":"1781753","profile":{ /* full profile */ }}
{"type":"detail","crd":"2432499","profile":{ /* ... */ }}

{"type":"done","ms":3981,"returned":10,"hydrated":10,"failed":0}
```

**`estimatedTotal` vs `available`.** `estimatedTotal` is FINRA's count for the radius;
`available` is what we actually ranked and can page through. They differ only when
`truncatedBy` is set. Render **`available`** as "N advisers found" — `estimatedTotal` would
promise rows the API cannot deliver.

**Why the ordering freezes before details arrive.** You cannot stream "the nearest 10" as
you discover them — you would emit someone at 8 km, then find someone at 2 km, and the
cards would reshuffle under the user's cursor. So the pipeline resolves candidates, ranks
them, and only then emits. `detail` frames arrive afterwards, keyed by CRD, and merge into
rows already on screen. **Nothing ever moves.**

`stream=sse` sends the same frames as `text/event-stream` (named events, for browser
`EventSource`). `stream=off` buffers everything into one JSON document with details already
folded into their stubs — the right choice for server-to-server callers that just want a list.

### A stub (in `batch` frames)

Already rich enough to render a card — no detail fetch needed:

```json
{
  "crd": "1781753", "name": "SUZANNE LEIGH OMAN",
  "otherNames": ["SUZANNE LEIGH GIPSON"],
  "isBroker": true, "isInvestmentAdvisor": true,
  "yearsExperience": 35.7, "hasDisclosures": false,
  "firm": { "firmName": "MORGAN STANLEY", "branchCity": "Kirkland",
            "branchState": "WA", "branchZip": "98033" },
  "distanceMeters": 800, "distanceMiles": 0.47,
  "distanceApproximate": true, "geoPrecision": "zip_centroid"
}
```

### A profile (in `detail` frames)

`yearsExperience`, `firmCount`, `firmHistory[]` (every employer with date ranges),
`exams[]` (Series 7/63/65/66/SIE with dates), `examCounts`, `registrationCounts`,
`registeredStates[]`, `registeredSROs[]`, `disclosures[]` (type, resolution, and the full
allegation/sanction detail), `sanctions`, `isBarred`, `branches[]` (street addresses), and
`reportUrl` (the official BrokerCheck PDF).

---

## Two things to understand before you build on this

### Distances are approximate, and the API says so

FINRA geocodes branch offices to **ZIP centroids**, not rooftops. Three different Kirkland
buildings — 3760 Carillon Point, 720 Market St, 10510 Northup Way, miles apart — all return
the identical coordinate `47.673156,-122.197628`.

So every record carries `geoPrecision: "zip_centroid"` and `distanceApproximate: true`, and
distances are floored to 500 m and rounded to 100 m. **Render them with a `~`.** Everyone in
one ZIP shares a distance; the tiebreak is most-experienced-first.

Rooftop precision requires geocoding the street addresses on the `detail` payload. That is a
planned upgrade, not shipped.

### Density {#density}

Adviser density varies **25×** at the same radius, because large firms register thousands of
reps to a single HQ address:

| Query point | radius | advisers |
|---|---|---|
| Times Square | 1 mi | **74,928** |
| San Francisco | 1 mi | 7,061 |
| Kirkland WA | 1 mi | 280 |

Two automatic behaviours handle this, and both are reported rather than silent:

- **Radius auto-tightening** — a Manhattan query for 25 miles shrinks to ~1.6 miles.
  `radiusRequested` vs `radiusMi` and `radiusAdjusted: true` tell you it happened.
- **Branch grouping** — when a person-level list would be dominated by one address, the
  response switches to branch offices with advisor counts (`grouped: true`). "Merrill Lynch,
  0.3 mi, 112 advisers" beats 10 indistinguishable names from one lobby. In sparse areas
  this never triggers.

`truncatedBy` tells you when a result is partial (`candidateCeiling` or
`finraPagingWindow` — FINRA caps deep paging at ~8,600 records). A partial answer never
reads as a complete one.

---

## Attribution is mandatory

BrokerCheck's Terms of Use §5 permits this use for investor-protection purposes **only if**
you attribute it. Every response carries an `attribution` block; surface it in any UI:

- name BrokerCheck as the source, and link to it and to the Terms of Use
- describe what you did with the data
- provide an error-reporting route
- disclose the retrieval date

> ⚠️ **Unresolved:** ToS **§6(p)** prohibits using BrokerCheck data "in conjunction with any
> machine learning, neural network, deep learning, predictive analytics or other artificial
> intelligence" system — and §5's carve-out does **not** waive it. Get a legal read before
> feeding this into an AI product. See [the build plan](../../docs/specs/brokercheck-advisor-api.md).

---

## Pagination — "show me 10 more"

The ranked list is cached, so **page 2 costs no upstream calls** and can never re-order what
the user is already looking at. Follow `meta.nextOffset` until `hasMore` is false.

```bash
curl "$BASE/v1/advisors?lat=47.6769&lng=-122.2060&limit=10"            # 1-10  of 300
curl "$BASE/v1/advisors?lat=47.6769&lng=-122.2060&limit=10&offset=10"  # 11-20 of 300
```

```json
{"type":"meta","offset":10,"limit":10,"returned":10,"available":300,
 "hasMore":true,"nextOffset":20, ...}
```

Advisers registered at two offices inside the radius arrive as two FINRA hits; results are
de-duplicated by CRD so a name never appears twice in a page.

## Other endpoints

```bash
GET /health              # liveness
GET /v1/stats            # cache sizes + hit rates
GET /v1/advisors/{crd}   # one full profile + their current employer
GET /v1/firms/{crd}      # firm record — contact, ownership, registrations, disclosures
```

### `GET /v1/firms/{crd}` — where contact details live

An individual's FINRA payload has a branch street address but **no phone number**. Contact
details only exist at firm level, so this endpoint is how "how do I reach this adviser" gets
answered.

```bash
curl $BASE/v1/firms/149777    # Morgan Stanley
```

```json
{ "firmId":"149777", "firmName":"MORGAN STANLEY",
  "otherNames":["SMITH BARNEY","CITIGROUP INSTITUTIONAL CONSULTING", ...],
  "firmType":"Limited Liability Company", "firmSize":"Large",
  "formedState":"Delaware", "regulator":"SEC", "finraRegistered":true,
  "secNumbers":{"advisor":"70103","brokerDealer":"68191"},
  "contact":{
    "phone":"914-225-1000",
    "officeAddress":{"street1":"2000 WESTCHESTER AVENUE","city":"PURCHASE",
                     "state":"NY","postalCode":"10577-2530",
                     "formatted":"2000 WESTCHESTER AVENUE, PURCHASE, NY 10577-2530"},
    "mailingAddress":{ ... }},
  "directOwners":[ ... ], "registrations":[ ... ], "disclosures":[ ... ],
  "reportUrl":"https://files.brokercheck.finra.org/firm/firm_149777.pdf" }
```

Search results carry a firm summary inline (`firm.phone`, `firm.officeAddress`,
`firm.firmSize`), so you rarely need this endpoint separately — it's there for the full
ownership and registration history.

---

## Architecture

```
GET /v1/advisors?lat&lng&radiusMi
      │
      ├─ ① probe        count-only calls to pick a workable radius     1 call per attempt
      ├─ ② candidates   FINRA lat/lon/r search, ALL pages in parallel  ~20 calls
      ├─ ③ collapse     group by branch ZIP                            0 calls
      ├─ ④ locate       resolve each unique ZIP to a coordinate        ~1 per ZIP, cached forever
      ├─ ⑤ rank         haversine + sort  ← the only true ordering     0 calls
      └─ ⑥ hydrate      per-CRD detail, in rank order                  1 per profile, cached 7d
```

**③ is what makes this affordable.** Thousands of reps share one office, so a ~1,600-candidate
result set collapses to 8–20 distinct locations. Coordinates are resolved once per *location*,
never per person.

**② fetches the WHOLE radius, deliberately.** FINRA returns geo results grouped by nearest-ZIP
cohort rather than interleaved by distance, so a partial fetch doesn't sample the radius — it
returns only the nearest ZIPs. Measured at Kirkland r=5: positions 0–299 are all Kirkland ZIPs,
while Bellevue (well inside the radius) first appears around position 1,000. Pages are fetched
concurrently, which is what keeps full coverage at ~2–3 s.

Three caches, three lifetimes — collapsing them into one TTL would throw away the biggest win:

| Cache | Key | TTL |
|---|---|---|
| Branch geo | ZIP / branchOfficeId | **permanent** — buildings don't move |
| Profile | CRD | 7 days — FINRA's own freshness SLA is ~2 business days |
| Query | geohash cell + radius + filter | 6 hours |

Query coordinates are **snapped to a geohash cell** before keying, so two users 50 m apart
share a cache entry instead of each triggering a cold run. The candidate fetch is independent of
`limit`, so `limit=10` and `limit=500` over the same area share one cache entry too.

### Restart fallback

The caches are in memory, so a restart would otherwise dump every user onto the cold path at
once. The service **snapshots to disk** on shutdown and every 5 minutes, and reloads on boot.
Verified on the live VM: 5 entries saved on shutdown, 5 restored on startup.

Entries store an **absolute** expiry, so a restart cannot extend stale data's life. A missing or
corrupt snapshot is not an error — the service simply starts cold. Losing the file costs latency,
never correctness. The ranked-query cache is deliberately *not* persisted: it is the most
volatile and the cheapest to rebuild.

`GET /v1/stats` reports snapshot state alongside cache hit rates.

**Typical latency:** ~2–3 s cold (a brand-new area), **~1 s warm**. Measured live: Denver 2.7 s,
Austin 2.2 s, Miami 2.5 s, Kirkland 1.9 s cold; ~1.0 s warm across all of them.

Machine size is load-bearing here: on `e2-small` the same cold query took **18 s**, because ~20
concurrent HTTPS fetches exhaust a 0.5-vCPU burst allowance. `e2-medium` is the floor.

---

## Develop

```bash
npm test          # 53 unit tests, no network or DB required
npm start         # http://localhost:8080
```

Zero runtime dependencies — Node stdlib only. The pure modules (`geo`, `profile`, `query`,
`rate-limit`, and `finra`'s mappers) are unit-tested against fixtures; network and cache glue
is not.

| Env | Default | |
|---|---|---|
| `PORT` | `8080` | |
| `BROKERCHECK_API_KEY` | *(empty)* | Empty = open endpoint. Set it and `/v1/*` requires `Bearer`. |
| `DEFAULT_RADIUS_MI` `MAX_RADIUS_MI` `DEFAULT_LIMIT` `MAX_LIMIT` | `10` `100` `50` `500` | |
| `CANDIDATE_CEILING` | `3000` | Candidates fetched per query. This is a **coverage** setting, not just cost — see §Architecture. |
| `AUTO_TIGHTEN` `DENSITY_CEILING` | `true` `20000` | Shrink the radius only above this many advisers. |
| `GROUP_THRESHOLD` | `5000` | `groupBy=auto` switches to branch-mode above this. |
| `FINRA_CONCURRENCY` `FINRA_GAP_MS` `FINRA_TIMEOUT_MS` `FINRA_RETRIES` | `16` `0` `20000` `2` | |
| `CACHE_SNAPSHOT_PATH` `CACHE_SNAPSHOT_INTERVAL_MS` | `/var/lib/brokercheck/cache-snapshot.json` `300000` | Disk fallback. |
| `RATE_LIMIT_PER_MINUTE` `RATE_LIMIT_BURST` | `30` `10` | Per-IP. Stands in for an API key. |

## Deploy

```bash
PROJECT=hushh-tech-prod ZONE=us-central1-c ./scripts/gcp-vm/deploy-gcp-vm.sh
./scripts/gcp-vm/test-vm-api.sh
```

Creates `brokercheck-api-vm` (e2-medium, debian-12, static IP `brokercheck-api-ip`) with two
systemd units — `brokercheck-api` on loopback:8080 and **Caddy** terminating TLS on :443 with
an automatic Let's Encrypt cert for the sslip.io hostname. Firewall `brokercheck-api-https`
opens 80/443 to the tag `brokercheck-api`.

**No browser stack** (BrokerCheck needs no login) and **no Cloud SQL** (the cache is
in-process) — by some distance the simplest VM in the fleet.

```bash
gcloud compute ssh brokercheck-api-vm --zone us-central1-c \
  --command 'sudo journalctl -u brokercheck-api -f'
```
