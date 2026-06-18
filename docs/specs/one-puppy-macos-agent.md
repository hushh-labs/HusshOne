# One Puppy — macOS On-Device Agent Specification

**Status:** Specification — for SE/FDE (native macOS build) · **Last updated:** 2026-06-18

The "One Puppy" is the native macOS agent that turns a Mac into a personal supercomputer that
**knows when to ask for help**. It runs workloads on-device, senses when the Mac can't keep up, and
hands off to the control plane to burst into the user's own cloud — then brings the result home. This
spec defines the agent's responsibilities, telemetry, triggers, credential vault, the control-plane
handshake, and packaging. The control plane (this repo) is already built; the native agent is the
next deliverable and integrates only through the documented HTTP contract.

## 1. Responsibilities

| # | Responsibility | Detail |
|---|---|---|
| 1 | **Device telemetry** | Maintain a live `DeviceProfile` + pressure signals (§3). |
| 2 | **On-device execution** | Run the user's containerized/native workload locally by default. |
| 3 | **Burst decision input** | Send the workload's `JobSpec` + `deviceProfile` to the control plane, which decides placement. |
| 4 | **Credential vault** | Hold the user's GCP key in Keychain (Secure Enclave-backed); attach it per request. |
| 5 | **Handshake** | For a Puppy placement, run locally and report via `puppy-result`; for a cloud burst, observe the NDJSON stream and surface progress. |
| 6 | **UX surface** | Menu-bar presence, the "borrowed a supercomputer" moment, failure states. (See macos-experience.md.) |

The Puppy is a **thin, trustworthy client**. All cloud complexity (provisioning, accelerator choice,
teardown, recovery) lives in the control plane — the device never talks to GCP directly.

## 2. The DeviceProfile (what the agent reports)

Matches `DeviceProfile` in `src/lib/burst/types.ts`. Populated from macOS APIs:

| Field | Source (macOS) |
|---|---|
| `cpuCores` | `sysctl hw.ncpu` / `ProcessInfo.processorCount` |
| `gpuCores` | Metal device query (`MTLCreateSystemDefaultDevice`) |
| `unifiedMemoryGb` | `sysctl hw.memsize` (Apple Silicon unified memory) |
| `diskFreeGb` | `URL.resourceValues(.volumeAvailableCapacityForImportantUsageKey)` |
| `networkMbps` | NWPathMonitor + a periodic throughput probe |
| `online` | NWPathMonitor reachability to the control plane |
| `id` / `label` | Stable per-device id (see §5) + model string (e.g. "Mac Studio (M3 Ultra)") |

## 3. Pressure signals & the burst trigger

Beyond the static fit-check the control plane runs, the Puppy detects *runtime* distress and asks to
burst. Signals (thresholds and hysteresis are formalized in **placement-autoscale.md** — the Puppy is
the *sensor*, the control plane is the *decider*):

| Signal | macOS source | Why |
|---|---|---|
| Memory pressure | `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` (warn/critical) | The classic "out of RAM" cliff. |
| Swap activity | `vm_stat` swapins/outs rate | RAM exhausted → thrashing. |
| Thermal state | `ProcessInfo.thermalState` (serious/critical) | Sustained load throttles the SoC. |
| GPU/CPU saturation | IOReport / `powermetrics`-class counters over a window | The job is compute-bound and slow. |
| ETA overrun | Workload progress vs. estimate | The local run will miss its deadline. |

The agent computes a debounced pressure score; when it crosses the promotion threshold for an
in-flight or queued workload, it submits a burst (with the latest `deviceProfile` showing the
pressure) so the control plane promotes it to the cloud. A minimum local-dwell time and cooldown
prevent flapping.

## 4. Credential vault (BYOC key handling)

- **Capture once.** During onboarding (see macos-experience.md), the user pastes their GCP
  service-account JSON. The agent validates it locally (well-formed, has `client_email`/`private_key`/
  `project_id`) before accepting.
- **Store in Keychain.** Persist as a generic password item, **Secure Enclave-backed where available**,
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (never synced to iCloud, never leaves the device).
- **Use per request.** Attach the key in the request `byoc` block over TLS 1.3 only for a cloud burst.
  The control plane uses it in-memory to mint a token and **never persists it** (enforced + tested).
- **Rotate/revoke.** The agent supports replacing or deleting the key; deletion removes the Keychain
  item. Recommend the user scope a dedicated, single-project, least-privilege SA (see byoc-security-privacy.md).
