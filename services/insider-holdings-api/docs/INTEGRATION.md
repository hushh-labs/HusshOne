# insider-holdings-api — integration guide

Who around here holds a large, publicly disclosed stake — and in what?

This service answers that from filings the people named in them are legally required to
make. It is the same shape as the RIA and BrokerCheck services in this repo: a regulator
compels a named group to publish something, and we make that filing usable.

Every upstream is free. No paid data vendor, nothing scraped, no runtime dependencies.

| Input | Source | Cost |
| --- | --- | --- |
| Positions, prices, names, roles | SEC quarterly Form 3/4/5 datasets | $0 |
| Private-company officers and directors | SEC Form D | $0 |
| Company business addresses | SEC EDGAR submissions API | $0 |
| Street-level coordinates | US Census batch geocoder | $0 |
| Postcode coordinates (fallback) | US Census ZCTA gazetteer | $0 |

## Base URL

Set by deployment. `/health` and `/v1/stats` are open. When
`INSIDER_REQUIRE_API_KEY` is enabled, every other route needs
`Authorization: Bearer <key>`. Use `INSIDER_PROFESSIONAL_API_KEY` for professional
filing routes and a distinct `INSIDER_FORM6_API_KEY` for `/v1/net-worth`.
`INSIDER_API_KEY` remains a legacy fallback for either scope.

---

## Start here: `GET /v1/around`

**This is the endpoint to build against.** One call, every source, duplicates collapsed,
and an explicit statement of what each source did and did not contribute.

```
GET /v1/around?lat=47.6749&lng=-122.2155&radiusMi=25&limit=25
```

```json
{
  "ok": true,
  "resolved": {"lat": 47.6749, "lng": -122.2155},
  "resolvedFrom": "coordinates",
  "radiusMi": 25,

  "summary": {
    "holders": 547,
    "naturalPersons": 537,
    "entities": 10,
    "companies": 50,
    "positionsPriced": 450,
    "positionsUnpriced": 97,
    "positionsRepriced": 431,

    "sumOfLargestPositionsAtMarket": 391284553017,
    "sumOfLargestPositionsAsFiled": 345019794510,
    "pricedThrough": "2025-08-22",

    "heldByNaturalPersons": 208418890189,
    "heldByEntities": 136600904321,
    "topEmployersByValue": [
      {"cik": "1018724", "name": "AMAZON COM INC", "people": 17, "disclosed": 204455354121}
    ]
  },

  "total": 547,
  "returned": 25,
  "hasMore": true,
  "collapsedFrom": 640,
  "duplicatesRemoved": 93,
  "subjectTypeFilter": null,

  "holders": [ /* see below */ ],
  "sources": { /* see below */ },
  "attribution": { /* see below */ }
}
```

`summary` describes the **whole radius**, not the returned page. `collapsedFrom` is how
many raw filings that radius held before co-filed positions were merged.

**`sumOfLargestPositionsAtMarket` is the headline number** — every holder priced at their
security's most recent market price. `sumOfLargestPositionsAsFiled` is the same holders
valued as each of them filed, kept so the two are comparable rather than blended.

**`pricedThrough` is the oldest market price behind the total**, deliberately the weakest
link rather than the most flattering one. Show it next to any figure: the SEC publishes
quarterly, so it trails the current quarter and a single rarely-traded security can drag
it back further.

### A holder row

