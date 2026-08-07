# Adam — Enterprise GTM: the Fortune-100 Land-and-Expand Play

*The full go-to-market machine: product-led land, evidence-led expand, agent+human sales org, and channel distribution. Last updated 2026-08. Working document — the plan improves as receipts accumulate.*

---

## 0. The play in one paragraph

Adam enters the Fortune 100 the way the iPhone did: **through the employees, not the RFP.** Any employee installs Adam from a link on the device they already carry and immediately sees, priced to the dollar, what a supercomputer would do for the work in front of them. That visibility is the wedge ("Trojan horse" internally — never in front of a customer). The expansion is CFO-shaped: workloads burst into **the company's own Google Cloud** — their VPC, their keys, their bill, pay-per-second, receipts for every job. We don't sell compute; we make their existing devices and their existing cloud commitment dramatically more productive. Land free in a day, prove on their workloads in a week, expand team-by-team on receipts, standardize as policy.

## 1. ICP and the entry points

**Primary ICP:** Fortune 100/500 companies with (a) large Google Cloud commitments they under-consume, (b) big fleets of high-end laptops/phones, (c) compute-hungry teams queueing for shared clusters.

**Entry personas (land):** the frustrated practitioner — data scientist waiting on the cluster, quant sampling instead of full-history backtesting, media engineer rendering overnight. Adam is free for them and requires nothing from IT.

