# NWS Nearby Intelligence — Production Handoff

This document is the integration and operations handoff for the standalone NWS Nearby service.

## Service identity

| Item | Value |
| --- | --- |
| Source repository | `hushh-labs/HusshOne` |
| Source directory | `services/nws-nearby-intelligence/` |
| Runtime | Python 3.13 / FastAPI / Cloud Run |
| Cloud Run service | `nws-nearby-intelligence` |
| Project / region | `hushh-tech-prod` / `us-central1` |
| Public base URL | `https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app` |
| Discovery route | `POST /v2/nearby-network/discover` |
| Public probes | `GET /health`, `GET /ready` |
| Current data mode | `VERIFIED_PUBLIC_BOOTSTRAP` |
| Current approved market | Kirkland, Washington / US `98033`, 11 reviewed public-association records |

This Cloud Run service remains separate from HusshOne's `one` web application. Moving the source
into HusshOne does not share its runtime identity, secret, container image, data, or deployment
lane with `one`.

## How a product integrates

1. Collect device-location consent in the product—not in this service.
2. The product's BFF/server route sends a coarse coordinate to this API, plus optional
   `country_code`. For manual location, send `postal_code` and `country_code`.
3. The BFF reads `coverage.status` before rendering results:
   - `COVERED`: render the public-association results.
   - `NOT_COVERED`: show that the location is understood but not yet available.
   - `LOCATION_UNRESOLVED`: ask for approximate location when available or show that postal
     geography is not yet indexed.
4. Never label results as people physically around the user. They are public professional,
   institutional, civic, or opt-in associations only.

Example server-to-server request (the key must come from that project's secret store):

```bash
curl --fail-with-body -X POST \
  -H 'Content-Type: application/json' \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{"query":{"latitude":47.6715,"longitude":-122.2133,"country_code":"US"},"top_n":100}' \
  'https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app/v2/nearby-network/discover'
```

The historical `{"postal_code":"98033"}` request remains compatible. Global postal and
coordinate inputs are accepted safely, but only approved markets receive people. See
[the API contract](API_CONTRACT.md) for exact response semantics.

## Authentication, CORS, and privacy boundary

`NWS_API_KEY` is a server-held secret, injected into Cloud Run from Secret Manager at an immutable
numbered version. It is not browser-safe. The API intentionally has non-cookie wildcard CORS for
`POST` and `OPTIONS`, which removes origin allowlisting friction but does not protect a key exposed
in a browser or mobile bundle.

Each consuming project must use a BFF/server route. Put its access credential in that project's
secret manager and never expose it through `NEXT_PUBLIC_*`, client JavaScript, a mobile bundle,
source control, logs, or DevTools. The current in-process rate limiter is an abuse guard; add
gateway/WAF quotas and per-consumer credential issuance before independently administered or high
volume clients are onboarded.

The service does **not** use an SSH key. Cloud Run is managed with three distinct, least-privilege
runtime, deployer, and builder identities. The runtime can read only its version-pinned API-key
secret; it has no Editor role, project-wide secret access, GitHub credential, Cloud SQL access, or
scraper access. Exact resource identifiers and break-glass operations are maintained in the private
platform runbook rather than this public source repository.

## Delivery path

1. `.github/workflows/nws-nearby-ci.yml` runs only when the NWS service or its deployment workflow
   changes.
2. `.github/workflows/deploy-nws-nearby-production.yml` runs only after a successful `main` CI
   result (or a `main`-only manual dispatch).
3. GitHub OIDC federation is restricted to HusshOne's `main` branch. A privileged workflow-run
   must originate from a same-repository `push`, not a pull request.
4. The workflow uploads only this service directory, builds through a dedicated build identity,
   resolves the Artifact Registry digest, and deploys that immutable image to the standalone Cloud
   Run service.
5. `NWS_API_KEY` is pinned to a numbered Secret Manager version (`1` at this handoff), never
   `latest`.

The unrelated HusshOne Cloud Build trigger for the `one` app ignores NWS-only service and workflow
changes. That keeps an NWS release from redeploying `one`.

## Rotate the API key

1. Add a new version to the service's production API-key secret (exact command is in the private
   platform runbook).
2. Update `NWS_API_KEY_SECRET_VERSION` in
   `.github/workflows/deploy-nws-nearby-production.yml`.
3. Merge and let the workflow deploy a new revision.
4. Verify each BFF has moved before retiring the old key version.

Do not replace a running revision's environment secret reference with `latest`.

## Release and rollback verification

After every deployment, prove all of the following:

1. NWS CI is green and the source SHA is on HusshOne `main`.
2. The new Cloud Run revision has 100% traffic, the dedicated runtime service account, and the
   intended numbered secret reference.
3. `/health` and `/ready` return `200`.
4. Missing or invalid key returns `401`; a valid server-side key returns the covered Kirkland
   contract for `47.6715, -122.2133` and for `98033`.
5. A valid India coordinate returns `200`, `coverage.status: "NOT_COVERED"`, and no results;
   `110001` plus `IN` returns `LOCATION_UNRESOLVED` and no results until postal geography exists.
6. An arbitrary-origin CORS preflight returns `Access-Control-Allow-Origin: *` and does not return
   `Access-Control-Allow-Credentials`.
7. `/internal/*` and `/v1/*` return `404`, and Cloud Run logs contain no raw coordinates or keys.

Rollback a known-good revision without rebuilding source:

```bash
gcloud run services update-traffic nws-nearby-intelligence \
  --region=us-central1 --project=hushh-tech-prod \
  --to-revisions=<known-good-revision>=100
```

## Accountable coverage expansion gate

Do not advertise a country or postal area as complete merely because its location input validates.
Before switching any new market to `COVERED`, the team must have a versioned canonical geography
source, approved public-association records, privacy/suppression controls, an indexed retrieval
snapshot, and negative-coverage tests proving that no Kirkland fallback data leaks into it.
