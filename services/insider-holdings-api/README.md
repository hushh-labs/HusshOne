# insider-holdings-api

Public-company insiders near a location, ranked by the position value **they disclosed
themselves**.

Ask it "who around here has a large disclosed stake, and in what?" and it answers from
the SEC's own Section 16 filings — the reports that officers, directors and 10%+ owners
are legally required to file, by name, precisely so the public can see them.

Every upstream is free. There is no paid data vendor, no scraped site, and no
credential beyond the optional bearer key on this service's own routes.

| Input | Source | Cost |
| --- | --- | --- |
| Positions, prices, names, roles | SEC quarterly Form 3/4/5 datasets | $0 |
| Issuer business addresses | SEC EDGAR submissions API | $0 |
| Postcode coordinates | US Census ZCTA gazetteer | $0 |

---

## What it will not do

This service indexes **only** people who personally file a Form 3, 4 or 5 under
Section 16 of the Securities Exchange Act of 1934. That duty is the whole basis for
naming them: they accepted it with the role, and they filed these numbers themselves.

It will not name anyone else. No inferred wealth, no property records, no political
donations, no spouses, no private investors. `assertDisclosable` enforces this at
ingest, so a non-qualifying person never enters the index in the first place.

**It never reads a filer's own address.** Form 3/4/5 carries a mailing address, and in
the 2026Q2 dataset only 42% are explicitly "c/o" the company — the rest cannot be
assumed to be business addresses. So every location here is the **issuer's** corporate
headquarters from EDGAR. Proximity means *"works at a company headquartered near you"*,
never *"lives near you"*.

A test asserts that no owner-address field can appear in any response.

---

## Endpoints

| Route | Auth | Returns |
| --- | --- | --- |
| `GET /health` | open | Uptime and index freshness |
| `GET /v1/stats` | open | Counters and the disclosure policy. Never per-identity usage |
| `GET /v1/insiders` | bearer | Location search, streamed as NDJSON |
| `GET /v1/insiders/{cik}` | bearer | One filer's disclosed positions |
| `GET /v1/issuers/{cik}` | bearer | One company. Never names a person |

### Search parameters

```
GET /v1/insiders?zip=94105&radiusMi=25&limit=25&minValue=1000000
GET /v1/insiders?lat=37.789&lng=-122.396&radiusMi=10&stream=json
```

| Parameter | Default | Notes |
| --- | --- | --- |
| `lat` + `lng` | — | Preferred. Reported back as `resolvedFrom: "coordinates"` |
| `zip` | — | Resolved through the bundled gazetteer to a ZIP centroid |
| `radiusMi` | 25 | Max 500 |
| `limit` / `offset` | 25 / 0 | Max limit 100 |
| `minValue` | 0 | Filter by disclosed position value in dollars |
| `stream` | `ndjson` | `json` for a single buffered object |

---

## How a position is valued

```
disclosedValue = SHRS_OWND_FOLWNG_TRANS × TRANS_PRICEPERSHARE
```

Both numbers come off the filing. Nothing is modelled or estimated.

**This is not a net worth.** It is one holding in one company as of one filing date, at
the price disclosed on that filing — not a live market price. A filer with no disclosed
price returns `disclosedValue: null`, never `0`, because an unknown value is not a value
of zero; those rows sort last but are still returned with their share count intact.

Ranking uses a person's **single largest position within the search radius**, not a sum
across companies. A sum would blend positions filed on different dates at different
prices into a figure that was never true at any single moment, and would attribute value
to a city where it isn't when someone sits on boards in several places.

---

## Running it

```bash
npm test                                   # 37 tests, no network

export SEC_USER_AGENT="YourOrg contact@example.com"   # the SEC requires this
npm run centroids                          # ~1 MB, once
npm run build-index -- --quarter 2026q2    # ~20 min, one call per issuer

npm start
curl "localhost:8080/health"
```

The SEC requires a descriptive `User-Agent` with a contact address on automated
requests and returns `403` without one. `SEC_USER_AGENT` sets it.

The index build takes roughly twenty minutes because it makes one EDGAR call per
distinct issuer, throttled to half the SEC's published 10-per-second ceiling. It is
built ahead of time and served from memory, so a request never waits on the SEC.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 8080 | |
| `INSIDER_API_KEY` | *(empty)* | When set, all `/v1/*` routes require `Authorization: Bearer <key>` |
| `INSIDER_DATA_DIR` | `./data` | Where the index and centroids live |
| `SEC_USER_AGENT` | — | Required for SEC requests |
| `SEC_RPS` | 5 | Outbound rate to the SEC |
| `RATE_LIMIT_PER_MINUTE` | 30 | Inbound, per client |
| `STALE_AFTER_DAYS` | 200 | `/health` flags an index older than this |

Quarterly data means an index in the tens of days old is normal, not a fault. `/health`
reports the age and a `stale` flag either way rather than implying freshness it lacks.

---

## Attribution

Data comes from SEC Forms 3, 4 and 5, EDGAR, and the US Census Bureau. The SEC's record
at `sec.gov` is authoritative. Every response carries a full attribution block including
the valuation and location caveats above.
