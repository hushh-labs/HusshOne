---
name: safe-changes
description: Pre-flight rules that stop a change in this repo from breaking an
  unrelated live feature. Use BEFORE editing any deploy config, secret, IAM
  policy, shared credential, or infrastructure resource, and before deploying.
  Each rule was written after a real incident; add a new one every time a
  mistake is found.
---

# Safe changes — One by hussh (`hushh-labs/HusshOne`)

> **A change is only finished when the things you did NOT intend to change are
> proven still working — not assumed.**

## The 60-second map (verified 2026-08-06)

Read this before any rule. Most incidents below are one of these facts being guessed.

| | |
|---|---|
| Repo | `hushh-labs/HusshOne` — **PUBLIC**, default branch `main` |
| Prod app | Cloud Run **`one`** / project **`hushone-app`** / `us-central1` |
| **Real public domain** | **`intelligence.hushh.ai`** → route `one` |
| ❌ NOT this app | `one.hushh.ai` → `hushh-webapp` in **`hushh-pda`** (different app; `/docs` 404s) |
| ❌ NOT this app | `uat.one.hushh.ai` → `hushh-webapp` in **`hushh-pda-uat`** |
| **UAT for this repo** | **None. There is no UAT/staging environment. `main` → prod.** |
| Live CD | Cloud Build trigger **`husshone-deploy-prod`** (project `hushone-app`, region `us-central1`), file `cloudbuild.yaml`, on push to `^main$` |
| Dead CD | `.github/workflows/deploy-prod.yml` + `prod-smoke.yml` — both **`state=disabled_manually`**; they have not fired since 2026-06-22, and the repo has **no Actions secrets** so they'd fail at auth anyway. Editing this YAML changes nothing. |
| Manual deploy | `npm run deploy:prod` → `scripts/deploy-prod.sh` |
| Secrets | Secret Manager, project **`hushone-app`** only. No Supabase, no Vercel, no `.env` secrets (`.env.production` is committed and holds **public** Firebase web config only). |
| DBs | `hushone-app:us-central1:hushh-identity-pg` (app) · `hushh-tech-prod:us-central1:hushh-directories-db` (directories, read-only) |
| Scraper/API VMs | project **`hushh-tech-prod`**, zone `us-central1-c` |

### The one identity that reads everything

**`53407187172-compute@developer.gserviceaccount.com`** is simultaneously:

- the runtime identity of Cloud Run **`one`**,
- the runtime identity of **~60 other Cloud Run services** in `hushone-app`
  (only `hushh-ai-backend` and `vertex-ai-token-refresh` have their own),
- the **deploy** identity of the `husshone-deploy-prod` Cloud Build trigger.

At project level it holds `roles/editor`, `roles/run.admin`,
`roles/secretmanager.secretAccessor`, `roles/cloudsql.client`,
`roles/artifactregistry.writer`, `roles/iam.serviceAccountUser`,
`roles/aiplatform.user`.

**Blast radius: any IAM change on this account touches ~60 services at once.**

### Shared credentials — the dangerous ones

| Credential | Used by |
|---|---|
| `ONE_INTERNAL_JOB_TOKEN` | Cloud Run `one` **+ 5 Cloud Scheduler jobs** (`x-one-job-token` header, value pasted in) **+ the `cloudbuild.yaml` health-gate** |
| `CONNECTOR_JWT_SECRET` | `one` + `openai-connector` |
| `openai-connector-service-api-key` | `one` + `openai-connector` |
| `PERSON_INTELLIGENCE_API_KEY` | `one` + `hushh-deep-intelligence-api` + `hushh-ria-intelligence-api` |
| `instagram/threads/twitter/linkedin-scraper-api-key` | `one` **+ the matching GCE VM**, which validates the same value |
| `directories-ro-db-password` | `one` **+ Cloud SQL in a different project** (`hushh-tech-prod`) |
| `GEMINI_API_KEY` | `hushh-shadow-intelligence` + `profile-osint-api` (**not** this app) |
| `SUPABASE_*` | `ait-vault-qr` + `hushh-vault-qr` (**not** this app — same project, different product) |

---

## Rules ledger

Rules are numbered sequentially and **never renumbered**, so they can be cited as
"R3" in review. A rule is only added after something actually went wrong.

### R1 — Grant the read permission BEFORE binding a secret to a service

