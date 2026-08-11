# insider-holdings-api — integration guide

Who around here holds a large, publicly disclosed stake — and in what?

This service answers that from SEC Section 16 filings. It is the same shape as the RIA
and BrokerCheck services in this repo: a regulator compels a named group of people to
publish something, and we make that filing usable.

## Base URL

Set by deployment. `/health` is open; every `/v1/*` route needs
`Authorization: Bearer <key>` when `INSIDER_API_KEY` is configured.

---

## Read this before you build a screen

Three properties of this data will shape your UI more than the field list will.

**1. Location is the company's, not the person's.** Every distance is measured to the
issuer's headquarters as filed with EDGAR. This service never reads a filer's own
address. So the honest label for a result is *"CFO at a company 3 miles away"*, never
*"lives 3 miles away"*. If your copy implies the second, it is wrong and it is the kind
of wrong that gets someone hurt.

**2. A value is one position, at one past moment.** `disclosedValue` is the shares on
the filer's most recent Form 3/4/5 multiplied by the price disclosed **on that filing**.
It is not a live quote and it is emphatically not the person's net worth — they may hold
ten other things this service cannot see, and the price may be months old. Show `asOf`
next to any figure.

**3. `null` is not zero.** A filer whose latest filing carried no price (Form 3 initial
statements and gifts do not) returns `disclosedValue: null` with the share count intact.
Render that as "shares disclosed, no price on file" — not as "$0", and not by hiding the
row. They sort last but they are real filers.

---

## `GET /v1/insiders` — the search

```
GET /v1/insiders?zip=94105&radiusMi=25&limit=25&minValue=1000000
```

| Parameter | Default | Max | Notes |
| --- | --- | --- | --- |
| `lat` + `lng` | — | — | Preferred; echoed as `resolvedFrom: "coordinates"` |
| `zip` | — | — | Resolved to a ZIP centroid, `resolvedFrom: "postal"` |
| `radiusMi` | 25 | 500 | |
| `limit` | 25 | 100 | |
| `offset` | 0 | 10000 | Ranking is stable, so paging never reorders |
| `minValue` | 0 | — | Dollars. Drops unpriced rows when above 0 |
| `stream` | `ndjson` | — | `json` returns one buffered object |

### The stream

Newline-delimited JSON, three frame types.

```json
{"type":"meta","resolved":{"lat":37.789,"lng":-122.396},"resolvedFrom":"postal",
 "radiusMi":25,"total":412,"returned":25,"hasMore":true,"issuersInRange":38,
 "index":{"quarter":"2026q2","builtAt":"…","ageDays":9.8},"attribution":{…}}

{"type":"insider","rank":1,"insider":{
  "cik":"1214128","name":"COOK TIMOTHY D","roles":["Officer"],"title":"Chief Executive Officer",
  "position":{"issuerCik":"320193","issuerName":"Apple Inc.","ticker":"AAPL",
              "security":"Common Stock","shares":3214080,"pricePerShare":171.3,
              "disclosedValue":550571904,"asOf":"2026-06-30","formType":"4"},
  "issuer":{"cik":"320193","name":"Apple Inc.","city":"CUPERTINO","state":"CA",
            "street1":"ONE APPLE PARK WAY","zip":"95014"},
  "distanceMiles":0,"distanceApproximate":true,"geoPrecision":"zip_centroid",
  "otherIssuersInRange":1,
  "profileUrl":"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=…&type=4"}}

{"type":"done","ms":41,"returned":25}
```

Render `meta` immediately, append each `insider` as it lands, stop on `done`.

`geoPrecision: "zip_centroid"` is on every row for a reason: Census centroids place
every address in a postcode at one point. A `distanceMiles` of `0` means *same
postcode*, not *same building*. Sub-half-mile distances are floored to 0 rather than
printed as a decimal that implies precision the source does not have.

---

## `GET /v1/insiders/{cik}` — one filer

Their positions across every issuer in the index, with `disclosedValue` summed across
the **priced** ones only.

```json
{"ok":true,"insider":{
  "cik":"1214128","name":"COOK TIMOTHY D","roles":["Officer"],"titles":["Chief Executive Officer"],
  "issuerCount":1,"disclosedValue":550571904,
  "positionsValued":1,"positionsUnvalued":0,
  "positions":[{"issuerCik":"320193","ticker":"AAPL","shares":3214080,
                "pricePerShare":171.3,"value":550571904,"asOf":"2026-06-30",
                "issuer":{"cik":"320193","name":"Apple Inc.","city":"CUPERTINO","state":"CA"}}]}}
```

`positionsValued` and `positionsUnvalued` are given separately so you can say
"$550.6M across 1 of 1 positions" rather than presenting a partial total as complete.

## `GET /v1/issuers/{cik}` — one company

Company record only. **This route never returns a person's name**, whatever the caller
asks for — the same firm/person split the RIA service uses.

## `GET /health`

Open. Reports index age and a `stale` flag. The SEC publishes quarterly, so an
`ageDays` in the tens is normal; `stale` only trips past `STALE_AFTER_DAYS` (200).

---

## Who is in the index, and who never will be

**In:** officers, directors, and greater-than-10% owners of US public companies — people
who file Forms 3, 4 and 5 themselves under Section 16 of the Securities Exchange Act of
1934. Congress created that duty for public scrutiny of self-dealing. Surfacing these
filings is their intended use.

**Never in:** anyone who does not personally file. No spouses, no private investors, no
wealth inferred from property records, donations, or any other trace. Enforced at ingest
by `assertDisclosable`, which throws rather than guessing when a relationship string is
unfamiliar.

If you need people outside that set, this is the wrong service and the answer is not to
widen it.

---

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Bad query. Body carries `field` naming the parameter |
| `401` | Missing or wrong bearer key |
| `404` | Unknown CIK, or no route |
| `429` | Rate limited. `retry-after` header and `retryAfterSec` in the body |

Mid-stream failures emit a terminal `{"type":"error"}` frame rather than truncating
silently, so a partial list is always distinguishable from a complete one.
