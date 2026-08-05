# The Advisors API — how it works, and why it isn't scraping

A team explainer. Read time ~8 minutes. No code required.

---

## The headline

**We are not scraping FINRA. We are calling FINRA's own public API.**

BrokerCheck — the official US registry of financial advisers and brokers — runs a JSON API at
`api.brokercheck.finra.org`. It needs **no login, no API key, no cookie, not even a
User-Agent header**. A bare `curl` with no headers at all returns data.

That single fact is why this service looks nothing like our Instagram or LinkedIn scrapers.

---

## How we found out

Honest answer: we looked, instead of assuming.

**Step 1 — the website's own behaviour was suspicious.** BrokerCheck's site is an Angular
single-page app. Single-page apps don't render data on the server; they fetch it from an API
in the browser. So an API had to exist — the only question was whether it was usable.

**Step 2 — we read the app's own JavaScript.** The site ships its logic in a bundle at
`brokercheck.finra.org/main.<hash>.js`. Inside it is the function that builds every search
request. Reformatted, it says:

```js
case "location":
  if (terms.location?.latitude && terms.location?.longitude) {
    params.lat = terms.location.latitude
    params.lon = terms.location.longitude
  } else if (terms.location?.value) { /* … split "City, ST" … */ }
```

That is the whole contract, written by FINRA. **The API takes raw latitude and longitude with
a radius.** Same bundle, same file: `"Radius (Miles)"` — so the units are miles.

**Step 3 — we tested it, and tried to break it.** ~55 live requests: different coordinates,
radius sweeps, pagination limits, filters, header combinations. Every one returned HTTP 200.
No CAPTCHA, no bot challenge, no rate limiting, no 403. Then we repeated it from the GCE VM,
because datacenter IPs are often treated differently — ten rapid requests, all 200.

**Step 4 — we checked whether we were allowed to.** `brokercheck.finra.org/robots.txt` is
three lines, and the `Disallow` is **empty** — everything is permitted.

So the discovery wasn't clever. It was reading the site's own source and then verifying every
assumption against the live service instead of trusting the read.

---

## Why this matters so much

Compare what it takes to get data from each source we work with:

| | Instagram / LinkedIn | Hotel / Healthcare directories | **BrokerCheck** |
|---|---|---|---|
| Login required | **Yes** — a human logs in via noVNC | No | **No** |
| Real browser needed | **Yes** — Chromium + Xvfb + x11vnc | No | **No** |
| Database needed | No | **Yes** — Cloud SQL | **No** |
| Runs 24/7 | Yes | Yes | **No — only on request** |
| Data freshness | live | **stale** between crawls | **live** |
| Breaks when… | session expires, IP gets 429'd | crawler falls behind | (nothing equivalent) |

The Instagram scraper is a robot driving a logged-in browser. The directory crawlers were
robots walking every US ZIP code writing into a notebook. **This is neither.** It's a
well-behaved client of a documented-by-observation public API.

That's why it's the simplest VM in the fleet: **Node and a web server. No Chromium, no
virtual display, no VNC, no database, no background worker.**

---

## What happens when a user opens the app

Real numbers from a real request, Kirkland WA.

### 1. The browser hands us a location
```
lat = 47.6769,  lng = -122.2060
```
(Or a ZIP — `postalCode=98033` also works, and FINRA has its own resolver that turns it into
coordinates.)

### 2. We ask FINRA how many advisers are in range
> **2,099** within 10 miles.

