# Advisors API — integration guide

Find financial advisers near a location. Send coordinates (or a ZIP), get back a
distance-ranked list with full professional profiles, streamed as they resolve.

Everything is handled server-side by this API: geo resolution, upstream calls to FINRA,
ranking, de-duplication, caching, pagination. **You call one URL.**

```
https://brokercheck.35.253.255.106.sslip.io
```

---

## 1. Your key

| | |
|---|---|
| Header | `Authorization: Bearer <key>` |
| Format | 64-character hex string |
| Where it lives | GCP Secret Manager · project `hushh-tech-prod` · secret `brokercheck-api-key` |

Get it once and put it in your app's environment:

```bash
gcloud secrets versions access latest --secret=brokercheck-api-key --project hushh-tech-prod
```

Permission denied? Ask for `roles/secretmanager.secretAccessor` on that secret, or run:

```bash
gcloud secrets add-iam-policy-binding brokercheck-api-key \
  --member="user:YOU@hushh.ai" --role="roles/secretmanager.secretAccessor" \
  --project hushh-tech-prod
```

If your app runs on Cloud Run, mount it rather than pasting the value — then key rotation
needs no code change:

```bash
gcloud run services update YOUR_SERVICE --project YOUR_PROJECT --region YOUR_REGION \
  --set-secrets=ADVISORS_API_KEY=projects/hushh-tech-prod/secrets/brokercheck-api-key:latest
```

### One rule: the key stays on your server

Call this API from your **route handler / BFF**, not from browser code. Anything shipped to
the browser — including `NEXT_PUBLIC_*` env vars — is readable by every visitor via devtools,
and a leaked key means anyone can drive traffic through your quota.

```
browser  ──►  your /api/advisors  ──►  this API
              (holds the key)          (holds nothing — no FINRA creds, no DB)
```

That proxy is ~15 lines. There's a complete copy-paste version in §5.

---

## 2. Quickstart

```bash
BASE=https://brokercheck.35.253.255.106.sslip.io
AUTH="Authorization: Bearer $ADVISORS_API_KEY"

# health — no key needed
curl $BASE/health

# 10 nearest advisers to a coordinate
curl -H "$AUTH" "$BASE/v1/advisors?lat=47.6769&lng=-122.2060&radiusMi=10&limit=10"

# same thing by ZIP
curl -H "$AUTH" "$BASE/v1/advisors?postalCode=98033&radiusMi=10&limit=10"

# one adviser, and one firm
curl -H "$AUTH" $BASE/v1/advisors/1781753
curl -H "$AUTH" $BASE/v1/firms/149777
```

---

## 3. `GET /v1/advisors`

### Parameters

| Param | Default | Notes |
|---|---|---|
| `lat` + `lng` | — | Required, **or** use `postalCode`. (`lon` is accepted too.) |
| `postalCode` | — | Alternative to coordinates. Alias: `zip`. Resolves to the ZIP centroid. |
| `radiusMi` | `10` | Statute miles, 0.1–100. May be auto-tightened — see §6. |
| `limit` | `50` | Results per page, 1–500. |
| `offset` | `0` | Page cursor. Send `meta.nextOffset` for "show more". |
| `type` | `ia` | `ia` = investment advisers · `broker` · `both`. |
| `status` | `active` | `active` · `previous` · `all`. |
| `minExperienceYears` | — | Server-side filter; costs nothing extra. |
| `detail` | `true` | `false` = stubs only, no profile hydration. Much faster. |
| `firmContact` | `true` | Joins employer phone + office address onto each row. |
| `groupBy` | `auto` | `person` · `branch` · `auto`. See §6. |
| `stream` | `ndjson` | `ndjson` · `sse` · `off`. |
| `batchSize` | `10` | Rows per streamed frame. |

### Choosing a `stream` mode

| Mode | Use when | Content-Type |
|---|---|---|
| `ndjson` | default; progressive rendering, server-to-server | `application/x-ndjson` |
| `sse` | you want browser `EventSource` semantics | `text/event-stream` |
| `off` | you just want one JSON blob | `application/json` |

---

## 4. The stream

Frames arrive in this order. One JSON object per line (`ndjson`).

```jsonc
// 1. Immediately — render your map + skeleton rows off this
{"type":"meta","resolved":{"lat":47.6769,"lng":-122.206},"resolvedFrom":"coordinates",
 "estimatedTotal":2099,"radiusMi":5,"radiusRequested":10,"radiusAdjusted":true,
 "offset":0,"limit":10,"returned":10,"available":300,"hasMore":true,"nextOffset":10,
 "grouped":false,"cache":"warm","truncatedBy":"candidateCeiling",
 "geoPrecisionNote":"Distances are computed from ZIP-centroid coordinates ..."}

// 2. Cards, nearest first — paint these as they land
{"type":"batch","seq":1,"items":[ /* … */ ]}
{"type":"batch","seq":2,"items":[ /* … */ ]}

// 3. Ordering is now final
{"type":"ranking_final","total":10,"mode":"person","hasMore":true,"nextOffset":10}

// 4. Full profiles, keyed by CRD — merge into the card already on screen
{"type":"detail","crd":"862222","profile":{ /* … */ }}

// 5. Terminal
{"type":"done","ms":3981,"returned":10,"hydrated":10,"failed":0}
```