- **Never log it.** The key is never written to logs, crash reports, or analytics.

> Roadmap: prefer **Workload Identity Federation** (keyless) over a downloaded SA key once supported
> end-to-end — see the security spec. The agent's vault abstraction should make this swap invisible to UX.

## 5. Identity & auth to the control plane

- The user signs into One (Firebase). The agent holds a Firebase **ID token** and sends it as
  `Authorization: Bearer …` (`hushhSession`). It refreshes tokens via the Firebase SDK.
- A stable, privacy-preserving device id (random UUID in Keychain; **not** a hardware serial) labels
  the device in telemetry — never a user-identifying hardware id.
- Both credentials are required for a burst (the A2A card's AND security).

## 6. Control-plane handshake (the exact contract)

```
1. Submit:   POST /api/one/burst
             body: { image, command?, env?, acceleratorKind, acceleratorCount, estimate,
                     deviceProfile, byoc? }   (Authorization: Bearer <Firebase ID token>)

2a. Puppy:   200 application/json
             { ok:true, placement:"puppy", reason, burstJobId,
               handshake:{ target:"puppy", jobId, spec, reportResultEndpoint } }
             → the agent runs the workload locally, then:
             POST /api/one/burst/{jobId}/puppy-result
                  { status:"completed"|"failed", result?, error?, runMs? }   (idempotent)

2b. Cloud:   200 application/x-ndjson  (frames: start → progress* → done | error | pending)
             → the agent surfaces progress; on `done` it presents the result;
               on `pending`(reason:"deadline") it informs the user it'll finish + notify.

3. Recover:  if the stream drops, GET /api/one/burst/{id} until terminal.
```

Full schemas: `docs/specs/burst-control-plane.openapi.yaml`.

## 7. On-device execution model

- The workload is a **container** (the same artifact that would run in the cloud) so local and burst
  execution are identical. On macOS, run via the user's container runtime (e.g. Apple's `container`
  framework / a supported runtime); fall back to a native runner for Metal/CoreML tasks.
- The agent enforces the same resource estimate locally and aborts→bursts if it blows past it.
- Results are normalized to the same shape the cloud path returns, so the UX is identical regardless of
  where the work ran.

## 8. Reliability on the device

- **Crash-safe job ledger.** Persist in-flight `burstJobId`s locally so the agent re-attaches after an
  app restart via `GET /api/one/burst/{id}`.
- **Network loss.** Bursts keep running server-side; the agent reconciles when connectivity returns.
- **No orphaned local work.** A local run that the agent abandons reports `failed` to `puppy-result` so
  the job ledger never lies.

## 9. Packaging & distribution

- **Signed, notarized** macOS app (Developer ID / App Store). Hardened runtime; least-privilege
  entitlements (network client, Keychain, the container runtime entitlement only).
- **Sandbox**-compatible where possible; document any required exceptions and justify them for review.
- **Auto-update** via the App Store or a signed update channel.
- **Privacy manifest** (`PrivacyInfo.xcprivacy`) declaring data use truthfully: no workload content
  leaves the device except to the user's own cloud; the GCP key never leaves the device except to the
  control plane over TLS for the user's own burst.

## 10. Telemetry (privacy-first)

- Emit only **non-content, non-credential** events: placement decisions, burst counts, durations,
  outcomes, pressure-trigger reasons. Never the workload payload, never the key, never file contents.
- Correlate with the control plane on `burstJobId` only.

## 11. Acceptance criteria (definition of done for the native agent)

1. Connect a GCP key in ≤ 30 seconds; key is in the Keychain and never logged.
2. A workload that fits runs locally; a workload that doesn't bursts automatically with a clear
   in-product explanation, and the result is identical in shape.
3. Pressure-triggered promotion works with no flapping (respects dwell/cooldown).
4. App quit / network drop mid-burst → result still delivered on relaunch; no orphaned cloud instance.
5. Removing the key fully revokes burst capability; deleting the account purges local state.
6. Passes Apple privacy review and the BYOC security review (see byoc-security-privacy.md).

## Related documents
- White paper: docs/whitepaper-xtreme-compute-burst.md
- macOS experience (UX bar): docs/specs/macos-experience.md
- Placement & autoscale: docs/specs/placement-autoscale.md
- BYOC security & privacy: docs/specs/byoc-security-privacy.md
- API contract: docs/specs/burst-control-plane.openapi.yaml
