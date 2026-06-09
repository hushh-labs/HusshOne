---
name: intelligence-release
description: >-
  Release a change to One's intelligence layer (the two-phase Deep Research
  pipeline) so it actually reaches users. Use this WHENEVER you edit the Phase-1
  prompt (src/lib/research/dossier.ts), the Phase-2 synthesis
  (~/Documents/hushh-deep-research-api/src/synthesize.ts), the models/limits, or
  the pipeline shape — i.e. "changed/updated the intelligence", "new intelligence
  layer", "tuned the prompt", "force users to re-scan", "bump the intelligence
  version", or "testers are seeing cached old results". Encodes the one step
  people forget (bumping INTELLIGENCE_VERSION) that forces every existing user
  back to "Send One" to re-run on the new layer, plus the build/deploy/verify
  runbook across BOTH repos. Without this, improved intelligence silently never
  reaches returning users — they keep getting their cached old scan.
---

# Intelligence release — make a layer change reach users

**The intelligence layer is the product.** When it improves, returning users must
re-run on it. But One auto-restores a user's last completed scan from
`one_last_scan` → `/api/one/scans/latest` and reveals it instantly. So after you
ship better intelligence, returning testers/users get their **old cached report**
and never see the change ("info from cache, loaded instantly"). The fix is a
**version stamp**: bump it and every old scan is treated as stale, routing the
user back to **Send One** to re-scan.

> If you change the intelligence and DON'T bump the version, the release is
> effectively invisible to everyone who has scanned before. Bumping the version
> is the whole point of this skill — never skip it.

## What counts as an intelligence change (bump required)

- Phase-1 prompt — `buildPersonDossierQuestion` in [src/lib/research/dossier.ts](src/lib/research/dossier.ts) (sent verbatim to Gemini Deep Research).
- Phase-2 synthesis — `SYNTH_SYSTEM` / section list in `~/Documents/hushh-deep-research-api/src/synthesize.ts`.
- Models or limits — `synthModel`, `synthMaxTokens`, `maxQuestionLength` in the DR repo `src/config.ts`; or the depth/timeout wiring in [src/lib/research/client.ts](src/lib/research/client.ts) / [src/app/api/one/research/route.ts](src/app/api/one/research/route.ts).
- The shape of the result (new/renamed sections, new `rich`/report fields).

Pure UI/copy/styling that doesn't change the *content* of the report does NOT
need a bump (the cache header already gets new code to users — see step 4).

## How the version-gate works (so you trust it)

- **`src/lib/research/version.ts`** exports `INTELLIGENCE_VERSION` (a date tag).
- Every completed result is stamped: `mapResearchResult` in
  [dossier.ts](src/lib/research/dossier.ts) sets `intelligenceVersion: INTELLIGENCE_VERSION`
  (the field lives on `OneDashboardResult` in [src/lib/ria/types.ts](src/lib/ria/types.ts)).
- On load, `hydrateFromUser` in [src/components/one/OneExperience.tsx](src/components/one/OneExperience.tsx)
  compares the recovered scan's stamp to the current constant. If it differs or is
  missing (old DB rows have none), it **drops `one_last_scan` and routes to
  `precollect` (Send One)** instead of revealing. Current-version scans still
  restore instantly; in-flight scans are untouched.
- Net effect: bump the constant → every prior user lands on Send One and re-runs
  on the new layer. (It also kills the old-shape `rich`/`sourceCards` crash at the
  source, since stale results never render.)

## Runbook

### 1. Edit the prompt(s)
Phase-1 in [src/lib/research/dossier.ts](src/lib/research/dossier.ts); Phase-2 in
`~/Documents/hushh-deep-research-api/src/synthesize.ts`. Keep the two phases
coherent (Phase-2 sections must be able to hold whatever Phase-1 now produces).

### 2. ⭐ Bump the version (the step everyone forgets)
Edit [src/lib/research/version.ts](src/lib/research/version.ts):

```ts
export const INTELLIGENCE_VERSION = "2026-06-09"; // → today's date, e.g. "2026-06-10"
```

Use today's date (`date +%F`). If you ship twice in one day, suffix it: `2026-06-10b`.

### 3. Build gates (husshone)
```bash
pkill -f "husshone.*next dev" 2>/dev/null   # dev server shares .next
npm run build                                # MUST pass — type-checks every src/*.tsx
```

### 4. Deploy
- **If this release also changed `prisma/schema.prisma` → apply the migration to prod FIRST**
  (deploy doesn't auto-migrate; Prisma RETURNING-selects every column, so an un-migrated
  schema column breaks all queries on that table). See the `deploy` skill's **Step 2.5**.
- **husshone → Cloud Run `one` / `hushone-app` / us-central1.** Follow the
  **`deploy`** skill (it has the wrong-service trap + exact command). Short form:
  ```bash
  gcloud run deploy one --source . --region us-central1 --project hushone-app --quiet
  ```
  This ships the version bump **and** the new Phase-1 prompt (Phase-1 lives in this repo).
- **deep-research-api → only if Phase-2 / models / DR config changed.** Deploy
  `hushh-tech-uat` / `asia-south1` via its own script:
  ```bash
  bash ~/Documents/hushh-deep-research-api/golive.sh
  ```
  (Vertex transport; preserves `API_KEYS` secret. Never print the team token.)

> The app shell (`/` document) is served `Cache-Control: no-cache, must-revalidate`
> (set in [next.config.ts](next.config.ts)), so new code/chunks reach browsers on
> the next load — no CDN purge needed. Hashed `/_next/static/*` stay immutable.

### 5. Verify the release actually routes users
- **Re-route (the key test):** as a returning user with an OLD stored scan, load
  one.hushh.ai → you must land on **Send One** (not an instant old report). Quick
  local repro with the `one-mock` config (port 3177): seed
  `localStorage.one_last_scan` with an old/missing `intelligenceVersion` → reload →
  expect the Send One screen + `one_last_scan` cleared. A current-version scan must
  still restore instantly.
- **New intelligence ran:** complete a fresh scan; confirm the new sections/fields
  appear, and check Cloud Logging for `one.research.completed` (husshone) and the
  DR `synth_ok` line if Phase-2 changed.
- **Live header:** `curl -sI https://one.hushh.ai/ | grep -i cache-control` →
  `no-cache, must-revalidate` (document), while a `/_next/static/...` asset is
  `immutable`.

## Pitfalls
- **Forgot the bump** → returning users keep their cached report; the release is
  invisible. This is the #1 failure — do step 2.
- **Deployed only husshone after a Phase-2 change** → the new prompt is live but
  synthesis is still old. Deploy the DR repo too (step 4).
- **Wrong Cloud Run service** (`one-hushh-ai` in `hushh-tech-prod`) → site never
  changes. See the deploy skill's wrong-service trap.
- **Testing in a logged-in browser that already cached the shell** → hard-refresh
  (Cmd+Shift+R) once; after the no-cache header is live this stops being an issue.
