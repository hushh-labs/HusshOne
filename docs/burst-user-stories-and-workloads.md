# One Burst Compute — user stories, ideal workloads & a live simulation

This is the "who is it for, what is it perfect at, and does it actually pay off" companion to
the [white paper](./whitepaper-xtreme-compute-burst.md) and the [placement spec](./specs/placement-autoscale.md).
The routing logic and the burst lifecycle described here are **real, tested system behavior**
(`src/lib/burst/placement.ts`, the provider lifecycle, and the
[simulation harness](../src/lib/burst/simulation.scenario.test.ts)). Dollar, runtime, and
accuracy figures are **modeled inputs you can edit** in `src/lib/burst/simulation.ts`.

Run it yourself:

```bash
npm run sim:burst        # routes 6 workloads through the real engine and completes every cloud burst
```

---

## The one-sentence value

One runs work on your Mac by default, and **bursts to a supercomputer in your own cloud only
when the job won't fit** — so cheap, private jobs stay free and local, and heavy or impossible
jobs still get done, faster and at full accuracy, paying only for the seconds you use.

The decision is automatic and least-surprising (`decidePlacement`): it keeps a job local when it
fits under 80% of the Mac's unified memory and disk, and bursts otherwise — naming the binding
constraint (memory, disk, TPU, offline, or unknown size).

---

## Who it's for (user stories)

| Persona | Story | What One does |
|---|---|---|
| **Indie / solo developer** | "Tune a small model on my own data without renting a GPU or shipping data anywhere." | Runs **on-device** — $0 cloud, data never leaves the Mac. |
| **Design / creative studio** | "Overnight batch renders without per-seat cloud GPU bills." | Runs **on-device** when it fits; bursts only the oversized batches. |
| **AI startup ML engineer** | "Train the *full* model — quantizing to fit a laptop tanks quality — but I can't justify a standing 8×A100 box." | **Bursts** to multi-GPU on demand; tears it down after. |
| **Quant researcher** | "Backtest the *whole* tick history overnight, not a 10% sample that hides tail risk." | **Bursts** (disk-bound) to run the full dataset. |
| **Biotech researcher** | "My pipeline targets TPUs — there's no Apple-Silicon path at all." | **Bursts** to Cloud TPU (the only place TPUs exist). |
| **Enterprise data scientist** | "Whole hyperparameter sweep done before standup, fanned out — not serial for two days." | **Bursts** wide, completes in one wall-clock window. |

---

## Which workloads it's perfect for

**Ideal to burst (heavy / spiky / infeasible locally):**
- Full fine-tunes and pre-training of large models (70B-class and up) — exceed unified memory.
- Multi-GPU / multi-node training and large hyperparameter sweeps — need fan-out.
- **TPU-only** pipelines (folding, large JAX models) — no on-device path exists.
- Data-heavy jobs whose working set exceeds local disk (multi-TB backtests, genomics, ETL).
- Deadline-bound bursts ("before standup", "overnight") where wall-clock matters more than $/hr.

**Ideal to keep on-device (the Puppy tier earns its keep here):**
- LoRA / adapter fine-tunes, distillation, and inference on small-to-mid models that fit in ≤80%
  of unified memory.
- Privacy-sensitive work that must never leave the device.
- Iterative, interactive loops where a 2-minute cloud provisioning tax would dominate.

**Poor fit (be honest):**
- Ultra-low-latency online serving (a burst's provisioning overhead is the wrong tool).
- Tiny jobs where any cloud round-trip costs more time than it saves — One keeps these local by design.

---

## Does it actually pay off? (live simulation results)

Routing 6 representative workloads through the **real** engine on a maxed M3 Ultra (192 GB):

| # | Workload | Decision | Time-to-result | Burst cost | Accuracy vs shrink-to-fit |
|---|---|---|---|---|---|
| 1 | LoRA fine-tune (8B) | **on-device** | 27m | $0 (avoids $0.30) | full, local |
| 2 | Diffusion batch (500 frames) | **on-device** | 49m | $0 (avoids $0.53) | full, local |
| 3 | Full fine-tune (70B) | **burst** 8×A100 | ~242m | $118.74 | **+18 pts** (91% vs 73%) |
| 4 | 5 TB backtest | **burst** (disk) | ~182m | $3.37 | **+13 pts** (99% vs 86%) |
| 5 | Protein folding (TPU) | **burst** TPU v5e-8 | ~92m | $14.79 | **unblocks** (impossible locally) |
| 6 | 100-trial HPO sweep | **burst** 8×A100 | ~122m | $59.96 | **+12 pts** (93% vs 81%) |

Every bursted job was driven through the real provider lifecycle to **`completed` (exit 0)** —
provisioned, ran, returned a result, torn down.

**Portfolio economics (modeled monthly frequencies):**

- **Time** — the four heavy jobs are *infeasible* on the Mac at full size; burst turns "can't run"
  into "done in ≤4 hours," and keeps the two light jobs instant and local.
- **Money** — **$1,555/mo** pay-per-use vs **$21,455/mo** for one standing 8×A100 box → **~$19,900/mo
  saved (93%)**, because real utilization is only **~17%**. You stop paying for idle accelerators.
- **Accuracy** — bursting runs the full-size model / full dataset instead of a shrink-to-fit proxy:
  **+12 to +18 points**, and the TPU job is simply impossible without it.

> **What's real vs modeled.** The *placement decision* and the *job-completion lifecycle* are the
> product's actual code, exercised live by the test. The prices, runtimes, and accuracy deltas are
> transparent inputs in `src/lib/burst/simulation.ts` — swap in your own committed-use / spot rates
> and measured numbers and the conclusions update automatically.