**Economic buyers (expand):** VP Data/AI (velocity), CFO/FinOps (idle GPU burn → pay-per-second), CISO (BYOC, keys-never-persisted, audit trail), CIO (no new vendor-hosted data path — it's *their* cloud).

**The receipt is the sales asset.** Every burst produces: what ran, where, duration, cost, and the naive alternative's cost. Champions forward receipts; receipts book meetings.

## 2. The four-stage motion

| Stage | Time | What happens | Exit criterion |
|---|---|---|---|
| **1 Land** | Day 1 | Employees install Adam (PWA link; no procurement). Planning is free — placement + hardware + price for their real asks | ≥25 weekly planners in one account |
| **2 Prove** | Week 1–2 | Pilot kit stands up burst in *their* GCP project (script/Terraform, reversible). 3–5 lighthouse workloads run for real | 3 receipts a champion forwards |
| **3 Expand** | Month 1–3 | Team-by-team rollout on receipts; account team maps org, harvests planner signups as leads | 3+ teams, monthly burst spend trend |
| **4 Standardize** | Quarter 2+ | The continuum becomes policy (on-device first, right-sized burst, no standing fleet). Enterprise agreement | Named in the company's AI/cloud standard |

## 3. The sales organization — agents + humans, one pipeline

Structure mirrors the product's own philosophy: **agents do the bounded, high-volume jobs; humans do judgment, trust, and the close.** One pipeline, every lead scored by the same signals.

### The agent team (built on our own stack — we dogfood One)
- **Lead-harvesting agent** — mines product telemetry (planner signups, burst receipts, onboarding-kit downloads — consented product signals only) plus public signals (cloud-commitment disclosures, AI hiring, GPU-shortage complaints) into scored accounts.
- **Lead-curating agent** — enriches and routes: which team inside the account, which persona, which lighthouse workload fits; drafts the receipt-based opening.
- **Outreach agents (email)** — sequence drafting + follow-up under human approval; every message anchored to a concrete receipt or a priced plan for *their* workload class, never generic AI copy.
- **Meeting-prep + account-memory agent** — briefs before every call; keeps the account graph (champions, blockers, receipts, spend trend) current in the CRM.
- **Conversion agent** — watches pilot health (activation, receipts/week, spend trend), flags stall risk, and proposes the expand play per team.
- *Rules:* agents draft, humans send; consent-first (aligned with PCHP posture); no scraped personal contact data.

### The human teams
- **Inside sales (SDR pod)** — phone + email on agent-curated leads; mission: convert planners → pilot meetings. Comp on qualified pilots, not raw meetings.
- **Field / solution selling ("door-to-door" for the F100)** — AE + solutions engineer pairs who run the pilot on the customer's real workloads and walk the receipts up the org. The demo IS the product on the buyer's own phone.
- **Account management** — post-land owners of the expand map; run the quarterly receipts review (velocity gained, dollars saved vs standing fleet) with the economic buyer.
- **Channel team** — owns the distribution partnerships (§4).
- **RevOps** — one funnel definition end-to-end (below), one CRM, agent-maintained hygiene.

### The funnel (one language for agents and humans)
`Visitor → Planner (free plan created) → Pilot (kit deployed in their cloud) → Receipted (first real burst) → Team (3+ users bursting) → Standard (policy + EA)`
Lead gen = everything that creates Planners. Lead closing = everything that moves Planner → Receipted. Expansion = Receipted → Standard. Every role, human or agent, is measured against exactly one of these transitions.

## 4. Channel & distribution — sell where the machines are sold

Name categories, not brands (canon: never claim partners we don't have).

- **PC & device manufacturers** — Adam ships as the answer to "why buy the high-end configuration?": the device is a supercomputer *and* the front door to one. Play: preload/bundle motions, retail demo mode (the 7-second wow), co-marketing on the compute continuum. The device maker sells more premium units; we land everywhere they ship.
- **Cloud & supercomputing providers** — Adam converts idle enterprise commitments into metered, attributable consumption on *their* newest GPU/TPU SKUs. Play: marketplace listings, co-sell with their enterprise reps (Adam gives their sellers a consumption story per account), certification on the newest hardware at launch.
- **Resellers / GSIs / integrators** — the pilot kit is their services wedge: land Adam, bill the standardization program.
- **Agent platforms** — the A2A card + AP2 offers make the capability discoverable and transactable by other agents programmatically; every agent platform is a storefront.

## 5. Marketing & advertising — receipts over reach

- **The 7-second proof** (zero-attention-span law): phone asks the impossible → decision card ("4× B200 in your cloud — $84/hr, 90 min") → done. Short-form first: 7s → 27s → 69s ladder; slice everything from it.
- **Content engine:** customer stories (`/customers`, machine-readable at `/api/stories`), the white paper, the enterprise page (`/enterprise`), the masterclass film pipeline in `hushh-agents` for keynote-craft pieces.
- **Advertising:** narrow, persona-targeted, receipt-anchored ("Backtested 5 TB for $2") — no generic AI brand spend until the PLG flywheel is measured.
- **PLG loop instrumented in-product:** free planning → "burst it" moment → onboarding kit → receipts → shareable savings. Every step emits an event (`/api/one/events`) the lead-harvesting agent consumes.

## 6. Metrics that run the machine

- **North star:** weekly receipted bursts per enterprise account.
- Land: planner signups/week, plan→pilot conversion. Prove: kit-deploy time, first-receipt time. Expand: teams/account, burst $/account/month, receipts forwarded. Efficiency: CAC by motion (PLG vs outbound vs channel), agent-drafted vs human-drafted reply rates.
- **Honesty bar in all collateral:** on-device + BYOC burst are live; edge + supercomputing-scale tiers are "expanding"; sim-derived numbers cite the sim.

## 7. Sequencing (first two quarters)

1. **Now:** launch `/enterprise` + pilot kit (this repo, gated only on the prod deploy); wire funnel events; stand up the CRM pipeline (Salesforce connector already available to the org).
2. **Q1:** first 3 lighthouse accounts via founder network + inside-sales pod on product signals; agent team v1 (harvest, curate, draft — human send).
3. **Q2:** first device-maker and cloud-provider channel conversations with receipts in hand; marketplace listing; expand agent team to pilot-health + conversion.

---

*Related: the positioning brief (`docs/one-network-positioning.md`), the Adam working-backwards brief, `/customers` stories, and the burst white paper. This play feeds the same brain as everything else — update it with every closed pilot.*
