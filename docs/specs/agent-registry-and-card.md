# Agent Registry & A2A Card — Xtreme Compute Burst

**Status:** Specification — for SE/FDE · **Last updated:** 2026-06-18

How the Xtreme Compute Burst agent is made **discoverable and installable** on Google's
**Gemini Enterprise Agent Platform** (formerly Vertex AI Agent Builder; Agent Engine runtime +
Cloud API Registry for tools) and via the open **A2A (Agent2Agent) protocol**.

> Grounding note for FDEs: Google rebranded Vertex AI → **Gemini Enterprise Agent Platform** at
> Cloud Next 2026 and consolidated it with Agentspace. The submission UIs/SDK names move faster than
> this doc; the *artifacts* below (A2A Agent Card, OpenAPI tool contract, function declaration) are
> the stable inputs every variant consumes. Confirm exact console/SDK steps against current Google
> docs at submission time.

## 1. Discovery surfaces (three, all driven by one source of truth)

| Surface | Artifact | Where | Consumer |
|---|---|---|---|
| **A2A discovery** | Agent Card | `GET /.well-known/agent.json` (live) | A2A clients, agent directories |
| **Managed tool** | OpenAPI 3.1 contract | `docs/specs/burst-control-plane.openapi.yaml` | Cloud API Registry / ADK `ApiRegistry` |
| **Function calling** | Gemini function declaration | §4 (embed in the agent/tool config) | Gemini models invoking the tool |

All three are generated from the same definitions in `src/lib/burst/agent-card.ts` and the route
handlers, so they never drift. **Bump `AGENT_CARD_VERSION`** when skills, endpoints, or auth change.

## 2. The A2A Agent Card

Served live and built from the request origin (so dev/preview/prod URLs are always correct). Schema:
A2A protocol **v0.3.0** `AgentCard`. Source: `src/lib/burst/agent-card.ts`; endpoint:
`src/app/.well-known/agent.json/route.ts`.

```jsonc
{
  "protocolVersion": "0.3.0",
  "name": "Hushh One — Xtreme Compute Burst",
  "description": "Personal supercomputing for Apple Silicon … bursts to the user's own GCP project …",
  "url": "https://one.hushh.ai/api/one/burst",
  "preferredTransport": "HTTP+JSON",
  "provider": { "organization": "Hushh", "url": "https://hushh.ai" },
  "version": "1.0.0",
  "capabilities": { "streaming": true, "pushNotifications": false, "stateTransitionHistory": true },
  "securitySchemes": {
    "hushhSession": { "type": "http", "scheme": "bearer", "bearerFormat": "Firebase ID token" },
    "byocGcp": { "type": "apiKey", "in": "header", "name": "X-BYOC-Provider", "description": "…in-memory only, never persisted…" }
  },
  "security": [ { "hushhSession": [], "byocGcp": [] } ],   // logical AND: both required
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json", "application/x-ndjson"],
  "skills": [
    { "id": "burst-compute", "name": "Burst a workload to the cloud", "tags": ["gpu","tpu","byoc","apple-silicon","autoscale","supercomputing"], "examples": ["My Mac is out of memory for this 70B fine-tune — burst it to a GPU."] },
    { "id": "placement-advice", "name": "Recommend a placement", "tags": ["placement","scheduling","cost"], "examples": ["Should this job run on my Mac or in the cloud?"] }
  ]
}
```

**Why two security schemes.** The `security` block is a logical AND: a caller must present **both** a
Hushh session (identity — *who is asking*) **and** a BYOC GCP credential (*whose cloud runs it*). This
encodes the BYOC trust model directly in the discovery document.

**Validation.** `GET /.well-known/agent.json` returns the card with `Cache-Control: max-age=3600`;
unit tests assert the required fields, the AND security, and origin-derived URLs.

## 3. Skills → endpoints

| Skill | Endpoint | Notes |
|---|---|---|
| `burst-compute` | `POST /api/one/burst` | Streams NDJSON; decides placement; provisions/runs/tears down on the cloud path. |
| `placement-advice` | `POST /api/one/burst` with a dry-run intent (FDE: gate via a `decideOnly` flag — roadmap) | Pure decision, no provisioning. |
| (lifecycle) | `GET /api/one/burst/{id}` | Resume/recover a dropped stream. |
| (on-device) | `POST /api/one/burst/{id}/puppy-result` | The native agent reports a local run's outcome. |

