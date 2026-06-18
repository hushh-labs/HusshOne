# BYOC Security & Privacy Specification — Xtreme Compute Burst

Defines the security and privacy contract for bring-your-own-cloud (BYOC) burst: how a customer's GCP credential and workload run in the customer's own project, on the customer's bill, with Hushh holding no compute and persisting no key material.

**Status:** Specification — for SE/FDE + privacy review.
**Last updated:** 2026-06-18.

---

## 1. Purpose

Hushh One — Xtreme Compute Burst runs a heavy workload where it runs best: on the user's Mac ("One Puppy") when it fits, or burst to the cloud when it doesn't. The cloud path is **BYOC**: the customer supplies their own GCP service-account credential, the burst VM is created in the customer's project, and the cost lands on the customer's bill. Hushh orchestrates; Hushh never owns the compute and never retains the key. This document is the threat model, credential lifecycle, IAM contract, and privacy posture for that path.

---

## 2. Principles (Apple-aligned)

- **On-device first.** Placement prefers the user's Mac. Burst to cloud only when the workload exceeds local capacity (memory/disk thresholds, TPU need, Puppy offline). The cloud is the fallback, not the default.
- **Data minimization.** Persist the minimum needed to operate and audit. Never persist key material. Never persist workload payload content. Store coordinates (projectId, region, source), not secrets.
- **The user's keys and data stay under the user's control.** The credential is the user's, captured on the user's device, used only to act in the user's project, and discarded after the request. The workload runs in the user's cloud — Hushh's control plane never reads it back beyond a bounded result blob.
- **Transparency & consent.** The app states, in plain English, what is collected, what crosses the network, and what runs in the user's own cloud — before the first burst. No silent expansion of scope.
- **Secure by default.** TLS on every hop. Teardown guaranteed. Least-privilege IAM. Owner-scoped lookups. No standing Hushh access to the customer project.
- **No telemetry of workload content.** Operational telemetry (timings, status, cost signals) is collected; workload inputs, outputs, and the SA private key are never sent to telemetry, logs, or analytics.

---

## 3. Trust boundaries & data flow

Three trust domains. The credential and payload originate in the **device** domain, transit the **control plane** domain over TLS, and execute in the **customer GCP** domain. Hushh's control plane is a conduit and orchestrator, not a vault.

```
┌───────────────────────────┐      TLS       ┌────────────────────────────┐      TLS      ┌──────────────────────────────┐
│  DEVICE (user's Mac)       │  ───────────▶  │  CONTROL PLANE (Hushh)     │  ──────────▶  │  CUSTOMER GCP PROJECT         │
│  "One Puppy" agent         │  per-request   │  Cloud Run, Firebase auth  │  GCE REST     │  (customer-owned, customer-   │
│                            │  HTTPS body    │                            │  bearer token │   billed)                     │
│  • GCP SA key in Keychain  │                │  • verifyOneRequest (JWT)  │               │  • GCE VM (Container-Optimized │
│    (Secure Enclave-backed) │                │  • resolveGcpCreds         │               │    OS), label hushh-burst      │
│  • workload payload        │                │  • mintAccessToken (mem)   │               │  • runs USER's container       │
│  • hushhSession (Firebase  │                │  • LRU client cache (256)  │               │  • external NAT                │
│    ID token)               │                │  • BurstJob row (NO key,   │               │  • result → guest attributes   │
│                            │                │    NO payload content)     │               │  • torn down after job         │
└───────────────────────────┘                └────────────────────────────┘               └──────────────────────────────┘
        owns the key                            holds key in memory only,                     where compute + payload + the
        owns the data                           for the request lifetime                      result actually live
```

What lives where, per hop:

| Artifact | Device | In TLS transit | Control plane (memory) | Control plane (at rest) | Customer GCP |
|---|---|---|---|---|---|
| SA private key | Keychain (Enclave) | yes (request body) | yes, request lifetime only | **never** | used to authn API calls |
| OAuth access token | — | yes (to GCP) | yes, LRU-cached client | **never** | bearer on GCE REST calls |
| Workload payload (finetune data, render inputs) | originates | yes (to provision) | transient | **never** (content) | runs inside the VM |
| hushhSession (Firebase ID token) | held | yes (Bearer) | verified, not stored | **never** | — |
| projectId / region / source | derived | yes | yes | **yes** (BurstJob row) | identifies target |
| Result blob | received | yes (return) | yes | **yes, bounded** (see §9) | produced by VM |

Crossing TLS: every device↔control-plane request, and every control-plane↔GCP REST call. No artifact crosses a trust boundary in cleartext.

---

