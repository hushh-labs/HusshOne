# NWS v4 One consumer handoff

## What ships

`/nearby` is the calm One UI for public Net Worth Score signals by U.S. area. The browser uses an
additive, same-origin v4 BFF:

| Surface | Role |
| --- | --- |
| `GET /nearby` | ZIP or approximate-location UI. |
| `POST /api/nws/v4/nearby` | Authenticated One BFF and browser-safe response curator. |
| `POST /v4/location-consent/receipt` | NWS consent receipt issuer, called only by the BFF. |
| `POST /v4/net-worth/discover` | NWS v4 discovery endpoint, called only by the BFF. |

Compatibility is deliberate: `POST /api/nws/nearby` and `src/lib/nws/contracts.ts` remain the
legacy v3 contract. Existing v3 consumers do not receive a response-shape change. New work should
use `/api/nws/v4/nearby` and `src/lib/nws/v4-contracts.ts`.

NWS is a 0–100 fixed-scale representation of a supported public net-worth estimate. Location
selects a public candidate area; it does not change a person's score. Associations are not a claim
of residence or live presence.

## Authentication and privacy

The UI sends its existing Firebase bearer token to the BFF. The BFF verifies that token and fails
closed with `401 authentication_required` if no signed-in subject is available.

The verified Firebase UID, email, name, and token are never sent to NWS. The BFF derives a stable,
product-scoped opaque actor (`one-user:<32 hex>`) with HMAC-SHA256 over the verified UID and a
dedicated One-only pseudonymization key. ZIP and
coordinate calls therefore bind to the same user without a shared service-wide audit actor.

The BFF also:

- keeps the NWS API key server-only;
- pins the NWS origin to the approved Cloud Run host;
- adds no permissive CORS headers;
- coarsens coordinates to two decimals;
- never sends coordinates to the consent receipt endpoint;
- never returns coordinates, receipts, raw UID, policy/audit internals, components, raw citations,
  contact data, or street-level data to the browser; and
- returns `Cache-Control: private, no-store`.

`X-Request-ID` is minted by One as `nwsbff_<uuid>`. A validated NWS-generated ID may be returned
separately as `X-NWS-Request-ID`; caller-supplied or malformed upstream IDs are ignored.

## Requests

ZIP and ZIP+4:

```json
{
  "query": { "postal_code": "60637", "country_code": "US" },
  "count": 100
}
```

Approximate device location:

```json
{
  "query": { "latitude": 47.67, "longitude": -122.21 },
  "count": 100,
  "consent_granted": true
}
```

Rules:

- `count` is exactly `100`, `150`, or `200`; the UI currently requests `100`.
- Send either a U.S. postal code or both coordinates, never a mixed/partial location.
- Coordinates require literal `consent_granted: true`; ZIP requests must omit it.
- Stringified numbers, non-finite coordinates, unknown fields, invalid ZIPs, and oversized bodies
  fail before NWS is called.

For coordinates, the BFF first calls the receipt endpoint with the opaque actor, purpose, scope,
and consent decision. It validates the signed receipt (up to 512 bytes), verifies actor binding,
then attaches the receipt to discovery. The browser never handles the receipt.

## Curated response

The v4 browser response contains only:

- contract and coverage contract identifiers;
- coarse query/coverage labels;
- snapshot date;
- discovered, evaluated, and eligible counts;
- expansion status without raw steps;
- requested, returned, eligible, and shortfall counts;
- explicit limitations; and
- ranked public profiles with estimate range, NWS uncertainty, confidence, observed floor, coarse
  public association, date, and source-family domains.

`result_set.shortfall_count` is always explicit. A valid response may discover people but return no
eligible NWS profiles; for example, `60 discovered`, `0 eligible`, and `100 short` is distinct from
an unresolved location or outage. The UI labels all incomplete states as partial public coverage.

The contract always discloses that nationwide financial coverage and geographic hierarchy are not
complete, and that public association is not live presence. It does not imply that 100 results are
available for every ZIP.

## Error behavior

| Status | Client code | UI |
| --- | --- | --- |
| `401` | `authentication_required` | Sign in required |
| `409` | `coverage_unavailable` | Coverage unavailable |
| `422` | `invalid_request` | Check location |
| `429` | `rate_limited` | Too many searches |
| `503` | `service_unavailable` | Source unavailable |
| `504` | `upstream_timeout` | Search timed out |
| `502` | `invalid_upstream_response` | Invalid/drifted upstream response, not forwarded |

Location denial, timeout, or unavailable geolocation stays in the UI and offers ZIP fallback.

## Runtime configuration

Cloud Run service `one` in project `hushone-app` needs:

| Environment name | Required | Value/source |
| --- | --- | --- |
| `NWS_NEARBY_V4_API_KEY` | Yes | Secret reference `projects/hushh-tech-prod/secrets/nws-husshone-v4-api-key:2` |
| `NWS_NEARBY_V4_ACTOR_HMAC_KEY` | Yes | `projects/hushone-app/secrets/nws-husshone-v4-actor-hmac-key:1`; dedicated random actor pseudonymization key, pinned to a numbered version |
| `NWS_NEARBY_V4_BASE_URL` | No | Defaults to and only accepts `https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app` |

Never use a `NEXT_PUBLIC_` name for the NWS key. Existing Firebase client/admin configuration stays
unchanged. Production must keep `NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH` and `ONE_ENABLE_DEV_AUTH` false.

The current root deployment entrypoints deploy a new image while preserving service configuration:

- `cloudbuild.yaml`
- `.github/workflows/deploy-prod.yml`
- `scripts/deploy-prod.sh`

Before the first v4 UI deploy, bind both secrets on `one`. Create the actor HMAC secret in One's
security boundary, keep it independent of the NWS API key, pin a numbered version, and retain it
across API-key rotations so audit identity remains stable. Confirm the active runtime service
account has `roles/secretmanager.secretAccessor` only on those specific secrets. Do not copy either
value into source or GitHub Actions.

## Verification

```bash
npx vitest run \
  src/lib/nws/contracts.test.ts \
  src/app/api/nws/nearby/route.test.ts \
  src/lib/nws/v4-contracts.test.ts \
  src/app/api/nws/v4/nearby/route.test.ts \
  src/app/nearby/NearbyPeople.test.tsx

npx eslint \
  src/lib/nws/v4-contracts.ts \
  src/lib/nws/v4-contracts.test.ts \
  src/test/nws-v4-fixtures.ts \
  src/app/api/nws/v4/nearby/route.ts \
  src/app/api/nws/v4/nearby/route.test.ts \
  src/app/nearby/NearbyPeople.tsx \
  src/app/nearby/NearbyPeople.test.tsx \
  src/app/nearby/page.tsx

npx tsc --noEmit
```

For live acceptance, separately prove the merged source, CI, Cloud Run revision/traffic, authenticated
v4 route behavior, and a signed-in real browser/device flow. A deployed NWS revision alone does not
prove that One has the secret binding or that `/nearby` is using v4.