```json
{
  "cik": "1214128",
  "name": "Jassy Andrew R",
  "roles": ["Director", "Officer"],
  "title": "President and CEO",
  "filerCount": 1,
  "filers": [{"cik": "1214128", "name": "Jassy Andrew R", "roles": ["Director","Officer"]}],

  "position": {
    "issuerCik": "1018724", "issuerName": "AMAZON COM INC", "ticker": "AMZN",
    "security": "Common Stock, par value $.01  per share",
    "kind": "direct",
    "shares": 2215333, "pricePerShare": 263.1, "strikePrice": null,
    "disclosedValue": 582854112,

    "marketValue": 589661927,
    "marketPrice": 266.19,
    "marketPriceAsOf": "2026-06-03",
    "marketPriceBasis": "security",
    "repricedFrom": 263.1,
    "priceMovedSuspiciously": false,

    "asOf": "2026-05-26", "formType": "4"
  },

  "issuer": {
    "cik": "1018724", "name": "AMAZON COM INC", "tickers": ["AMZN"],
    "exchanges": ["Nasdaq"], "industry": "Retail-Catalog & Mail-Order Houses",
    "street1": "410 TERRY AVENUE NORTH", "city": "SEATTLE", "state": "WA", "zip": "98109",
    "phone": "2062661000",
    "reportUrl": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=…&type=4"
  },

  "distanceMiles": 6.7,
  "distanceApproximate": true,
  "geoPrecision": "street_interpolated",
  "otherIssuersInRange": 1,
  "profileUrl": "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=…&type=4"
}
```

---

## Six things that will shape your UI more than the field list

### 1. Location is the company's, never the person's

Every distance is measured to the **issuer's** business address as filed with EDGAR.
This service never reads a filer's own address — not for placement, not for display.

So the honest label is *"CFO at a company 6.7 miles away"*, never *"lives 6.7 miles
away"*. If your copy implies the second it is wrong, and it is the kind of wrong that
gets someone hurt.

`geoPrecision` tells you what the coordinate is worth:

| Value | Meaning |
| --- | --- |
| `street_interpolated` | Geocoded to the street, interpolated along Census TIGER address ranges — accurate to tens of metres, not rooftop-exact |
| `zip_centroid` | The centre of a postcode. Every address in that postcode shares one point, so `0` means *same postcode*, not *same building* |

Centroid distances under half a mile are reported as `0` rather than a decimal that
implies precision the source cannot support. Street-level distances are not floored,
because there 0.2 miles is a real measurement.

### 2. Two values per position, and you almost always want `marketValue`

Every position carries both:

| Field | Meaning | Use it for |
| --- | --- | --- |
| `disclosedValue` | shares × the price on **that person's own filing** | showing what was filed |
| `marketValue` | the same shares × the security's **most recent market price** | ranking, totals, any "how rich" reading |

`disclosedValue` is priced on whatever day that individual last traded, so two people
holding the same stock get different prices and someone who last filed a year ago
carries a year-old price. Live example: Bezos's Amazon stake was priced at `$231.11`
from 2026-05-05 while another Amazon insider had filed at `$266.19` on 2026-06-03, and
an SVF holding in Coupang was still carrying a price from 2025-08-22 — **355 days
stale**.

`marketValue` prices every holder of a security identically, at the median price of the
most recent day it traded. `/v1/around` ranks and totals on it.

**`marketPriceAsOf` is the real age of the number**, not `asOf` (which dates the share
count). The SEC publishes these datasets quarterly, so market prices trail the current
quarter by up to a few months — check `index.pricing.pricedThrough` on `/health` for the
ceiling across the whole index.

`marketPriceBasis` says where the price came from:

- `security` — a market-priced trade in this exact security. The normal case.
- `issuer` — the issuer's principal security. **Derivatives only**, because an option
  grant discloses no price of its own.
- `filed` — no market price existed for this security; `pricePerShare` stands.
- `none` — never priced at all; `marketValue` is `null`.

Neither figure is **the person's net worth**. They may hold ten other things this
service cannot see.

#### Why only four transaction codes set a price

A Form 4 price column means different things depending on the transaction code, and most
of them are not the market price of the share. Measured across all 34,191 priced
non-derivative rows in 2026Q2, as a ratio of the same issuer/security/day median sale:

| Code | Meaning | Ratio vs sale | Used? |
| --- | --- | --- | --- |
| `S` `F` `P` `I` | sale, tax withholding, purchase, discretionary | 0.996–1.000 | **yes** |
| `M` | option exercise — reports the **strike** | **0.299** | no |
| `X` | derivative exercise — reports the **strike** | **0.158** | no |
| `A` `G` `J` `C` | grant, gift, other, conversion | 86–97% are `$0` | no |

Letting `M` set a price understates a position by ~70%. That is the same failure that
once valued Musk's Tesla stake at $9.6B instead of $287.4B.

Share classes are priced separately, always — on 85 issuer-days two classes of one
company differed by more than 5%, and a Berkshire Class A holder priced at the Class B
price would be understated roughly 1500×. A share position whose exact security has no
market-priced trade keeps its filed price rather than borrowing the issuer's.

`priceMovedSuspiciously` is `true` when re-pricing moved a position more than 3× in
either direction. That is usually a share split — the filing's share count is pre-split
while the price is post-split — so treat the figure with care rather than as a real move.

### 3. `null` is not zero

A filer whose latest filing carried no price returns `disclosedValue: null` with the
share count intact. Render it as *"shares disclosed, no price on file"* — not `$0`, and
do not hide the row.

This matters more than it sounds. Privately-held issuers file a price of `0.00` because
no public price exists; taken literally that valued an 842-million-share SpaceX position
at zero. A price of `0.00` is parsed as *no price*.

### 4. Options are not shares

`kind` is `direct` (shares owned outright) or `derivative` (options, RSUs, warrants).

For a derivative, `shares` is the number of **underlying** shares and `disclosedValue`
is **intrinsic worth only**: `shares × (marketPrice − strikePrice)`. Options over 100,000
shares at a $50 strike are not worth $50m when the stock trades at $500 — the holder
must pay the strike. Underwater options are worth `0`, never a negative number. A strike
of exactly `0` is a restricted stock unit, which converts for free and carries full
market value.

Label these differently in your UI. "Holds $45m in options" and "holds $45m in stock"
are not the same claim.

### 5. Not every "holder" is a human being

Section 16 names funds, holding companies and sovereign investors alongside people.
Around Kirkland 10 of the 547 holders are corporations, and they hold **$136.6bn of
the $345bn total — 39%** — `DEUTSCHE TELEKOM AG` at $128bn is a German telecoms group, not
somebody's neighbour.

Every row carries `subjectType`, either `person` or `entity`, and you can filter:

```
GET /v1/around?lat=…&lng=…&subjectType=person
```

The summary reports the split both ways — `naturalPersons` / `entities` and
`heldByNaturalPersons` / `heldByEntities` — and is always computed over the whole area
*before* the filter, so switching the filter never changes the totals.

Be aware this is a **name heuristic, not a fact from the filing**: Section 16 has no
person/entity flag. It is tuned to prefer calling something a person when uncertain,
because wrongly labelling a human as a company would silently hide them behind the
filter.

### 6. `filerCount > 1` means one position, several filers

A single economic holding is routinely reported by a stack of related entities — one
group in the index has **37 filers** on the same 1,650,000 shares, and 3,713 groups are
co-filed. `/v1/around` collapses these into one row and lists every filer in `filers`.

Where a fund stack includes a natural person, the person becomes the headline name
instead of an LLC. Show `filerCount` when it is above 1 so the reader knows a fund
structure is behind the number.

`/v1/insiders` does **not** collapse. If you use the raw feed, expect duplicates.

---

## `GET /v1/insiders` — the raw feed

Same search, streamed, no collapsing. Use it when you want every filing row.

| Parameter | Default | Max | Notes |
| --- | --- | --- | --- |
| `lat` + `lng` | — | — | Preferred; echoed as `resolvedFrom: "coordinates"` |
| `zip` | — | — | Resolved to a postcode centroid, `resolvedFrom: "postal"` |
| `radiusMi` | 25 | 500 | |
| `limit` | 25 | 100 | |
| `offset` | 0 | 10000 | Ranking is stable, so paging never reorders |
| `minValue` | 0 | — | Dollars. Drops unpriced rows when above 0 |
| `stream` | `ndjson` | — | `json` returns one buffered object |