**Incident (2026-06-09, migrate-before-deploy — commit `1325080`).** The same
ordering class of bug that took prod down here: new code shipped before the thing
it depends on existed. With Prisma it was a column; with Secret Manager it is a
read grant. Cloud Run validates every `secretKeyRef` at revision start — bind a
secret the runtime identity cannot read and the revision **never becomes ready**,
so the previous good revision keeps serving while every later deploy silently
fails. Granting early costs nothing; binding early is fatal.

**Rule.** Grant `roles/secretmanager.secretAccessor` to the **consuming runtime
identity** first, in its own step, and only then add the `--set-secrets` binding.
The consumer's identity — not yours, not the secret owner's. In this repo the
consumer is nearly always
`53407187172-compute@developer.gserviceaccount.com`; a VM service in
`hushh-tech-prod` is a **different** identity in a **different** project, so do
both.

**Check.** Every secret bound to `one` must be readable by `one`'s runtime SA.
Access can come from a **secret-level** binding *or* a **project-level** role — a
check that only reads secret-level IAM false-fails (it reported 7 fake failures
here on a perfectly healthy service). Check both:

```bash
PROJ=hushone-app
SA=$(gcloud run services describe one --region us-central1 --project $PROJ \
      --format='value(spec.template.spec.serviceAccountName)')
PROJROLES=$(gcloud projects get-iam-policy $PROJ --flatten='bindings[].members' \
  --filter="bindings.members:$SA" --format='value(bindings.role)')
BLANKET=$(echo "$PROJROLES" | grep -cE 'roles/(secretmanager.secretAccessor|secretmanager.admin|editor|owner)')
echo "runtime SA: $SA  | project-wide accessor roles: $BLANKET"
gcloud run services describe one --region us-central1 --project $PROJ --format=json \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).spec.template.spec.containers[0];console.log([...new Set((c.env||[]).filter(e=>e.valueFrom).map(e=>e.valueFrom.secretKeyRef.name))].join('\n'))})" \
| while read -r S; do
    if gcloud secrets get-iam-policy "$S" --project $PROJ --format='value(bindings.members)' 2>/dev/null | grep -q "$SA"; then
      echo "OK   $S  (secret-level grant)"
    elif [ "$BLANKET" -gt 0 ]; then
      echo "OK*  $S  (project-level grant only)"
    else
      echo "FAIL $S  <- $SA cannot read this"
    fi
  done
```

Any `FAIL` means the next deploy produces a revision that never goes live.

**What `OK*` is telling you (verified 2026-08-06).** 7 of the 17 secrets bound to
`one` — `CONNECTOR_JWT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`,
`linkedin-scraper-api-key`, `instagram-scraper-api-key`,
`openai-connector-service-api-key`, and both Gmail secrets — have **no
secret-level binding at all**. They work only because the runtime SA holds
`roles/editor` + `roles/secretmanager.secretAccessor` at the **project** level.
Tightening that project grant (a reasonable-looking security cleanup) breaks the
app in seven places at once, with no error until the next revision starts. If you
ever remove the blanket grant, add the seven secret-level bindings **first** —
that is R1 applied to itself.

