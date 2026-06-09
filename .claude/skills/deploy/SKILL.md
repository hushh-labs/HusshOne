---
name: deploy
description: >-
  Deploy this app (One by hussh) to production on Google Cloud Run. Use this
  whenever the user wants to deploy, ship, release, push to prod/production,
  "go live", redeploy, or roll back one.hushh.ai — even if they don't name Cloud
  Run explicitly. Encodes the EXACT production target (which is easy to get
  wrong — see the wrong-service trap), the deploy command, pre-deploy build
  gates, post-deploy verification on the live domain, and rollback. Prefer this
  over ad-hoc gcloud commands so you deploy to the service the domain actually
  serves.
---

# Deploy — One by hussh → Cloud Run

Next.js 16 (standalone) app on **Google Cloud Run**, built from source via Cloud
Build using the repo `Dockerfile`.

## ⚠️ The wrong-service trap — READ FIRST

`one.hushh.ai` is served by Cloud Run service **`one`** in project
**`hushone-app`** (region `us-central1`). There is ALSO a similarly-named service
**`one-hushh-ai`** in project **`hushh-tech-prod`** that the domain does **NOT**
point to. Deploying to `one-hushh-ai` looks successful but the public site never
changes — the classic "I deployed but it's still showing the old UI" symptom is
almost always this, **not** a CDN cache. Always deploy to **`one` / hushone-app**,
and verify the mapping if unsure:

```bash
gcloud beta run domain-mappings list --region us-central1 --project hushone-app \
  --format="table(metadata.name, spec.routeName)"   # one.hushh.ai -> one
```

| What | Value |
|------|-------|
| **Production service** | **`one`** |
| **Project** | **`hushone-app`** |
| Region | `us-central1` |
| Public domain | `one.hushh.ai` → service `one` (direct, no CDN in front) |
| Origin URL | `https://one-yxfa6ba3aq-uc.a.run.app` |
| gcloud account | `ankit@hushh.ai` |
| ❌ NOT this | `one-hushh-ai` in `hushh-tech-prod` (different service, not on the domain) |

## The one-paragraph version

Confirm the working tree is what you want to ship, run `npm run build` and make it
pass, then `gcloud run deploy one --source . --region us-central1 --project
hushone-app --quiet`. Then curl `https://one.hushh.ai/` and confirm the new marker
shows — it updates immediately (no CDN), so if it doesn't, you deployed to the
wrong service.

## Step 1 — Decide exactly what ships

`--source` uploads the **current working directory** (respecting `.gcloudignore`),
**not** git HEAD — uncommitted changes deploy too.

- Run `git status` and confirm the tree is intentional. This repo has carried
  parallel uncommitted WIP before; don't ship a half-finished experiment by
  surprise. If unsure what a change is, show the user first.
- `.gcloudignore` excludes `.git`, `.next`, `node_modules`, and **`.env*`**, so local
  secrets are never uploaded. Leave it that way.

## Step 2 — Pre-deploy gates (don't skip)

A failed Cloud Build wastes ~5 min, so catch it locally first.

```bash
pkill -f "husshone.*next dev" 2>/dev/null   # stop any dev server; it shares .next
npm run build                                # the real gate: compile + TypeScript. MUST pass.
# optional: npm run typecheck | npm run lint | npm test
```

`next build` type-checks **every** `.tsx` under `src/` (even unimported experimental
files), so a broken WIP component fails the build. Fix or set it aside — don't deploy
a red build.

## Step 3 — Deploy (to the correct service)

```bash
gcloud run deploy one \
  --source . \
  --region us-central1 \
  --project hushone-app \
  --quiet
```

Why these choices:
- **service `one`, project `hushone-app`** → the service `one.hushh.ai` actually maps
  to. (See the wrong-service trap above.)
- **`--source .`** → Cloud Build builds the `Dockerfile` and pushes to the project's
  `cloud-run-source-deploy` Artifact Registry repo.
- **No `--set-env-vars` / `--update-secrets`** → env, secrets, memory, and the request
  **timeout** already live on the service and are **preserved**. The app needs a Cloud
  Run timeout **≥ 900s** (a scan can run that long) — don't reset it by passing fresh
  config. Only touch env/secrets when the user explicitly asks.
- **`--quiet`** → non-interactive (auto-confirms the AR repo; doesn't change the
  service's IAM/unauth policy).

Takes ~3–6 min. On success gcloud prints the new revision (e.g. `one-00018-nzq`)
serving 100% of traffic.

## Step 4 — Verify on the live domain (this is the real test)

`one.hushh.ai` hits the service directly — **no CDN/edge cache** in front (the
`one.hushh.ai` etag equals the service's etag), so a correct deploy is visible
**immediately**. Verify against the domain itself, not just the origin:

```bash
gcloud run services describe one --region us-central1 --project hushone-app \
  --format="value(status.traffic[0].revisionName, status.traffic[0].percent)"   # new revision @ 100%?

curl -s -m 30 -o /dev/null -w "HTTP %{http_code}\n" https://one.hushh.ai/
curl -s -m 30 https://one.hushh.ai/ | grep -oiE "<title>[^<]*</title>"          # new marker present?
```

Pick a marker you know changed (page `<title>`, a new font like `space_grotesk`, new
copy). If the domain still shows the old marker, you almost certainly deployed to the
wrong service — re-check the domain mapping and redeploy to `one` / `hushone-app`.

> Note on caching: the home page document now sends `Cache-Control: no-cache,
> must-revalidate` (set via `headers()` in `next.config.ts`), so browsers and any
> shared cache revalidate the shell on every load and pick up a new deploy
> immediately — no hard-refresh needed in normal cases. Hash-named
> `/_next/static/*` chunks stay `public, max-age=31536000, immutable` (safe — the
> filenames change each build). Verify after deploy:
> `curl -sI https://one.hushh.ai/ | grep -i cache-control` → `no-cache, must-revalidate`.
> (This repo's Next is customized — read `node_modules/next/dist/docs/` before
> changing caching.)

## Rollback

Instant traffic-split back to a known-good revision (no rebuild):

```bash
gcloud run revisions list --service one --region us-central1 --project hushone-app \
  --format="table(metadata.name, metadata.creationTimestamp)"

gcloud run services update-traffic one \
  --region us-central1 --project hushone-app \
  --to-revisions <PREVIOUS_REVISION>=100
```

## Discovery / self-check

If anything above looks stale, re-derive it:

```bash
gcloud config list                                                          # account + project
# which service does the domain serve?  (the most important check)
gcloud beta run domain-mappings list --region us-central1 --project hushone-app \
  --format="table(metadata.name, spec.routeName)"
gcloud run services list --project hushone-app \
  --format="table(metadata.name, region:label=REGION, status.url)"
dig +short one.hushh.ai
```

## Pre-flight checklist

- [ ] `git status` reviewed — only intended changes in the tree
- [ ] `npm run build` passes (dev server stopped first)
- [ ] deploying to **service `one`, project `hushone-app`, us-central1** (NOT one-hushh-ai)
- [ ] new revision serving 100%
- [ ] `https://one.hushh.ai/` shows the new marker (HTTP 200) — verified on the domain
- [ ] `curl -sI https://one.hushh.ai/ | grep -i cache-control` → `no-cache, must-revalidate` (the document always revalidates; no hard-refresh needed in normal cases)