Newline-delimited JSON, three frame types:

```json
{"type":"meta","total":640,"issuersInRange":50,"index":{…},"attribution":{…}}
{"type":"insider","rank":1,"insider":{…}}
{"type":"done","ms":85,"returned":25}
```

Render `meta` immediately, append each `insider` as it lands, stop on `done`. A
mid-stream failure emits a terminal `{"type":"error"}` frame rather than truncating, so
a partial list is always distinguishable from a complete one.

## `GET /v1/liquidity` — proposed sales, SEC Form 144

Everything else here reports what someone **holds**. This reports what they have
signalled they may **sell**, in exact dollars the filer supplied. Shares are not cash,
and a large holder who has noticed no sale is in a different position from one who has
noticed $50m.

```
GET /v1/liquidity?name=barrett
GET /v1/liquidity?issuer=expensify&minValue=1000000
```

```json
{"ok": true, "total": 1,
 "people": [{
   "name": "David Barrett", "filerCik": "1892682", "roles": ["Director","Officer"],
   "noticeCount": 2, "largestProposedSale": 24859.9,
   "notices": [{"issuerName":"Expensify, Inc.","unitsToBeSold":19123,
                "proposedSaleValue":24859.9,"approxSaleDate":"06/15/2026","exchange":"NASDAQ"}]
 }]}
```

A Form 144 is a **notice of intent**, not a completed sale, and the same shares may be
noticed more than once. So these figures are **never summed and never added to a
holding**. `largestProposedSale` is the biggest single notice, not a total.

Where a Form 144 filer CIK matches a Section 16 row, `/v1/around` attaches a compact
`liquidity` block to that person — so a row can say "holds $582m, and has noticed an
intent to sell up to $24m" rather than leaving you to guess whether the stake is liquid.

## `GET /v1/net-worth` — sworn net worth, Florida

**The only source in this service that reports an actual net worth**, and the only US
regime that publishes one. Article II §8(j)(1) of the Florida Constitution requires
certain officials to file *"a sworn statement showing net worth"* — an exact figure they
swore to, not a band and not a model.

```
GET /v1/net-worth?county=hillsborough&limit=25
GET /v1/net-worth?name=latimer
GET /v1/net-worth?office=sheriff&minNetWorth=1000000
```

```json
{"ok": true, "total": 2841,
 "people": [{
   "name": "Craig Latimer", "prefix": "Hon",
   "offices": ["Supervisor Of Elections - Elected Constitutional Officer"],
   "county": "Hillsborough", "formYear": 2025,
   "netWorth": 6629408.00,
   "filingUrl": "https://disclosure.floridaethics.gov/api/Report/RenderPdf/…/False"
 }]}
```

Read the difference carefully. Everywhere else in this service, a figure is **one
holding in one company** — Bezos's Amazon stake, not Bezos's wealth. Here it is the
person's **whole declared position**, sworn under the Florida Constitution.

**Only a bounded net-worth field on page one is extracted.** Raw filings and the asset,
liability, and income schedules are not retained or emitted, because Form 6 instructs
filers to identify real property *"by providing the street address of the property"* —
so those schedules can contain home addresses.
Location is the **county and office** the person is elected to serve. There are no
coordinates and this endpoint takes no `lat`/`lng`.

A missing figure is `null`, never `0`: filings before form year 2023 are scans with no
text layer, and treating one as zero would rank a scanned filer as the poorest official
in Florida. Negative net worth is real and is preserved — Form 6 prints a deficit in
parentheses.

## `GET /v1/private-offerings` — private-company founders

Officers, directors and promoters named on a company's **Form D** — the filing a private
company makes when it raises under Regulation D. This is the founder population, which
Section 16 cannot see at all.

