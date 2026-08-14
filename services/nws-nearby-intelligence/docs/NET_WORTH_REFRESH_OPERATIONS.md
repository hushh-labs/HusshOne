# Net-worth snapshot refresh operations

Status: production infrastructure contract, 2026-08-14.

This document covers the background publisher and publication lane used by `POST
/v3/nearby-net-worth/discover` and `POST /v4/net-worth/discover`. The query API remains a
standalone, low-latency read plane. It does not start crawlers, hold an SSH credential, or write
evidence.

## Architecture

```text
Cloud Scheduler (OAuth)
        |
        v
Cloud Run Job: nws-net-worth-refresh-v4
        |
        +--> current reviewed upstream snapshot adapter
        +--> policy and source-registry validation
        +--> deterministic identity and ledger validation
        |
        v
gs://hushh-tech-prod-nws-published-snapshots
  published/net-worth-v1.0.0/registry-v4/releases/<snapshot-id>.json  (immutable)
  published/net-worth-v1.0.0/registry-v4/active.json                   (CAS pointer)
        |
        v
FastAPI query service (objectViewer only)
```

The job writes an immutable release first. It advances `active.json` only with a Cloud Storage
generation precondition. A concurrent or stale writer fails instead of overwriting a newer
release. The active pointer contains the snapshot object generation and SHA-256; the reader
verifies both before accepting the snapshot.

The older `nws-net-worth-refresh` job and `published/net-worth-v1.0.0/active.json` pointer are a
separate registry-v3 rollback lane. The current production API reads only the `registry-v4`
prefix. Operators must not execute, inspect, or roll back the legacy lane as if it were the active
v4 data plane.

The initial production source remains the partial Florida Form 6 declared-net-worth roster. The
job transforms the current reviewed artifact already exposed by the server-side upstream API. It
does not crawl Florida filings, rebuild that upstream artifact, or increase geographic coverage.
A job success means that a valid, source-disclosed derivative snapshot was published. It does not
mean nationwide named financial coverage or a complete Florida census.

### Relationship to the social scraper fleet

This lane reuses the proven operational shape—standalone worker, dedicated identity, scheduled
execution, health/audit evidence, and Secret Manager—but not the LinkedIn or Instagram machines.
It shares no VM, browser profile, login session, cookie, disk, public port, SSH credential, or
default Compute service account with those collectors. Social sources remain discovery-only and
cannot publish a financial claim or NWS value.

## Dedicated identities

| Identity | Access |
| --- | --- |
| `nws-net-worth-collector-v4@hushh-tech-prod.iam.gserviceaccount.com` | Write registry-v4 release objects and CAS pointer; read the numbered Form 6 upstream secret. |
| `nws-net-worth-scheduler@hushh-tech-prod.iam.gserviceaccount.com` | Invoke the active `nws-net-worth-refresh-v4` job; a separate legacy-job grant remains for the rollback lane. |
| `nws-nearby-runtime@hushh-tech-prod.iam.gserviceaccount.com` | Read published snapshot objects; existing API dependencies only. |
| `nws-nearby-deployer@hushh-tech-prod.iam.gserviceaccount.com` | Update and execute the preprovisioned job during a governed release. |

The setup script uses prefix-conditioned bucket IAM, a bucket-metadata viewer role, secret-level
IAM, and job-level IAM. It does not grant `Editor`, project-wide Secret Manager access, or an SSH
role. It never prints secret values.

## One-time setup

An operator with the required administrative permissions runs the script separately from CI. The
script requires explicit project, region, immutable image digest, and numbered secret version. It
defaults to a dry run.

A secret administrator must first provision a numbered `nws-form6-api-key` version and configure
the upstream Form 6 route to accept that dedicated credential. The script deliberately neither
creates the secret nor copies a value from the legacy shared `insider-api-key` secret.

```bash
cd services/nws-nearby-intelligence

./scripts/setup-net-worth-refresh-production.sh \
  --project hushh-tech-prod \
  --region us-central1 \
  --image 'us-central1-docker.pkg.dev/hushh-tech-prod/cloud-run-source-deploy/nws-nearby-intelligence@sha256:<digest>' \
  --form6-secret-version 1
```

Review the plan, then apply:

```bash
./scripts/setup-net-worth-refresh-production.sh \
  --project hushh-tech-prod \
  --region us-central1 \
  --image 'us-central1-docker.pkg.dev/hushh-tech-prod/cloud-run-source-deploy/nws-nearby-intelligence@sha256:<digest>' \
  --form6-secret-version 1 \
  --bucket hushh-tech-prod-nws-published-snapshots \
  --apply
```

