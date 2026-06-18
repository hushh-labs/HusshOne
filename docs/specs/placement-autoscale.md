# Placement & Burst-Trigger Engine — Hushh One "Xtreme Compute Burst"

Decide, per workload, whether to run on the local "One Puppy" Mac or burst to the customer's cloud — statically (fit) and at runtime (pressure) — with hysteresis and hard cost guardrails.

**Status: Specification — for SE/FDE** · Last updated: 2026-06-18

---

## 1. Goals / Non-goals

**Goals**

- Define a formal, deterministic, unit-testable placement model that matches `decidePlacement()` in `src/lib/burst/placement.ts` and extends it.
- Specify the *runtime* burst trigger: promote an in-flight or queued workload to the cloud when the device is "slowing down / can't perform / needs more power."
- Make burst behavior cost-bounded by construction: no burst proceeds past a budget cap without an explicit policy decision.
- Degrade gracefully and legibly back to on-device when the cloud cannot serve a burst.
- Keep BYOC credentials in-memory only; never persist key material; never leak it into logs, reasons, or telemetry.

**Non-goals**

- TPU on-device (Apple Silicon has none — TPU is always cloud, and full Cloud TPU provisioning is next-step; v1 returns 501 on the real path).
- Multi-cloud routing (Azure/AWS/Neo) — interface is reserved (§11), not implemented.
- Learned cost/perf models — deferred (§11); v1 thresholds are static and explicit.
- Workload *estimation* itself (producing `WorkloadEstimate`) — assumed upstream; this engine consumes it.

---

## 2. Inputs & data model

Types live in `src/lib/burst/types.ts`. The placement engine is pure (no I/O).

| Type | Fields (relevant) |
|---|---|
| `WorkloadEstimate` | `vramGb`, `unifiedMemoryGb`, `vcpus`, `diskGb`, `estimatedMinutes` |
| `DeviceProfile` | `id`, `label`, `cpuCores`, `gpuCores`, `unifiedMemoryGb`, `diskFreeGb`, `networkMbps`, `online` |
| `AcceleratorKind` | `"gpu"` \| `"tpu"` |
| `PlacementDecision` | `target` (`"puppy"`\|`"gcp"`), `reason`, `fitsLocally`, `headroom?{memoryGb,diskGb}` |

**Reference device — "One Puppy"** (`DEFAULT_PUPPY_PROFILE`, maxed M3 Ultra Mac Studio):
`cpuCores=32`, `gpuCores=80`, `unifiedMemoryGb=192`, `diskFreeGb=2048`, `networkMbps=10000`, `online=true`.

**Apple Silicon invariant.** GPU/VRAM and host RAM share **one** unified memory pool. The binding memory requirement is therefore `max(vramGb, unifiedMemoryGb)` measured against the single unified-memory budget — not two independent budgets.

---

## 3. Formal static placement model

`decidePlacement(estimate, device, acceleratorKind = "gpu") → PlacementDecision`

### 3.1 Constants

- `SAFETY = 0.8` — never pack the Puppy past 80% of unified memory or free disk. Reserve the remaining 20% for macOS, the One Puppy agent, foreground user work, and allocator fragmentation. The fraction is a guardrail against thrashing/swap, not a performance target; §4 handles the dynamic case when reality diverges from the estimate.

### 3.2 Derived quantities

```
memBudgetGb  = device.unifiedMemoryGb * SAFETY
diskBudgetGb = device.diskFreeGb      * SAFETY
memNeedGb    = max(estimate.vramGb, estimate.unifiedMemoryGb)
memoryHeadroomGb = memBudgetGb  - memNeedGb
diskHeadroomGb   = diskBudgetGb - estimate.diskGb
headroom = { memoryGb: round1(memoryHeadroomGb), diskGb: round1(diskHeadroomGb) }
```

`headroom` = spare capacity on the Puppy under the safety budget; **negative values are the binding deficit** and are still reported. `round1(x) = round(x*10)/10`.

### 3.3 Decision table (first match wins)

| # | Predicate | `target` | `fitsLocally` | `headroom` |
|---|---|---|---|---|
| 1 | `device.online == false` | `gcp` | false | — |
| 2 | `acceleratorKind == "tpu"` | `gcp` | false | — |
| 3 | `vramGb <= 0 && unifiedMemoryGb <= 0` (degenerate/unknown) | `gcp` | false | — |
| 4 | `memoryHeadroomGb < 0` (mem-bound) | `gcp` | false | reported |
| 5 | `diskHeadroomGb < 0` (disk-bound) | `gcp` | false | reported |
| 6 | otherwise (fits) | `puppy` | true | reported |

