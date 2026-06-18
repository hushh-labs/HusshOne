# One Burst Compute — provisioning your cloud (BYOC)

This sets up everything One needs to burst into **your own** Google Cloud project: the APIs, a
**least-privilege** service account, and (for TPU) a result bucket. One never owns the compute —
bursts run in your project, on your bill, and the credential stays under your control.

Pick whichever fits how you work. Both produce the same least-privilege result.

## Option A — one command (humans / quick start)

```bash
PROJECT_ID=your-project REGION=us-central1 CREATE_KEY=true ./setup.sh
# add ENABLE_TPU=true to also provision the TPU path (Cloud TPU API + a result bucket)
```

It enables the APIs, creates the role + service account, optionally a TPU bucket, and optionally a
key file (`one-burst-key.json`) to paste into One. Safe to re-run.

## Option B — Terraform (standard IaC / automation systems)

```bash
cd terraform
terraform init
terraform apply -var project_id=your-project -var region=us-central1 \
  -var enable_tpu=true -var create_key=true

terraform output -raw service_account_key_json > one-burst-key.json   # if create_key=true
terraform output tpu_result_bucket                                     # if enable_tpu=true
```

Drop the Terraform module into an existing pipeline; it exposes `project_id`, `region`,
`enable_tpu`, `tpu_result_bucket`, and `create_key` and outputs the service-account email, role,
bucket, and (optionally) the key.

## What gets created (least privilege)

| Resource | Why |
|---|---|
| APIs: Compute Engine, Cloud Storage (+ Cloud TPU if enabled) | The services a burst uses. |
| Custom role `oneBurst` | Only `compute.instances.{create,get,delete,setMetadata,setLabels}`, `compute.disks.create`, `compute.subnetworks.use`, `compute.zoneOperations.get` (+ `tpu.nodes.*` when TPU). Nothing more. |
| Service account `hushh-burst` | The identity One acts as in **your** project. |
| TPU result bucket (optional) | The TPU node writes results here; the control plane reads them. Bucket-scoped access, 7-day cleanup. |
| Key (optional) | A JSON key to paste into One. **Prefer keyless** — see below. |

## Recommended: keyless (Workload Identity Federation)

A downloaded key is the simplest path and what the macOS app uses today. For server-to-server or
fleet deployments, prefer **Workload Identity Federation** so there is no long-lived key to manage or
leak — grant the burst service account to a federated identity instead of `create_key=true`. The
control plane already supports Application Default Credentials; see
`docs/specs/byoc-security-privacy.md` §6 for the target design.

## After provisioning

1. Note your **region** and (for TPU) the **bucket name** → set `ONE_BURST_TPU_RESULT_BUCKET`.
2. Check **GPU/TPU quota** for your region: <https://console.cloud.google.com/iam-admin/quotas>.
3. Connect in One (**Settings → Connect your cloud**, or the `/burst/setup` page) — it validates
   auth, permissions, and quota for you and tells you if anything's missing.

The credential is checked against your project, then kept **on your device** — Hushh never stores it.
See `docs/customer/getting-started.md` for the full customer onboarding, and
`docs/runbooks/forward-deployed-engineer-playbook.md` for the deploy/operate runbook.