```
GET /v1/private-offerings?name=gerstner
GET /v1/private-offerings?company=altimeter&state=MA
```

**There is no `lat`, `lng` or `radiusMi` here, and there will not be.** A small private
issuer's filed address is frequently the founder's home — in one real filing the issuer
address and both related persons' addresses are the same house. So these records are
never geocoded or distance-ranked, and **city and state are the finest granularity this
route returns**. The person's own address is never read.

```json
{"ok": true, "total": 6,
 "people": [{
   "name": "Brad Gerstner", "roles": ["Executive Officer"],
   "company": {"cik":"…","name":"Altimeter Premier Growth Expansion",
               "entityType":"Limited Partnership","city":"BOSTON","state":"MA"},
   "offerings": [{"totalOfferingAmount":1500000000,"totalAmountSold":1500000000}],
   "largestOfferingAmount": 1500000000
 }]}
```

`largestOfferingAmount` is money the **company** raised. Form D states no ownership share
for any named person, so no personal wealth figure can be derived from it — a founder
may hold 60% of one raise or 2% of another. The field is deliberately not called `value`.

## `GET /v1/insiders/{cik}` — one filer

Their positions across every issuer, with `disclosedValue` summed over the **priced**
ones only. `positionsValued` and `positionsUnvalued` are reported separately so you can
say "$550.6M across 1 of 2 positions" rather than presenting a partial total as complete.

## `GET /v1/issuers/{cik}` — one company

Company record only. **This route never returns a person's name**, whatever the caller
asks for — the same firm/person split the RIA service uses.

## `GET /health` — open

```json
{"ok": true,
 "index": {"quarters":["2025q3","2025q4","2026q1","2026q2"],
           "people":56143,"issuers":6148,
           "issuersStreetLevel":4303,"issuersZipCentroid":610,
           "peopleStreetLevel":42437,"ageDays":0,"stale":false},
 "privateOfferings": {"people":4660}}
```

Both dataset sizes are reported here on purpose. A dataset that fails to reach the
container produces an endpoint that answers every query with zero results and no error,
so `people: 0` on this check is how you catch it.

The SEC publishes quarterly, so an `ageDays` in the tens is normal; `stale` only trips
past `STALE_AFTER_DAYS` (200).

---

## Who is in the index, and who never will be

**In:** people under a legal duty to publish, because of a role they accepted.

- **Section 16 filers** — officers, directors and greater-than-10% owners of US public
  companies, who file Forms 3, 4 and 5 by name under the Securities Exchange Act of 1934.
  Congress created that duty for public scrutiny of self-dealing; surfacing these filings
  is their intended use.
- **Form D related persons** — executive officers, directors and promoters of private
  companies that raised under Regulation D.

**Never in:** anyone who does not personally appear on such a filing. No spouses, no
private investors, no wealth inferred from property records, donations, social profiles
or any other trace. Enforced at ingest by `assertDisclosable()`, which throws rather than
guessing when a relationship is unfamiliar.

**No home addresses, ever.** Not the filer's, and — for Form D — not the issuer's either.
Tests fail the build if a street, postcode or coordinate reaches a Form D response, or if
any owner-address field survives serialisation anywhere.

If you need people outside that set, this is the wrong service, and the answer is not to
widen it.

---

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Bad query. Body carries `field` naming the parameter |
| `401` | Missing or wrong bearer key |
| `404` | Unknown CIK, or no route |
| `429` | Rate limited. `retry-after` header and `retryAfterSec` in the body |

Rate limiting is per client, read from `x-forwarded-for` counting back
`TRUSTED_PROXY_COUNT` hops from the right — so rotating the leftmost value cannot win a
fresh budget.

---

## Attribution

Every response carries an `attribution` block naming the SEC as the source and stating
the two caveats most likely to be misread: that a position value is one holding at one
past moment rather than a net worth, and that location is the issuer's business address
rather than the person's. The SEC's own record at `sec.gov` is authoritative.
