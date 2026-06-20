/* Single source of truth for the One Burst Compute case studies + agent-consumable
   offers. Powers the SEO pages (/customers), the JSON feed (/api/stories), the A2A
   agent card, the AP2 offer catalog (/.well-known/ap2/offers.json), the MCP overview
   tool, and the generated one-page PDFs — so every surface stays in sync.

   Stories are representative composites (illustrative personas, not named customers).
   Figures are grounded in the live simulation + the hardware recommender; prices are
   modeled inputs (see src/lib/burst/hardware.ts). */
import { ACCEL_CATALOG } from "@/lib/burst/hardware";

export interface BenchRow { role: "undersized" | "matched" | "oversized"; hardware: string; time: string; cost: string; note: string }

export interface CaseStudy {
  slug: string;
  persona: string;
  industry: string;
  title: string;
  summary: string; // one-line, for cards + meta description
  challenge: string;
  understanding: string; // how One profiled/listened to the workload
  hardware: string; // the matched best hardware + why
  benchmark?: BenchRow[];
  completion: string; // offload → run → complete → teardown
  outcomes: { label: string; value: string }[];
  quote: string;
  tags: string[];
}

export const CASE_STUDIES: CaseStudy[] = [
  {
    slug: "ai-startup-full-70b-finetune",
    persona: "AI startup ML engineer",
    industry: "Artificial intelligence",
    title: "Training the full 70B model — not a laptop-sized compromise",
    summary: "A 4-person team trains a full 70B fine-tune per run for $118 instead of a standing $21K/mo GPU box — and ships +18 accuracy points.",
    challenge:
      "A 70B-class model needs ~220 GB of accelerator memory — impossible on a Mac. The team's only options were to quantize down to an 8B proxy (and lose quality) or pay for a standing multi-GPU box around the clock.",
    understanding: "One profiled the job at ~220 GB accelerator memory, GPU, 8-way parallel — far past the Mac's headroom — so it routed to a cloud burst.",
    hardware: "Matched 8× NVIDIA A100 80GB (640 GB) — the best performance-per-dollar that fits. A T4 pick wouldn't fit (would need 14 chips); an 8× H100 box would finish faster but cost more for the same result.",
    benchmark: [
      { role: "undersized", hardware: "T4", time: "—", cost: "—", note: "won't fit (needs 14× T4)" },
      { role: "matched", hardware: "8× A100 80GB", time: "~242 min", cost: "$118.42", note: "best perf-per-dollar that fits" },
      { role: "oversized", hardware: "8× H100 80GB", time: "~100 min", cost: "$130.90", note: "faster, but more $ for the same result" },
    ],
    completion: "One provisioned the cluster in the team's own GCP project, streamed progress, returned the checkpoint, and tore the cluster down — no idle spend.",
    outcomes: [
      { label: "Output quality", value: "+18 accuracy pts (91% vs 73% proxy)" },
      { label: "Cost per run", value: "$118.42 (pay-per-use)" },
      { label: "Vs standing box", value: "~$940/mo vs ~$21,455/mo" },
      { label: "Time-to-result", value: "~242 min, fully managed" },
    ],
    quote: "We were about to put a GPU server on the company card. Instead we pay per run, and we ship the real model — not the one that fit.",
    tags: ["fine-tuning", "llm", "gpu", "training", "byoc"],
  },
  {
    slug: "quant-fund-full-history-backtest",
    persona: "Systematic trading desk",
    industry: "Finance",
    title: "Backtesting the full 5 TB history — for two dollars a run",
    summary: "A quant desk runs the entire tick history nightly on a right-sized L4 for ~$2 — instead of a 10% sample that hid tail risk.",
    challenge:
      "5 TB of tick history doesn't fit a laptop's disk, so the desk backtested on a 10% sample — quietly hiding tail risk. The instinct was to throw a big GPU at it.",
    understanding: "One saw a 5 TB working set (exceeds local disk → burst) that is IO-bound, not compute-bound — so raw GPU horsepower wouldn't help.",
    hardware: "Matched 1× NVIDIA L4 — cheaper than the naive 2× T4 pick AND the H100 pick, because the bottleneck is data, not FLOPs.",
    benchmark: [
      { role: "undersized", hardware: "2× T4", time: "~362 min", cost: "$4.22", note: "slower and pricier" },
      { role: "matched", hardware: "1× L4", time: "~182 min", cost: "$2.12", note: "right tool for an IO-bound job" },
      { role: "oversized", hardware: "1× H100", time: "~18 min", cost: "$3.00", note: "a frontier GPU mostly idle" },
    ],
    completion: "Full-dataset backtest ran in the desk's own cloud, results returned, instance torn down.",
    outcomes: [
      { label: "Output quality", value: "+13 accuracy pts on tail estimates (99% vs 86% sample)" },
      { label: "Cost per run", value: "~$2.12" },
      { label: "Coverage", value: "100% of history (vs 10% sample)" },
    ],
    quote: "The H100 felt right and was almost pure waste. One put it on an L4 and it cost two dollars.",
    tags: ["backtesting", "finance", "data", "io-bound", "gpu"],
  },
  {
    slug: "biotech-protein-folding-tpu",
    persona: "Computational biology lab",
    industry: "Biotechnology",
    title: "A TPU-only pipeline that was simply impossible on a Mac",
    summary: "A folding pipeline that returned nothing on Apple Silicon now completes in ~92 minutes for ~$15 — on Cloud TPU, in the lab's own project.",
    challenge: "Their protein-structure / MD pipeline targets TPUs (JAX/XLA). There is no Apple-Silicon path — the work was impossible on the device, full stop.",
    understanding: "One recognized a TPU accelerator family — which exists only in the cloud — and bursted accordingly.",
    hardware: "Matched 8× Cloud TPU v5e — the family the workload actually needs.",
    completion: "One provisioned the TPU slice, ran the pipeline, returned results, and tore it down — credential, data, and bill stayed in the lab's own project.",
    outcomes: [
      { label: "Feasibility", value: "Impossible → completes in ~92 min" },
      { label: "Cost per run", value: "~$14.79" },
      { label: "Data control", value: "Stayed in the lab's own cloud" },
    ],
    quote: "It wasn't slow before. It was impossible. Now it's a 90-minute job.",
    tags: ["tpu", "science", "biotech", "jax", "byoc"],
  },
  {
    slug: "enterprise-hyperparameter-sweep",
    persona: "Enterprise data scientist",
    industry: "Enterprise software",
    title: "A 100-trial sweep done before standup",
    summary: "A sweep that took two days serially now finishes in ~2 hours for ~$60 — fanned out across 8× A100, with the best model up +12 points.",
    challenge: "Run serially on one box, a 100-trial hyperparameter sweep took ~two days — so the team ran fewer trials and shipped a worse model.",
    understanding: "One profiled ~300 GB aggregate with high parallelism → burst, fanned out.",
    hardware: "Matched 8× NVIDIA A100 80GB. If a deadline demands it, One can match 8× H100 to cut wall-clock to ~51 min — matching to your priority, cost or speed.",
    benchmark: [
      { role: "matched", hardware: "8× A100 80GB", time: "~122 min", cost: "$59.70", note: "best perf-per-dollar that fits" },
      { role: "oversized", hardware: "8× H100 80GB", time: "~51 min", cost: "$66.76", note: "latency option for a hard deadline" },
    ],
    completion: "The whole sweep finished in one wall-clock window in the team's own cloud, then tore down.",
    outcomes: [
      { label: "Output quality", value: "+12 accuracy pts on best model (93% vs 81%)" },
      { label: "Time-to-result", value: "~2 days → ~2 hours" },
      { label: "Cost per run", value: "~$59.70" },
    ],
    quote: "The full sweep lands before standup now. We stopped rationing trials.",
    tags: ["hpo", "training", "gpu", "enterprise", "parallel"],
  },
  {
    slug: "on-device-keeps-it-home",
    persona: "Indie developer & design studio",
    industry: "Independent / creative",
    title: "The work that should stay home — One isn't 'send everything to the cloud'",
    summary: "A LoRA fine-tune and a 500-frame render run on-device for $0, fully private — because One bursts only when it actually helps.",
    challenge: "Not every job belongs in the cloud. Small fine-tunes and batch renders fit a Mac — paying to ship them out wastes money and privacy.",
    understanding: "One found both jobs fit comfortably under 80% of a Mac Studio's 192 GB unified memory (≈114 GB and ≈90 GB headroom), so it kept them on-device.",
    hardware: "On-device (Apple Silicon) — no cloud hardware needed.",
    completion: "Ran locally; the data never left the machine and no instance was ever provisioned.",
    outcomes: [
      { label: "Cost", value: "$0 cloud" },
      { label: "Privacy", value: "Data never left the device" },
      { label: "Accuracy", value: "Full — no shrink-to-fit" },
    ],
    quote: "It just ran it on my Mac and told me why. No upload, no invoice.",
    tags: ["on-device", "privacy", "apple-silicon", "cost"],
  },
];