### 3.4 Predicate as inequalities

Local placement (`puppy`) holds **iff all** of:

```
device.online == true
acceleratorKind != "tpu"
(vramGb > 0 OR unifiedMemoryGb > 0)
max(vramGb, unifiedMemoryGb) <= device.unifiedMemoryGb * 0.8     # mem fit
diskGb                        <= device.diskFreeGb      * 0.8     # disk fit
```

Boundary is **inclusive**: `headroom == 0` (need exactly equals budget) ⇒ `puppy`. Strictly negative headroom ⇒ `gcp`.

### 3.5 Reasons (user-facing, no secrets)

- Offline: "One Puppy is offline — bursting to the cloud."
- TPU: "TPU workloads run only in the cloud — bursting to GCP."
- Unknown: "Workload size is unknown — bursting to the cloud."
- Mem-bound: "Needs ~{vramGb}GB accelerator memory; One Puppy offers ~{memBudgetGb}GB usable — bursting to the cloud."
- Disk-bound: "Needs ~{diskGb}GB disk; One Puppy has ~{diskBudgetGb}GB usable — bursting to the cloud."
- Fits: "Fits on {label} with ~{memoryGb}GB memory headroom — running on-device."

---

## 4. Runtime burst triggers (the "needs more power" path)

The static model decides at *admission*. Reality diverges: estimates undershoot, foreground load spikes, the Mac thermal-throttles. The **runtime trigger** promotes an in-progress or queued workload from `puppy → gcp` when sustained device pressure says the local run is degrading. It never demotes a running cloud job to local.

### 4.1 Signals (sampled from the One Puppy macOS agent; see one-puppy-macos-agent spec)

Sample period `T_s = 5s`. Evaluate over a sliding window `W = 60s` (12 samples) unless noted.

| Signal | Symbol | Source | Promote-warn | Promote-fire |
|---|---|---|---|---|
| Memory pressure | `memPressurePct` | `kern.memorystatus` / pressure level | ≥ 70% for ≥ 30s | ≥ 85% for ≥ 30s, or level == "critical" |
| Swap activity | `swapRateMBs` | swapins+swapouts delta | > 50 MB/s for ≥ 30s | > 200 MB/s for ≥ 20s |
| Thermal state | `thermalState` | `NSProcessInfo.thermalState` | `serious` | `critical` |
| GPU saturation | `gpuUtilPct` | IOReport / agent metric | ≥ 90% mean over `W` | ≥ 97% mean over `W` **and** progress-rate falling |
| CPU saturation | `cpuUtilPct` | host_processor_info | ≥ 90% mean over `W` | ≥ 97% mean over `W` (CPU-bound jobs only) |
| ETA overrun | `etaRatio = projectedMinutes / estimate.estimatedMinutes` | progress telemetry | ≥ 1.5 | ≥ 2.0 and `projectedRemaining > 10min` |
| Progress stall | `progressRate` | workload checkpoints | < 50% of expected for ≥ 2 min | ~0 for ≥ 3 min (no checkpoint advance) |

`projectedMinutes` is a linear extrapolation from observed progress fraction `p` and elapsed `t`: `projectedMinutes = t / max(p, ε)`.

### 4.2 Pressure score & promotion rule

Compute a debounced **pressure score** `P ∈ [0,1]` as the max of normalized fire-conditions; a signal contributes only after its **dwell** is satisfied:

```
fire(signal)  = signal crossed its promote-fire threshold continuously for its dwell
warn(signal)  = signal crossed its promote-warn  threshold continuously for its dwell
PROMOTE  iff   any fire(signal)   == true
               OR (count of distinct warn(signal) >= 2 sustained over W)
```

Two simultaneous *warn* signals (e.g. high memory pressure + ETA overrun) promote even if neither alone fires — combined degradation is the common real case.

### 4.3 Hysteresis, debounce, minimum dwell (anti-flap)

