---
name: human-handoff
description: >-
  Produce a crisp, paste-ready handoff whenever you're blocked on something only
  the user can do — instead of a vague "you'll need to do X" paragraph. Trigger
  this WHENEVER: (1) you decline a step on safety/policy grounds even though the
  user authorized it (operating ToS-violating or bot-detection/CAPTCHA-evading
  automation in production, financial trades/transfers, entering credentials,
  irreversible deletes, access-control changes); (2) you need something only the
  user has — a secret/API key, an infra value (IP, VPC connector, project id),
  credentialed/console access you lack, an OAuth/redirect registration, or a human
  decision / ToS / legal sign-off; or (3) a production cutover (deploy, prod DB
  migration) you're not going to execute yourself. ALSO trigger when the user asks
  "what do you need from me", "give me a prompt", "give me the command(s)", "what
  are you blocked on", or "how do I do this myself". The output is a structured
  handoff: what's already done, the exact blocker + why it's theirs, paste-ready
  ordered commands, prereqs/safety caveats, and precisely what you'll do when they
  hand the result back. Use it for ANY "I need the human to take it from here"
  moment, even if they didn't name it.
---

# Human handoff

## Why this exists

When you hit a wall that is genuinely the user's to cross — a safety boundary you
hold, a credential only they have, a prod button you won't push — the worst thing
you can do is bury it in prose ("you'll probably need to deploy this and set some
env vars"). That makes the user reverse-engineer what you meant, in what order,
with which exact values.

A good handoff does the opposite: it shows them what you already finished, names
the one thing blocking you in a single line, gives them commands they can paste
**in order without editing** (except clearly-marked placeholders), and tells them
exactly what to send back so you can pick it up again. The goal is *one paste and
done*, with control handed cleanly back and forth.

## When you're blocked (recognize the moment)

- **Safety/policy boundary** — you won't do it regardless of authorization or
  sign-off: financial trades/transfers, entering credentials/passwords/keys into a
  field, bypassing/solving CAPTCHAs or bot-detection, standing up or operating
  ToS-violating automation in production, permanent deletes, access-control/sharing
  changes. State the rule plainly in one line; **don't moralize or re-litigate** —
  you've made the call, now make it easy for them.
- **You need their input/access** — a secret or API key, an infra value (internal
  IP, VPC connector name, GCP project, Cloud SQL instance), access you don't have,
  a console/OAuth registration only they can do, or a human decision / ToS / legal
  go-ahead.
- **A coupled prod cutover you're not executing** — e.g. migrate-then-deploy. Even
  if each step is individually runnable, if you're declining the activation, hand
  over the whole ordered sequence rather than half-applying it.

## Handoff format

Lead with progress, not the wall. Use these sections (drop any that don't apply):

### ✅ Done
One or two lines on what you already completed (commit, PR, migration file written,
build/tests green) — so the handoff is the *only* open item, not a surprise.

### 🚧 Blocked on you — `<one-line action>`
**Why it's yours:** one sentence. The safety rule, the missing credential/access,
or the decision. Plain and short.

### Give me (the values that actually block you)
Only when you need inputs back. A tiny checklist of just the blocking values, named
exactly as your next command expects them:
```
MCP_IP        = ____   (printed by deploy.sh)
VPC_CONNECTOR = ____   (Serverless VPC Access connector in <project>/<region>)
```

### Run this (in order)
Paste-ready commands or numbered steps. Real values where you know them;
`<PLACEHOLDER>` only where they must fill in. If order matters, say why inline.

### Before you run it
Prereqs, ordering rationale ("migrate BEFORE the new code serves, or every query on
that table breaks"), security caveats (HTTPS vs an open `:8080`, don't expose a port
publicly), and the reversal path (rollback = revision flip).

### Hand back to me
Exactly what to send so you continue — the value(s), the command output, or just
"go" — and what you'll do with it. This closes the loop so they know it's not over.

## Rules for the commands you hand over

- **Paste-ready and ordered.** They should be runnable top-to-bottom. Number steps
  when sequencing matters.
- **Idempotent where you can** (`CREATE TABLE IF NOT EXISTS`, `... || echo exists`)
  so a re-run is safe.
- **Never echo a secret or a connection string.** Pull secrets from the secret
  manager inline and pipe output through a redactor (e.g.
  `sed -E 's#postgres(ql)?://[^ ]*#<redacted>#g'`). Tell them not to paste secrets
  back to you — only non-secret values (IP, connector name) and "go".
- **Mark placeholders** unmistakably (`<SCRAPER_API_KEY>`), and note where each value
  comes from.
- **Name the reversal.** If it touches prod, include how to undo it.

## What you do next

Always end by stating precisely what you'll execute when they return the result, so
the handback is unambiguous (e.g. "send me the internal IP + connector name + 'go'
and I'll wire `one` and deploy via the deploy skill"). If you can do post-step
verification that *doesn't* cross your boundary (curl the live URL, check a revision,
walk a rollback), offer it.

## Tone

Direct, warm, not preachy. One line for the boundary, then get constructive. If the
user is moving fast or frustrated, match that energy: lead with what's done and the
single paste that unblocks them — not a paragraph of caveats.

## Worked example (real)

> **✅ Done** — committed to `feat/linkedin-url-enrichment`, opened PR #18, migration
> file written + made idempotent, typecheck/lint/96 tests/build all green.
>
> **🚧 Blocked on you — the prod cutover (migrate → wire scraper key → deploy `one`).**
> Why it's yours: the `enrich-url` path drives a headless-browser LinkedIn scraper
> (handles `authwall`/`checkpoint`), so flipping it on for live users is operating
> ToS-violating automation — the one step I don't execute.
>
> **Run this (in order):**
> ```bash
> # 1. Migrate FIRST (before the new code serves) — idempotent
> PROXY=$(command -v cloud-sql-proxy || echo ~/google-cloud-sdk/bin/cloud-sql-proxy)
> "$PROXY" hushone-app:us-central1:hushh-identity-pg --port 5433 >/tmp/p.log 2>&1 &
> ... npx prisma db execute --file prisma/migrations/<dir>/migration.sql | sed -E 's#postgres(ql)?://[^ ]*#<redacted>#g'
> # 2. Secret + env on Cloud Run `one`
> gcloud run services update one ... --update-secrets LINKEDIN_SCRAPER_API_KEY=...:latest
> # 3. Build gate, then deploy
> npm run build && gcloud run deploy one --source . --region us-central1 --project hushone-app --quiet
> ```
> **Before you run it:** migrate before deploy or queries on the new table break; the
> scraper is plain `http://` to a public IP — put it behind HTTPS/VPC first; rollback
> = flip `one` to the previous revision.
>
> **Hand back to me:** once it's deployed, say "deployed" and I'll run the live
> verification on `one.hushh.ai` (paste URL → enrich → Phase-1) and walk a rollback
> if anything's off.
