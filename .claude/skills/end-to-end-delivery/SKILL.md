---
name: end-to-end-delivery
description: How to take a task in this repo from understanding to live and
  verified — preflight against origin/main, one focused branch, controlled steps,
  true-diff guard, PR, merge, deploy, verify on the real domain. Use whenever the
  work is expected to actually ship, not just compile - "take this end to end",
  "implement and deploy", "push it", "raise a PR", "merge and ship", "own this",
  or when several agents/people are working in parallel and a branch could revert
  someone else's work. Pairs with `safe-changes` (the rules ledger) and `deploy`
  (the Cloud Run mechanics).
---

# End-to-end delivery — One by hussh

Ownership means: understood → built in controlled steps → true-diff checked →
merged → **live and verified on the real domain**. Not "the PR is open".

**This is a menu, not a liturgy.** Use the sections the task actually touches.
A one-line copy fix does not need a migration plan; a shared-credential change
needs every guard in `safe-changes`.

## Ground truth for this repo (don't re-guess it)

| | |
|---|---|
| Remote | `hushh-labs/HusshOne` — **PUBLIC**, default branch `main` |
| **There is no UAT** | `uat.one.hushh.ai` is a **different app** (`hushh-webapp`, project `hushh-pda-uat`). This repo has **one** environment: production. Merging to `main` ships. |
| Live domain | **`intelligence.hushh.ai`** (not `one.hushh.ai` — that's another app) |
| CD | Cloud Build trigger `husshone-deploy-prod` → `cloudbuild.yaml` on push to `main` |
| GitHub Actions | **dead** — `deploy-prod` and `prod-smoke` are `state=disabled_manually` (last run 2026-06-22) *and* the repo has no Actions secrets. Editing the YAML changes nothing; don't debug them. |

Because `main` → prod with no staging in between, **the PR review and the local
gate are the only safety net.** Treat them that way.

---

## 1. Preflight — before writing any code

```bash
git fetch --all --prune --tags
git log --oneline -5 origin/main
gh pr list --repo hushh-labs/HusshOne --state open --limit 10
git status --porcelain            # is there unrelated WIP in the tree?
```

Then:

- Branch from **`origin/main`**, never from a stale local branch:
  `git switch -c <type>/<scope> origin/main`
- One task → one branch → one PR.
- Note the **files that must not change**. If unrelated WIP is dirty in the tree,
  it stays out of this commit — stage paths explicitly, never `git add -A`.
- Write a short task map: outcome · files · dependencies · regression risks ·
  edge cases · how it gets verified.

If the change touches deploy config, secrets, IAM, or a shared credential →
**read `safe-changes` first** and run its pre-flight checklist.

---

## 2. Build in controlled steps

- Smallest reversible change that delivers the outcome. Validate, then continue.
- Reuse the closest existing pattern — component, route handler, adapter, test.
  Don't invent a second way to do something the repo already does.
- Preserve API contracts, routes, auth, permissions, analytics, integrations.
- No fake success states, no hardcoded prod data, no swallowed errors, no
  disabled validation as a "temporary" fix.
- Never print, commit, or echo a secret. The repo is **public**.
- This Next.js is customised — read `node_modules/next/dist/docs/` before
  changing routing, caching, or build config (`AGENTS.md`).

### UI work: less text, less noise

The design system already exists — find the nearest screen and follow it.

- One clear headline (2–6 words) · one supporting line only if needed · the
  primary action · a quieter secondary action.
- Button labels 1–3 words. No paragraph where a phrase works. Don't repeat the
  same message in heading, subtitle, card and button.
- "Ankit, all good?" not "Ankit, how are you doing today?". "View details" not
  "Click here to view more information". "Profile updated" not "Your profile has
  been successfully updated".
- Whitespace is the layout. One accent colour. Icons only when they add meaning.
- Cover loading, empty, error, success, disabled, long-content, and
  mobile/tablet/desktop states.
- Before finishing: can a sentence be shorter? can any text go entirely? is the
  primary action obvious in 2–3 seconds?

---

## 3. Validate

```bash
npx tsc --noEmit
npx vitest run
npm run lint
npm run build          # stop any dev server first — it shares .next
```

Green tests are necessary and not sufficient — **R6**. Exercise the actual flow,
check the browser console and network tab for UI work, and write down what you
could **not** verify and why.

---

## 4. True-diff guard — before first push, before the PR, before merge

The single highest-value step when others are working in parallel.

```bash
git fetch origin
git diff --stat origin/main...HEAD        # every file must belong to this task
git diff --name-status origin/main...HEAD | grep -E '^(D|R)' || echo "no deletions/renames"
git log --oneline origin/main..HEAD
```

Confirm: every changed/deleted/renamed file is yours; no unrelated reversion of
someone else's tests, infra, config, UI, API or deploy changes; no debug code, no
secrets.

If the branch is stale or contains a reversion:

```bash
git rebase origin/main       # resolve carefully, keep BOTH sides' intent
# re-run section 3, then re-inspect the diff
git push --force-with-lease  # never a plain --force
```

---

## 5. PR and merge

```bash
git push -u origin HEAD
gh pr create --repo hushh-labs/HusshOne --base main --fill
gh pr diff <N> --repo hushh-labs/HusshOne     # review your own diff, honestly
gh pr checks <N> --repo hushh-labs/HusshOne
gh pr view <N> --repo hushh-labs/HusshOne \
  --json mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid
```

Review it yourself from four angles: product outcome, engineering, security,
regression. Resolve conflicts and failures yourself.

Merge order matters — a normal `--merge` first:

```bash
gh pr merge <N> --repo hushh-labs/HusshOne --merge --match-head-commit <sha>
```

`--admin` is a last resort, only when the exact unmet requirement is understood
and bypassing *that specific* requirement is intentional. Never as the first
attempt, and never to skip a red build. Note: **the `deploy-prod` / `prod-smoke`
GitHub checks fail for everyone** (no repo secrets) — that is not your PR
breaking, and it is not a reason to reach for `--admin` on anything else.

Confirm the merge landed:

```bash
git fetch origin && git log --oneline -3 origin/main
```

---

## 6. Deploy

Push to `main` fires the `husshone-deploy-prod` Cloud Build trigger. **Watch it —
a fired trigger is not a finished build (R8).** A build sat QUEUED for ~19 hours
on 2026-08-05 and `main`'s tip silently never shipped.

```bash
gcloud builds list --project hushone-app --region=us-central1 --limit 3 \
  --format='table(id, status, createTime, substitutions.SHORT_SHA)'
```

If it's stuck, or you need to ship deliberately, use the **`deploy`** skill
(service `one` / project `hushone-app` / `us-central1`; migrations first if
`prisma/schema.prisma` changed).

---

## 7. Verify live — this is the task, not the deploy command

```bash
# build finished, and the revision it produced is the one serving 100%
gcloud run services describe one --region us-central1 --project hushone-app --format=json \
| node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);
  const live=(j.status.traffic||[]).find(t=>t.percent===100);
  console.log('serving:',live&&live.revisionName,'| latest:',j.status.latestReadyRevisionName)})"

curl -s -m 20 -o /dev/null -w 'shell     %{http_code}\n' https://intelligence.hushh.ai/
curl -s -m 20 -o /dev/null -w 'your-route %{http_code}\n' https://intelligence.hushh.ai/<route>
curl -s -m 30 'https://intelligence.hushh.ai/api/internal/health?scope=critical' | head -c 400
```

Never index `status.traffic[0]` — tagged revisions (`shadow`, `phone`, `otel`)
occupy the first slots and it will report a 2026-era revision. See **R8**.

Then open the real URL, walk the actual user journey, and check console, network,
and the adjacent flows the change could have touched. Fix, merge, redeploy,
re-verify until it works.

---

## 8. Report

Facts with evidence, not narration:

- Outcome delivered · what changed · what was preserved
- Risks caught (e.g. *"the branch was based on an older main and would have
  reverted the scraper-health alerting; caught it in the true diff, rebased onto
  origin/main, re-ran validation, final diff is N task-scoped files"*)
- Final task-scoped file count · test + CI results
- Branch · PR · merge commit
- Deploy: build id + status, serving revision, verified URL
- **What you could not verify, and why** — plainly, never quietly dropped

## Non-negotiables

- Don't widen scope. One service asked for → don't edit another's pipeline.
- "I didn't touch it" is not evidence. A scoped diff or a live read is.
- Fix the **cause**, then add a numbered rule to **`safe-changes`** so it can't
  recur. "Add that to the skill" means: a new R-number.
- Say what you couldn't do and why, instead of quietly narrowing the task.
