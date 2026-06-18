# Forward-Deployed Engineer Playbook — Xtreme Compute Burst

**Status:** Runbook — for SE/FDE · **Last updated:** 2026-06-18

The hands-on, end-to-end guide to bring Xtreme Compute Burst to life: validate locally, set up a
customer's BYOC GCP project, deploy the control plane, register the agent, validate live, and operate
it. Pair this with the white paper (the "why") and the specs (the "what"). Commands assume the repo at
the project root.

---

## 0. Prerequisites checklist

| Need | Detail |
|---|---|
| Repo + Node ≥ 20.19 | `npm ci` |
| GCP project (control plane) | `hushone-app`, Cloud Run + Cloud SQL (existing) |
| GCP project (customer BYOC) | The user's own project for bursts (§2) |
| GPU quota | In the burst region/zone of the BYOC project (§2.3) |
| Container image | A workload image the burst VM can pull (§2.4) |
| Gemini Enterprise Agent Platform | Access to register agents/tools (§5) |
| `gcloud` CLI | Authenticated to the relevant projects |

---

## 1. Validate locally (no GCP needed) — do this first

Mock mode exercises the entire flow with zero cloud cost.

```bash
npm ci
npm run test:burst          # 108 burst tests
npm run typecheck           # 0 errors

export ONE_ENABLE_MOCK_BURST=true ONE_ENABLE_DEV_AUTH=true
npm run dev
```

Discovery:
```bash
curl -s localhost:3000/.well-known/agent.json | jq '.name, .skills[].id'
# → "Hushh One — Xtreme Compute Burst", "burst-compute", "placement-advice"
```

A cloud-bound burst (estimate exceeds the Puppy) streams to done:
```bash
curl -N -X POST localhost:3000/api/one/burst \
  -H "Authorization: Bearer DEV_TOKEN" -H "Content-Type: application/json" \
  -d '{"image":"busybox","acceleratorKind":"gpu","acceleratorCount":1,
       "estimate":{"vramGb":300,"unifiedMemoryGb":300,"vcpus":16,"diskGb":100,"estimatedMinutes":30},
       "deviceProfile":{"online":true,"unifiedMemoryGb":192}}'
# → NDJSON: start → progress… → done
```

A Puppy placement (drop the estimate under ~153 GB) returns a handshake:
```bash
curl -s -X POST localhost:3000/api/one/burst -H "Authorization: Bearer DEV_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"image":"busybox","acceleratorKind":"gpu","acceleratorCount":1,
       "estimate":{"vramGb":8,"unifiedMemoryGb":8,"vcpus":4,"diskGb":20,"estimatedMinutes":5},
       "deviceProfile":{"online":true,"unifiedMemoryGb":192}}' | jq '.placement, .handshake.reportResultEndpoint'
```

---

## 2. Set up the customer's BYOC GCP project

### 2.1 Enable APIs
```bash
gcloud config set project CUSTOMER_PROJECT
gcloud services enable compute.googleapis.com
```

### 2.2 Create a dedicated least-privilege service account
Grant only what a burst needs (prefer a custom role over `roles/compute.instanceAdmin.v1`). See
`docs/specs/byoc-security-privacy.md` §5 for the exact permission set and the "do NOT grant" list.
```bash
gcloud iam service-accounts create hushh-burst \
  --display-name="Hushh One Burst (least privilege)"

gcloud iam roles create hushhBurst --project CUSTOMER_PROJECT \
  --title="Hushh Burst" \
  --permissions=compute.instances.create,compute.instances.get,compute.instances.delete,compute.instances.setMetadata,compute.zoneOperations.get,compute.disks.create,compute.subnetworks.use,compute.instances.setServiceAccount

gcloud projects add-iam-policy-binding CUSTOMER_PROJECT \
  --member="serviceAccount:hushh-burst@CUSTOMER_PROJECT.iam.gserviceaccount.com" \
  --role="projects/CUSTOMER_PROJECT/roles/hushhBurst"

gcloud iam service-accounts keys create /tmp/hushh-burst.json \
  --iam-account=hushh-burst@CUSTOMER_PROJECT.iam.gserviceaccount.com
```
> The key is the user's. In production it lives in the user's macOS Keychain and is sent per-request;
> Hushh never stores it. For server-side dogf/single-tenant, inject it via Secret Manager (§3).
> **Roadmap:** prefer Workload Identity Federation (keyless) — security spec §6.

### 2.3 Confirm GPU quota
```bash
gcloud compute regions describe REGION --format="value(quotas)" | tr ',' '\n' | grep -i gpu
# Request more via the Console (IAM & Admin → Quotas) if NVIDIA_*_GPUS is 0.
```

### 2.4 Make the workload image pullable
Push to Artifact Registry in the customer project and ensure the VM's service account can pull it
(`roles/artifactregistry.reader`). Public images work too.

---

## 3. Deploy the control plane

The app deploys to Cloud Run (service `one`, `hushone-app`, us-central1). Use the existing deploy
skill/runbook; then set the burst configuration.

Apply the DB migration (adds `BurstJob`):
```bash
npm run db:deploy          # prisma migrate deploy (idempotent; ADD COLUMN/TABLE IF NOT EXISTS)
```