export function getCaseStudy(slug: string): CaseStudy | undefined {
  return CASE_STUDIES.find((c) => c.slug === slug);
}

export const PORTFOLIO = {
  keptOnDevice: 2,
  bursted: 4,
  burstSpendMonthly: 1554.56,
  alwaysOnMonthly: 21454.7,
  savedMonthly: 19900.14,
  savedPct: 93,
  utilizationPct: 17,
};

/* AP2-compatible offer catalog: each accelerator tier as an agent-consumable offer with
   pay-per-second pricing. Derived from the real hardware catalog so pricing never drifts. */
export interface BurstOffer {
  id: string;
  name: string;
  unit: "chip-hour";
  priceUsd: number;
  currency: "USD";
  accelerator: { family: string; memoryGbPerChip: number; maxChips: number };
  bestFor: string;
  billing: "pay-per-second";
}

export function burstOffers(): BurstOffer[] {
  return ACCEL_CATALOG.map((c) => ({
    id: `burst-${c.id}`,
    name: `One Burst — ${c.label}`,
    unit: "chip-hour",
    priceUsd: c.usdPerHourPerChip,
    currency: "USD",
    accelerator: { family: c.id, memoryGbPerChip: c.memGbPerChip, maxChips: 8 },
    bestFor: c.bestFor,
    billing: "pay-per-second",
  }));
}