The script is idempotent for service accounts, bucket controls, IAM bindings, the Cloud Run Job,
and the Scheduler job. Existing resources with incompatible controls fail verification. It does
not execute the refresh job.

Required bucket controls:

- Uniform bucket-level access.
- Public access prevention enforced.
- Object versioning enabled.
- 30-day soft delete.
- No browser-facing CORS configuration.

## Job interface

The active Cloud Run Job is named `nws-net-worth-refresh-v4` and runs:

```text
python -m app.jobs.refresh_net_worth
```

Production configuration:

| Variable | Value |
| --- | --- |
| `NWS_SNAPSHOT_BUCKET` | `hushh-tech-prod-nws-published-snapshots` |
| `NWS_SNAPSHOT_PREFIX` | `published/net-worth-v1.0.0/registry-v4` |
| `NWS_SOURCE_REGISTRY_PATH` | `/app/config/sources.yaml` |
| `NWS_SOURCE_REGISTRY_MANIFEST_PATH` | `/app/config/source-registry-manifest.json` |
| `NWS_SOURCE_REGISTRY_SHA256` | Reviewed SHA-256 of `sources.yaml`; pinned in setup and CI. |
| `NWS_SOURCE_REGISTRY_VERSION` | Reviewed registry version; currently `4`. |
| `NWS_FORM6_API_BASE_URL` | Existing server-side `insider-holdings-api` URL |
| `NWS_FORM6_API_KEY` | Numbered `nws-form6-api-key` secret mount, job only. |
| `NWS_FORM6_TIMEOUT_SECONDS` | `8` |
| `NWS_FORM6_REQUEST_INTERVAL_SECONDS` | `2.1`; stays within the upstream 30-request/minute budget. |
| `NWS_FORM6_MAX_RATE_LIMIT_RETRIES` | `2`; only bounded `429` retries are permitted. |
| `NWS_FORM6_MAX_RETRY_AFTER_SECONDS` | `30`; larger or invalid delays fail closed. |
| `NWS_FORM6_REFRESH_DEADLINE_SECONDS` | `600`; the full 67-county refresh cannot run indefinitely. |
| `NWS_SNAPSHOT_MAX_RECORDS_PER_JURISDICTION` | `1000` |

The FastAPI read plane also pins `NWS_SNAPSHOT_MAX_AGE_HOURS=24` and
`NWS_SNAPSHOT_MAX_SOURCE_AGE_HOURS=720`. A newer derivative snapshot cannot hide an expired
reviewed source index; `/ready` fails closed when either bound is exceeded.

The API receives the bucket, prefix, and the same immutable registry pins. The route-scoped
`nws-form6-api-key` must exist before setup and must be accepted only by the upstream Form 6
route. Its credential belongs to the job; it is intentionally removed from the FastAPI revision.
The default six-hour Scheduler cadence revalidates and republishes the reviewed upstream
artifact; it is not an upstream filing crawler.

## Release path

The production workflow performs these gates in order:

1. Wait for NWS CI on `main`.
2. Build one immutable image and resolve its digest.
3. Verify that the preprovisioned refresh job and published bucket exist.
4. Update the job to that exact image digest and numbered source secret.
5. Execute the job synchronously. A nonzero task aborts the release.
6. Verify `active.json` references a release object with the expected schema and matching hash.
7. Deploy the FastAPI candidate at zero traffic with bucket/prefix read configuration.
8. Require `/ready` to expose a loaded snapshot ID and SHA-256.
9. Smoke the v2, v3, and v4 contracts, including coordinate-consent single use and replay denial.
10. Promote the candidate; any post-promotion failure restores the previous API revision.

An infrastructure administrator must run setup before the first workflow. CI does not create
service accounts, buckets, Scheduler jobs, or broad IAM bindings.

### Route-key rotation without downtime

The professional and Form 6 keys must contain different values. Rotate them with numbered
Secret Manager versions and a zero-traffic upstream revision:

1. Deploy `insider-holdings-api` at zero traffic with both new route-specific versions.
2. Prove each new key returns `200` only on its own route and `401` on the other route.
3. Publish the snapshot with the still-live Form 6 version.
4. Point a zero-traffic NWS candidate at the tagged upstream revision and the new professional
   key, then smoke and promote NWS.
5. Promote the upstream revision, repoint NWS to the canonical upstream URL, and update the
   refresh job to the new Form 6 version.
6. Run one successful refresh before disabling the superseded versions.

Never copy the legacy shared key into two newly named secrets; different names alone do not
create credential isolation.

## Manual execution and probes

Run and wait:

```bash
gcloud run jobs execute nws-net-worth-refresh-v4 \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --wait
```

Inspect executions without displaying payload data:

