# Insurance Agents API — integration guide

Find insurance agencies near a location. Send coordinates (or a ZIP), get back a
distance-ranked list with address, phone, insurable products and agency tier, streamed as
they resolve.

**This is the sibling of the [Advisors API](brokercheck-advisors.md) — same input layer, same
stream contract, same key model.** A component that consumes one consumes the other with the
same code; only the per-item fields differ (agencies vs advisers). Everything is handled
server-side: geocoding, upstream calls, ranking, de-duplication, caching, pagination.

```
https://insurance-agents.34.61.69.175.sslip.io
```

> **Scope:** Nationwide agencies (that's what the source locator covers), not a carrier-neutral
> "all insurance agents" feed.

---

## 1. Your key — identical model to the Advisors API

| | |
|---|---|
| Header | `Authorization: Bearer <key>` |
| Where it lives | GCP Secret Manager · project `hushh-tech-prod` · secret `insurance-agents-api-key` |

```bash
gcloud secrets versions access latest --secret=insurance-agents-api-key --project hushh-tech-prod
```

Permission denied? Ask for `roles/secretmanager.secretAccessor` on that secret, or:

```bash
gcloud secrets add-iam-policy-binding insurance-agents-api-key \
  --member="user:YOU@hushh.ai" --role="roles/secretmanager.secretAccessor" \
  --project hushh-tech-prod
```

On Cloud Run, mount it (don't paste the value):

```bash
gcloud run services update YOUR_SERVICE --project YOUR_PROJECT --region YOUR_REGION \
  --set-secrets=INSURANCE_AGENTS_API_KEY=projects/hushh-tech-prod/secrets/insurance-agents-api-key:latest
```

Same rule as the Advisors API: **call this from your server/route handler, never browser code**
— a bearer key shipped to the browser is readable by every visitor. `/health` is open; `/v1/*`
returns `401` without the key.

---

## 2. Quickstart

```bash
BASE=https://insurance-agents.34.61.69.175.sslip.io
AUTH="Authorization: Bearer $INSURANCE_AGENTS_API_KEY"

curl $BASE/health                                                     # no key
curl -N -H "$AUTH" "$BASE/v1/agents?lat=47.6769&lng=-122.2060&limit=10"
curl    -H "$AUTH" "$BASE/v1/agents?postalCode=98033&radiusMi=10&limit=10"
```

### Location input — same as the Advisors API

| Input | `meta.resolvedFrom` | Resolves to |
|---|---|---|
| `lat=47.6769&lng=-122.2060` | `coordinates` | geocoded by the locator; `meta.resolved` echoes the point |
| `postalCode=98033` (alias `zip`, `q`) | `postal` | the ZIP's geocoded centroid |

---

## 3. `GET /v1/agents`

| Param | Default | Notes |
|---|---|---|
| `lat` + `lng` | — | Required, **or** `postalCode`. (`lon` accepted.) |
| `postalCode` | — | A ZIP or "City, ST". Alias: `zip`, `q`. |
| `radiusMi` | — | Optional distance filter (miles). |
| `limit` | `25` | Results per page, 1–200. |
| `offset` | `0` | Page cursor. Send `meta.nextOffset` for "show more". |
| `stream` | `ndjson` | `ndjson` · `sse` · `off`. |
| `batchSize` | `10` | Rows per streamed frame. |

Same param names and semantics as `/v1/advisors`, so the same client call site works for both.

---

## 4. The stream — same frame contract as the Advisors API

```jsonc
// 1. meta — render map + skeletons off this. Same shape as /v1/advisors (resolved, resolvedFrom,
//    available, offset, limit, returned, hasMore, nextOffset, pagesFetched, truncatedBy, cache).
{"type":"meta","resolved":{"lat":47.6688,"lng":-122.1923},"resolvedFrom":"postal",
 "resolvedLocation":{"city":"Kirkland","state":"WA","zip":"98033"},
 "query":"98033","estimatedTotal":704,"available":50,"offset":0,"limit":10,"returned":10,
 "hasMore":true,"nextOffset":10,"pagesFetched":1,"truncatedBy":null,"cache":"warm", ...}

// 2. batch — cards, nearest first. UNLIKE the Advisors API these are already COMPLETE
//    (the source returns full data inline), so there is no follow-up `detail` frame.
{"type":"batch","seq":1,"items":[ /* agencies */ ]}

// 3. ranking_final — ordering frozen (same signal as /v1/advisors)
{"type":"ranking_final","total":10,"mode":"agency","hasMore":true,"nextOffset":10}

// 4. done
{"type":"done","ms":180,"mode":"agency","returned":10,"hasMore":true,"nextOffset":10}
```

Also possible mid-stream: `{"type":"error","error":"…"}` (terminal, on an HTTP 200 body — check
frame types, not just `response.ok`).

**The one difference from the Advisors API:** it emits no `detail` frames, because a `batch`
item is already a complete agency. A client written for the Advisors API works unchanged — it
just never receives `detail` frames to merge. `stream=sse` → `text/event-stream`; `stream=off`
→ one buffered `{ok, meta, agents}` doc.

### An agency (in `batch` frames)

```json
{
  "id": "12345",
  "name": "B G I Agency Network Inc.",
  "address": { "line1": "10829 NE 68th St", "line2": "Ste 202", "city": "Kirkland",
               "region": "WA", "postalCode": "98033",
               "formatted": "10829 NE 68th St, Ste 202, Kirkland, WA 98033" },
  "phone": "(206) 726-0906",
  "email": "…", "website": "https://…",
  "products": ["Auto","Commercial","Farm","Home","Renters"],
  "agencyType": "Elite", "tier": "Tier 1",
  "hours": { … }, "yearEstablished": "1998",
  "social": { "facebook": "…", "instagram": "…", "twitter": "…" },
  "location": { "lat": 47.6812, "lng": -122.1934 },
  "distanceMeters": 354, "distanceMiles": 0.22,
  "distanceApproximate": true, "geoPrecision": "geocoded",
  "source": "nationwide"
}
```

The distance fields (`distanceMeters`, `distanceMiles`, `distanceApproximate`, `geoPrecision`,
`location`) and `address` are the **same shape** as an Advisors API item, so a shared card
renderer handles both. `agencyType: "Elite"` is the ELITE STATUS badge.

---

## 5. Copy-paste integration — same code as the Advisors API

The client and server proxy are identical to the [Advisors API guide §5](brokercheck-advisors.md);
only the path (`/api/agents` → `/v1/agents`) and the item fields differ. Server route:

```ts
// app/api/agents/route.ts
export const runtime = "nodejs";
export async function GET(request: Request) {
  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const key of ["lat", "lng", "postalCode", "radiusMi", "limit", "offset"]) {
    const v = incoming.get(key);
    if (v) params.set(key, v);
  }
  const upstream = await fetch(`${process.env.AGENTS_API_BASE}/v1/agents?${params}`, {
    headers: { Authorization: `Bearer ${process.env.INSURANCE_AGENTS_API_KEY}` },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
```

The NDJSON reader from the Advisors guide works verbatim — switch on `frame.type` for
`meta` / `batch` / `ranking_final` / `done` / `error`. (No `detail` case fires here.)

**"Show 10 more":** re-call with `offset = meta.nextOffset` until `hasMore` is false — same as
the Advisors API. The ranking is cached, so paging costs no upstream calls.

---

## 6. Behaviours to design around

- **Distances are approximate** — geocoded, not rooftop-surveyed. Every item carries
  `geoPrecision: "geocoded"` and `distanceApproximate: true`. Render `~`.
- **Coverage is the nearest ~50 today.** The source pages 50 at a time; `available` reflects
  what we ranked. For "nearest N + radius" that's complete. `truncatedBy` signals when more
  exist upstream than we returned.
- **`estimatedTotal` vs `available`** — same rule as the Advisors API: render `available` as
  "N found"; `estimatedTotal` is the source's count for the whole query.

---

## 7. Other endpoints & errors

```
GET /health     open — liveness
GET /v1/stats   cache + snapshot stats
```

| Status | Meaning |
|---|---|
| `400` | Bad input (`{"ok":false,"error":"…","type":"QueryError"}`) |
| `401` | Missing/wrong bearer key |
| `429` | Per-IP rate limit; honour `retry-after` |
| `502` | Upstream failure |

Errors before the stream are a JSON body; **mid-stream** errors arrive as a terminal
`{"type":"error"}` frame on an HTTP 200 — identical to the Advisors API.

---

Source: Nationwide agency locator. Every response carries an `attribution` block — surface it.
