# ria-identity-api

**Phone number → firm → "which one of these advisers is you?"**

An investment adviser types their office phone into your onboarding form. This service turns
that number into a **firm**, then lists the advisers the SEC currently shows registered at
that firm, so the adviser can point at their own row and claim it. It is a **disambiguation
aid for someone claiming their own profile** — not a reverse-phone lookup, not an
identity-resolution service, and not proof that the caller is who they say they are.

**Every source is live. There is no snapshot file anywhere in this service.** Each fact in a
response comes from exactly one place, and the response says which:

| Fact | Source | Required? | Liveness |
|---|---|---|---|
| **phone → firm** | Cloud SQL `ria.firms` — the SEC **Form ADV** firm feed the `ria-directory` crawler ingests (`hushh-tech-prod:us-central1:hushh-directories-db`) | **Optional** | As fresh as the last successful ingest. Every response carries `freshness`. |
| **phone → business → firm** | **Google Places (New)** `places:searchText`, then SEC IAPD firm search + address scoring | Required when there is no Cloud SQL | Live on every request. Nothing but `placeId` may ever be stored. |
| **the adviser roster** | **SEC IAPD** (`api.adviserinfo.sec.gov`) | **Required** | Live on every request, always. |
| **every person profile** | **SEC IAPD** | **Required** | Live on every request, always. |