## 4. Credential lifecycle

The credential is the user's GCP service-account JSON. It exists to mint a short-lived token that creates and tears down one VM in the user's project. Its lifetime in Hushh's control plane is a single request.

**Capture (device).** The One Puppy macOS agent stores the SA key in the macOS Keychain, Secure-Enclave-backed where the hardware supports it. The key is the user's own, for the user's own project. The agent reads it only to attach it to an outbound burst request.

**Transmit (device → control plane).** Sent per-request, in the HTTPS request body, over TLS. Never placed in a URL, query string, or header that lands in access logs. One request, one credential; nothing is cached on the wire.

**Resolve (control plane).** `resolveGcpCreds` (src/lib/burst/credentials.ts) selects creds by precedence: (1) per-request service-account JSON — the BYOC happy path; (2) `BYOC_GCP_SERVICE_ACCOUNT_JSON` env — dogfood/single-tenant deploys; (3) Application Default Credentials — the Cloud Run runtime SA. The resolved object carries `source ∈ {"request","env","adc"}`.

**Use (control plane, memory only).** `mintAccessToken` builds a `JWT` auth client (or ADC client) and mints a `cloud-platform`-scoped OAuth token. The auth **client** is cached per credential in a bounded LRU (256 entries, key `sa:<client_email>` or `adc:<projectId>`) so a tight status-poll loop reuses the library's in-memory token instead of re-signing a JWT every poll. The cache holds clients, evicts cold tenants, and never spills to disk. The minted token — not the key — is the bearer for every Compute Engine REST call.

**Discard.** The private key lives in process memory for the request lifetime only. There is no write path to disk, DB, or logs. The LRU evicts cold entries; process restart clears all.

**CRITICAL invariant (enforced + tested):** the SA private key is **never persisted**. The BurstJob row stores only `projectId`, `region`, and `credsSource`. Tests assert the persisted spec contains no `private_key` or `serviceAccountJson`.

### 4.1 Data-at-rest inventory — BurstJob row

Every column classified. **safe** = non-identifying operational data; **sensitive** = customer-identifying or content-bearing, handle with care; **never-stored** = must not appear at rest, asserted by tests.

| Column | Holds | Classification | Notes |
|---|---|---|---|
| `id` | job identifier | safe | opaque |
| `ownerId` | Firebase UID of requester | sensitive | scopes every lookup; tenant key |
| `status` | queued/running/done/failed/torn-down | safe | operational |
| `placement` | "puppy" \| "gcp" | safe | decision outcome |
| `projectId` | customer GCP project | sensitive | coordinate, not secret |
| `region` | GCP region | safe | coordinate |
| `credsSource` | "request" \| "env" \| "adc" | safe | provenance, not the cred |
| `instanceName` | GCE VM name (hushh-burst-*) | safe | lifecycle handle |
| `accelerator` | GPU/TPU kind requested | safe | resource shape |
| `resourceEstimate` | mem/disk estimate | safe | sizing |
| `imageRef` | container image reference | sensitive | may hint at customer intent |
| `costSignal` | observed/estimated cost | safe | for cost caps (§11) |
| `createdAt` / `updatedAt` / `endedAt` | timestamps | safe | audit/SLO |
| `resultBlob` | bounded result (§9) | **sensitive** | size/sensitivity-capped, truncated |
| `error` | failure reason (redacted) | sensitive | must not echo payload/secret |
| `serviceAccountJson` / `private_key` | — | **never-stored** | test-asserted absent |
| workload payload content | — | **never-stored** | runs in customer cloud only |

---

## 5. Least-privilege IAM

The BYOC service account needs exactly enough to create, observe, and delete one short-lived burst VM and pull its image. Prefer a **custom role** over `roles/compute.instanceAdmin.v1`.

**Minimal permissions:**

| Permission | Why |
|---|---|
| `compute.instances.create` | provision the burst VM |
| `compute.instances.get` | poll instance state |
| `compute.instances.delete` | guaranteed teardown |
| `compute.instances.setMetadata` | read result via guest attributes |
| `compute.zoneOperations.get` | await create/delete operation completion |
| `compute.zones.get` / `compute.machineTypes.get` | resolve zone + machine type |
| Image pull (Artifact Registry reader on the source repo) | `artifactregistry.repositories.downloadArtifacts` if pulling from AR |
| `compute.disks.create` (implicit with instance) | boot disk |
| `compute.subnetworks.use` / `compute.networks.use` | attach to network for external NAT |