```bash
gcloud run jobs executions list \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --job=nws-net-worth-refresh-v4 \
  --limit=5 \
  --format='table(name.basename(),completionTime,succeededCount,failedCount,cancelledCount)'
```

Verify the active pointer and immutable release digest without printing people:

```bash
TMP_DIR="$(mktemp -d)"
gcloud storage cp \
  gs://hushh-tech-prod-nws-published-snapshots/published/net-worth-v1.0.0/registry-v4/active.json \
  "$TMP_DIR/active.json" \
  --project=hushh-tech-prod

jq '{snapshot_id,schema_version,snapshot_object,snapshot_generation,snapshot_sha256,published_at}' \
  "$TMP_DIR/active.json"
```

Verify the API reader:

```bash
NWS_URL="$(gcloud run services describe nws-nearby-intelligence \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --format='value(status.url)')"

curl --fail-with-body "$NWS_URL/ready" | jq \
  '{status,net_worth_snapshot_id,net_worth_snapshot_sha256,net_worth_snapshot_generated_at}'
```

## Rollback

API rollback and data rollback are separate.

For an API regression, restore the prior Cloud Run revision:

```bash
gcloud run services update-traffic nws-nearby-intelligence \
  --project=hushh-tech-prod \
  --region=us-central1 \
  --to-revisions='<previous-revision>=100'
```

For a bad snapshot, do not delete the immutable release. Prepare a reviewed pointer JSON for the
previous immutable release, then replace `active.json` only if it still has the generation you
inspected:

```bash
TMP_DIR="$(mktemp -d)"
ACTIVE_URI='gs://hushh-tech-prod-nws-published-snapshots/published/net-worth-v1.0.0/registry-v4/active.json'

CURRENT_ACTIVE_GENERATION="$(gcloud storage objects describe "$ACTIVE_URI" \
  --project=hushh-tech-prod \
  --format='value(generation)')"
test -n "$CURRENT_ACTIVE_GENERATION"

# An operator must review this complete file. It must reference the prior immutable
# release object, that object's exact generation and SHA-256, and the approved registry.
test -s "$TMP_DIR/previous-active.json"
jq -e '
  .schema_version == "nws-net-worth-active-pointer-v1" and
  (.snapshot_id | type == "string" and length > 0) and
  (.snapshot_object | startswith("published/net-worth-v1.0.0/registry-v4/releases/")) and
  (.snapshot_generation | test("^[1-9][0-9]*$")) and
  (.snapshot_sha256 | test("^[0-9a-f]{64}$")) and
  .snapshot_schema_version == "nws-net-worth-snapshot-v1" and
  (.source_registry_sha256 | test("^[0-9a-f]{64}$"))
' "$TMP_DIR/previous-active.json" >/dev/null

gcloud storage cp "$TMP_DIR/previous-active.json" "$ACTIVE_URI" \
  --project=hushh-tech-prod \
  --if-generation-match="$CURRENT_ACTIVE_GENERATION"
```

The publisher uses the same compare-and-swap rule; an unconditional pointer upload is
prohibited. A generation-precondition failure means another publisher won the race: stop,
reinspect, and do not retry blindly. After restoring the pointer, restart or redeploy the API
reader if it does not refresh snapshots automatically, then verify `/ready` reports the intended
snapshot ID and hash. Remove `TMP_DIR` when the evidence is no longer needed.

Pause the recurring refresh during an upstream incident:

```bash
gcloud scheduler jobs pause nws-net-worth-refresh-v4 \
  --project=hushh-tech-prod \
  --location=us-central1
```

Resume only after a manual job execution and pointer/API verification succeed.

## Existing social scraper reuse boundary

HusshOne already operates persistent-browser VMs for LinkedIn, Instagram, Threads, and X. NWS may
reuse their operational lessons—persistent Chromium, narrow systemd workers, staged queues,
backoff, session-health signals, and human login through an SSH/IAP tunnel—but not their data or
public network shape by default.

The current social VMs expose public network ports and some use plain HTTP with bearer tokens.
They also use a broad default Compute service account. Those controls must not be copied into NWS.

If a future reviewed NWS source truly requires a browser:

- Use a dedicated no-external-IP VM and dedicated least-privilege identity.
- Deliver jobs over a private queue or VPC path.
- Keep noVNC and DevTools on localhost; use IAP/OS Login only for human challenges.
- Never bypass login, CAPTCHA, checkpoint, consent, or rate limits.
- Write raw artifacts to a governed immutable evidence vault, not VM local disk.
- Use public social profiles for identity discovery/corroboration only.
- Never infer assets, liabilities, residence, or NWS from followers, posts, photos, check-ins, or
  lifestyle.

The public FastAPI service must never receive an SSH key, scraper bearer key, Chrome profile,
write permission, or request-time scrape capability.