Runtime config (Cloud Run env / Secret Manager — never commit secrets):
```
ONE_ENABLE_MOCK_BURST=false
BYOC_GCP_REGION=us-central1
ONE_BURST_DEFAULT_MACHINE_TYPE=n1-standard-8
ONE_BURST_DEFAULT_GPU_TYPE=nvidia-tesla-t4
ONE_BURST_TEARDOWN=true
# Optional single-tenant fallback creds (else per-request BYOC / ADC):
# BYOC_GCP_SERVICE_ACCOUNT_JSON=<secret>   BYOC_GCP_PROJECT_ID=<customer-project>
```
Tunables (defaults sane): `ONE_BURST_POLL_INTERVAL_MS`, `ONE_BURST_DEADLINE_MS`,
`ONE_BURST_TIMEOUT_MS`, `ONE_BURST_STATUS_TIMEOUT_MS`, `ONE_BURST_RETRIES`, `ONE_BURST_AUTH_CACHE_SIZE`.

Verify the card is live:
```bash
curl -s https://one.hushh.ai/.well-known/agent.json | jq '.url, .version'
```

---

## 4. Validate a real burst (one controlled run)

With real BYOC creds, submit a tiny GPU job and watch provision → run → **teardown**:
```bash
curl -N -X POST https://one.hushh.ai/api/one/burst \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" -H "Content-Type: application/json" \
  -d '{"image":"<ARTIFACT_REGISTRY_IMAGE>","acceleratorKind":"gpu","acceleratorCount":1,
       "estimate":{"vramGb":300,"unifiedMemoryGb":300,"vcpus":16,"diskGb":100,"estimatedMinutes":10},
       "deviceProfile":{"online":true,"unifiedMemoryGb":192},
       "byoc":{"serviceAccountJson":"<SA_JSON_STRING>","projectId":"CUSTOMER_PROJECT","region":"us-central1"}}'
```
Then confirm **no instance is left behind** (the load-bearing safety check):
```bash
gcloud compute instances list --project CUSTOMER_PROJECT --filter="labels.hussh-burst=1"
# → expect EMPTY after the job settles. If not, see §7 reconciliation.
```
> TPU is intentionally `501` in v1 (real path). Use `acceleratorKind:"gpu"`.

---

## 5. Register the agent on the Gemini Enterprise Agent Platform

Per `docs/specs/agent-registry-and-card.md` §5:
1. Ensure the card + endpoints are live over TLS (§3 verify).
2. Import the tool from `docs/specs/burst-control-plane.openapi.yaml` into the Cloud API Registry (or
   register the function declaration via the ADK `ApiRegistry`).
3. Register the agent pointing at `/.well-known/agent.json`; attach the `burst_compute` tool and both
   security schemes (Hushh OIDC + BYOC pass-through).
4. Configure governance: allowed callers, rate limits, and the per-user cost caps (placement spec).
5. Validate in mock mode, then against the real BYOC project. Tag the listing with `AGENT_CARD_VERSION`.

> Google's console/SDK names move quickly (Vertex AI → Gemini Enterprise Agent Platform). Confirm exact
> steps against current Google docs; the artifacts above are the stable inputs.

---

## 6. Operate it (day 2)

- Dashboards, SLOs, and alerts: `docs/specs/slo-observability.md`. Wire the structured `one.burst.*`
  events to log-based metrics and the on-call dashboard before go-live.
- The **orphaned-instance alert** and the **reconciliation sweep** (lists `hussh-burst`-labeled
  instances, deletes any with no live job) are mandatory — they are the cost-safety backstop.
- Watch GPU quota and Cloud Run concurrency vs. the soft deadline.

---

## 7. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `503` on submit | No resolvable BYOC creds | Pass a `byoc` block, or set `BYOC_GCP_*`. |
| `501` on submit | TPU requested on the real path | Use `gpu`; TPU is the next-step Cloud TPU API. |
| Burst never leaves "provisioning" | GPU quota / image pull failure | Check quota (§2.3) and image pull perms (§2.4); read the instance serial log. |
| Instance left running | Teardown failed/disabled | Check `ONE_BURST_TEARDOWN`; run the reconciliation sweep; inspect `one.burst.teardown_failed`. |
| `401` everywhere | Bad/expired Firebase token | Refresh the ID token. |
| Recovery says "running" forever (real BYOC) | Per-request creds aren't stored | Expected: the original stream finalizes it; env/ADC bursts recover fully (security spec). |

---

## 8. Rollback

- Control plane: redeploy the previous Cloud Run revision (deploy skill). The `BurstJob` migration is
  additive and safe to leave in place.
- Kill switch: set `ONE_ENABLE_MOCK_BURST=true` (no real provisioning) or revoke the BYOC SA key to halt
  all bursts immediately. Then run the reconciliation sweep to clear any in-flight instances.

## Related documents
- White paper: docs/whitepaper-xtreme-compute-burst.md
- Agent registry & card: docs/specs/agent-registry-and-card.md
- BYOC security & privacy: docs/specs/byoc-security-privacy.md
- SLO & observability: docs/specs/slo-observability.md
- API contract: docs/specs/burst-control-plane.openapi.yaml