**Do NOT grant:** `roles/owner`, `roles/editor`, project-wide `roles/compute.admin`, IAM-admin permissions, `iam.serviceAccounts.actAs` beyond the burst SA, billing-admin, storage-admin, or any permission on data buckets the burst does not need.

**Recommendations:**
- Use a **dedicated** service account, named for burst, used for nothing else.
- Scope it to **one project**. No cross-project bindings.
- Optionally constrain with **org policy**: restrict VM external IP (`constraints/compute.vmExternalIpAccess`), restrict allowed images, and limit machine types/regions.
- Customer creates the SA and role; Hushh documents the exact custom-role definition in the FDE playbook. Hushh never asks for broader grants "to make it work."

---

## 6. Production hardening roadmap

Today the credential is per-request and in-memory only — strong on the "never persisted" invariant, but it places the key on the wire every request. The target raises the floor without weakening that invariant.

| Capability | Today | Target |
|---|---|---|
| Credential storage | per-request body, memory only | **Secret Manager** entry per user, **KMS envelope encryption** with a per-user key |
| DB reference | inline at request time | `byocCredentialRef` column — a Secret Manager resource name, resolved at runtime; key material still never in the row |
| Keyless option | SA key JSON | **Workload Identity Federation** — customer trusts Hushh's OIDC issuer; no long-lived key leaves the customer's project |
| Token scope | `cloud-platform` OAuth | **short-lived downscoped tokens** via STS (Credential Access Boundary) limited to the burst VM's resources |
| Network perimeter | external NAT, no perimeter | **VPC Service Controls** perimeter around the customer project; egress rules for the control plane |

Sequencing: WIF (eliminate the key) and STS downscoping (shrink the token) deliver the largest privacy gains and should lead. Secret Manager + KMS is the bridge for customers who must supply a key. VPC-SC is the enterprise overlay.

---

## 7. STRIDE threat model

| Category | Threat | Vector | Mitigation |
|---|---|---|---|
| **Spoofing** | Attacker impersonates a user to launch burst on their bill | Forged/replayed request | Firebase ID token (Bearer) verified by `verifyOneRequest`; two-credential A2A card — `hushhSession` (who asks) AND `byocGcp` (whose cloud) both required |
| **Spoofing** | Forged agent card | Tampered card body | Signed/JWS-verified agent card; reject unsigned or mismatched-signature cards |
| **Tampering** | Mutate workload/spec in transit | MITM on device↔control-plane or control-plane↔GCP | TLS on every hop; signed agent card (JWS); validate JobSpec server-side |
| **Tampering** | Swap container image | Untrusted `imageRef` | Pull from Artifact Registry only; recommend digest pinning + image provenance (§10) |
| **Repudiation** | "I never launched that burst" | Missing trail | Append-only audit log: who, when, projectId, instanceName, status, cost — secrets and payload excluded |
| **Information disclosure** | SA key leaks from Hushh | Persisted key, log spill | Key never persisted (tested); never logged; LRU holds clients not keys; redacted errors |
| **Information disclosure** | Workload content leaks via telemetry | Payload in logs/analytics | No telemetry of workload content; payload runs only in customer cloud; result blob bounded + truncated; contact data redacted elsewhere — here payload is the customer's own |
| **Information disclosure** | Result blob over-collects | Large/sensitive guest-attribute return | Size + sensitivity cap, truncation, classified **sensitive** (§9) |
| **Denial of service** | Burst spam drains a bill | Repeated launches | Per-user rate limits; per-user **cost caps** (cross-ref placement spec); GCP quota as backstop |
| **Denial of service** | Orphaned instances | Dropped stream / crash | **Guaranteed teardown** on completion, failure, and soft deadline; idempotent delete (404 = already gone) |
| **Elevation of privilege** | Burst SA does more than burst | Over-broad IAM | Least-privilege custom role (§5); dedicated SA; no `actAs` widening |
| **Elevation of privilege** | Hushh gains standing access to customer cloud | Persistent creds | No standing Hushh access — Hushh acts only with the per-request credential, only for the request, only in that project |

---

## 8. Tenant isolation

- **One user's burst can never touch another user's project.** The only thing that can act in a GCP project is the per-request BYOC credential supplied for that request. Hushh holds no master credential to anyone's project.
- **Owner-scoped DB lookups.** Every BurstJob read/resume is filtered by `ownerId` derived from the verified `hushhSession`. The recovery endpoint (`GET /api/one/burst/[id]`) returns a job only to its owner; a cross-owner id is a 404, not a 403 (no existence leak).
- **No shared compute.** Each burst is a fresh VM in the customer's own project, labeled `hushh-burst`, torn down after the job. There is no shared pool across tenants.
- **Credential is the boundary.** Because the credential is the sole actor and it is the customer's own, the blast radius of any single tenant is structurally bounded to that tenant's project.