## 4. Gemini function declaration (managed-tool form)

Register this as a function/tool so a Gemini-hosted agent can call the burst capability. Keep it in
sync with the OpenAPI request body.

```json
{
  "name": "burst_compute",
  "description": "Decide where a workload runs (on-device vs cloud) and, when it exceeds local capacity, provision an accelerator instance in the caller's own GCP project, run the containerized workload, return the result, and tear the instance down.",
  "parameters": {
    "type": "object",
    "required": ["image", "acceleratorKind", "acceleratorCount", "estimate"],
    "properties": {
      "image": { "type": "string", "description": "Container image to run (e.g. Artifact Registry path)." },
      "command": { "type": "array", "items": { "type": "string" } },
      "env": { "type": "object", "additionalProperties": { "type": "string" } },
      "acceleratorKind": { "type": "string", "enum": ["gpu", "tpu"] },
      "acceleratorCount": { "type": "integer", "minimum": 1, "maximum": 8 },
      "machineType": { "type": "string" },
      "region": { "type": "string" },
      "estimate": {
        "type": "object",
        "required": ["vramGb", "unifiedMemoryGb", "vcpus", "diskGb", "estimatedMinutes"],
        "properties": {
          "vramGb": { "type": "number" }, "unifiedMemoryGb": { "type": "number" },
          "vcpus": { "type": "number" }, "diskGb": { "type": "number" }, "estimatedMinutes": { "type": "number" }
        }
      },
      "deviceProfile": { "type": "object", "description": "Snapshot of the local Mac (One Puppy)." },
      "byoc": {
        "type": "object",
        "description": "The caller's own GCP credentials. Used in-memory only; never persisted.",
        "properties": { "serviceAccountJson": { "type": "string" }, "projectId": { "type": "string" }, "region": { "type": "string" } }
      }
    }
  }
}
```

## 5. Publishing to the Gemini Enterprise Agent Platform

High-level flow (exact console/SDK steps confirmed at submission — see the FDE playbook for the
hands-on runbook):

1. **Deploy the control plane** to Cloud Run (service `one`, project `hushone-app`, us-central1) so the
   card and endpoints are live over TLS. Verify `GET /.well-known/agent.json` returns 200.
2. **Import the tool** into the **Cloud API Registry** from `burst-control-plane.openapi.yaml` (or
   register the function declaration via the ADK `ApiRegistry`). Attach the auth schemes.
3. **Register the agent** in Agent Builder / Agent Engine, pointing at the A2A card URL, with the
   `burst_compute` tool attached and the two security schemes configured (Hushh OIDC + BYOC pass-through).
4. **Set governance**: org-level tool availability, allowed callers, rate limits, and the per-user cost
   caps from the placement spec.
5. **Validate** end-to-end in mock mode (`ONE_ENABLE_MOCK_BURST=true`) then against a real BYOC project.
6. **Version & publish.** Tag the listing with `AGENT_CARD_VERSION`; changes to skills/auth require a
   card bump and a re-publish.

## 6. Versioning & compatibility

- `protocolVersion` tracks the A2A spec (`0.3.0`). `version`/`AGENT_CARD_VERSION` tracks *our* contract.
- Backward-compatible additions (new optional fields, new skills) → minor bump. Breaking changes
  (renamed/removed skills, changed auth, changed required request fields) → major bump + a migration note.
- The OpenAPI `info.version`, the function declaration, and the card version are released together.

## 7. Handoff items the customer/Google org must provide

- A Google org with the Gemini Enterprise Agent Platform enabled and permission to register agents/tools.
- The Hushh OIDC/issuer configuration for the `hushhSession` scheme (Firebase project `hushone-app`).
- Sign-off on the BYOC pass-through credential model with the org's security team.

## Related documents
- White paper: docs/whitepaper-xtreme-compute-burst.md
- API contract: docs/specs/burst-control-plane.openapi.yaml
- BYOC security & privacy: docs/specs/byoc-security-privacy.md
- Forward-deployed engineer playbook: docs/runbooks/forward-deployed-engineer-playbook.md