**Cloud SQL is optional, and optional means optional.** With no database attached the service
answers the whole question from live Google Places + SEC IAPD alone. That is a supported
standalone mode, not a degraded one — see [Cloud SQL is optional](#cloud-sql-is-optional--the-standalone-mode)
for exactly what you keep and what you lose.

The people rule is a correctness requirement, not a preference. The same database has an
`advisers` table and this service **never reads it**: measured 2026-08-06, IAPD lists four
advisers currently registered at firm CRD 2907 and that table holds exactly **one** of them.
A roster served from it would have told three real advisers they do not exist.

---

# Security model — read this before you write any front-end code

Five rules. All five are load-bearing, and three of them are your job, not the service's.

### 1. The API key never touches a browser. Put a BFF proxy in front.

`/v1/*` is gated by `Authorization: Bearer <key>`. That key is a **server-side credential**.
Anyone holding it can spend your entire daily quota and start walking the phone-number space.

```
browser ──POST /api/claim/lookup──▶ YOUR backend (holds the key) ──▶ ria-identity-api
```

Your BFF should also do the narrowing the service deliberately does not do for you: rate-limit
per *session*, and never forward `limit`/`detail` straight from the client.

> **The `access-control-allow-origin: *` header on every response is not an invitation.**
> It exists so uptime probes and server-side tools work without CORS ceremony. Calling this
> API from browser JavaScript means shipping the bearer key to every visitor's devtools.
> Don't.

### 2. Send an OTP to the number that was entered. The lookup is not proof of identity.

Every `/v1/*` response carries `verificationRequired: true` and an `attribution.verificationNotice`
saying the same thing, because it is the single easiest thing to get wrong:

> This response identifies a firm and the advisers publicly registered at it. **It does not
> verify that the caller is any of them.**

The required flow is:

1. Claimant enters a phone number.
2. You call this API and show them the narrowed pick-list.
3. **You send a one-time passcode to the number that was entered.**
4. Only after they prove possession do you reveal or attach the profile to their account.

Our answer narrows the question. The OTP is what answers it. A claimant who picks a row but
never proves possession has claimed nothing — do not persist the link, and do not show them
anything you would not show a stranger.

### 3. The per-minute limit and the daily cap exist to stop bulk enumeration.

| Control | Default | Applies to | What it stops |
|---|---|---|---|
| Token bucket | **30/min**, burst **10** | all of `/v1/*` | A burst. |
| **Daily cap** | **2,000/day** | **every route that discloses a firm or a person**: `/v1/claim/lookup`, `/v1/claim/search`, `/v1/advisors/{crd}`, `/v1/firms/{crd}` | A patient crawler. At 30/min a scraper walks 43,200 numbers a day; the cap is what makes that impractical. |

These are **product constraints, not cost controls**. A legitimate onboarding flow spends
**one lookup per adviser**, so the ceiling is nearly free for the real use and fatal to the
abusive one.

**`/v1/claim/search` and `/v1/advisors/{crd}` used to be exempt** on the reasoning that neither
is keyed on a phone number. That reasoning was wrong in one direction that mattered: CRDs are
small sequential integers, so `/v1/advisors/{crd}` is a walk of the SEC's *individual* index,
and it named a person for free. Both are charged now, and the charge is structural rather than
per-route — `scripts/lib/routes.mjs` declares what each route discloses and its `dispatch()` is
the only thing that runs a handler, so a new disclosing route cannot ship uncapped. A
`400` for a malformed query still costs nothing: the query is parsed before the cap is charged.

Three things follow for you:

- **They are keyed on something the caller cannot choose.** `X-Forwarded-For` is
  client-supplied at its *left* end, so the service counts hops from the **right**
  (`TRUSTED_PROXY_COUNT=1` behind Caddy or bare Cloud Run, **2** behind an external HTTPS load
  balancer). Spoofing the header buys nothing.
- **With a key configured, the daily cap is charged to the KEY, not the IP.** Your BFF's
  entire traffic shares one 2,000/day bucket. Size for that, and if you legitimately need
  more, **ask for your own key and your own cap** rather than sharing one.
- **On Cloud Run the cap is weaker than on the VM.** Both counters are per-process and
  in-memory, so a scale-to-zero deployment splits the cap across instances *and* loses a
  counter every time an instance is reclaimed. The deploy script divides
  `DAILY_LOOKUP_CAP` by `MAX_INSTANCES` to keep the fleet ceiling at 2,000/day, but it cannot
  fix the reset-on-cold-start hole — that needs a shared counter. **If hard anti-enumeration
  enforcement matters more than the idle bill, deploy the VM** (or run Cloud Run with
  `--min-instances=1` and `DAILY_LOOKUP_CAP=2000`).

Cap headers ride on every disclosing response:

```
x-ratelimit-daily-limit: 2000
x-ratelimit-daily-remaining: 1994
```

### 4. `/v1/firms/{crd}` deliberately returns no person names.

CRDs are small sequential integers. A firm route that named a firm's owners and officers
could be walked, start to finish, into a national directory of RIA owners and executives —
which is precisely what this service must never become. So that route publishes the firm's
own filing plus a Schedule A **count**, and nothing else. Person names surface in exactly one
place: `/v1/claim/lookup`, once a single firm is in play and the size gate has been passed.

Two more disclosure rules the service enforces on your behalf, so you know what you will and
will not receive:

- **Ambiguous firm → zero people.** While it is unclear which firm the number belongs to,
  naming anyone would name people at firms that are not the claimant's.
- **Large firm → only advisers with a real narrowing signal.** At a firm with hundreds of
  advisers the phone number distinguishes nobody, so the response names only people who
  appear on the firm's own Form ADV Schedule A — and if none do, it names **nobody**. An
  alphabetical slice of a wirehouse roster is pure disclosure with zero disambiguation value.

**There is no firm-scoped route that names people, and adding one is not a small change.**
`/v1/firms/{crd}` and the `firm` frame carry the same 22-key projection with a Schedule A
count and no names. Neither is a side door around the size gate on `/v1/claim/lookup`, and the
Cloud Run smoke test asserts it on every deploy — structurally (no person-shaped array under
any key) and by value (no adviser the lookup named appears in the firm body).

### 5. Only `placeId` may be persisted from Google.

Of everything Google Places returns, `placeId` is the only field you may store. The business
`name`, `formattedAddress`, `phone` and `website` in `sources.places.business` are **live-use
only** — render them, then forget them. The payload marks it for you (`"persistable": ["placeId"]`)
and the server enforces it structurally: `places.mjs` keeps a 60-second module-local memo that
the on-disk cache snapshot cannot reach, and no Google-derived value is ever a cache key. See
[Attribution](#attribution).

---

## The key

| | |
|---|---|
| GCP project | `hushh-tech-prod` |
| Secret name | `ria-identity-api-key` |
| Format | 64-character hex |
| Header | `Authorization: Bearer <key>` |

```bash
gcloud secrets versions access latest --secret=ria-identity-api-key --project hushh-tech-prod
```

The deploy **auto-creates** this secret (random 32-byte hex) on first run if it does not exist.
`/health` and `/v1/stats` are open on purpose — an uptime probe that needed a credential is
one more thing to get wrong at 3am. Everything else under `/v1/*` returns `401` without it.

Running with an **empty** key is a supported local-development mode (still rate-limited and
still daily-capped). In production a key SHOULD be set: unlike the sibling location-search
services, this endpoint turns a phone number into *named people*, and the key is what makes a
caller accountable. **Once a key is configured the service fails closed.**

The service also holds two **shared, pre-existing** secrets that the deploy reads but must
never create or rotate — rotating either here breaks another service:

| Secret | What it is | Also used by |
|---|---|---|
| `directories-db-password` | the `directories` Postgres user | `ria-directory` and the rest of the directories fleet |
| `hotel-scraper-places-api-key` | Google Places (New) API key | `hotel-scraper` |

---

## Quick start

```bash
# Cloud Run (recommended). Exact URL lands in outputs/cloudrun-deployment.json.
BASE=$(gcloud run services describe ria-identity-api --project hushh-tech-prod --region us-central1 --format='value(status.url)')
# VM alternative: BASE=https://ria-identity.<STATIC_IP>.sslip.io  (outputs/vm-deployment.json)

KEY=$(gcloud secrets versions access latest --secret=ria-identity-api-key --project hushh-tech-prod)
AUTH="Authorization: Bearer $KEY"

# is it up, is a database in the answer, and how old is the Form ADV mapping? (no key needed)
curl -s $BASE/health | jq '{ok, dbEnabled: .sources.formAdvDb.enabled, dbReachable: .sources.formAdvDb.reachable, age: .freshness.ageDays, stale: .freshness.stale, hints}'

# the main call — streamed NDJSON, one JSON object per line
curl -N -H "$AUTH" "$BASE/v1/claim/lookup?phone=814-238-6249"

# one buffered document instead of a stream
curl -H "$AUTH" "$BASE/v1/claim/lookup?phone=814-238-6249&stream=off" | jq .
```

---

## Endpoints

> **About the examples below.** Every **firm-level** value is real public record — firm name,
> CRD, address, main office line, headcount, SEC number. Every **person** is a synthetic
> placeholder (`JANE Q. ADVISER`, individual CRD `9999999`); the live service returns the
> SEC's actual roster in those slots. Counts marked *illustrative* stand in for values that
> change between requests.

| Route | Auth | Daily cap | Returns people? |
|---|---|---|---|
| `GET /health` | open | no | no |
| `GET /v1/stats` | open | no | no |
| `GET /v1/claim/lookup` | bearer | **yes** | yes, under the disclosure rules |
| `GET /v1/claim/search` | bearer | **yes** | yes |
| `GET /v1/advisors/{crd}` | bearer | **yes** | one named individual, by CRD |
| `GET /v1/firms/{crd}` | bearer | **yes** | **never** |

---

### `GET /v1/claim/lookup` — the main endpoint

| Param | Default | Notes |
|---|---|---|
| `phone` | *required* | Free text, ≤ 64 chars. `(814) 238-6249`, `814-238-6249`, `+1 814 238 6249`, `8142386249 x12` all normalise to the same key. |
| `limit` | `10` | 1–50. Out-of-range **clamps**; non-numeric is a `400`. This is a disclosure ceiling — it is not env-overridable on the server. |
| `detail` | `false` | Opt **in** to hydrating each candidate with their full IAPD profile. Costs one upstream call per person. A pick-list only needs names. |
| `stream` | `ndjson` | `ndjson` · `sse` · `off`. |

A nonsense phone number is a **200 with `outcome:"invalid_phone"`**, not a 400 — the caller is
a human mid-onboarding who deserves a guidance string in the body, not a status code your
front end has to reinterpret.

```bash
curl -N -H "$AUTH" "$BASE/v1/claim/lookup?phone=814-238-6249"
```

**Frame 1 — `meta`** (one per response, always first):

```jsonc
{
  "type": "meta",
  "service": "ria-identity-api",
  "query": { "raw": "814-238-6249", "national10": "8142386249", "valid": true },

  "outcome": "few_candidates",          // see the outcome table below
  "confidence": "medium",               // none | low | medium | high
  "nextStep": "pick_person",            // confirm | pick_person | pick_firm | enter_name
  "explanation": "That number is the main line for NESTLERODE & LOY, INC. — is one of these 4 advisers you?",

  "currentAdviserCount": 4,             // people CURRENTLY at the firm, in the rows we fetched
  "rosterMatchesIncludingFormer": 9,    // illustrative. IAPD's RAW match count — includes
                                        // former employees. NOT a roster size. Never render it as one.
  "rosterTruncated": false,             // true = we stopped before exhausting IAPD's matches
  "rosterError": null,

  "notes": ["4 advisers are currently registered at that firm — short enough for the claimant to pick their own row."],
  "firmCount": 1,
  "candidateCount": 4,

  "firmMatch": { "crd": 2907, "confidence": "high", "matchedOn": ["form_adv", "places"], "agreed": true },

  "sources": {
    "formAdv": { "available": true, "matched": true, "crds": [2907], "queryMs": 2, "error": null },
    "places": {
      "available": true, "skipped": null, "businessFound": true,
      "crd": 2907, "firmName": "NESTLERODE & LOY, INC.", "confidence": "high",
      "matchedOn": ["name", "city", "state", "zip", "address"],
      "score": 165, "maxScore": 165, "branchCount": 3, "reason": null,
      "candidates": [
        { "crd": 2907, "name": "NESTLERODE & LOY, INC.", "score": 165,
          "matchedOn": ["name","city","state","zip","address"], "confirmed": true, "branchCount": 3 }
      ],
      "error": null,
      "business": {
        "placeId": "ChIJoeXqwL2ozokRaUpadgF5Uks",
        "name": "Nestlerode & Loy Investment Advisors",
        "formattedAddress": "110 Regent Ct Ste 202, State College, PA 16801",
        "phoneVerified": true,
        "persistable": ["placeId"]      // ← Google Maps ToS. Store placeId. Store nothing else here.
      }
    },
    "roster": {
      "from": "sec_iapd_live",
      "note": "Advisers come from SEC IAPD, through a short-lived read-through cache of IAPD's own responses. No adviser is ever served from a local adviser table."
    }
  },

  "freshness": {
    "lastIngestAt": "2026-07-29T14:26:24.587Z",
    "sourceFile": "IA_FIRM_SEC_Feed_07_29_2026.xml.gz",
    "rowsUpserted": 23640,
    "ageDays": 8,
    "staleAfterDays": 14,
    "stale": false,
    "source": "cloud_sql:ria.ingest_runs(kind=firms, ok=true)"
  },

  "detail": false,
  "limit": 10,
  "verificationRequired": true,
  "attribution": { /* see Attribution below — present on every /v1/* response */ }
}
```

**Frame 2 — `firm`** (one per matched firm). This is the **only** firm shape that ever reaches
the wire, on every route. There is not one person name in it:

```json
{
  "type": "firm",
  "firm": {
    "crd": 2907,
    "name": "NESTLERODE & LOY, INC.",
    "dba": null,
    "secNumber": "801-112333",
    "registrationType": "sec",
    "registrationStatus": "Registered",
    "address": {
      "street1": "110 REGENT COURT, SUITE 202", "street2": null,
      "city": "STATE COLLEGE", "state": "PA", "zip": "16801", "country": "United States"
    },
    "phone": "814-238-6249",
    "phone10": "8142386249",
    "website": "HTTP://WWW.NESTLERODE.COM",
    "totalEmployees": 4,
    "advisoryEmployees": 4,
    "iarCount": null,
    "effectiveAdviserCount": null,
    "aum": 199064720,
    "numAccounts": 612,
    "latestFilingDate": null,
    "scheduleAPersonCount": null,
    "branchCount": null,
    "recordSource": "form_adv_db",
    "lastSeen": "2026-08-06T11:27:05.110Z",
    "reportUrl": "https://adviserinfo.sec.gov/firm/summary/2907"
  }
}
```

`scheduleAPersonCount` is **`null`, not `0`**, when the source cannot say — the Cloud SQL Form
ADV feed carries no Schedule A at all, and reporting `0` would assert that a firm has no
disclosed owners when the truth is that we did not look. Render `null` as "not stated".

**Frames 3…n — `candidate`**, ranked, one per line:

```json
{
  "type": "candidate",
  "rank": 1,
  "candidate": {
    "individualCrd": 9999999,
    "name": "JANE Q. ADVISER",
    "firmCrd": 2907,
    "firmName": "NESTLERODE & LOY, INC.",
    "title": null,
    "score": 6,
    "reasons": [
      "No disclosure events on the SEC record",
      "Registered at the STATE COLLEGE, PA office"
    ],
    "branchCity": "STATE COLLEGE",
    "branchState": "PA",
    "hasDisclosures": false,
    "profileUrl": "https://adviserinfo.sec.gov/individual/summary/9999999"
  }
}
```

*(three more `candidate` frames follow in the live response; elided here)*

**About `score`** — it is a normalised sum of the signals that actually fired, out of a
theoretical 90:

| Signal | Points |
|---|---|
| Named on the firm's Form ADV Schedule A | 40 |
| The only adviser the SEC lists at the firm | 20 |
| Discloses ownership of 25%+ (Schedule A code D/E/F) | 15 |
| Holds a senior title (CEO / President / Founder / Managing / Principal / Owner) | 10 |
| No disclosure events on the SEC record | 5 |

**Do not render `score` as a percentage of certainty.** The Cloud SQL Form ADV feed carries no
Schedule A, so on the common path the 40-, 15- and 10-point signals *cannot* fire and a
perfectly good candidate scores 6. `score` is a **within-response ordering signal**. The
`reasons` array is the thing to show a human.

**Final frame — `done`**:

```json
{
  "type": "done", "ms": 2143,
  "outcome": "few_candidates", "nextStep": "pick_person",
  "firms": 1, "candidates": 4, "hydration": null,
  "upstream": { "limit": 24, "spent": 7, "remaining": 17, "denied": 0, "exhausted": false },
  "verificationRequired": true
}
```

`stream=sse` sends the same frames as `text/event-stream` (`event: meta`, `event: firm`, …).
`stream=off` buffers them into one document:

```json
{ "ok": true, "meta": { … }, "firms": [ … ], "candidates": [ … ], "done": { … },
  "verificationRequired": true, "attribution": { … } }
```

**Mid-stream failures** arrive as a terminal frame in the framing you are already parsing —
`{"type":"error","error":"…","verificationRequired":true}` — never as a truncated stream.

---

### `GET /v1/claim/search` — the name fallback

For when the phone misses: a mobile, a new office line, a firm that filed a different number.
One upstream call, so it is not streamed, and it is **not** daily-capped (a name is not a walk
of the number space).

| Param | Default | Notes |
|---|---|---|
| `name` | *required* | Person names only, ≤ 120 chars. A firm name returns zero hits. No wildcards. |
| `state` | — | Two-letter code. The single most useful narrowing signal for a common name. |
| `limit` | `10` | 1–50. |

```bash
curl -H "$AUTH" "$BASE/v1/claim/search?name=Jane%20Q%20Adviser&state=PA&limit=5"
```

```json
{
  "ok": true,
  "query": { "name": "Jane Q Adviser", "state": "PA" },
  "total": 1,
  "candidates": [
    {
      "individualCrd": 9999999,
      "name": "JANE Q. ADVISER",
      "firmCrd": 2907,
      "firmName": "NESTLERODE & LOY, INC.",
      "title": null,
      "score": 6,
      "reasons": [
        "Matched the name \"Jane Q Adviser\" in the SEC IAPD adviser directory",
        "Registered in PA",
        "No disclosure events on the SEC record"
      ],
      "branchCity": "STATE COLLEGE",
      "branchState": "PA",
      "hasDisclosures": false,
      "profileUrl": "https://adviserinfo.sec.gov/individual/summary/9999999"
    }
  ],
  "verificationRequired": true,
  "attribution": { … }
}
```

Unlike `/v1/claim/lookup`, this route **propagates an IAPD failure as a 502**. IAPD is the only
source here, so swallowing the error would render as "no adviser by that name" — a materially
wrong answer to give someone trying to find themselves.

---

### `GET /v1/advisors/{crd}` — one adviser's public SEC profile

The full public IAPD record for an individual CRD. Live on every call.

```bash
curl -H "$AUTH" "$BASE/v1/advisors/9999999"
```

```json
{
  "ok": true,
  "individual": {
    "crd": 9999999,
    "name": "JANE Q. ADVISER",
    "firstName": "JANE", "middleName": "Q", "lastName": "ADVISER",
    "otherNames": [],
    "currentEmployments": [
      { "firmCrd": 2907, "firmName": "NESTLERODE & LOY, INC.", "iaOnly": true,
        "registrationBeginDate": "2015-06-01",
        "branches": [ { "branchOfficeId": "000000", "street1": "110 REGENT COURT",
                        "street2": "SUITE 202", "city": "STATE COLLEGE", "state": "PA",
                        "zip": "16801", "lat": 40.79, "lng": -77.86, "privateResidence": false } ] }
    ],
    "previousEmployments": [],
    "exams": [ { "code": "S65", "name": "Uniform Investment Adviser Law Examination", "date": "2014-11-12" } ],
    "registeredStates": ["PA"],
    "registeredSROs": [],
    "hasDisclosures": false,
    "disclosures": [],
    "reportUrl": "https://adviserinfo.sec.gov/individual/summary/9999999"
  },
  "verificationRequired": true,
  "attribution": { … }
}
```

Everything in it is already public at `adviserinfo.sec.gov`. Nothing is inferred, enriched, or
joined against any other source, and **no personal contact detail is ever produced** — see
"What this cannot do".

---

### `GET /v1/firms/{crd}` — firm-level public record only

```bash
curl -H "$AUTH" "$BASE/v1/firms/2907"
```

```json
{
  "ok": true,
  "crd": 2907,
  "firm": { /* exactly the firm projection shown above — same 22 keys, no person names */ },
  "sources": {
    "formAdvDb": { "present": true, "error": null, "lastSeen": "2026-08-06T11:27:05.110Z" },
    "iapd":      { "present": true, "error": null, "live": true }
  },
  "freshness": { "lastIngestAt": "2026-07-29T14:26:24.587Z", "ageDays": 8, "stale": false, … },
  "disclosure": "Firm-level public record only. This route never returns the names of a firm's owners, officers or advisers; use /v1/claim/lookup, which applies the disclosure rules for naming a person.",
  "verificationRequired": true,
  "attribution": { … }
}
```

The two source records are **projected**, never echoed whole — whatever a source starts
carrying, only firm-level fields survive.

A CRD that at least one source **looked for and did not have** is a `404`. Two *empty* sources
are not automatically a `404`: with Cloud SQL switched off and IAPD faulting, nobody looked, and
publishing that as "No firm found for CRD 2907" would state a fact about the SEC's register that
we never checked. That case is a `503` with `retryable: true`.

---

### `GET /health` — open, and honest about every dependency

```json
{
  "ok": true,
  "service": "ria-identity-api",
  "timestamp": "2026-08-06T17:40:00.000Z",
  "sources": {
    "formAdvDb": { "reachable": true, "latencyMs": 3, "error": null,
                   "enabled": true, "enabledMode": "auto", "timeoutMs": 800,
                   "host": "127.0.0.1", "port": 5439, "database": "ria", "user": "directories",
                   "passwordConfigured": true, "mode": "pg-pool" },
    "places":    { "configured": true, "note": "Live business lookup enabled. Only placeId may ever be persisted." },
    "iapd":      { "base": "https://api.adviserinfo.sec.gov/search", "live": true,
                   "note": "Rosters and person profiles come from SEC IAPD, through a short read-through cache of IAPD's own responses. No adviser is ever read from a local adviser table." }
  },
  "freshness": { "lastIngestAt": "2026-07-29T14:26:24.587Z", "sourceFile": "IA_FIRM_SEC_Feed_07_29_2026.xml.gz",
                 "rowsUpserted": 23640, "ageDays": 8, "staleAfterDays": 14, "stale": false,
                 "source": "cloud_sql:ria.ingest_runs(kind=firms, ok=true)" },
  "hints": []
}
```

`ok` stays `true` while the process is serving — a probe that flapped because a downstream was
slow would restart a working instance and fix nothing. **The per-source booleans and
`freshness` are what an operator actually reads**, and `hints` spells out any problem in plain
English (unreachable database → check the Cloud SQL Auth Proxy; stale feed → check the
directories ingest job; no Places key → no firm match can be corroborated).

With **no database configured**, the same block reports the absence rather than a failure —
read `enabled` and `mode` first, not `reachable`. (Shown with `RIA_DB_ENABLED=off`; under the
`auto` default with nothing configured, `enabledMode` is `"auto"` and the rest is identical.)

```json
"formAdvDb": { "reachable": null, "latencyMs": 0, "error": null,
               "enabled": false, "enabledMode": "off", "mode": "disabled",
               "host": null, "port": null, "database": null, "user": null,
               "passwordConfigured": false, "timeoutMs": 800 }
```

`freshness` becomes `{"configured": false, "applicable": false, "stale": false, "skipped":
"not_configured", …}` — **`stale` is `false`**, because a source you are not using has no age
to worry about. (Known cosmetic bug in this build: `hints` still emits "Cloud SQL is
unreachable — check the Cloud SQL Auth Proxy" when the database is deliberately off. Read
`enabled`, not the hint.)

`GET /v1/stats` (also open) reports cache sizes and hit rates, which sources are configured,
the rate-limit settings and the aggregate daily-cap state. It never reports per-identity usage
— that would let an unauthenticated caller read an authenticated one's state.

---

## Cloud SQL is optional — the standalone mode

The Form ADV firm table is a **speed-and-corroboration** source. The live chain — Google Places
→ IAPD firm search → address cross-validation → IAPD roster — answers phone → firm end to end
with no database of ours in the loop, so a deployment with no Cloud SQL is **supported, not
degraded**: no 5xx, no boot failure, no red banner on `/health`.

| `RIA_DB_ENABLED` | Behaviour |
|---|---|
| `auto` *(default)* | On iff `RIA_DB_PASSWORD` or `RIA_DB_HOST` is set. Keeps laptops and CI out of "database outage" without ignoring a password an operator did set. |
| `on` | Always consulted. What `scripts/cloudrun/deploy-cloudrun.sh` sets, because that deploy attaches an instance deliberately. |
| `off` | Never consulted. **No socket is ever opened and no `pg` import happens** — this is structural, not a policy. |

Disabled, every store method short-circuits: `lookupByPhone` returns
`{firms: [], consulted: false, skipped: "not_configured"}`, `getFirm` returns `null`, `ping`
returns `ok: null` (not `false` — "nothing to ask" is not "asked and no answer"). When the
database *is* enabled, every query is raced against `RIA_DB_TIMEOUT_MS` (**800 ms**), so a hung
Auth Proxy costs 800 ms of a request that was already doing the live chain in parallel.

### What you lose without it

| | With Cloud SQL | Live sources only |
|---|---|---|
| `confidence` ceiling on a firm match | `high` (both sources agree) | **`medium`** — `high` requires two sources agreeing, and there is only one |
| `firmMatch.matchedOn` | `["form_adv","places"]`, `["form_adv"]` or `["places"]` | always `["places"]` |
| `ambiguous_firm` / `pick_firm` | fires on a shared switchboard (**630** numbers map to 2 firms, **202** to 3+) and on a two-source disagreement | **never fires** — Places returns one business, so a shared line silently resolves to whichever firm it found |
| `firmDisagreement` | detectable | never |
| Firm fields from the filing | `phone`, `phone10`, `website`, `totalEmployees`, `advisoryEmployees`, `aum`, `numAccounts`, `lat`/`lng`, `firstSeen`/`lastSeen` | all `null`; the firm record comes from live IAPD firm detail (`recordSource: "iapd_live"`) |
| `freshness` | real ingest age | `applicable: false` |
| Coverage | ~23,645 firm rows, phone-indexed, sub-millisecond | whatever Places finds **and** IAPD cross-validation confirms at ≥ 95/165 |

Two consequences worth stating plainly:

- **`PLACES_API_KEY` becomes mandatory.** With neither source, every number returns
  `outcome: "no_match"`. Cloud SQL and Places are alternatives for phone → firm; IAPD is not
  optional in either shape, because it is the only source of people.
- **`sources.formAdv` does not yet distinguish "never asked" from "asked and missed"** — in
  standalone mode it reports `{available: true, matched: false, queryMs: 0, error: null}`.
  Read `/health`'s `formAdvDb.enabled` to know whether a database is in the answer at all.

Outcomes, the disclosure rules and the daily cap are **identical in both shapes**. The size
gate reads the live IAPD roster count, not the filed headcount, so nothing about who gets named
changes when the database goes away.

---

## Outcomes, confidence, and what your UI should do

`outcome` says what we found. `nextStep` says what to do about it. **Branch on `nextStep`.**

| `outcome` | `confidence` | `nextStep` | What the UI should do |
|---|---|---|---|
| `single_person` | `high`, capped by the firm confidence | **`confirm`** | One card: name, firm, SEC `profileUrl`. *"Is this you?"* → **then OTP to the number they typed.** |
| `few_candidates` | `medium`, capped | **`pick_person`** | 2–5 rows, ranked. The claimant taps their own. Show `reasons`, not `score`. → **OTP.** |
| `ambiguous_firm` | `low` | **`pick_firm`** | Firm cards **only** — the response contains no people, by design. Ask *"which firm is yours?"*, keep the chosen `crd`, then go to the name step (below) and check the returned candidate's `firmCrd` matches. |
| `large_firm` | `low` | **`enter_name`** | Ask for the adviser's name → `/v1/claim/search`. Any `candidates` present are Schedule A-signalled only; render them as hints, never as a pick-list. |
| `no_match` | `none` | **`enter_name`** | *"We couldn't find that number — what's your name?"* → `/v1/claim/search`. |
| `invalid_phone` | `none` | **`enter_name`** | Show `explanation` inline on the phone field. `phoneReason` is a stable code (`too_short`, `non_nanp_country`, `invalid_area_code`, `invalid_exchange`, …). Let them retype **or** switch to the name step. |

Confidence is **weakest-link**: a `single_person` outcome under a firm match we only half
believe is reported as `medium`, not `high`. That is the difference between *"this is you"* and
*"this is probably your firm, and if so this is you"* — write the copy to match.

### Three things that will bite you if you only read the enum

1. **`large_firm` does not always mean "big firm".** It also fires when IAPD's *individual*
   index holds nobody for the firm, which is extremely common for solo SEC-registered advisers
   (their IAR registration lives at the state level). **Measured over 50 random indexed
   numbers: 17 came back `large_firm`, and 15 of those were this second case, not a wirehouse.**
   Detect it with `currentAdviserCount === 0 && rosterError === null` and say *"the SEC doesn't
   list anyone registered at that firm"* — not *"too many advisers"*. `notes` already carries
   the right prose.

2. **`rosterMatchesIncludingFormer` is not a roster size.** It is IAPD's raw match count and it
   **includes former employees**. Rendering it as "advisers at this firm" is how you tell a
   3,388-person firm it has 5,039 advisers. Use `currentAdviserCount`, and respect
   `rosterTruncated` (which means "at least this many").

3. **There is no firm-scoped roster endpoint.** After `pick_firm` there is nothing to call that
   lists that firm's people — that is deliberate. Record the chosen CRD, send the claimant to
   the name step, and verify that the candidate they pick has a matching `firmCrd`.

### Errors

| Status | Body | When |
|---|---|---|
| `400` | `{"ok":false,"error":"phone is required.","type":"QueryError","field":"phone"}` | Malformed request. `field` tells you which input to highlight. |
| `401` | `{"ok":false,"error":"Unauthorized"}` | Missing/wrong bearer key. |
| `404` | `{"ok":false,"error":"No firm found for CRD 1"}` | Real answer: at least one source looked and had no such record. |
| `429` | `{"ok":false,"error":"Rate limit exceeded","retryAfterSec":2}` | Token bucket. Honour `retry-after`. |
| `429` | `{"ok":false,"error":"Daily lookup cap reached (2000 per day)…","dailyLimit":2000,"used":2000,"resetsAt":"2026-08-07T00:00:00.000Z"}` | Daily cap. Resets at the UTC day boundary. |
| `429` | `{"ok":false,"error":"This request's upstream call budget was exhausted…"}` | `/v1/claim/search` could not afford even its one SEC call within `MAX_UPSTREAM_CALLS_PER_REQUEST`. Ours, not the SEC's — retry. |
| `502` | `{"ok":false,"error":"…"}` | An upstream failed in a way we could not degrade around — in practice SEC IAPD on `/v1/claim/search` and `/v1/advisors/{crd}`, where it is the only source. **A Cloud SQL failure no longer reaches a status code**: it is caught and reported in `sources.formAdv.error`. |
| `503` | `{"ok":false,"error":"Neither source could be consulted for CRD …","retryable":true}` | `/v1/firms/{crd}` only: no source was consulted, so "no such firm" is not something we may claim. |

`/v1/claim/lookup` **degrades rather than fails.** An IAPD outage still returns the firm, with
the failure reported in `rosterError` and in `notes`. A Places outage still returns the Cloud
SQL answer. A dead database still returns the live Places answer — and a database that was
never configured is not a failure at all. Check `sources.*.error` before you conclude that
something does not exist.

---

## Coverage — the honest numbers

All measured **2026-08-06** against the real live sources unless stated. These are point-in-time
readings of a live system, not a service level.

**Build verification**

```
$ node --test scripts/lib
# tests 306   # pass 306   # fail 0   # duration_ms 466
```

**The Form ADV firm table (Cloud SQL `ria.firms`)** — when one is attached. Everything in this
block is what the optional source contributes; none of it applies in standalone mode.

| | |
|---|---|
| Rows | **~23,645** SEC-registered advisory firms |
| Last successful firm ingest | `IA_FIRM_SEC_Feed_07_29_2026.xml.gz`, **23,640 rows upserted**, finished **2026-07-29** |
| Age at measurement | **8 days** (`staleAfterDays` 14) |
| Phone stored with a leading country code | **547 rows** — matched by the `'1' || $1` arm of the query, not missed |
| Numbers that map to **2 firms** | **630** |
| Numbers that map to **3+ firms** | **202** |

Those last two rows are the `ambiguous_firm` → `pick_firm` population: shared suites, a parent
and its affiliates, an outsourced-compliance provider's line. A Google Places result that lands
on one of them resolves it; otherwise the claimant is asked.

**Headcount data quality** — **88 firms report 0 advisory employees**, and **19 of those
disclose more than five Schedule A people**. A reported `0` means "not stated on that line of
the filing", *not* "one person answers this phone". The size gate treats `0` exactly like
`null` and fails closed. (Before it did, typing the AllianceBernstein Corporation switchboard —
`212-969-1000`, CRD 107445, 0 reported advisory employees, 14 disclosed Schedule A persons —
returned the firm's entire board and C-suite by name.)

**Where the time goes.** Every response carries its own wall clock: `done.ms` for the whole
request, and `sources.formAdv.queryMs` for the database leg. The two firm sources run in
parallel, and they are three orders of magnitude apart — the indexed Form ADV query is **a few
milliseconds at most** through the Auth Proxy (which is why its request-side deadline is 800 ms
and not pg's 5 s), while the Places → IAPD firm chain is **~2 s**. So `done.ms` on a warm process is
essentially the live chain plus the roster page, and dropping Cloud SQL costs no latency at
all. `detail=true` adds one IAPD call per candidate, capped at 10.

**Cloud Run cold start: not yet measured.** No `ria-identity-api` service exists in
`hushh-tech-prod/us-central1` at the time of writing, so there is no real number to publish.
`smoke-cloudrun.sh` prints first-vs-second `/health` timings on every run — take it from there
rather than from an estimate.

**Outcome mix, 50 random indexed numbers** — 17 `large_firm`, of which **15 were "IAPD's
individual index holds nobody for this firm"** rather than a genuinely large firm. See point 1
above.

**Roster paging** — firm CRD 793: IAPD reports **5,039 matches** (including former employees)
for a firm that files **3,388** advisory staff, and one IAPD page is **100 rows**. The service
pages to `rosterMaxRows` (300 by default), filters to current employees itself, and reports
`currentAdviserCount`, `rosterMatchesIncludingFormer` and `rosterTruncated` as three separate
numbers so none can be mistaken for another.

**People completeness — why the roster is always live** — firm CRD 2907: IAPD lists **4**
currently registered advisers; the `advisers` table in the same database holds **1**. The other
three have no row at all.

**Google Places → CRD cross-validation** — required score **95/165** *and* a name signal;
`high` at 125+. For the CRD 2907 test case the wrong single IAPD hit (CRD 144426, matched on
one of its 100 registered DBAs) scores **0/165** and the correct firm scores **165/165**. A
naive `total === 1` would have handed an adviser a stranger's firm to claim.

**Phone normalisation** — the NANP "no N11 central office code" rule wrongly refused **9 live
main-office lines** (e.g. `888-511-4611`, `866-211-8970`) before the toll-free carve-out;
measured against the 2026-08-03 SEC roster.

---

## What this cannot do

**The SEC publishes no individual phone numbers. A personal mobile will never match.**
Form ADV carries a firm's *main office* telephone number and nothing else. So the match is
always `phone → firm's main line → the people registered at that firm` — never `phone →
person`. If an adviser types their direct dial, their cell, or a number their firm has not
filed, the honest answer is `no_match` and the flow moves to the name step. That is a feature,
not a gap: a service that could turn a mobile number into a named person is the thing this one
is deliberately not.

**A shared switchboard resolves to several firms.** Fund complexes, shared suites, parents and
affiliates, and outsourced-compliance providers all put one number on many filings — 630
numbers map to two firms and 202 to three or more. Those return `ambiguous_firm` with **no
people**, and the claimant picks. We do not guess, because the losing side of that guess is
somebody else's firm.

**Two live sources can disagree, and we will not break the tie for you.** A firm that recently
moved, renamed or re-registered looks exactly like a mismatch between its Form ADV filing and
its current business listing. When that happens you get `ambiguous_firm` with
`firmDisagreement: true` and **both** firms. The claimant is the only person in the loop who
knows which one is theirs.

**The Form ADV mapping is only as fresh as its last ingest.** It is a bulk feed, and a
three-week-old row is still a real filing — but a firm that changed its number since the last
ingest will miss on the Cloud SQL path (the live Places cross-check is what catches many of
those). **Surface `/health`'s `freshness`, and the per-response `freshness` block, in whatever
you build.** `stale: true` means past `staleAfterDays` (14) — or that we could not read the age
at all, which counts as stale, because "we cannot tell you how old this is" is not a
reassurance.

> **Current operational reality:** `ria-directory-vm` — the crawler that writes `ria.firms` —
> is **TERMINATED**, so the mapping is frozen at the 2026-07-29 feed and keeps aging. It flips
> to `stale: true` around **2026-08-12**. Either refresh it (runbook below) or run without it:
> `RIA_DB_ENABLED=off` is a supported shape, and an aging Form ADV row is exactly the thing the
> live Places cross-check exists to catch.

**It is not proof of identity, and it never will be.** No `/v1/*` response asserts that the
caller is anyone. `verificationRequired: true` is on every one of them. The OTP is yours to
send.

**A few smaller ones.** Non-NANP numbers are rejected with `outcome:"invalid_phone"` and
`phoneReason:"non_nanp_country"` — SEC Form ADV filings are not indexed by them here. The Cloud
SQL feed carries no Schedule A, so `scheduleAPersonCount` is `null` on that path. Firms
registered only at the state level are not in the firm table at all (the ingest is the SEC firm
feed). And a number answered by a call centre or an answering service will resolve to whoever
that business is, which may not be an advisory firm at all — hence `no_match`.

---

## Attribution

Every `/v1/*` response carries this block. **Render the source, and do not present the data as
ours.**

```json
{
  "source": "SEC Investment Adviser Public Disclosure (IAPD) and Form ADV public data",
  "sourceUrl": "https://adviserinfo.sec.gov",
  "retrievedAt": "2026-08-06T17:40:00.000Z",
  "notice": "Firm and adviser records are retrieved from the SEC's Investment Adviser Public Disclosure system (IAPD) and from public Form ADV filings. The SEC's own record at adviserinfo.sec.gov is authoritative.",
  "verificationNotice": "This response identifies a firm and the advisers publicly registered at it. It does not verify that the caller is any of them. Send a one-time passcode to the number that was entered and only treat a profile as claimed once the claimant proves possession.",
  "placesNotice": "Where a Google Places business record contributed to the firm match it is marked in `sources.places`. Under the Google Maps Platform terms only `placeId` may be stored; the business name, address, phone and website in that block are for live use in this response and must not be persisted."
}
```

**`retrievedAt` is a live getter, not a boot constant.** The roster and profiles are fetched
from IAPD as the request is served, so the retrieval date *is* the response date. Display it.

**Google Maps Platform terms — the one hard rule.** Of everything Google Places returns,
**only `placeId` may be persisted.** The business `name`, `formattedAddress`, `phone` and
`website` in `sources.places.business` are **live-use only**: put them in the screen you are
currently rendering, then forget them. Never write them to a database, an enrichment column, or
a cache. The payload marks it for you — `"persistable": ["placeId"]` — so a downstream writer
has no excuse for guessing. Server-side, this is enforced structurally: `places.mjs` keeps a
60-second module-local memo that the on-disk cache snapshot cannot reach, and no
Google-derived value is ever used as a cache key.

The SEC's record at `adviserinfo.sec.gov` is authoritative. Link to it — every firm carries
`reportUrl` and every linkable person carries `profileUrl` — so a claimant can verify against
the SEC's own page rather than trusting our rendering of it.

---

## Runbook

### Refreshing the Form ADV data

This service **never writes**. Every statement it issues is a `SELECT`. `ria.firms` is owned by
the sibling **`ria-directory`** service, whose worker discovers, downloads and stream-ingests
the SEC's Form ADV / IAPD compilation feeds and records each attempt in `ria.ingest_runs`.

That VM is currently `TERMINATED`, so to refresh:

```bash
# 1. start the crawler VM
gcloud compute instances start ria-directory-vm --project hushh-tech-prod --zone us-central1-c

# 2. trigger an ingest cycle (add `force` to re-ingest the latest compilation even if current)
cd services/ria-directory && ./scripts/gcp-vm/run-now.sh ingest

# 3. watch it
gcloud compute ssh ria-directory-vm --project hushh-tech-prod --zone us-central1-c \
  --command 'sudo journalctl -u ria-directory-worker -f'

# 4. confirm this service sees the new feed — ageDays should drop to ~0
curl -s "$BASE/health" | jq '.freshness'
```

Freshness is read from `ingest_runs` where `kind='firms' AND ok=true AND finished_at IS NOT
NULL`, and cached for five minutes — a run that started and failed is never reported as
freshness, or a broken pipeline would read as a healthy one. Allow up to five minutes for
`/health` to pick up a fresh ingest, or restart the API.

### Local development

```bash
cd services/ria-identity-api
npm install

export PLACES_API_KEY=$(gcloud secrets versions access latest --secret=hotel-scraper-places-api-key --project hushh-tech-prod)
export TRUSTED_PROXY_COUNT=0        # no proxy in front locally — ignore X-Forwarded-For entirely
export CACHE_SNAPSHOT_PATH=/tmp/ria-identity-cache.json
# RIA_IDENTITY_API_KEY unset = open mode (still rate-limited, still daily-capped)

# OPTIONAL: add the Form ADV table. Without these two lines you get the standalone mode —
# no socket is opened and nothing warns you, because nothing is wrong.
cloud-sql-proxy --address 127.0.0.1 --port 5439 hushh-tech-prod:us-central1:hushh-directories-db &
export RIA_DB_PASSWORD=$(gcloud secrets versions access latest --secret=directories-db-password --project hushh-tech-prod)

npm start
npm test        # node --test scripts/lib — 306 tests, no network, no database
```

The Auth Proxy port is **5439**, deliberately not 5432 — that is a local-loopback choice and
has nothing to do with the Cloud Run socket port (also 5432; see Deploy).

Every `SECRET` can also come from a file via `${NAME}_FILE` (e.g. `RIA_DB_PASSWORD_FILE`),
which keeps the value out of the process environment.

**Env vars worth knowing:** `PORT` (8080) · **`RIA_DB_ENABLED`** (`auto` · `on` · `off` — an
unrecognised value falls back to `auto`, so a typo cannot silently switch a configured database
off) · `RIA_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` · `RIA_DB_TIMEOUT_MS` (800 — the
request-side deadline; `0` disables it) · `RIA_DB_STALE_AFTER_DAYS` (14) · `PLACES_API_KEY` ·
`IAPD_USER_AGENT` · `IAPD_GAP_MS` (0 — minimum spacing between outbound SEC calls) ·
`IAPD_ROSTER_MAX_ROWS` (300) · `RATE_LIMIT_PER_MINUTE` (30) · `DAILY_LOOKUP_CAP` (2000) ·
`TRUSTED_PROXY_COUNT` (1) · `MAX_UPSTREAM_CALLS_PER_REQUEST` (24) ·
`MAX_PROFILE_CALLS_PER_REQUEST` (10).

The disclosure ceilings (`defaultLimit` 10, `maxLimit` 50, `singlePersonMax` 1,
`fewCandidatesMax` 5) are **deliberately not env-overridable**. They bound how many named
people one phone number can reveal, which is a disclosure decision, not a tuning knob. Change
them in `scripts/lib/config.mjs`, in review, or not at all.

### Deploy

Two supported paths, same code, same env contract. **Neither replaces the other** — they share
three Secret Manager secrets and one Cloud SQL instance, all read-only, and both can serve at
once. Running one does not touch the other.

| | **Cloud Run — recommended** | VM |
|---|---|---|
| Script | `scripts/cloudrun/deploy-cloudrun.sh` | `scripts/gcp-vm/deploy-gcp-vm.sh` |
| Idle cost | **$0** (`--min-instances=0`) | e2-medium billed 24/7, ~$25–30/month |
| Cold start | first request after idle pays it | none |
| Daily cap | per instance, and **lost when an instance is reclaimed** | exact — one process, forever |
| Database | `/cloudsql/<conn>` unix socket, **port 5432** | Cloud SQL Auth Proxy on loopback **5439** |
| TLS / host | managed `*.run.app` | Caddy on `ria-identity.<STATIC_IP>.sslip.io` |

This endpoint is used **once per adviser during onboarding**, so an always-on VM is almost
entirely idle cost. Start with Cloud Run; move to the VM only if the anti-enumeration posture
matters more than the bill (see security rule 3).

#### Cloud Run (scale to zero)

```bash
cd services/ria-identity-api
DRY_RUN=1 ./scripts/cloudrun/deploy-cloudrun.sh   # print every gcloud call, change nothing
./scripts/cloudrun/deploy-cloudrun.sh             # the real thing
./scripts/cloudrun/smoke-cloudrun.sh              # SHOW_PEOPLE=1 to print candidate names
```

Idempotent, and nothing in this repo runs it for you — it is not in `cloudbuild.yaml`, no
trigger, no scheduler. In order it enables five APIs; creates `ria-identity-api-key` only if it
is missing and **fails** if either shared secret is absent (minting one would hand this service
a password its owner does not have); grants the runtime SA `roles/secretmanager.secretAccessor`
and `roles/cloudsql.client` **before** the deploy, because Cloud Run validates secret references
at revision start and a revision that never becomes ready looks exactly like a no-op deploy;
builds via Cloud Build; deploys; then verifies by selecting the traffic entry at `percent==100`
rather than indexing `traffic[0]`. Results land in `outputs/cloudrun-deployment.json`.

Defaults, and why: `--min-instances=0` (the entire point), `--max-instances=5` (a public
scale-to-zero endpoint is also a scale-to-your-credit-limit endpoint), `--concurrency=80`
(fewer instances ⇒ the in-memory limits stay closer to the configured ones), `--cpu-boost`
(buys most of the cold start back), `--timeout=120s`, `--cpu=1 --memory=512Mi`.
`DAILY_LOOKUP_CAP` is computed as `FLEET_DAILY_LOOKUP_CAP / MAX_INSTANCES` — **400 × 5 = 2,000
fleet-wide**. If you change `MAX_INSTANCES`, keep that product at 2,000 or change it
consciously.

> **`RIA_DB_PORT=5432`, not 5439.** There is no Auth Proxy on Cloud Run;
> `--add-cloudsql-instances` mounts the socket and `pg` connects to
> `${host}/.s.PGSQL.${port}`, which Cloud Run creates only at `.s.PGSQL.5432`. Carry the VM's
> 5439 over and every query `ENOENT`s on a path that looks right, silently, while lookups
> degrade to the Places-only path. `smoke-cloudrun.sh` asserts this.

For the cheapest possible footprint, drop the database entirely — `ATTACH_CLOUD_SQL=0` also
forces `RIA_DB_ENABLED=off`, so the revision describes no database it cannot reach:

```bash
ATTACH_CLOUD_SQL=0 ./scripts/cloudrun/deploy-cloudrun.sh
```

The smoke test skips the socket checks in that mode instead of failing. It also asserts
`min-instances=0` — one `gcloud run services update` can switch that off with no error and no
alert, only a bill — measures cold vs. warm `/health`, and runs the person-disclosure
regression on `/v1/firms/{crd}`.

The image is `node:20-slim`, non-root, no build step, one runtime dependency (`pg`), and
`CACHE_SNAPSHOT_PATH=/tmp/…` because the config default is not writable by a non-root user. It
bakes **no secret** — every credential arrives via `--set-secrets` — and it deliberately has no
wait-for-postgres entrypoint, which would turn a Cloud SQL blip into a container that never
becomes ready.

#### VM (always-on, the stronger anti-enumeration posture)

```bash
./scripts/gcp-vm/deploy-gcp-vm.sh          # PROJECT=hushh-tech-prod ZONE=us-central1-c by default
./scripts/gcp-vm/test-vm-api.sh            # public smoke test; SHOW_PEOPLE=1 to print names
```

In order: reads (or mints) `ria-identity-api-key`; reads the two shared secrets; grants the VM
service account `roles/cloudsql.client` and `roles/secretmanager.secretAccessor` (additive
bindings, never `set-iam-policy`); reserves `ria-identity-api-ip` and opens 80/443 to the
`ria-identity-api` tag; creates `ria-identity-api-vm` (Debian 12, e2-medium) if absent;
installs Node 22, Caddy and the pinned Cloud SQL Auth Proxy; installs two systemd units;
writes `/etc/ria-identity.env` at `0600`; and curls `/health` on the VM.

TLS terminates at Caddy on `ria-identity.<STATIC_IP>.sslip.io` (the first handshake provisions
the cert; allow ~30s). The exact host and IP land in `outputs/vm-deployment.json`.

**The Auth Proxy unit is `Wants=`, not `Requires=`.** A database that will not answer is not
fatal: the live Google Places path still resolves a phone on its own, `/health` reports the
reachability honestly, and lookups degrade instead of failing. `Requires=` would turn a proxy
restart into a full outage.

```bash
# operating it
gcloud compute ssh ria-identity-api-vm --zone us-central1-c --command 'sudo systemctl status cloud-sql-proxy --no-pager'
gcloud compute ssh ria-identity-api-vm --zone us-central1-c --command 'sudo journalctl -u ria-identity-api -f'

# Cloud Run logs
gcloud run services logs read ria-identity-api --project hushh-tech-prod --region us-central1 --limit 50

# rotating OUR key (never the two shared secrets — that breaks other services)
printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets versions add ria-identity-api-key --data-file=- --project hushh-tech-prod
./scripts/cloudrun/deploy-cloudrun.sh      # or ./scripts/gcp-vm/deploy-gcp-vm.sh
```

The cache snapshot (IAPD profiles and firm records only — nothing Google-derived, ever) is
warmed before the server accepts traffic and saved on `SIGTERM`/`SIGINT`, so a restart does not
dump every in-flight caller onto the cold path. On the VM it lives at
`/var/lib/ria-identity/cache-snapshot.json` and survives restarts; on Cloud Run it is `/tmp`
and per-instance, so a scale-to-zero starts cold. Losing it costs latency, never correctness.