---

## 9. Privacy

**What Hushh collects:** operational metadata — job id, owner UID, status, placement, projectId, region, creds source, instance name, accelerator/resource shape, timestamps, cost signal, and a bounded result blob. That is the BurstJob row (§4.1).

**What Hushh does NOT collect:** the SA private key (never persisted), the workload payload content (runs in the customer cloud, not retained by Hushh), and any telemetry of workload inputs/outputs.

**Workload payloads** — finetune data, render inputs, etc. — are the customer's own and execute inside the customer's VM. Hushh provisions the VM and reads back only the result; it does not stream or retain the payload.

**Result blob guidance:**
- Treat as **sensitive**. Apply a hard **size cap** and **truncate** past it; record that truncation occurred.
- Results that are or may be large/binary belong in the customer's own storage (the customer cloud), with Hushh storing only a reference or summary.
- Never log the result blob; classify it **sensitive** at rest.

**Deletion & retention.** BurstJob rows are retained for operability/audit, then aged out per the retention window. A user delete request removes their rows and result blobs. Because no key or payload is stored, deletion is fast and complete for those classes by construction.

**GDPR / CCPA posture.** Hushh is a processor for the operational metadata it stores; the customer is controller of the workload and its cloud. Right-to-access and right-to-erasure cover the BurstJob rows and result blobs. Key material and payload content are out of scope because Hushh never holds them at rest. Lawful basis: performance of the burst the user requested.

**Apple-style plain-English summary (shown in-app before first burst):**

> Your cloud, your key, your bill. When a job is too big for your Mac, One runs it in *your own* Google Cloud project using a key you provide. We use your key only to start and stop that one job, and we never save it. Your job's data stays in your cloud — we don't keep it. We do save the basics (which project, when, how it went, and the result) so the feature works and you can see your history. You can delete that anytime.

---

## 10. Secure defaults & guardrails

- **TLS everywhere.** Device↔control plane and control plane↔GCP. No cleartext credential or payload, ever.
- **Guaranteed teardown.** The VM is deleted on completion, failure, **and** soft deadline. Delete is idempotent (404 treated as already-gone). No lingering instance can hold the user's data after the job.
- **External IP.** The burst VM uses external NAT today. Recommend the org-policy constraint to disable external IP and route egress via Cloud NAT where the workload allows; document the tradeoff (image pull, result return) in the FDE playbook.
- **Image provenance.** Pull workload images from **Artifact Registry**; recommend digest pinning and provenance attestation. Reject images from untrusted registries by policy.
- **Startup-script review.** The startup script that launches the container is reviewed and minimal: pull image, run, write result to guest attributes, signal completion. No credential is embedded in the script; no broad metadata access beyond what teardown/result needs.
- **Label discipline.** Every burst instance is labeled `hushh-burst` for inventory, reconciliation, and orphan sweeps.

---

## 11. Abuse & cost safety

- **Stolen-key blast radius is bounded to the user's own project.** A leaked BYOC credential can act only in the customer's own project, with a least-privilege role; it cannot reach Hushh, other tenants, or any Hushh-owned compute. Recommend the customer rotate the SA key on suspicion and rely on GCP audit logs in their project.
- **Rate limits.** Per-user limits on burst launches throttle a runaway client or compromised session.
- **Per-user cost caps.** Enforce a per-user cap that refuses or pauses bursts past a threshold; the `costSignal` column feeds it. Cross-reference the placement spec for cap placement and the soft-deadline interaction.
- **Quota as backstop.** GCP project quota in the customer's project is the final ceiling; the customer controls it.

---

## 12. Compliance & audit

- **Logged:** burst lifecycle events — request received, placement decision, provision start, status transitions, teardown, completion/failure, cost signal. Each event carries owner UID, project, region, instance name, timestamps.
- **Never logged:** the SA private key, the OAuth token, the workload payload, and the result blob content. Errors are redacted before logging.
- **Retention:** audit events retained per the security retention window; operational rows per §9.
- **Access:** audit logs are access-controlled to security/ops on a need-to-know basis. Customer-side actions in GCP are visible in the customer's own Cloud Audit Logs — the source of truth for what the credential did in their project.

---

## Related specs

- white paper — docs/whitepaper-xtreme-compute-burst.md
- one-puppy macOS agent — docs/specs/one-puppy-macos-agent.md
- SLO / observability — docs/specs/slo-observability.md
- forward-deployed engineer playbook — docs/runbooks/forward-deployed-engineer-playbook.md