- **Minimum local dwell `D_local = 90s`.** A freshly admitted local job cannot be promoted for its first 90s — absorbs warm-up spikes (model load, page-in).
- **Per-signal dwell** is the "for ≥ Xs" column in §4.1; a signal must hold continuously, resetting if it dips below threshold.
- **Promotion is one-way and latched.** Once `PROMOTE`, the job is marked `burst-pending`; it does not return to local for the remainder of that run even if pressure subsides. (Prevents ping-pong; a checkpoint-and-migrate handoff is single-shot.)
- **Cooldown `C = 300s` per device.** After any promotion, suppress *new* promotions device-wide for 5 min to avoid cascade-promoting every queued job during a transient system-wide spike; queued jobs re-evaluate static fit after `C`.
- **Confirmation hold `H = 10s`.** Between `PROMOTE` decision and actually provisioning, hold and re-sample; if all fire-conditions clear within `H` (pure transient), cancel the promotion. Exception: `thermalState == critical` skips `H`.

### 4.4 Handoff semantics

On confirmed promotion: checkpoint locally if the workload supports it → provision cloud per §5 → resume from checkpoint (or restart if non-checkpointable) → tear down local execution. Surface a single user message: "One needs more power — moving this run to your cloud." All burst guardrails (§6) still apply; a promotion that fails its budget gate is denied and the job continues locally with a "kept on-device (budget cap)" note.

---

## 5. Accelerator / machine selection

Map a `WorkloadEstimate` → GCP machine type + GPU type + count + boot disk. Defaults: machine `n1-standard-8`, GPU `nvidia-tesla-t4`, count `1` (env `ONE_BURST_DEFAULT_MACHINE_TYPE` / `ONE_BURST_DEFAULT_GPU_TYPE`). Accelerator count is clamped to `1..8`.

### 5.1 GPU sizing table (drive on `memNeedGb = max(vramGb, unifiedMemoryGb)`)

| `memNeedGb` | GPU type | Per-GPU mem | Count | Suggested machine | Notes |
|---|---|---|---|---|---|
| ≤ 16 | `nvidia-tesla-t4` | 16 GB | 1 | `n1-standard-8` | Default tier |
| ≤ 24 | `nvidia-l4` | 24 GB | 1 | `g2-standard-8` | L4 = better perf/$ than T4 |
| ≤ 48 | `nvidia-l4` | 24 GB | 2 | `g2-standard-24` | Sharded / data-parallel |
| ≤ 80 | `nvidia-tesla-a100` (80GB) | 80 GB | 1 | `a2-ultragpu-1g` | Single large-mem device |
| ≤ 320 | `nvidia-tesla-a100` (80GB) | 80 GB | 2–4 | `a2-ultragpu-{2,4}g` | `ceil(memNeedGb/80)` |
| ≤ 640 | `nvidia-h100-80gb` | 80 GB | 4–8 | `a3-highgpu-8g` | NVLink; clamp at 8 |
| > 640 | `nvidia-h100-80gb` | 80 GB | 8 | `a3-highgpu-8g` | Cap; flag as oversize, see §8 |

**vCPU/disk sizing.**
- Machine vCPU `>= max(estimate.vcpus, 8)`; round up to the nearest offered shape for the chosen family.
- Boot/scratch disk `= ceil(estimate.diskGb * 1.25) + 50 GB` (working space + image), pd-ssd; min 100 GB.
- `acceleratorCount = clamp(ceil(memNeedGb / perGpuMem), 1, 8)`.

### 5.2 TPU — next-step

TPU is a documented contract only in v1. Real provisioning returns **501**; the mock provider simulates it. When implemented: map `estimate` → TPU generation/topology (e.g. v5e `2x2` … `4x8`) on the Cloud TPU API. Until then, TPU always routes to `gcp` (rule 2) and surfaces "TPU bursting is coming soon" on the real path.

---

## 6. Cost guardrails

No burst proceeds past a cap without an explicit policy decision. Caps are evaluated **before** `provision()` and re-checked on lifetime extension.

| Guardrail | Default | Behavior on breach |
|---|---|---|
| Per-burst budget cap | $25 est. | **Confirm** if over; **deny** if over hard ceiling (below) |
| Per-burst hard ceiling | $100 est. | **Deny** outright; never auto-provision |
| Per-user/day cap | $200/24h rolling | **Queue** further bursts until window rolls; notify user |
| Max instance lifetime | 6h | Auto-teardown at deadline regardless of state; checkpoint first |
| Require-confirmation threshold | est. cost ≥ $25 **or** count ≥ 4 GPUs **or** H100/A100 family | Block on explicit user confirm |
| Idle auto-teardown | no progress / 0% GPU util for 15 min | Teardown (guaranteed; §8) |

