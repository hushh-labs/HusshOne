# insider-holdings-api

Company insiders near a location, ranked by the position value **they disclosed
themselves**.

Ask it "who around here has a large disclosed stake, and in what?" and it answers from
filings the people named in them are legally required to make: SEC Section 16 reports
for public-company officers, directors and 10%+ owners, and Form D for the officers and
directors of private companies that raised under Regulation D.

Every upstream is free. There is no paid data vendor, no scraped site, and no
credential beyond the optional bearer key on this service's own routes.

| Input | Source | Cost |
| --- | --- | --- |
| Positions, prices, names, roles | SEC quarterly Form 3/4/5 datasets | $0 |
| Private-company officers and directors | SEC Form D | $0 |
| Sworn net worth (Florida officials) | Florida Form 6 | $0 |
| Proposed sales (liquidity) | SEC Form 144 | $0 |
| Physician ownership stakes | CMS Open Payments | $0 |
| Adviser owners and control persons | SEC Form ADV Schedule A/B | $0 |
| Issuer business addresses | SEC EDGAR submissions API | $0 |
| Street-level coordinates | US Census batch geocoder | $0 |
| Postcode coordinates (fallback) | US Census ZCTA gazetteer | $0 |

Current index: **56,143** Section 16 filers across **6,148** companies (four quarters),
plus **4,660** Form D founders. 4,303 companies are placed at street level and the rest
fall back to a postcode centroid.

---

## What it will not do

This service indexes **only** people under a legal duty to publish, because of a role
they accepted: Section 16 filers of Forms 3/4/5, and the related persons named on a
company's Form D.

It will not name anyone else. No inferred wealth, no property records, no political
donations, no spouses, no private investors. `assertDisclosable` enforces this at
ingest, so a non-qualifying person never enters the index in the first place.

**It never reads a filer's own address.** Form 3/4/5 carries a mailing address, and in
the 2026Q2 dataset only 42% are explicitly "c/o" the company — the rest cannot be
assumed to be business addresses. So every location here is the **issuer's** corporate
headquarters from EDGAR. Proximity means *"works at a company headquartered near you"*,
never *"lives near you"*.

**Form D goes further and is not mapped at all.** For a small private issuer the filed
business address is frequently a residence — in filing `0002133962-26-000001` the issuer
address and both related persons' addresses are the same house. So Form D records are
searchable by name and company, reported at **city and state only**, and never geocoded
or distance-ranked. Ranking them by proximity would put homes on the map indirectly,
which is the one thing this service refuses to do.

Tests fail the build if any owner-address field survives serialisation, or if a street,
postcode or coordinate reaches a Form D response.

---

## Endpoints

| Route | Auth | Returns |
| --- | --- | --- |
| **`GET /v1/around`** | bearer | **Orchestrated view — build against this one** |
| `GET /health` | open | Uptime, index freshness, both dataset sizes |
| `GET /v1/stats` | open | Counters and the disclosure policy. Never per-identity usage |
| `GET /v1/insiders` | bearer | Raw location search, streamed as NDJSON, not collapsed |
| `GET /v1/insiders/{cik}` | bearer | One filer's disclosed positions |
| `GET /v1/issuers/{cik}` | bearer | One company. Never names a person |
| `GET /v1/net-worth` | bearer | **Sworn exact net worth** — Florida Form 6 |
| `GET /v1/liquidity` | bearer | Proposed sales — SEC Form 144 |
| `GET /v1/adviser-owners` | bearer | **~144k** owners/controllers of investment advisers — Form ADV |
| `GET /v1/physician-ownership` | bearer | Physician stakes in drug/device makers — CMS |
| `GET /v1/private-offerings` | bearer | Private-company founders by name or company |

`/v1/around` is the endpoint to integrate with. It answers a location once across every
source, collapses co-filed positions, and states what each source contributed:

```
GET /v1/around?lat=47.6749&lng=-122.2155&radiusMi=25&limit=25

640 raw filings -> 93 duplicates removed -> 547 positions across 50 companies
```

One economic holding is routinely reported by a stack of related entities — one group in
the index has **37 filers** on the same 1,650,000 shares. `/v1/around` merges those into
a single row and lists every filer; `/v1/insiders` returns them all, uncollapsed.

`/v1/private-offerings` has no `lat`/`lng` and never will — see the Form D note below.

### Search parameters

```
GET /v1/around?lat=47.6749&lng=-122.2155&radiusMi=25
GET /v1/insiders?zip=94105&radiusMi=25&limit=25&minValue=1000000
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

Every position carries **two** figures, and they are never merged:

```
disclosedValue = shares × the price on that person's own filing
marketValue    = shares × the security's most recent market price
```

Both come off filings. Nothing is modelled or estimated.

`disclosedValue` answers *"what did they file"*. Its weakness is that the price is
whatever the stock traded at on the day that individual last dealt — so two insiders in
one company are valued at different prices, and a filer who last traded a year ago
carries a year-old price. Bezos's Amazon stake was priced from 2026-05-05 while another
Amazon insider had filed a month later; an SVF holding in Coupang was carrying a price
355 days stale.

`marketValue` answers *"what is it worth"*. Every holder of a security is priced
identically, at the median price of the most recent day that security traded. **Ranking
and totals use it.** `marketPriceAsOf` on each position is the true age of the figure.

**Only transaction codes S, F, P and I may set a price.** Measured across 34,191 priced
rows in 2026Q2 against the same-day median sale price: `M` (option exercise) reports the
strike at **0.299×** market and `X` at **0.158×**, while `A`, `G`, `J` and `C` are 86–97%
zeros. Admitting `M` would understate positions by ~70% — the failure that once valued
Musk's Tesla stake at $9.6B instead of $287.4B. Prices are keyed per **security**, never
per issuer, so a Berkshire Class A holder can never be priced at the Class B price.

A derivative is worth its **intrinsic** value only: options over 100,000 shares at a $50
strike are not worth $50m when the stock trades at $500, because the holder must pay the
strike. Underwater options are `0`, never negative. A strike of exactly `0` is a
restricted stock unit, which converts for free and carries full market value.

**This is not a net worth.** It is one holding in one company — the person may hold ten
other things this service cannot see. A position that could never be priced returns
`null`, never `0`, because an unknown value is not a value of zero; those rows sort last
but are still returned with their share count intact.

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
| `INSIDER_API_KEY` | *(empty)* | Legacy fallback key for every `/v1/*` route |
| `INSIDER_PROFESSIONAL_API_KEY` | `INSIDER_API_KEY` | Key for professional/filing routes |
| `INSIDER_FORM6_API_KEY` | `INSIDER_API_KEY` | Separate key for `/v1/net-worth` |
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
