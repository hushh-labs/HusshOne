# macOS Experience Specification — the Steve Jobs bar

**Status:** Specification — for design + SE/FDE · **Last updated:** 2026-06-18

This is the product spec for how Xtreme Compute Burst *feels*. The engineering can be perfect and the
product can still fail if the experience isn't effortless, honest, and a little magical. Target: an
**A+++ from Steve Jobs and the Apple team** — which means relentless simplicity, the user never doing
work the machine could do, privacy the user can feel, and a moment of delight when it matters.

## 1. The one sentence

> "Your Mac is a supercomputer — and when one job needs more, One quietly borrows a bigger one and
> brings the answer back. You never leave the app. Your keys and your data stay yours."

If a screen, setting, or word doesn't serve that sentence, cut it.

## 2. Principles (non-negotiable)

1. **Invisible mechanics, visible outcome.** The user sees results, not infrastructure. No "instance,"
   "provision," "quota," "VM," or "zone" ever appears in the default UI.
2. **Zero-config by default.** One good default beats ten options. The only setup is "connect your cloud."
3. **Honesty builds trust.** When One uses the cloud, it says so, plainly, and says whose cloud (yours)
   and what it cost. No silent surprises — financial or privacy.
4. **The machine does the work.** Accelerator choice, sizing, teardown, recovery — never the user's job.
5. **Privacy you can feel.** "Your key stays on this Mac. Your data runs in your own cloud. We keep none
   of it." Said in plain words, at the moment it's relevant.
6. **Fast, then beautiful.** Time-to-first-feedback is a feature. Progress is alive, never a dead spinner.
7. **Fail like Apple.** Errors are calm, specific, and always offer the next step. Never a stack trace,
   never a dead end.

## 3. First run — onboarding (≤ 60 seconds, 3 screens)

**Screen 1 — Welcome.** "One makes your Mac a supercomputer." One line on what it does. One button:
*Get started.* (One silently reads the device profile — no questions.)

**Screen 2 — Connect your cloud (the only real step).**
- Plain ask: "Paste your Google Cloud key so One can borrow supercomputers when your Mac needs them."
- A single field + *Paste*. Inline reassurance, present before they ask: **"Your key stays on this Mac
  (in the Secure Enclave). Your data runs in your own Google Cloud. We never store either."**
- A quiet "Don't have a key? Here's the 2-minute setup" link → a guided, copy-paste path (the FDE
  playbook's customer-setup steps, productized).
- Validate locally; on success: a green check and "You're set."

**Screen 3 — You're ready.** "One will use your Mac first, and only borrow more power when a job needs
it. You're in control." Button: *Start using One.* Done.

No accounts to reconcile, no plan picker, no infra. If the user skips the key, One still works
on-device and asks for the key only at the first moment a burst would help (just-in-time, never nagging).

## 4. The everyday state — the menu bar

- A calm menu-bar item. Idle: a subtle glyph. Working locally: a soft pulse. Bursting: a distinct,
  confident "borrowing power" state.
- One click reveals: what's running, where (On this Mac / In your cloud), progress, and — for a burst —
  a live, honest cost estimate ("~$0.40 so far").
- Nothing demands attention unless it needs a decision.

## 5. The burst moment (the magic)

This is the moment the product earns its name. Choreography:

1. **Sense.** A job is too big or the Mac is straining. (No scary warning — One just acts.)
2. **Tell, briefly.** A gentle, non-blocking notice: **"This one needs more power — One is borrowing a
   supercomputer to finish it faster."** (Whose cloud: yours. One line.)
3. **Show life.** Live progress with a real signal ("Running on an A100 in your cloud · ~3 min left").
   The language is human; the accelerator name is allowed here because it reads as *power*, not jargon —
   keep it to a confident phrase, never a config.
4. **Land it.** The result appears exactly as if it ran locally — same shape, same place. A quiet line:
   **"Done. One borrowed a supercomputer and cleaned it up. Cost: $0.62, billed to your cloud."**
5. **Leave nothing behind.** The instance is gone; One says so once. Trust compounds.

If the user is away (deadline handoff), One says: "This is taking longer than usual — I'll keep working
and let you know the moment it's done," then delivers via notification. Never a lie, never a lost job.

## 6. Cost & control — visible, never scary

- A live cost estimate during any burst; a one-line cost summary after.
- Sensible **caps by default** (per-burst and per-day) with a calm prompt only when a job would exceed
  them: "This job may cost about $9. Continue, or keep it on your Mac?" (See placement-autoscale.md.)
- A simple history: what ran where, how long, and what it cost — plain, exportable, no dashboards.

## 7. Privacy & security as felt experience

- The reassurance copy from onboarding reappears, contextually, the first time a burst happens.
- A one-tap "What does One send to the cloud?" answer in plain English (workload + your key to your own
  project; nothing kept by Hushh). Mirrors the security spec, said like a human.
- Removing the key is one tap and obviously complete ("Your cloud is disconnected. One will run on this
  Mac only.").

## 8. Failure states (calm, specific, actionable)

| Situation | What the user sees | Next step offered |
|---|---|---|
| No GPU quota in their project | "Your Google Cloud doesn't have GPU capacity here yet." | One-tap "How to request it" + "Run on this Mac instead." |
| Bad / expired key | "One couldn't reach your cloud — your key may have changed." | "Update key." |
| Burst failed | "That job didn't finish. Nothing was left running, and you weren't charged for the result." | "Try again" / "Run locally." |
| Offline | "You're offline — One will run this on your Mac." | (auto) |

Never show: HTTP codes, stack traces, instance names, "503", or "provisioning."

## 9. Accessibility & polish

- Full VoiceOver labels for every state; Dynamic Type; reduced-motion honored for the burst animation.
- Localizable copy; no jargon that won't translate.
- The burst animation is tasteful and brief — delight, not theater.

## 10. Definition of "A+++"

1. A non-technical user installs, connects a key, and gets a burst result **without learning a single
   cloud concept**.
2. At every cloud moment, the user knows **what happened, whose cloud, and what it cost** — without asking.
3. No dead spinners, no jargon, no orphaned cost, no lost jobs, no privacy surprises.
4. The first burst makes someone say "wait — it just did *that*?" — and trust it.

## Related documents
- White paper: docs/whitepaper-xtreme-compute-burst.md
- One Puppy macOS agent: docs/specs/one-puppy-macos-agent.md
- BYOC security & privacy: docs/specs/byoc-security-privacy.md
- Placement & autoscale (cost caps): docs/specs/placement-autoscale.md
