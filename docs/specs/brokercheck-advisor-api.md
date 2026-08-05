# BrokerCheck Advisor API — build plan

A **standalone, self-contained HTTP API**. Caller sends coordinates, gets back nearby financial
advisers with full profiles, streamed. No secrets on the consumer side, no dependency on One's
adapter pipeline, no Cloud Run app coupling. A different project can `curl` it on day one.

Status: **Phases 1–4 shipped and live** (2026-08-04) at
`https://brokercheck.35.253.255.106.sslip.io` — see [services/brokercheck-api/](../../services/brokercheck-api/README.md).
Phases 0 (legal), 5 (SEC bulk layer) and 6 (OpenAPI) are outstanding.

Every technical claim below was verified live against FINRA on 2026-08-04. Claims marked ⚠️
are decisions, not facts.

---

## 1. What we verified

### The good news: no ZIP reverse-geocoding needed

`https://api.brokercheck.finra.org/search/individual` accepts **`lat`, `lon`, and `r` (radius in
statute miles) natively**. Confirmed both from the SPA's own request builder and by live call:

```bash
curl -s 'https://api.brokercheck.finra.org/search/individual?lat=47.6769&lon=-122.2060&r=10&nrows=100&start=0&wt=json'
```

**Zero authentication.** No API key, no cookie, no User-Agent, no Referer, no Origin — a bare curl
with no headers returns 200. `access-control-allow-origin: *`. No CAPTCHA, no WAF challenge, no
429s across the whole recon session. The BrokerCheck *UI* gates radius behind a ZIP box ("Search by
ZIP to use Radius"), which is why the naive design looked mandatory — it's a UI restriction only.

### The bad news that shapes the whole design

**FINRA's own geo index is ZIP-centroid based.** Three genuinely different Kirkland buildings —
3760 Carillon Point, 720 Market St, 10510 Northup Way, miles apart — all return the byte-identical
coordinate `47.673156, -122.197628`. Those coordinates match published ZIP centroids to within
57–864 m. The radius filter is a step function that snaps exactly at the centroid.

So the thing you rejected is what FINRA does internally. Using their radius naively just outsources
the ZIP-centroid error instead of fixing it. **But their radius is still the right candidate
filter** — it's a correct superset, and it beats single-ZIP badly: in San Francisco, one ZIP (94104)
returns 2,787 advisers while `r=1` returns 7,061. Single-ZIP loses **61%** of advisers within a mile.

**There is no distance sort and no distance field.** `sort=distance+asc` returns 200 and is silently
ignored — proven by sending `sort=zzzbogus+asc` and getting identical ordering. Only two sorts are
real: `score+desc` and the name sort. True "nearest" must be synthesized by us.

**Coordinates live only on the detail endpoint.** Search results carry `branch_city`/`branch_state`/
`branch_zip` and nothing finer. `GET /search/individual/{CRD}` returns
`currentEmployments[].branchOfficeLocations[]` with `street1`, `street2`, `city`, `state`,
`zipCode`, `branchOfficeId`, and lat/lng. That `street1` is what we geocode ourselves to beat
FINRA's own ordering.

### Density is the real product problem

| Query point | radius | total individuals |
|---|---|---|
| Times Square | 1 mi | **74,928** |
| Times Square | 25 mi | 123,709 |
| San Francisco | 1 mi | 7,061 |
| Kirkland WA | 1 mi | 280 |
| Rural South Dakota | 1 mi | 0 |

25× density variance at identical radius, and 74,928 inside one mile of midtown. The cause: big
wirehouses register thousands of reps to a single HQ branch address. Of the first 100 hits at
Times Square `r=1`, **all 100 shared branch ZIP 10175** — one Fifth Avenue building.

Your "max ~1,000" holds for suburban queries. It does not hold for dense metros, and a naive
"10 nearest" there returns 10 arbitrary people from the same lobby. §4 solves this.

### Hard limits

- `nrows` max is exactly **100**. Over-limit returns **HTTP 200** with `{"errorCode":-1,
  "errorMessage":"Exceeded limit","hits":null}` — check the body, never the status code.
- `start` caps between 8500 (works) and 9000 (fails). **Max ~8,600 reachable per query**, regardless
  of the reported total.
- Detail payload is double-encoded: the real object is a **JSON string** at
  `hits.hits[0]._source.content` requiring a second `JSON.parse`. ~8–11 KB.
- Wrong path `GET /individual/{CRD}` (no `/search`) returns 403 — that's a path error, not a ban.

---

## 2. ⚠️ The one decision only you can make

BrokerCheck's Terms of Use (last modified 2023-11-17, extracted verbatim from the SPA bundle):

- **§6(g)** bans "any data mining, scraping or harvesting tools (including robots)".
- **§5 overrides that**: "Notwithstanding the restrictions set forth in Section 4 and Section 6 (e),
  (f), (g), and (k), the BrokerCheck data may be copied and compiled, including by use of data
  mining, scraping or harvesting tools (including robots)... **solely for investor protection,
  academic, compliance or regulatory purposes**" — subject to five conditions: name BrokerCheck as
  the source; link to BrokerCheck and the ToU; describe your use and any changes; provide an
  error-reporting mechanism; disclose the retrieval date and keep it current.
- **§6(p) is NOT waived by §5**: prohibits using "any portion of BrokerCheck in the development of
  any software program or in conjunction with any **machine learning, neural network, deep learning,
  predictive analytics or other artificial intelligence** computer or software program."

So the scraping ban has an explicit carve-out we plausibly fit. **The AI clause does not**, and
Hushh is an AI product. That is a lawyer's call, not mine, and it is worth 20 minutes before we
build on BrokerCheck as the *sole* source.

**Two mitigations, both cheap:**

1. **Write to FINRA.** §5 has a written-permission escape hatch: `brokercheck@finra.org` or FINRA
   BrokerCheck, 9509 Key West Ave, Rockville MD 20850. A short letter describing the product settles
   §6(p) definitively. Send it in week 1 regardless of what we build.
2. **Make the SEC feed the legal floor.** The SEC's IAPD compilation feeds are **free,
   unauthenticated, daily, and carry no equivalent restriction** — verified live:
   `reports.adviserinfo.sec.gov/reports/CompilationReports/CompilationReports.manifest.json`
   returned files dated today. `IA_INDVL_Feed` is a 167 MB zip → 1.08 GB XML → **240,355 adviser
   representatives, 99.2% with street-level addresses**, plus exams with dates, designations (CFP),
   previous registrations with begin/end dates, full employment history, and disclosure flags.

That second point matters for your question *"how are you gonna extract out the RIA from there"*.
There are two answers and we should use both:

- **From BrokerCheck:** `filter=ia=true,active=true` pushes it server-side. At Times Square `r=1`
  that cuts 74,928 → 14,108.
- **From the SEC:** the IA_INDVL feed *is* the RIA population, already separated, already
  street-addressed, and legally clean. BrokerCheck's own UI admits that for IA-only individuals
  (`bcScope: "NotInScope"`) it doesn't even carry disclosures or experience — it links out to SEC.

My recommendation: **SEC IAPD as the durable base layer, BrokerCheck for live lookup and the
broker-dealer population the SEC feed doesn't cover.** That gives the product full coverage while
keeping the legally unambiguous source as the backbone.

---

## 3. Architecture

One VM, one Node service, one Postgres cache. No browser stack — BrokerCheck is a plain unauthenticated
JSON API, so **Chromium, Xvfb, x11vnc, noVNC and the entire login/session machinery are all
unnecessary**. This will be by far the simplest VM in the fleet.

```
        consumer (any project)
              │  GET /v1/advisors?lat=..&lng=..&radiusMi=10&limit=50
              ▼
   ┌──────────────────────────────────────────────────┐
   │  brokercheck-api-vm   (hushh-tech-prod, us-central1-c)
   │                                                  │
   │  ①  candidates ──► api.brokercheck.finra.org     │  ZIP-centroid superset
   │        │            /search/individual (lat,lon,r)│  1–9 calls
   │        ▼                                          │
   │  ②  branch collapse: group by branch ZIP          │  8-20 unique locations
   │        │                                          │  from ~1000 people
   │        ▼                                          │
   │  ③  detail ──► /search/individual/{CRD}           │  rich data + street1
   │        │                                          │
   │        ▼                                          │
   │  ④  geocode street1 ──► rooftop lat/lng           │  CACHED BY branchOfficeId
   │        │                                          │
   │        ▼                                          │
   │  ⑤  haversine + rank + stream out                 │
   └──────────────────────────────────────────────────┘
              │
              ▼
        Cloud SQL: brokercheck DB (3 caches)
```

### ② is the trick that makes this affordable

Thousands of reps share one building. In SF, `555 California St` appeared under **four spelling
variants at one coordinate**. So we never geocode per person — we geocode **per branch office**,
keyed by FINRA's own `branchOfficeId`, and every rep at that branch inherits the coordinate.

**Measured:** a ~1,600-person result set collapses to **8–20 unique locations**. That turns 1,600
lookups into a dozen on a cold query, and zero on a warm one. It is the single biggest cost and
latency lever in the design.

### Why a VM and not Cloud Run

You asked for a VM and it's the right call here: stable egress IP if FINRA ever starts rate-limiting
by source, no cold starts on a latency-sensitive endpoint, no request-duration ceiling on long
streams, and a local disk for the hot cache. Copy **`services/twitter-scraper`** as the skeleton —
*not* `linkedin-scraper`, which recon flagged as the oldest and most divergent member of the fleet
(no `/session/status`, deprecated `page.waitFor`, full `puppeteer` instead of `puppeteer-core`).

---

## 4. Solving the density problem

This is the part that decides whether the product feels good or broken, and it needs a committed
answer rather than a knob.

**Default response mode is branch-first, not person-first.** When a query returns more people than
`limit`, we return **branch offices ranked by true distance**, each carrying a rep count and the
top few reps by experience. The user sees "Morgan Stanley — 521 Fifth Ave, 0.3 mi, 847 advisers"
rather than 10 indistinguishable names from one lobby. Expanding a branch pages into its people.

In sparse areas the collapse is a no-op — Kirkland's 280 results across ~40 branches renders as
people directly, which is what you'd want there anyway.

Three supporting levers, all pushed server-side to FINRA so we never over-fetch:

- `filter=ia=true,active=true` — RIA-only, currently registered.
- `filter=experience=<days>-*` — minimum years of experience, encoded as a **days range**
  (the UI multiplies years by 365; `7300-*` is 20+ years). Verified live.
- `radiusMi` — and because density varies 25×, the API should **auto-tighten** the radius when the
  candidate total exceeds a threshold, and report what it did in the `meta` frame. A user in
  Manhattan asking for 25 miles does not want 123,709 results; they want the radius that yields a
  usable set, stated honestly.

---

## 5. The API contract

```
GET /v1/advisors
  lat, lng           required, WGS84
  radiusMi           default 10, auto-tightened in dense areas (reported in meta)
  limit              default 50, max 500
  type               ia | broker | both        (default ia)
  status             active | previous | all   (default active)
  minExperienceYears optional, pushed server-side
  groupBy            branch | person | auto    (default auto — see §4)
  batchSize          default 10
  stream             ndjson | sse | off        (default ndjson)
```

One bearer key from Secret Manager (`hushh-tech-prod` / `brokercheck-api-key`) gates `/v1/*`;
`/health` stays open. Per-IP rate limiting on top, so the endpoint can't be turned into a free
proxy onto FINRA. `GET` so it's curl-able and cacheable.

### Stream shape

NDJSON over chunked transfer — one JSON object per line, consumable from `fetch` + `ReadableStream`,
`curl`, or any language's HTTP client with no special library. `stream=sse` serves the same events
as `text/event-stream` for browser `EventSource` consumers. `stream=off` buffers and returns one
JSON document.

```
{"type":"meta","resolved":{"lat":47.6769,"lng":-122.206},"radiusMi":10,
 "radiusAdjusted":false,"estimatedTotal":280,"branches":41,"cache":"warm"}

{"type":"batch","seq":1,"items":[ …10 stubs, ascending distance… ]}
{"type":"batch","seq":2,"items":[ … ]}
{"type":"ranking_final","total":280}          ← ordering is now frozen

{"type":"detail","crd":2013441,"yearsExperience":36.6,"firmCount":7,
 "pastFirms":[…],"exams":[…],"disclosures":[…]}
…
{"type":"done","total":280,"hydrated":280,"cached":251,"fetched":29,"ms":4180}
```

**Why ordering freezes before details arrive.** You cannot stream "the 10 nearest" as you discover
them — you'd emit someone at 8 km, then find someone at 2 km, and the cards reshuffle under the
user's cursor. So: resolve candidates → collapse to branches → geocode → sort → *then* stream.
That's affordable precisely because stage ② shrank the geocoding work. Details hydrate behind the
frozen order and merge into cards already on screen. Nothing ever moves.

### The stub is already rich — no detail fetch needed to render a card

The search result carries more than expected, which is why first paint is fast:

| Field | Source |
|---|---|
| CRD, name, other names | `ind_source_id`, `ind_firstname/middlename/lastname` |
| Broker / IA / both | `ind_bc_scope`, `ind_ia_scope` |
| **Years of experience** | `ind_industry_days` ÷ 365 |
| Has disclosures | `ind_bc_disclosure_fl` |
| Registration count | `ind_approved_finra_registration_count` |
| Current firm + branch city/state/ZIP | `ind_current_employments[]` |

---

## 6. Data extraction — everything we can get

Verified present on live detail payloads (CRD 2013441, 1059581, 810315, 1731327):

**Identity** — `individualId`, first/middle/last/suffix, `otherNames[]`, `bcScope`, `iaScope`.

**Experience** ⚠️ *derived, not given* — from `basicInformation.daysInIndustry` (integer, present
when **inactive**) else `daysInIndustryCalculatedDate` (M/D/YYYY, present when **active** → now
minus date). There is no `yearsOfExperience` field.

**Firm count** ⚠️ *derived* — `uniqBy(firmId)` across `currentEmployments` + `currentIAEmployments`
+ `previousEmployments` + `previousIAEmployments`. **Do not use the search field
`ind_employments_count`** — on CRD 2013441 it reported 3 while the true unique-firm count was 7.

**Employment history** — current and previous, each with `firmId`, `firmName`, `registrationBeginDate`,
`registrationEndDate`, `city`, `state`, `iaOnly`, SEC numbers.

**Branch offices** — `street1`, `street2`, `city`, `cityAlias[]`, `state`, `zipCode`,
`branchOfficeId`, `privateResidenceFlag`, lat/lng (ZIP-centroid — we re-geocode).

**Exams** — `examsCount{state,principal,product}` plus `stateExamCategory[]` /
`principalExamCategory[]` / `productExamCategory[]`, each `{examCategory, examName, examTakenDate,
examScope}`. Real sample: Series 7, 63, 65, 9, 10, 8, 31, SIE with dates back to 1989.

**Registrations** — `registrationCount{...}`, `registeredStates[]{state, regScope, status, regDate}`,
`registeredSROs[]{sro, status, CategoriesList[]}`.

**Disclosures** — `disclosures[]` with `eventDate`, `disclosureType` (Regulatory / Customer Dispute /
Financial / Criminal / Termination), `disclosureResolution`, and `disclosureDetail` — an **open,
type-dependent key/value bag with no fixed schema**, containing `Allegations`, `Resolution`,
`SanctionDetails[]`, `Initiated By`, `Broker Comment`, arbitration docket numbers. Parse
defensively; do not assume keys.

**Sanctions** — `basicInformation.sanctions{permanentBar, limitedBySECSummary, sanctionDetails[]}`.
⚠️ Read from SPA source only; no barred individual's payload was fetched. Confirm before relying on it.

**PDF-only extras** — `https://files.brokercheck.finra.org/individual/individual_{CRD}.pdf` (verified
200, 9 pages) holds three classes the JSON never returns: full **Form-U4 Employment History**
including non-securities jobs with position titles and locations, **Other Business Activities**, and
**Professional Designations**. Phase 4 at the earliest — the extracted text is tilde/pipe-delimited
and needs layout-aware parsing.

---

## 7. Caching — three caches, three lifetimes

Collapsing these into one TTL throws away the biggest win.

| Cache | Key | TTL | Why |
|---|---|---|---|
| **Branch geocode** | `branchOfficeId` | **permanent** | Office buildings don't move. The highest-value cache — it's the slow, paid, rate-limited step, and it's shared across thousands of reps. |
| **Profile detail** | `CRD` | **7–30 days** | Disclosures move on regulatory timescales. FINRA's own SLA is ~2 business days from filing, so a short TTL buys nothing. |
| **Query → CRD list** | `geohash(lat,lng,6) + radius + filter` | **1–24 h** | The volatile one. |

**Snap query coordinates to a geohash cell before keying.** Two users 50 m apart otherwise trigger
two completely cold runs; at ~600 m precision they share one. In a dense metro that's the difference
between a 4-second first paint and 200 ms.

Store in Cloud SQL `hushh-directories-db` (already RUNNABLE) as a new `brokercheck` database, reached
through the proven Cloud SQL Auth Proxy pattern. This is **not** a resurrection of Family B — there's
no ZIP work queue, no 24/7 crawler, no outward spiral. It's a read-through cache that fills from
live traffic.

---

## 8. Delivery phases

Each ships independently and is verifiable on its own.

Phases 1–4 are ✅ **done**. Two findings from building them, both recorded here because they
changed the design:

- **The datacenter-IP risk did not materialise.** Ten rapid requests from `brokercheck-api-vm`
  all returned 200. FINRA treats GCE egress the same as residential.
- **`groupBy=auto` had to stop measuring the sample.** The first implementation decided
  person-vs-branch mode from advisors-per-branch across the fetched candidates, but FINRA's
  relevance ordering varies between identical calls, so the same query flipped modes between
  requests. It now keys off `estimatedTotal`, which is deterministic. For an API another
  project builds against, a stable answer beats a marginally smarter one.

**Phase 0 — legal (parallel, blocks nothing) — ⚠️ OUTSTANDING**
Send the §5 written-permission letter to `brokercheck@finra.org`. Get a lawyer's read on §6(p).
Meanwhile build against the SEC IAPD feed path so we're never blocked on the answer.

**Phase 1 — VM + skeleton**
`services/brokercheck-api/` copied from `twitter-scraper`, browser stack stripped. `deploy-gcp-vm.sh`
creating `brokercheck-api-vm` (e2-medium, debian-12, static IP), systemd units `cloud-sql-proxy` +
`brokercheck-api`. `GET /health` live. TLS via sslip.io like linkedin-scraper.
*Done when:* `curl https://brokercheck.<ip>.sslip.io/health` → 200.

**Phase 2 — the core pipeline (no streaming yet)**
Candidate fetch with pagination + the `Exceeded limit` body check. Branch collapse. Detail fetch with
double-parse. Geocode + `branchOfficeId` cache. Haversine + rank. `stream=off` returns one JSON doc.
*Done when:* Kirkland coords return 280 advisers correctly distance-ordered, with rooftop precision.

**Phase 3 — streaming + caching**
NDJSON and SSE. Batch flushing. The three caches with geohash keying. Per-IP rate limiting.
*Done when:* first batch flushes < 1.5 s warm, and a cold metro query streams progressively.

**Phase 4 — density UX + hardening**
Branch-first grouping, radius auto-tightening, `filter` pushdown for type/status/experience.
Circuit breaker and backoff on FINRA. Honest `geoPrecision` on every record.

**Phase 5 — SEC IAPD base layer**
Nightly IA_INDVL ingest into the same Postgres, giving offline coverage, legal insulation, and
street-level addresses for 240k advisers without a single FINRA call.

**Phase 6 — docs + handoff**
OpenAPI spec, a README with copy-paste curl examples, and the §5 attribution obligations rendered in
any consuming UI (source credit, link to BrokerCheck + ToU, retrieval date, error-reporting contact).

---

## 9. Open questions worth one probe each

- Can the search endpoint be made to return coordinates directly (a Solr-style `fl` field-list
  param)? If yes, stage ③ collapses for ranking purposes and the pipeline gets much cheaper.
- Exact `filter` key/value vocabulary — the shape is known from source, but a guessed
  `status=barred` returned a soft error envelope. Worth confirming from DevTools rather than guessing.
- Does a GCE datacenter IP behave the same as a residential one? Cloudflare may score them
  differently, and all recon ran from here. **Test this in Phase 1, before building on the assumption.**
- Sustained-rate ceiling. Only a 6-request burst at ~1/s was tested. Find the real limit before
  Phase 3 concurrency tuning.
- How many pure broker-dealer reps are absent from the SEC feed? That number sizes how much we
  actually need BrokerCheck once Phase 5 lands.