### 3. We fetch the candidates — **all of them**
100 per page (FINRA's hard maximum), around 20 pages, **fetched in parallel**.

This matters more than it sounds. FINRA returns geo results grouped by nearest-ZIP *cohort*,
not interleaved by distance. At Kirkland, positions 0–299 are all Kirkland ZIPs; Bellevue —
comfortably inside the same 5-mile radius — doesn't appear until position ~1,000. We
originally fetched only the first 300 and **Bellevue was structurally invisible**. Fetching
the whole radius is the fix, and doing it in parallel keeps it at ~2–3 seconds.

### 4. Here's the first problem: **FINRA gives no distance**

There is no distance field, and `sort=distance+asc` is silently ignored. (We proved it by
sending `sort=zzzbogus+asc` and getting identical results — the API accepts any sort key and
ignores the ones it doesn't know.)

**So "nearest" is something we compute, not something we receive.**

### 5. Second problem: search results have no coordinates

A search result gives a branch **city, state and ZIP** — no street, no coordinates. Those
only exist on the per-person detail endpoint.

Naively: 300 people → 300 extra API calls.

### 6. The trick that makes it fast

> Those 300 advisers sit in only **3 distinct ZIP codes** — because Morgan Stanley registers
> dozens of advisers to a single office.

So we don't resolve 300 locations. We resolve **3**, and every adviser inherits their office's
coordinate.

**300 lookups become 3.** This is the core idea of the whole service.

### 7. Now we can rank
Straight-line distance from the user to each office, sorted nearest-first.

### 8. We stream, in two tiers

```
2.9s   "2,099 advisers found, here are the first 10"   → cards appear
2.9s   CHRISTINE COTE · Morgan Stanley · ~800m · 914-225-1000
3.1s   Christine's full record: 47.5 yrs, 7 firms, 3 disclosures   → card fills in
```

**Why two tiers?** Name, firm, distance and phone resolve fast. Full professional history is
slow. Sending everything at once means the user stares at a blank screen for ~8 seconds.
Sending position first means cards appear in ~3 seconds and deepen as they read.

The ordering is **frozen before the first card is sent**, so nothing re-shuffles under the
user's cursor while details load.

---

## Two behaviours worth understanding

### Density: 74,928 advisers within one mile of Times Square

Large firms register thousands of representatives to a single headquarters address. A naive
"10 nearest" in Manhattan returns ten indistinguishable names from one lobby.

So above a threshold, the API returns **offices instead of people**:

```
Merrill Lynch   · 0.3 mi · 112 advisers
RBC Capital     · 0.3 mi ·  16 advisers
Stifel Nicolaus · 0.3 mi ·  14 advisers
```

Kirkland (2,099) returns people. Manhattan (14,955) returns offices. Automatic, and the
response says which mode you got.

### Distances are approximate — and we say so

FINRA geocodes offices to **ZIP centroids, not rooftops**. We verified this: 3760 Carillon
Point, 720 Market St and 10510 Northup Way — three different Kirkland buildings, miles
apart — all return the identical coordinate `47.673156, -122.197628`.

So every record is tagged `geoPrecision: "zip_centroid"` and `distanceApproximate: true`,
distances are rounded to 100 m with a 500 m floor, and the UI shows `~0.5 mi` rather than a
falsely precise `0.47 mi`.

Making this rooftop-accurate means geocoding the street addresses ourselves. Not built yet.

---

## Caching, and what happens on restart

Four caches, each with a lifetime matched to how fast that data actually changes:

| Cache | Lifetime | Why |
|---|---|---|
| Office coordinates | **forever** | buildings don't move |
| Firm records | 30 days | a firm's address and phone rarely change |
| Adviser profiles | 7 days | registrations move on regulatory timescales |
| Ranked search results | 6 hours | the volatile one |

Effect: first search of an area ~2–3 s; every later search ~**1 s**.

Nearby users share cached work — query coordinates are snapped to a ~600 m grid cell, so two
people 50 m apart don't each trigger a cold lookup.

**Restart fallback.** The caches live in memory, so a restart used to wipe them and send every
user back to the slow path at once. Now the service **writes a snapshot to disk** on shutdown
and every 5 minutes, and reloads it on boot. Verified on the live VM: 5 entries saved on
shutdown, 5 restored on startup.

Entries store an **absolute** expiry, so a restart can't accidentally extend stale data's
life. A missing or corrupt snapshot is not an error — the service just starts cold, exactly as
before. Losing the file costs speed, never correctness.

---

## How fresh is the data, really?

There's a chain, and it's worth being precise:

```
Adviser changes firm in the real world
     ↓  ~2 business days     ← FINRA's own publishing lag (their stated SLA)
Visible in FINRA's database
     ↓  0 seconds            ← we read it live on a cold request
Our API returns it
     ↓  up to 7 days         ← if served from our profile cache
User sees it
```

So: **on a cold request we are never staler than FINRA.** On a cached request we can be up to
7 days behind FINRA — which is itself ~2 days behind reality.

Every response includes `cache: "cold" | "warm"` so a caller knows which they got.

> **Known gap:** we don't yet expose *how old* a warm result is — only that it is warm. A
> `fetchedAt` timestamp per record is a small addition and is not built yet.

---

## Verifying it yourself

The BrokerCheck website and this API read the **same** upstream service, so results should
agree. If raw counts look different, it is almost always **different defaults**, not
different data:

| | BrokerCheck website | Our API default |
|---|---|---|
| Radius | 25 miles | 10 miles |
| Who | brokers **and** advisers | investment advisers only |
| Status | active **and** previous | active only |

To reproduce the website's result set exactly:

```
?postalCode=98033&radiusMi=25&type=both&status=all
```

---

## Where it runs

| | |
|---|---|
| Endpoint | `https://brokercheck.35.253.255.106.sslip.io` |
| VM | `brokercheck-api-vm` · project `hushh-tech-prod` · zone `us-central1-c` |
| Size | e2-medium |
| Auth | one bearer key, in Secret Manager as `brokercheck-api-key` |
| Code | `services/brokercheck-api/` |
| Integration guide | [docs/api/brokercheck-advisors.md](../api/brokercheck-advisors.md) |

The service holds **no credentials of its own** — FINRA needs none and there's no database.
The only secret is the key controlling who may call us.

---

## In one paragraph

FINRA publishes a public, unauthenticated API containing every registered financial adviser in
the United States, including their exams, employment history, registrations and disciplinary
disclosures. It accepts coordinates and a radius directly. What it does *not* provide is
distance, ordering, coordinates on search results, de-duplication, caching or streaming — and
that gap is exactly what this service fills. We call FINRA live, collapse hundreds of advisers
into a handful of office locations, resolve those, rank by true distance, and stream results
so the interface fills in progressively rather than hanging. No browser, no login, no crawler,
no database.