Also possible: `{"type":"detail_error","crd":"…","error":"…"}` for a single profile that
failed to hydrate (the rest of the stream is unaffected), and `{"type":"error","error":"…"}`
as a terminal mid-stream failure.

**`estimatedTotal` vs `available` — don't confuse them.** `estimatedTotal` is FINRA's count for
the whole radius. `available` is how many we actually ranked and can page through. They differ
when `truncatedBy` is set. **Render `available`** as "N advisers found" — showing
`estimatedTotal` promises rows the API cannot deliver.

**Why ordering freezes before details arrive.** The list is fully ranked before the first
card is emitted, so rows never re-shuffle while the user is reading. `detail` frames fill in
behind a layout that has already settled. Render stubs immediately; don't wait for details.

### A `batch` item

```json
{
  "crd": "862222",
  "name": "CHRISTINE NOELLE COTE",
  "otherNames": [],
  "isBroker": true,
  "isInvestmentAdvisor": true,
  "yearsExperience": 47.5,
  "hasDisclosures": true,
  "distanceMeters": 800,
  "distanceMiles": 0.47,
  "distanceApproximate": true,
  "geoPrecision": "zip_centroid",
  "location": { "lat": 47.673156, "lng": -122.197628 },
  "firm": {
    "firmId": "149777",
    "firmName": "MORGAN STANLEY",
    "branchCity": "Kirkland", "branchState": "WA", "branchZip": "98033",
    "phone": "914-225-1000",
    "officeAddress": {
      "street1": "2000 WESTCHESTER AVENUE", "city": "PURCHASE",
      "state": "NY", "postalCode": "10577-2530",
      "formatted": "2000 WESTCHESTER AVENUE, PURCHASE, NY 10577-2530"
    },
    "firmType": "Limited Liability Company", "firmSize": "Large",
    "reportUrl": "https://files.brokercheck.finra.org/firm/firm_149777.pdf"
  }
}
```

That's enough to render a complete card — **no detail fetch required**.

### A `detail` profile

```json
{
  "crd": "862222", "name": "CHRISTINE NOELLE COTE",
  "yearsExperience": 47.5,
  "firmCount": 7,
  "firmHistory": [
    { "firmName": "MORGAN STANLEY", "current": true, "registrationBeginDate": "6/1/2009" },
    { "firmName": "SMITH BARNEY", "current": false,
      "registrationBeginDate": "3/1/1993", "registrationEndDate": "6/1/2009" }
  ],
  "exams": [ { "category": "Series 7", "name": "General Securities Representative",
               "takenDate": "12/16/1989", "scope": "BC" } ],
  "examCounts": { "state": 2, "principal": 0, "product": 2 },
  "registeredStates": [ { "state": "Washington", "scope": "BC", "status": "APPROVED" } ],
  "registeredSROs": [ { "sro": "FINRA", "status": "APPROVED", "categories": ["GS"] } ],
  "registrationCounts": { "sro": 1, "finra": 1, "state": 51, "advisorState": 0 },
  "hasDisclosures": true,
  "disclosures": [
    { "eventDate": "11/4/1999", "type": "Regulatory", "resolution": "Final",
      "detail": { "Initiated By": "…", "Allegations": "…", "SanctionDetails": [ … ] } }
  ],
  "isBarred": false,
  "branches": [ { "street1": "4000 Carillon Point", "city": "Kirkland",
                  "state": "WA", "zip": "98033", "branchOfficeId": "408168" } ],
  "reportUrl": "https://files.brokercheck.finra.org/individual/individual_862222.pdf"
}
```

⚠️ `disclosures[].detail` is an **open key/value bag with no fixed schema** — the keys differ
by disclosure type. Render it generically (iterate entries); don't destructure fixed fields.

---

## 5. Copy-paste integration

### Your server route (Next.js App Router)

```ts
// app/api/advisors/route.ts
export const runtime = "nodejs";

export async function GET(request: Request) {
  const incoming = new URL(request.url).searchParams;

  // Allow-list what the browser may control; never forward arbitrary params.
  const params = new URLSearchParams();
  for (const key of ["lat", "lng", "postalCode", "radiusMi", "limit", "offset",
                     "type", "minExperienceYears", "detail", "groupBy"]) {
    const value = incoming.get(key);
    if (value) params.set(key, value);
  }

  const upstream = await fetch(
    `${process.env.ADVISORS_API_BASE}/v1/advisors?${params}`,
    { headers: { Authorization: `Bearer ${process.env.ADVISORS_API_KEY}` } },
  );

  // Pass the stream straight through — do not await .text(), that defeats streaming.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
```

### Your client

