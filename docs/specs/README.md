# Xtreme Compute Burst — Documentation Index

The complete documentation set for **Hushh One — Xtreme Compute Burst**: personal supercomputing for
Apple Silicon with bring-your-own-cloud (BYOC) burst, published as an agent on the Gemini Enterprise
Agent Platform. Written for solution engineers, forward-deployed engineers, security/privacy
reviewers, and partners.

## Read in this order

| # | Document | For | What it covers |
|---|---|---|---|
| 1 | [White paper](../whitepaper-xtreme-compute-burst.md) | Everyone | The why, the architecture, the experience, status & roadmap. |
| 2 | [macOS experience](./macos-experience.md) | Design, PM, SE | The Steve-Jobs-bar UX: onboarding, the burst moment, cost, privacy, failure states. |
| 3 | [One Puppy macOS agent](./one-puppy-macos-agent.md) | macOS eng, FDE | The native on-device agent: telemetry, triggers, Keychain vault, the control-plane handshake, packaging. |
| 4 | [Placement & autoscale](./placement-autoscale.md) | Backend eng | The formal decision model, runtime burst triggers + hysteresis, accelerator sizing, cost guardrails. |
| 5 | [BYOC security & privacy](./byoc-security-privacy.md) | Security, privacy | Trust boundaries, credential lifecycle, least-privilege IAM, STRIDE, data-at-rest inventory, hardening roadmap. |
| 6 | [Agent registry & A2A card](./agent-registry-and-card.md) | FDE, integrations | Publishing to the Gemini Enterprise Agent Platform; the A2A card, tool contract, function declaration. |
| 7 | [API contract (OpenAPI 3.1)](./burst-control-plane.openapi.yaml) | Integrations | The machine-readable control-plane contract (registry tool import). |
| 8 | [SLO & observability](./slo-observability.md) | SRE, on-call | SLIs/SLOs, error budgets, events, traces, dashboards, alerts, the cost-reconciliation sweep. |
| 9 | [FDE playbook](../runbooks/forward-deployed-engineer-playbook.md) | FDE, SE | End-to-end bring-up: validate, customer GCP setup, deploy, register, validate live, operate, rollback. |

Also: [feature overview](../xtreme-compute-burst.md) and the
[test plan & verification](../xtreme-compute-burst-test-plan.md).

## What is built vs. specified

| State | Items |
|---|---|
| **Built & tested** (this repo) | Placement engine; BYOC credential resolution + token-client caching; **GPU path (Compute Engine) + TPU path (Cloud TPU API)**; mock provider; streaming submit + recovery routes; **A2A agent-card endpoint**; **Puppy result callback**; **in-app "2-minute GCP setup" validation flow**; **static registry artifacts** (`registry/`); `BurstJob` persistence. 150+ burst tests, high line coverage. |
| **Built — needs a Mac to compile/notarize** | Native macOS One Puppy agent (SwiftPM package at `macos/OnePuppyAgent/`). |
| **Roadmap** | Secret-Manager/KMS credential vault + Workload Identity Federation; learned accelerator sizing; Azure/AWS/Neo-cloud providers. |
| **Customer-supplied to run live** | A GCP project with Compute Engine API + GPU quota (and, for TPU, a result bucket + TPU quota); a least-privilege SA key; a pullable container image. |

## Source of truth (code)
- Agent card + function declaration: `src/lib/burst/agent-card.ts` → served at `src/app/.well-known/agent.json/route.ts`
- Registry upload artifacts: `registry/agent-card.json`, `registry/function-declaration.json` (drift-tested)
- Placement: `src/lib/burst/placement.ts`
- BYOC creds: `src/lib/burst/credentials.ts`
- GCP providers: `src/lib/burst/providers/gcp.ts` (GPU), `src/lib/burst/providers/gcp-tpu.ts` (TPU), `gcp-common.ts` (shared)
- In-app GCP setup flow: `src/lib/burst/setup.ts` + `src/app/api/one/burst/setup/**` + `src/app/burst/setup/`
- Submit / recovery / puppy-result routes: `src/app/api/one/burst/**`
- Persistence: `src/lib/db/burst-store.ts`, `prisma/schema.prisma` (`BurstJob`)
- Native macOS One Puppy agent: `macos/OnePuppyAgent/` (SwiftPM; build/notarize on a Mac)
