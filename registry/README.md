# Registry upload artifacts

Static, upload-ready artifacts for publishing **Hushh One — Xtreme Compute Burst** to the
**Gemini Enterprise Agent Platform** (Agent Engine + Cloud API Registry) and any A2A directory.

| File | What it is | Where it goes |
|---|---|---|
| `agent-card.json` | A2A Agent Card (v0.3.0) for `https://one.hushh.ai` | A2A discovery / agent directory; also served live at `GET /.well-known/agent.json`. |
| `function-declaration.json` | Gemini function-calling declaration for `burst_compute` | Register as a managed tool (Cloud API Registry / ADK `ApiRegistry`). |

The machine-readable control-plane contract for OpenAPI-based tool import lives at
`docs/specs/burst-control-plane.openapi.yaml`.

## These are generated — do not hand-edit

They are produced from the single source of truth in `src/lib/burst/agent-card.ts`.
A drift test (`src/lib/burst/registry-artifacts.test.ts`) fails CI if they fall out of sync.

Regenerate after changing the card or function declaration:

```bash
UPDATE_REGISTRY=1 npx vitest run src/lib/burst/registry-artifacts.test.ts
```

Bump `AGENT_CARD_VERSION` in `src/lib/burst/agent-card.ts` when skills, endpoints, or auth change,
then regenerate and re-publish. See `docs/specs/agent-registry-and-card.md` for the full publishing flow.