**Estimated burst cost** `≈ pricePerHour(machine, gpu, count, region) * (estimate.estimatedMinutes/60) * overrunFactor`, with `overrunFactor = 1.5` to budget for ETA blowout. Pricing is a static per-region table in v1 (learned model in §11).

**Cap → decision mapping.**

```
if estCost > HARD_CEILING:                 DENY  (reason: "exceeds max per-job budget")
elif userDaySpend + estCost > DAY_CAP:     QUEUE (reason: "daily compute budget reached")
elif estCost >= CONFIRM_THRESHOLD
     or count >= 4 or family in {A100,H100}: REQUIRE_CONFIRM
else:                                       ALLOW
```

A **denied** burst from the runtime trigger (§4.4) keeps the job on-device with a clear note. A **queued** burst holds in `pending` and retries when the rolling window frees budget. Teardown is **guaranteed** on every terminal path (completed/failed/denied-after-provision/lifetime); teardown is idempotent and safe to call on failure.

---

## 7. Region / zone selection & quota fallback

1. **Default region** = the resolved BYOC creds region (`ResolvedGcpCreds.region`), else `ONE_BURST_DEFAULT_REGION`, else `us-central1`.
2. **Zone candidates** = the chosen region's zones that offer the selected GPU family, ordered by historical success then alphabetically.
3. **Provision attempts** walk the candidate zones. On `ZONE_RESOURCE_POOL_EXHAUSTED` / `QUOTA_EXCEEDED` / stockout, advance to the next zone.
4. **Cross-region fallback** (opt-in per request) tries a small allowlist of nearby same-continent regions to preserve data-residency expectations; never crosses a residency boundary implicitly.
5. **GPU downshift** (last resort, only if `memNeedGb` still fits a smaller device): T4↔L4 within the same memory class, never silently reducing total accelerator memory below `memNeedGb`.
6. After exhausting candidates → **fail** per §8.

Every attempt records zone + outcome (not creds) for the SLO/observability spec.

---

## 8. Failure & fallback semantics

| Failure | Detection | Behavior | User message |
|---|---|---|---|
| No quota / stockout (all zones) | provision errors | Fall back to on-device if it fits; else queue | "Cloud capacity is tight — kept this on One for now." |
| BYOC creds invalid/expired | auth error pre-provision | Do **not** retry; surface | "Couldn't reach your cloud — check your connection in Settings." |
| Out of credits / billing disabled | billing error | Deny; no partial provision | "Your cloud account is out of credits." |
| Budget cap (§6) | pre-provision gate | Deny/queue; stay local if fits | "Kept on-device — this would exceed your compute budget." |
| Oversize (> 8×H100) | sizing (§5) | Deny; advise splitting | "This workload is larger than One can burst today." |
| Provision succeeds, run fails | poll status `failed` | Guaranteed teardown; report exit/error | "The cloud run failed — your data is untouched." |
| Lifetime / idle teardown | §6 timers | Checkpoint if possible, teardown | "Stopped the cloud run after the time/idle limit." |

**Graceful-degradation rule.** Whenever a burst cannot proceed and the workload *statically fits* the Puppy under §3, prefer on-device over failing. If it does not fit and cannot burst, the job stays `pending` with a precise, actionable reason — never a silent stall. No failure path leaks creds, stack traces, or internal identifiers into user-facing text.

---

## 9. Worked examples

Device = `DEFAULT_PUPPY_PROFILE` unless noted. `memBudget = 153.6 GB`, `diskBudget = 1638.4 GB`.

**E1 — Comfortable fit (local).** `estimate{vram:50, unified:50, disk:100, vcpus:8}`, gpu.
`memNeed=50 ≤ 153.6`, `disk=100 ≤ 1638.4`. → **puppy**, headroom `{memory:103.6, disk:1538.4}`. Reason: "Fits … ~103.6GB memory headroom."