```ts
export async function findAdvisors(
  { lat, lng, limit = 10, offset = 0 },
  { onMeta, onCards, onDetail },
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/advisors?lat=${lat}&lng=${lng}&limit=${limit}&offset=${offset}`, { signal });
  if (!response.ok) throw new Error(`advisors: ${response.status}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are newline-delimited; the last piece may be incomplete — keep it buffered.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.type === "meta") onMeta(frame);                     // paint skeletons
      else if (frame.type === "batch" || frame.type === "branches")
        onCards(frame.items);                                       // paint cards
      else if (frame.type === "detail") onDetail(frame.crd, frame.profile); // fill in
      else if (frame.type === "error") throw new Error(frame.error);
    }
  }
}
```

Usage — the browser's own geolocation feeds it directly:

```ts
navigator.geolocation.getCurrentPosition(({ coords }) => {
  findAdvisors({ lat: coords.latitude, lng: coords.longitude }, {
    onMeta:   (m) => setState({ total: m.available, nextOffset: m.nextOffset, hasMore: m.hasMore }),
    onCards:  (items) => setCards((prev) => [...prev, ...items]),
    onDetail: (crd, profile) =>
      setCards((prev) => prev.map((c) => (c.crd === crd ? { ...c, profile } : c))),
  });
});
```

**"Show 10 more":** re-call with `offset = meta.nextOffset`. The ranking is cached server-side,
so the next page costs no upstream work and cannot re-order what's already on screen. Stop
when `hasMore` is `false`.

---

## 6. Three behaviours to design around

### Distances are approximate — always render `~`

FINRA geocodes offices to **ZIP centroids**, not rooftops. Three different Kirkland buildings
share one coordinate. So:

- every row carries `geoPrecision: "zip_centroid"` and `distanceApproximate: true`
- distances are floored to 500 m and rounded to 100 m
- **everyone in the same ZIP shares a distance**, tiebroken by most-experienced-first

Show `~0.5 mi`, never `0.47 mi`, and never `0 m`.

### Results may switch from people to branches

Adviser density varies ~25× at the same radius, because large firms register thousands of
reps to one HQ address (Times Square: **74,928 within one mile**). When a person list would
be dominated by a single address, the response returns **branch offices** instead:

- `meta.grouped: true`, and frames are typed `branches` rather than `batch`
- each item has `firmName`, `advisorCount`, `distanceMeters`, and `advisors[]` (top 5)

Handle both shapes. Suburban queries return people; dense metros return branches.

### The radius may be tightened

A Manhattan request for 25 miles comes back as ~1.6 miles. Compare `radiusRequested` against
`radiusMi` and surface it when `radiusAdjusted` is true — *"showing advisers within 1.6 miles"*.

`truncatedBy` (`candidateCeiling` | `finraPagingWindow`) tells you the list is partial. It is
never silently truncated.

---

## 7. Other endpoints

```
GET /health              open, no key — liveness
GET /v1/stats            cache sizes + hit rates
GET /v1/advisors/{crd}   one profile + their current employer
GET /v1/firms/{crd}      firm record — contact, ownership, registrations, disclosures
```

`GET /v1/firms/149777` returns Morgan Stanley: phone, office and mailing addresses, firm
type/size, SEC numbers, 10 direct owners, registrations, disclosures.

⚠️ Note the shape difference. On the **standalone** endpoint contact details are nested:
`firm.contact.phone`, `firm.contact.officeAddress`. On a **search row** the same values are
flattened onto the firm summary: `item.firm.phone`, `item.firm.officeAddress`. Search rows
already carry that summary, so you rarely need this endpoint — reach for it when you want
ownership or full registration history.

---

## 8. Errors

| Status | Meaning |
|---|---|
| `400` | Bad input — `{"ok":false,"error":"lat must be between -90 and 90","type":"QueryError"}` |
| `401` | Missing or wrong bearer key |
| `429` | Per-IP rate limit; honour the `retry-after` header |
| `502` | Upstream FINRA failure |

Errors before the stream starts are a JSON body with the status. Errors **mid-stream** arrive
as a terminal `{"type":"error"}` frame on an HTTP 200 response — so check frame types, not
just `response.ok`.

---

## 9. Performance

| | |
|---|---|
| Cold query (new area) | ~2–3 s |
| Warm query | **~1 s** |
| Page 2+ | no upstream calls — served from the cached ranking |
| Detail hydration | streams behind the cards, ~0.3–1 s |

A cold query fetches the **whole radius** — up to ~20 FINRA pages in parallel — so that
suburbs inside the radius are actually reachable. That work happens once per area per 6 hours;
every caller after the first gets the warm path.

Three server-side caches: branch coordinates (permanent), profiles (7 days), firms (30 days),
ranked queries (6 hours, keyed on a ~600 m geohash cell so nearby users share a result).

Nothing to configure — just don't block your first paint on `done`.

---

Source: FINRA BrokerCheck. Every response carries an `attribution` block — surface the source
credit and links in any UI that displays this data.