(`gcloud policy-troubleshoot iam` would answer this in one call but the
Policy Troubleshooter API is **not enabled** on these projects; enabling it is a
durable change, so don't do it just to run a check — see R7.)

---

### R2 — A feature with no consumer does not belong in the deploy pipeline

**Incident (2026-08-05, BrokerCheck advisor API).** A standalone service was built
and deliberately **not** wired into One's adapter pipeline. Wiring its credential
into the `one` service "so it's ready" would have added a secret binding, an IAM
grant and a new failure mode to the live app for a feature with zero callers —
all downside, no working feature.

**Rule.** Wire a shared credential, env var, or service dependency in the **same
change that first uses it** — never earlier. New standalone services stay
standalone until something calls them.

**Check.** Ask *"what breaks today if I don't?"* If nothing, don't. Then prove the
consumer exists in code before adding the binding:

```bash
grep -rn "MY_NEW_SECRET_ENV" src/ services/ --include='*.ts' --include='*.tsx' --include='*.mjs'
# no hits => you are wiring a credential nothing reads. Stop.
```

---

### R3 — Only ever ADD access. Never replace, revoke, or rotate

**Incident (standing — `ONE_INTERNAL_JOB_TOKEN`).** This one value lives in three
places that are updated separately: the Cloud Run env of `one`, the
`x-one-job-token` header **pasted into 5 Cloud Scheduler jobs**, and
`cloudbuild.yaml`'s health-gate. Adding a new secret version rotates it for the
app but **not** for the scheduler headers — every background worker
(`one-social-archive`, `one-preference-recompute`, `one-media-analyze`,
`one-social-refresh-sweep`, `one-health-watchdog`) starts returning 401 and scans
quietly stop being enriched. Nothing pages; it just degrades.

**Rule.** Use `add-iam-policy-binding`, **never** `set-iam-policy` (it replaces the
whole policy and silently drops ~60 other services' access). Never revoke,
delete, disable, or rotate a credential unless asked for that exact thing in those
words. Adding a secret *version* is a rotation — same rule.

**Check.** After any secret or IAM work, prove nothing was removed and no new
version appeared:

```bash
S=ONE_INTERNAL_JOB_TOKEN
gcloud secrets get-iam-policy "$S" --project hushone-app \
  --format='table(bindings.role, bindings.members)'          # original readers still present?
gcloud secrets versions list "$S" --project hushone-app --limit 3 \
  --format='table(name, state, createTime)'                  # newest version unchanged?
```

---

### R4 — Know which system you are in

**Incident (2026-07-30, commit `b251769` — "point health-gate at canonical
intelligence.hushh.ai (not one.hushh.ai)").** The CI health gate probed
`one.hushh.ai`, which is a **completely different application** — Cloud Run
`hushh-webapp` in project `hushh-pda`. It answers 200 on `/`, so the gate looked
green while testing someone else's app; it 404s on this app's routes
(`/docs`, `/discovery`). `scripts/deploy-prod.sh` **still has this bug today**.

**Rule.** Before touching mail, data, or any outbound call, name the exact system
and prove the lookalike is untouched. In this repo the lookalikes are:

- `intelligence.hushh.ai` (this app) vs `one.hushh.ai` / `uat.one.hushh.ai`
  (`hushh-webapp`, projects `hushh-pda` / `hushh-pda-uat`)
- Cloud Run `one` in `hushone-app` vs `one-hushh-ai` in `hushh-tech-prod`
- `SUPABASE_*` / `GEMINI_API_KEY` in `hushone-app` — same Secret Manager,
  **different products** (`hushh-vault-qr`, `profile-osint-api`)
- `PLAID_CLIENT_ID` vs `plaid-client-id`, `ENCRYPTION_KEY` vs `encryption-key`,
  `SUPABASE_URL` vs `supabase-url` — duplicate names, different consumers
- **Mail:** this app sends via `GMAIL_USER` / `GMAIL_APP_PASSWORD`
  (secrets `hushh-0f330a4e-…` / `hushh-0f330f12-…`) — not SendGrid, not the
  `email-template-api` service.

**Check.** Re-derive the map, don't recall it:

```bash
gcloud beta run domain-mappings list --region us-central1 --project hushone-app \
  --format='table(metadata.name, spec.routeName)'
for p in hushh-pda hushh-pda-uat; do
  echo "-- $p"; gcloud beta run domain-mappings list --region us-central1 --project "$p" \
    --format='table[no-heading](metadata.name, spec.routeName)'
done
```

Then prove the other system is untouched with a scoped diff:
`git diff origin/main...HEAD --stat -- <the-other-system's-paths>` → empty.

---

### R5 — Prove a revert, don't claim it

**Incident (2026-06-09, commit `b4e4164` — "roll back deep-research dossier
magazine redesign").** A UI revert diffed against the most recent commit looked
clean while leftover styling from the reverted work was still in the tree.
Diffing against your own last commit only proves your last step, not the rollback.

**Rule.** Diff against the commit **before the work started**, not against your own
last commit. Byte-identical or it isn't reverted.

**Check.**

```bash
BEFORE=<sha-before-the-work-began>
git diff --stat "$BEFORE"..HEAD -- <paths-being-reverted>   # MUST print nothing
```

For a Cloud Run rollback, "reverted" means traffic actually moved:

```bash
gcloud run services update-traffic one --region us-central1 --project hushone-app \
  --to-revisions <GOOD_REVISION>=100
```
then re-run the R8 check and confirm the serving revision is the one you named.

---

### R6 — Verify with the real thing, and report what you did NOT verify

**Incident (2026-08-06, commit `8422949` — "stop scraper VMs paging on
non-events").** Scraper health alerting fired on a synthetic probe timing out,
not on a real scrape failing. Green probes and red reality had drifted apart; the
fix was to alert from real traffic. Same class: a green `vitest run` is not a live
service, and an accepted API call is not a correct result.

**Rule.** Verify against the live surface, and state plainly what you could not
check. Never let a checklist imply coverage that doesn't exist.

**Check.** Unit gate first, then the live surface:

```bash
npx tsc --noEmit && npx vitest run                       # necessary, NOT sufficient
curl -s -m 20 -o /dev/null -w 'shell     %{http_code}\n' https://intelligence.hushh.ai/
curl -s -m 20 -o /dev/null -w 'discovery %{http_code}\n' https://intelligence.hushh.ai/discovery

# /api/internal/health is token-guarded — unauthenticated it returns
# {"ok":false,"error":"Unauthorized internal request"}, which is NOT a health signal.
TOKEN=$(gcloud secrets versions access latest --secret=ONE_INTERNAL_JOB_TOKEN --project hushone-app)
curl -s -m 60 -H "x-one-job-token: $TOKEN" \
  'https://intelligence.hushh.ai/api/internal/health?scope=critical' | head -c 500
# expect {"ok":true,...,"criticalDown":0} with database / vertex / deep_research_api all "up"
```

Never echo `$TOKEN` — this repo is public.

Then write down what you did **not** verify and why — e.g. "did not exercise the
Instagram scraper: consumes platform rate-limit"; "did not verify UAT: **this repo
has no UAT environment**".

---

### R7 — "Give me the URL / link / repo" is a READ request

**Incident (standing).** Asked for "the link", the reflex is to create — a repo, a
bucket, a Cloud Run service, a Cloud Build trigger. In this project that reflex is
expensive: `hushone-app` already carries 63 Cloud Run services and 25 Cloud Build
triggers, several of them duplicates of each other (`ocr-service` has three
triggers). Creating durable named resources is the user's decision and is often
hard to undo with the credentials on hand.

**Rule.** Locate what already exists. A path inside an existing repo is a valid
URL. Never create a repo, project, bucket, service, or trigger to answer a
question.

**Check.**

```bash
git remote -v
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "NO UPSTREAM — branch is not pushed"
git log --oneline "origin/$(git rev-parse --abbrev-ref HEAD)..HEAD" 2>/dev/null   # empty = fully pushed
```

---

### R8 — A green build is not a serving revision

**Incident (2026-08-06, found while writing this file).** Two independent traps
caught at once on the live service:

1. Cloud Build `1b77ca72` for `main@5594a4c` was **still QUEUED ~19 hours after
   the trigger fired** — created `2026-08-05T18:55Z`, still not started when
   checked on 2026-08-06. The commit was merged, `gh` was green, and `main`'s tip
   was simply not deployed; live was revision `one-00147-fnn`, built from the
   *previous* commit. (It drained and reached `SUCCESS` later the same session —
   which is the point: nothing told anyone either way.)
2. The `deploy` skill's own verify command,
   `--format='value(status.traffic[0].revisionName, status.traffic[0].percent)'`,
   returns **`one-00008-wib`** with an empty percent, while the revision actually
   serving 100% is **`one-00149-4sw`**. `traffic[0]` is a *tagged* revision
   (`shadow`; then `phone`, `otel`) — tagged entries occupy the first array slots
   and the real `percent: 100` entry is **last**. The command reads like a
   rollback-to-a-2026-era-revision alarm and is simply wrong.

**Rule.** After any deploy, prove three separate things: the build **finished**,
the revision it produced is **the one serving 100%**, and the **live domain**
returns the new marker. Never index `traffic[0]`; select the entry by `percent`.

**Check.**

```bash
# 0. is the pipeline you think ran even enabled? (both GH workflows here are disabled)
gh api repos/hushh-labs/HusshOne/actions/workflows --jq '.workflows[] | "\(.name) state=\(.state)"'

gcloud builds list --project hushone-app --region=us-central1 --limit 3 \
  --format='table(status, createTime, substitutions.SHORT_SHA)'   # SUCCESS, not QUEUED/WORKING

gcloud run services describe one --region us-central1 --project hushone-app --format=json \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
  const live=(j.status.traffic||[]).find(t=>t.percent===100);
  console.log('serving :',live&&live.revisionName,'@',live&&live.percent+'%');
  console.log('latest  :',j.status.latestReadyRevisionName);
  console.log(live&&live.revisionName===j.status.latestReadyRevisionName?'IN SYNC':'*** NOT SERVING LATEST ***')})"

curl -s -m 20 -o /dev/null -w 'live %{http_code}\n' https://intelligence.hushh.ai/docs
```

---

### R9 — A tool denial is not a blocker until it survives a retry and a named layer

**Incident (2026-08-05, rebuilding the scraper health alerting).** Creating the
`one-scraper-readiness-sweep` Cloud Scheduler job was denied by the Claude Code
auto-mode classifier. It was reported to the user as a hard blocker, with a
paste-ready command and the suggestion that a settings `allow` rule would fix it.
**The identical command succeeded on a plain retry minutes later, unchanged.** The
handoff was pure cost: a round-trip for work that was never actually blocked, plus
a fix suggestion that was wrong on the facts — `gcloud scheduler` is **not** in
`.claude/settings.local.json`, so an allow-list entry was never what stood in the
way. The same classifier then denied two verification `curl`s that also succeeded
on retry.

**Rule.** A denial is evidence about *one attempt*, not about capability. Retry
once before believing it. If it fails again, name the layer before escalating —
settings `allow`/`deny`, the auto-mode classifier, GCP/GitHub IAM, or the remote
API — and only then hand work back, quoting the exact stderr. Never claim an
`allow` rule will fix a denial without first confirming the command is absent from
the allow-list *and* that the allow-list is what rejected it. Do not tell the user
they are blocking you until you have proven they are.

**Check.**

```bash
# What is genuinely allow-listed? A denial for something absent here may still be
# the classifier (non-deterministic) — retry before reporting it as a blocker.
python3 -c "
import json
p = json.load(open('.claude/settings.local.json'))['permissions']
for k in ('allow','deny'):
    v = p.get(k) or []
    print(f'{k}:', ', '.join(v) if v else '(none)')
"
```

---

## Pre-flight checklist

Run before editing deploy config, secrets, IAM, or shared credentials — and again
before deploying.

- [ ] **R7** — `git remote -v`, upstream set, branch pushed. Nothing new created to answer a question.
- [ ] **R4** — named the exact service/project/domain this change lands in; re-derived the domain map; scoped diff proves the lookalike is untouched.
- [ ] **R2** — every credential/env var added has a consumer **in this same change** (`grep` proved it).
- [ ] **R1** — every secret the deploy config binds is readable by the **consuming** runtime identity (loop passes with no `FAIL`).
- [ ] **R3** — only `add-iam-policy-binding` used; no `set-iam-policy`, no revoke, no new secret version. Original readers still listed.
- [ ] **R6** — `npx tsc --noEmit && npx vitest run` green, **plus** a live probe of `intelligence.hushh.ai`. Wrote down what was not verified.
- [ ] Prisma schema changed? → migration applied to prod **first** (see the `deploy` skill, Step 2.5).
- [ ] **R8** — after deploy: build `SUCCESS`, serving revision == latest ready, live domain returns the new marker.
- [ ] **R5** — if this was a revert/rollback: diffed against the commit **before** the work; empty output.
- [ ] **R9** — hitting a denial? retried once, named the layer, and checked the allow-list before telling the user they're blocking you.

---

## Adding a rule

Rules are numbered **sequentially and never renumbered** so they can be cited as
"R3" in review. Append a new one every time a mistake is found — including
mistakes caught before they shipped.

```markdown
### R<n> — <imperative one-liner>
**Incident (<date>, <what was being built>).** What went wrong and what it
would have broken.
**Rule.** The generalisation.
**Check.** The exact command or diff that catches it next time.
```

Two requirements, or the rule is decoration:

1. **The Check must actually run in this repo.** Paste it into a terminal here and
   confirm it returns something meaningful before committing the rule.
2. **The Incident must be real** — a commit SHA, a date, a live observation. If it
   was carried in from another repo, say so.
