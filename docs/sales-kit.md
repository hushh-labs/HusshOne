# 🤫 Adam — Sales Kit

*Everything a seller needs to sell 🤫 Private Agent One for 💥 workloads. Pair with `docs/gtm-enterprise-play.md` (the motion) and `docs/marketing-kit.md` (the air cover). Keep every number honest — receipts close deals, hype re-opens them.*

---

## 1. The one-liner

> **Adam turns the computer your customer already owns into a supercomputer — and their cloud contract into results.** On-device when it fits ($0, private, instant); burst to the right-sized GPU/TPU in *their own* Google Cloud when it doesn't; torn down the moment the answer lands.

## 2. The pitches

**30 seconds (elevator):** "Your teams queue for a shared cluster while your laptops idle and your cloud commitment goes under-consumed. Adam fixes all three with one agent: it knows what the device in your hand can do, runs what fits right there for free, and bursts what doesn't to the exact right machine in your own Google Cloud — priced to the dollar *before* anything runs, deleted the moment it's done. Pilot in an afternoon, in your own project, fully reversible."

**2 minutes (first meeting):** add the three proof points (§5), the security posture (§6), and the ask: "Give me one team and one workload. The pilot kit is one script in your own GCP project. If the receipts don't convince you, you've lost an afternoon."

## 3. The side-by-side — how the customer gets compute today vs Adam

*This is the centerpiece. Draw it on the whiteboard. Categories, not vendor names — let the customer name their own incumbent.*

| | **Do-nothing (laptop only)** | **DIY cloud console** | **Managed GPU cloud / neocloud** | **Standing cluster (on-prem or reserved)** | **🤫 Adam** |
|---|---|---|---|---|---|
| Who decides where a job runs | The user guesses | The user guesses | The vendor's menu | The queue | **The agent — placement is automatic, reasoned, shown** |
| Uses hardware you already own | Only | No | No | No | **Yes — on-device first, $0 when it fits** |
| Cloud account | — | Yours | **Theirs** (your data on their account) | Yours/none | **Yours (BYOC)** — your VPC, your bill, your keys |
| Right-sizing | — | Manual (overpay or won't fit) | Their SKU list | Fixed | **Matched perf-per-dollar that fits — shown side-by-side vs naive picks** |
| Idle cost | $0 | Forgotten instances burn | Subscriptions/minimums | **The whole point — idle burns 24/7** | **$0 — exists only while the job runs, torn down after** |
| Price known before running | — | No | Sometimes | N/A (sunk) | **Yes — to the dollar, before anything runs** |
| Newest hardware (H200/B200/GB200, Trillium) | Never | If you know what to pick | Waitlists vary | Refresh cycle (years) | **Day-one in the catalog, matched automatically** |
| Setup for a first user | — | Hours + expertise | Account + card + docs | Months | **A link. The pilot: one script, one afternoon** |
| Security review surface | — | Your controls | **New vendor data path** | Yours | **No new data path — everything runs in the customer's own cloud; keys never persisted** |
| Agent-ecosystem ready | No | No | Rarely | No | **A2A card + AP2 offers + MCP — other agents can discover and use it** |

**The sentence that lands it:** *"Everyone else sells you a place to run compute. Adam is the intelligence that decides where compute should run — and the place is one you already own."*

## 4. Value creation — where the money is made (show, don't claim)

| Value lever | Without Adam | With Adam | The receipt to show |
|---|---|---|---|
| **Better results** (train the real thing) | Shrunk 8B proxy because the full model "doesn't fit" | The full 70B, ~$118/run | **+18 accuracy points** — capability that was being left on the table |
| **Speed** (time-to-result) | Overnight render, days in a queue | Right-sized burst, minutes-to-hours | "Overnight → over coffee" |
| **Cost avoidance** | Standing GPU box burning 24/7 | Pay-per-second, auto-teardown | **~93% cheaper** for the same completed job |
| **Full-fidelity work** | Sampled backtest | All 5 TB of history | **~$2** for the full backtest |
| **Free tier they own** | Laptops idle while cloud is rented | On-device placement | **2 of 6 representative workloads ran at $0** |
| **Cloud ROI** | Committed spend under-consumed | Attributable, metered consumption | Finance sees *which team, which job, which dollar* |

ROI math to do live with the buyer: (jobs/week that queue or get downsized) × (hours saved + capability delta) vs (pilot cost ≈ one afternoon + per-second usage). It routinely clears in week one.

## 5. Proof points (memorize these five)

1. Full **70B fine-tune ~ $118**, **+18 points** vs the shrunk proxy.
2. **5 TB backtest ~ $2**.
3. **~93% cheaper** than a standing box for the same job.
4. **$0** for what fits on-device (2 of 6 representative workloads).
5. TPU-only science (protein folding) **possible from a phone** — impossible on any laptop.

*Honesty bar: representative composites with transparent, editable figures; sims cite the sim. Say so if asked — it builds trust.*

## 6. Security / procurement answers (the CISO three)

- **"New data path?" No.** Workloads run in the customer's own GCP project/VPC. Hushh operates no compute and stores no customer data from bursts.
- **"Credentials?"** Used in-memory only, never persisted; on Apple devices, held in Secure Enclave/Keychain. Full audit trail per job.
- **"Blast radius?"** One reversible script in one project they control; teardown is automatic, even on failure. Kill it by revoking one service account.

## 7. Objections → answers

- *"We already have a cluster."* — Keep it. Adam feeds it the right jobs and catches the overflow that queues today. The comparison isn't cluster-vs-Adam; it's queue-vs-answer.
- *"We already have cloud."* — Perfect: Adam is how the *rest* of the company actually consumes it. BYOC means we make your existing commitment productive, not replace it.
- *"Just another GPU reseller?"* — We sell no compute. Zero margin on chips. The product is the placement intelligence and the seamless act.
- *"Why not just use the console?"* — Ask who in the buying team can name the right machine for a 640GB fine-tune, its $/hr, and remember to turn it off. Adam does all three, every time.
- *"Is it real?"* — Live product (one.hushh.ai/adam), 25-check public launch gate, 328-test engine, demo in 30 seconds on the buyer's own phone.

## 8. The demo (the buyer's phone IS the demo)

1. Open **one.hushh.ai/adam** on *their* iPhone (UAT link pre-launch). Tap **▶ Watch the demo** — Adam narrates itself in 30 seconds.
2. Then their turn: "Fine-tune the full 70B" → the card: **N× B200 in *your* Google Cloud — $, minutes**. Tap "Why this hardware?" → matched vs naive, priced.
3. "Enhance a 4K clip" → **$0 — runs right here.** Land the line: *"That's the whole company: what fits runs free on what you own; what doesn't gets exactly the right machine in your cloud."*
4. Close: "One team, one workload, one afternoon" → the pilot kit (/docs/onboarding-kit).

## 9. Packaging & pricing talk track

- **Adam (individual):** free planning; bursts at the customer's own cloud cost. (We are not a compute middleman.)
- **Pilot:** the kit, one team, self-serve — free.
- **Enterprise:** org-wide placement policy, audit, priority support, fleet features — the EA conversation *after* receipts (stage: Standardize). Never lead with it.

## 10. The close checklist

☐ Champion identified (the person whose job queued) ☐ Receipt forwarded ☐ Pilot deployed in *their* project ☐ 3 receipts ☐ Economic-buyer review booked with the receipts ☐ Expand map drawn ☐ CRM stages current (see GTM play §8)

---

Built and published by the 🤫 Research & Advisory Team · Signed **🤫 Confidential**
*Simplicity is the signature of excellence.*
