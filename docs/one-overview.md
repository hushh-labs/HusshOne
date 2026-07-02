# One — the intelligence API

**One is a personal intelligence agent by hushh.** Give it a person's identity + (optional) public
profile URLs and it builds a deep, **cited dossier** and a structured **preference & lifestyle profile** —
the same engine that powers [one.hushh.ai](https://one.hushh.ai).

This documentation covers the **One Developer API**: that intelligence, over HTTP. No SDK — plain JSON
requests, JSON responses, and a live **Server-Sent Events** stream. It's **key‑gated** (a `Bearer` key
issued by hushh).

---

## What you can do

- **Start a scan** — submit `name` + `email` + a location, plus any public profile URLs
  (LinkedIn / Instagram / X / Threads). One scrapes what's public and starts deep research.
- **Get the dossier** — a synthesized, cited report on who the person is, with footprint categories.
- **Get the preference & lifestyle profile** — a 6‑section preference profile plus lifestyle facts
  (brands, colours, places, foods, eyewear, solo‑vs‑social…) inferred from public photos.
- **Stream it live** — one SSE connection multiplexes research progress → dossier → preferences → done.
  Or just poll.

---

## Start here

1. **[API overview & contract](one-api-overview.md)** — auth, the full request/response contract, the
   endpoint map, and every status/error code. *Read this first.*
2. **[Streaming + preferences](one-api-streaming.md)** — the live SSE flow and the preference/lifestyle
   payload in detail.
3. **[Scan API basics](one-api.md)** — the minimal two‑call flow (start a scan, poll for the dossier) and
   the per‑platform data contracts.

Machine‑readable spec: [`GET /api/v1/openapi.json`](https://one.hushh.ai/api/v1/openapi.json) (OpenAPI 3.1).

---

## Good to know

- **Base URL:** `https://one.hushh.ai` · **Auth:** `Authorization: Bearer <YOUR_API_KEY>` on every request.
- **Privacy:** only public/visible content is used; sensitive traits (health, religion, politics, skin
  tone) are never inferred, and other people in photos are never identified.
- **Isolation:** each subject is scoped to its own tenant — two subjects scanned under one key never see
  each other's data.
- **Same engine as one.hushh.ai** — nothing is stripped down for the API.
