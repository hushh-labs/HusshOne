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

Set by deployment. `/health` and `/v1/stats` are open; every other route needs
`Authorization: Bearer <key>` when `INSIDER_API_KEY` is configured.

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
    "people": 547,
    "companies": 50,
    "positionsPriced": 450,
    "positionsUnpriced": 97,
    "sumOfLargestDisclosedPositions": 345019794510,
    "topEmployersByDisclosedValue": [
      {"cik": "1018724", "name": "AMAZON COM INC", "people": 41, "disclosed": 204455354121}
    ]
  },

  "total": 547,
  "returned": 25,
  "hasMore": true,
  "collapsedFrom": 640,
  "duplicatesRemoved": 93,

  "people": [ /* see below */ ],
  "sources": { /* see below */ },
  "attribution": { /* see below */ }
}
```

`summary` describes the **whole radius**, not the returned page. `collapsedFrom` is how
many raw filings that radius held before co-filed positions were merged.

### A person row

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

## Five things that will shape your UI more than the field list

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

### 2. A value is one position, at one past moment

`disclosedValue` is shares × the price disclosed **on that filing**. It is not a live
quote and it is **not the person's net worth** — they may hold ten other things this
service cannot see, and the price may be months old. Always show `asOf` next to a figure.

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

### 5. `filerCount > 1` means one position, several filers

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