**E2 — Boundary, exactly at 0.8 (local).** `estimate{vram:153, unified:153}`.
`memNeed=153 ≤ 153.6` ⇒ headroom `0.6 ≥ 0`. → **puppy** (inclusive boundary). Note: this is the static admission decision; §4 may still promote at runtime if real pressure fires.

**E3 — Mem-bound, unified is binding (burst).** `estimate{vram:2, unified:180}`.
`memNeed = max(2,180) = 180 > 153.6` ⇒ headroom `-26.4`. → **gcp**, mem-bound. Per §5, `memNeed=180 → 3×A100-80GB`, `a2-ultragpu-4g`. Illustrates the Apple-Silicon unified-pool rule: tiny VRAM, huge RAM still bursts.

**E4 — Disk-bound (burst).** `estimate{vram:40, unified:40, disk:5000}`.
mem fits (`40 ≤ 153.6`) but `disk 5000 > 1638.4` ⇒ disk headroom `-3361.6`. → **gcp**, disk-bound. Boot disk `= ceil(5000*1.25)+50 = 6300 GB`.

**E5 — TPU + offline precedence.** `estimate{vram:1, unified:1}`, `acceleratorKind="tpu"`, device `online=false`.
Rule 1 (offline) fires before rule 2. → **gcp**, "offline." (Order matters: offline outranks TPU; both burst regardless.) On the real path TPU then yields the 501 "coming soon" contract (§5.2).

**E6 — Runtime promotion (dynamic).** E1 admitted local; at `t=4min`, `memPressurePct=88%` for 35s **and** `swapRateMBs=240` for 25s. Both fire after `D_local` and the 10s hold. → **PROMOTE**; cost gate: est. $9 < $25 → ALLOW; provision T4 (memNeed still 50 → wait: 50 > 16/24 → L4×2 / `g2-standard-24`); resume from checkpoint; teardown local. User sees "One needs more power — moving this run to your cloud."

---

## 10. Test hooks

**Existing — static model** (`src/lib/burst/placement.test.ts`, keep green): comfortable fit; mem-exceeds-budget; disk-exceeds-budget; TPU always bursts; offline bursts; degenerate/unknown estimate bursts; unified-memory (not VRAM) binding; headroom reported; default `acceleratorKind` = gpu.

**To add — static boundaries:** headroom exactly `0` ⇒ puppy; headroom `-0.1` ⇒ gcp; offline-outranks-TPU ordering; disk-bound while mem-fits names *disk*; negative headroom is still reported on a burst.

**To add — runtime trigger:** single fire-signal promotes after dwell; warn-alone does not; two warns sustained over `W` promote; `D_local` blocks promotion in first 90s; per-signal dwell resets on a sub-threshold dip; promotion is latched (no demotion after pressure clears); cooldown `C` suppresses subsequent promotions; confirmation hold `H` cancels a pure transient; `thermalState==critical` bypasses `H`; ETA `etaRatio≥2.0` with `remaining>10min` fires, but `≥2.0` with `remaining<10min` does not.

**To add — guardrails/fallback:** est. cost > hard ceiling ⇒ DENY; day-cap breach ⇒ QUEUE; confirm-threshold ⇒ REQUIRE_CONFIRM; denied runtime promotion keeps job local with note; teardown idempotent + called on every terminal path; zone-exhaustion walks candidates then falls back; oversize (>8×H100) denied; no creds/PII in any reason string (assert against the message set in §3.5/§8).

---

## 11. Future

- **Multi-cloud.** `ComputeBurstProvider` (in `types.ts`) already abstracts `provision/submit/pollStatus/teardown` behind `BurstProviderId`. Add Azure / AWS / Neo-cloud implementations without touching routes; extend the sizing table (§5) and pricing table (§6) per provider; add provider as a placement dimension (price/locality/quota-aware routing).
- **Learned cost/perf models.** Replace static thresholds and the pricing table with models trained on `BurstJob` history: predict `estimatedMinutes`, real `memNeedGb` (close the estimate-vs-actual gap that drives §4 promotions), and per-zone provision success — feeding both the sizing table and the overrun factor.
- **TPU.** Promote §5.2 from 501-contract to real Cloud TPU provisioning with a generation/topology sizing table.

---

### Related specs

- the white paper (docs/whitepaper-xtreme-compute-burst.md)
- one-puppy macOS agent spec (docs/specs/one-puppy-macos-agent.md)
- SLO spec (docs/specs/slo-observability.md)
