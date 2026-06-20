# One Burst Compute — case studies & customer stories

How One creates value in the real world: it **understands a workload**, **benchmarks the
hardware**, **matches the best accelerator for the job**, **offloads and completes it** in the
customer's own cloud, and reports the **time, money, and accuracy** at the end.

> These are **representative, composite stories** — illustrative personas, not named customers.
> The mechanics are real system behavior: placement (`src/lib/burst/placement.ts`), hardware
> matching (`src/lib/burst/hardware.ts`), and the burst lifecycle (`/api/one/burst`) all run in
> the live simulation (`npm run sim:burst`, `npm run sim:burst:e2e`). Prices, runtimes, and
> accuracy figures are transparent, editable model inputs.

---

## How One does it (the loop behind every story)

1. **Listen / understand the workload** — One profiles the job's shape: accelerator memory,
   working-set on disk, accelerator family (GPU vs TPU), and how parallel it is.
2. **Decide placement** — if it fits in ≤80% of the Mac's unified memory and disk, it stays
   **on-device** (free, private). Otherwise it **bursts**.
3. **Benchmark & match the best hardware** — for a burst, One picks the accelerator class with
   the **best performance-per-dollar that actually fits** — not the biggest box (overpay), not
   the smallest (won't fit / crawls).
4. **Offload & complete** — provisions the instance in the customer's cloud, streams progress,
   runs the workload, returns the result, and **tears the instance down** (no idle spend).
5. **Report** — time-to-result, spend, and the accuracy delta vs any shrink-to-fit workaround.

Every case below was routed by this loop in the live run.

---

## Case 1 — The AI startup that needed the *whole* model

**Customer:** a Series-A AI startup; a 4-person ML team shipping a domain assistant.
**Workload:** a full fine-tune of a **70B-class** model (~220 GB accelerator memory, 8-way
parallel, ~4 h).

**The before.** Their MacBooks and even a Mac Studio can't hold a 70B model. Their only options
were to **quantize it down to an 8B proxy** (and watch quality drop) or sign up for a standing
multi-GPU cloud box they'd pay for around the clock.

**What One did.**
- *Understood it:* 220 GB, GPU, highly parallel → cannot fit the Mac → **burst**.
- *Benchmarked the hardware:*

  | Pick | Hardware | Time | Cost | Verdict |
  |---|---|---|---|---|
  | Naive cheap | T4 | — | — | **won't fit** (needs 14× T4) |
  | **One's match** | **8× A100 80GB** | **~242 m** | **$118.42** | best perf-per-dollar that fits |
  | Naive premium | 8× H100 80GB | ~100 m | $130.90 | faster, but more $ for the same result |

- *Completed it:* offloaded, ran, returned the checkpoint, tore the cluster down.

**The outcome.** They trained the **full 70B** instead of an 8B proxy — **+18 accuracy points**
(91% vs 73% on their eval) — for **$118 a run**. Against a standing 8×A100 box (~**$21,455/mo**),
their real usage (8 runs/mo) cost **~$940/mo** — they stopped paying for idle GPUs.

> *"We were about to put a GPU server on the company card. Instead we pay per run, and we ship the
> real model — not the one that fit."*

---

## Case 2 — The quant fund that stopped sampling

**Customer:** a systematic trading desk.
**Workload:** a strategy backtest across the **full 5 TB tick history** (IO-bound, modest GPU,
~3 h).

**The before.** 5 TB doesn't fit a laptop's disk, so they backtested on a **10% sample** — which
quietly hid tail risk. The "fast" instinct was to throw a big GPU at it.

**What One did.**
- *Understood it:* 5 TB working set → exceeds local disk → **burst**; and the job is **IO-bound**,
  not compute-bound.
- *Benchmarked the hardware:*

  | Pick | Hardware | Time | Cost | Verdict |
  |---|---|---|---|---|
  | Naive cheap | 2× T4 | ~362 m | $4.22 | slower *and* pricier |
  | **One's match** | **1× L4** | **~182 m** | **$2.12** | right tool for an IO-bound job |
  | Naive premium | 1× H100 | ~18 m | $3.00 | a frontier GPU mostly idle on an IO job |

- *Completed it:* full-dataset backtest, result returned, instance down.

**The outcome.** They now run the **entire history** every night — **+13 accuracy points** on tail
estimates (99% vs an 86% sample proxy) — for **~$2 a run**. One's match was **cheaper than the
naive cheap pick and the premium pick**, because it understood the job was about data, not FLOPs.

> *"The H100 felt right and was almost pure waste. One put it on an L4 and it cost two dollars."*

---

## Case 3 — The biotech lab that was simply blocked

**Customer:** a computational-biology lab.
**Workload:** a protein-structure / MD run whose pipeline targets **TPUs** (JAX/XLA), ~1.5 h.

**The before.** There is **no Apple-Silicon path** for their TPU pipeline — the work was
impossible on the device, full stop. Standing up TPUs by hand was a week of DevOps they didn't have.

**What One did.**
- *Understood it:* `acceleratorKind: tpu` → TPUs exist **only in the cloud** → **burst to TPU**.
- *Matched the hardware:* **8× Cloud TPU v5e** — the family the workload actually needs.
- *Completed it:* provisioned the TPU slice, ran the pipeline, returned results, tore it down.

**The outcome.** A workload that returned **nothing** on a Mac now **completes in ~92 minutes for
~$14.79** — and the credential, data, and bill stayed in the lab's own project.

> *"It wasn't slow before. It was impossible. Now it's a 90-minute job."*

---

## Case 4 — The enterprise team that beat the standup clock

**Customer:** a data-science team inside a large enterprise.
**Workload:** a **100-trial hyperparameter sweep** (~300 GB aggregate, 8-way parallel, ~2 h).

**The before.** Run serially on one box, the sweep took ~two days — so they ran *fewer* trials and
shipped a worse model.

**What One did.**
- *Understood it:* 300 GB + high parallelism → **burst**, fanned out.
- *Benchmarked the hardware:*

  | Pick | Hardware | Time | Cost | Verdict |
  |---|---|---|---|---|
  | **One's match** | **8× A100 80GB** | **~122 m** | **$59.70** | best perf-per-dollar that fits |
  | Naive premium | 8× H100 80GB | ~51 m | $66.76 | latency option if a deadline demands it |

- *Completed it:* the whole sweep finished in one wall-clock window.

**The outcome.** The full sweep lands **before standup** for **~$60** — **+12 accuracy points** on
the best model (93% vs an 81% truncated-sweep proxy). And when a deadline truly demands it, One can
match the **H100** to cut the wall-clock to ~51 minutes — *the point is it matches to your priority,
cost or speed.*

---

## Case 5 — The work that *should* stay home (One isn't "send everything to the cloud")

**Customers:** an indie iOS developer (LoRA fine-tune of an 8B model) and a design studio
(500-frame diffusion batch).

**What One did.** Both fit comfortably under 80% of a Mac Studio's 192 GB unified memory, so One
**kept them on-device** — with ~114 GB and ~90 GB of headroom to spare.

**The outcome.** **$0 cloud, full accuracy, and the data never left the machine.** The credibility
of the whole system is here: One bursts when it *helps*, and refuses to when it doesn't — saving the
cloud bill *and* the privacy.

> *"It just ran it on my Mac and told me why. No upload, no invoice."*

---

## Portfolio view (one team, one month)

Routing all six workloads through the real engine, at modeled run frequencies:

| Metric | Result |
|---|---|
| Routing | **2 kept on-device**, **4 bursted** (each offloaded, completed, torn down) |
| Pay-per-use burst spend | **$1,554.56 / mo** |
| Standing always-on box (one 8×A100, 24/7) | **$21,454.70 / mo** |
| **Saved** | **$19,900 / mo (93%)** — at **~17% true utilization** |
| Better output | **+12 to +18 accuracy points** on the heavy jobs; one job **unblocked** entirely |

**The throughline:** efficiency (right hardware, no idle spend), performance (completed in minutes,
fanned-out), and accuracy (the full model/dataset, not a shrink-to-fit proxy) — chosen automatically
by understanding each workload.

> **Real vs modeled.** Placement, hardware matching, and job completion are the product's actual
> code, exercised live by `npm run sim:burst` and `npm run sim:burst:e2e`. Prices, runtimes, and
> accuracy deltas live in `src/lib/burst/hardware.ts` and `simulation.ts` — drop in your
> committed-use / spot rates and measured numbers and every figure here recomputes.
