---
name: handoff-summary
description: >-
  Produce a clean, plain-language "here's exactly what YOU need to do" summary whenever a turn ends with the
  user (Ankit) needing to act — blocked on procurement, credentials, a GCP/VM console action, a deploy
  go-ahead, or a safety-gated step. Use this ANY time you're handing control back: the user has said he loses
  the thread when a turn just stops ("tumne chat end kar diya but mujhe idea nahi kya hua"). Also trigger when
  he asks "ab kya karun", "what do I do", "summary do", "I'm confused", or after a long multi-step session.
  Simple Hinglish, no jargon, smallest set of steps, copy-paste-ready commands. (Lighter, user-facing
  companion to the heavier human-handoff skill.)
---

# Handoff summary — "tumhe kya karna hai"

Whenever you're blocked or handing control back to Ankit, end the turn with this exact 3-part shape. Keep it
SHORT and scannable. No internal jargon. He should know in 10 seconds what happened and what to do.

## Format (use these headings, in simple Hinglish)

**1. ✅ Kya hua / kahan atke**
- 1–3 lines. What's done, and what's blocking (and why it's HIS to do — creds/console/billing/safety).
- A tiny status table is fine if multiple things.

**2. 👉 Tumhe kya karna hai**
- Numbered, smallest set of steps.
- Copy-paste-ready commands in fenced blocks (with the real project/zone/paths filled in — never placeholders he has to guess).
- Never ask him to paste secrets into chat — tell him to use Secret Manager / files.

**3. ⏭️ Phir main kya karunga**
- What you'll do the moment he hands it back (verify / deploy / continue), so he knows it's not on him after that.

## Rules
- Lead with the ask — don't bury it under recap.
- Only include what's necessary for HIS next action; link/mention details rather than dumping them.
- If several PRs/items are pending, list them in one small table (name → state → who owns next).
- Be honest about what's NOT done and what could go wrong.
- Prefer this plain format over a long technical wall of text.

## Mini example
> **✅ Kya hua:** IG scraper down hai (login page 429 — datacenter IP block). Fix code ready (PR #56), par activate karne ko ek proxy account chahiye.
> **👉 Tumhe karna hai:** 1) ek mobile proxy le lo → 2) `gcloud secrets create scraper-proxy-url ...` → 3) mujhe "done" bolo.
> **⏭️ Phir main:** VM redeploy + verify karke IG ko up kar dunga.
