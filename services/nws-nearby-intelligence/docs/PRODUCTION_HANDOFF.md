# NWS Nearby Intelligence — production handoff

This document is the operator checklist for the standalone US national NWS service. Read the
canonical [US national coverage handoff](US_NATIONAL_COVERAGE_HANDOFF.md) before operating it.

## Service identity

| Item | Value |
| --- | --- |
| Repository path | `hushh-labs/HusshOne/services/nws-nearby-intelligence/` |
| Runtime | Python 3.13 / FastAPI / Cloud Run |
| Cloud Run service | `nws-nearby-intelligence` |
| Project / region | `hushh-tech-prod` / `us-central1` |
| Public base URL | `https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app` |
| Discovery route | `POST /v2/nearby-network/discover` |
| Public probes | `GET /health`, `GET /ready` |
| Data mode | `NATIONAL_PUBLIC_PROFESSIONAL_SNAPSHOT` with reviewed Kirkland compatibility |
| Geography | 33,791-record 2025 Census Gazetteer ZCTA package |
| National sources | SEC Section 16 Officers/Directors and CMS NPPES active individuals |

The service is separate from the HusshOne `one` web application: separate runtime identity,
container image, secrets, deployment workflow, Cloud SQL read role, and rollback history.

## Integration boundary

Products call through their BFF/server route using `X-NWS-API-Key`. Wildcard non-cookie CORS
removes origin allowlist friction but does not protect a key in browser/mobile code.

```bash
curl --fail-with-body -X POST \
  -H 'Content-Type: application/json' \
  -H "X-NWS-API-Key: $NWS_API_KEY" \
  -d '{"query":{"postal_code":"60637"},"top_n":60}' \
  'https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app/v2/nearby-network/discover'
```

The consumer must parse `coverage.status`, treat covered-but-sparse results as valid, and render
public-association rather than physical-presence language. `98033` stays on its reviewed release;
other resolved US locations use the national fan-out.

## IAM, secrets, and database

| Purpose | Resource |
| --- | --- |
| Runtime identity | `nws-nearby-runtime@hushh-tech-prod.iam.gserviceaccount.com` |
| Build identity | `nws-nearby-build@hushh-tech-prod.iam.gserviceaccount.com` |
| Deploy identity | `nws-nearby-deployer@hushh-tech-prod.iam.gserviceaccount.com` |
| Cloud SQL instance | `hushh-tech-prod:us-central1:hushh-directories-db` |
| NPPES database / role | `healthcare` / `nws_nearby_ro` |
| Discovery secret | `nws-nearby-api-key` |
| SEC source secret | `insider-api-key` |
| NPPES database secret | `nws-nearby-nppes-db-password` |

These are resource names only. Never put values in source, docs, command output, screenshots, or
browser storage. The deployment workflow references explicit numbered versions, not `latest`.

The NPPES runtime role may execute only `public.nws_public_professionals_by_postal` and
`public.nws_public_professionals_nearby`. It must not receive `SELECT` on `public.providers`,
`public.zips`, or the owner-inspection view. Apply the expand migration in
[`sql/nppes_read_model.sql`](../sql/nppes_read_model.sql), promote and probe the function-calling
revision, then apply the view-revocation contract in
[`sql/nppes_read_model_contract.sql`](../sql/nppes_read_model_contract.sql). Use
`psql -v ON_ERROR_STOP=1`, then run
[`sql/verify_nppes_read_model.sql`](../sql/verify_nppes_read_model.sql) as `nws_nearby_ro`.

Cloud Run delivery uses Workload Identity Federation and dedicated service accounts; there is no
NWS SSH key or persistent application VM login.

## Delivery

1. `.github/workflows/nws-nearby-ci.yml` runs tests, Ruff, compilation, dependency checks, and
   national geography/source-adapter gates.
2. `.github/workflows/deploy-nws-nearby-production.yml` accepts a successful same-repository main
   CI run or main-only manual dispatch.
3. The workflow builds an immutable image, resolves its digest, deploys with the Cloud SQL
   attachment and numbered secrets, then probes `/health` and `/ready`.
4. The standalone NWS workflow/path exclusions prevent an NWS-only change from redeploying the
   unrelated `one` application.

Proof must distinguish main SHA, CI success, image digest, deployed revision, traffic, probe
success, national-source health, and authenticated business responses.

## Production sign-off

After each deploy, verify:

1. Intended SHA is on `main` and NWS CI/deploy workflows succeeded.
2. Expected Cloud Run revision has 100% traffic and the dedicated runtime identity.
3. `/health` and `/ready` return `200` with expected service/data mode.
4. Missing/invalid key returns `401`.
5. `60637` is `COVERED`, uses the national backend, and exposes SEC/NPPES source status without
   Kirkland records.
6. With the healthy release snapshots, `60637` and `top_n: 60` returns at least 60 results. This is
   a release-health probe, not a universal ZIP guarantee.
7. `98033` stays on the reviewed 60-record Kirkland release with manifest hashes.
8. Additional US regions and one sparse/rural ZCTA route nationally and report truthful counts.
9. An explicit India coordinate returns `NOT_COVERED` and no people.
10. An unknown ZCTA returns `LOCATION_UNRESOLVED` and no people.
11. Arbitrary-origin CORS preflight succeeds without credential support.
12. `/internal/*` and `/v1/*` return `404`.
13. Response/log inspection finds no raw request coordinate, secret, connection string, person
    exact coordinate/address/phone, or financial position/value field.

Inspect revision/traffic explicitly:

```bash
gcloud run services describe nws-nearby-intelligence \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --format='yaml(status.url,status.latestReadyRevisionName,status.traffic)'
```

## Secret rotation

1. Add a new Secret Manager version through the private platform procedure.
2. Update the corresponding numbered version constant in the NWS deployment workflow.
3. Merge and deploy a new revision.
4. Verify source/consumer cutover.
5. Retire the old version only after all callers have moved.

Do not switch a running environment reference to `latest`.

## Source degradation

SEC and NPPES fan out independently. An unavailable source may fail soft while the other returns
results, but source status must disclose the degradation. Do not fill counts from Kirkland, lower
privacy filters, enable BrokerCheck without terms clearance, or infer missing people.

Escalate unexpected SEC ranking contract/value fields, NPPES role/grant drift, stale snapshots,
large `60637` count regression, Cloud SQL saturation, or any prohibited response/log field.

## Rollback

```bash
gcloud run services update-traffic nws-nearby-intelligence \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --to-revisions=<known-good-revision>=100
```

Repeat revision, probe, auth, `60637`, `98033`, non-US, and privacy checks. If the known-good
revision is Kirkland-only, notify consumers that national availability is rolled back; do not keep
advertising nationwide query coverage.
