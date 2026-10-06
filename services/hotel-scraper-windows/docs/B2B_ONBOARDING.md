# B2B Intelligence onboarding lookup v1

P2P is deferred. This contract only resolves business directory candidates.

`POST /api/v1/businesses/onboarding/lookup`

Request: `{"work_email":"owner@example.com","phone":"+1 4255550100"}`.
US phone numbers only in v1. No arbitrary scraping is triggered.

The authenticated application backend (BFF) must verify control of the email and
phone before invoking this service for onboarding, enforce per-account rate limits,
and obtain the user's consent. Cloud Run IAM authenticates the caller service,
not the end user. Do not expose its invocation credentials to browsers. The local
desktop endpoint is loopback-only; do not publish the desktop server.

The response has `contract_version: b2b-onboarding.v1`, `scope: b2b`, candidates,
match evidence, native identities, last_seen, warnings and an optional autofill draft.
Statuses: draft_ready, needs_selection, no_match, unavailable. Partial directory
failure or candidate truncation prevents automatic draft selection. Match strength
is a rule-based label, not a probability or ownership verification.

Both exact normalized phone and exact website hostname must match one candidate
for draft_ready. Shared branches and duplicate directory representations require
selection. Common consumer email domains are excluded from domain evidence; that
list is conservative but not exhaustive. Subdomains, redirects, and aliases are
not inferred. Missing websites reduce coverage. Organizations only are queried
in healthcare; firms only in RIA; agencies only in insurance.

No email address is echoed or persisted. Responses use Cache-Control: no-store.
No INSERT, UPDATE, DELETE, schema change, claimant attachment or claim creation
occurs. Email/phone possession does not establish business authority. A later
claim endpoint must verify authority and save only the user-confirmed draft into
the app account store, not overwrite canonical scraped rows.

Queries normalize existing columns and may be expensive at nationwide scale.
Existing connection/statement timeouts bound failures; production load testing
and separately approved indexed normalized lookup columns are needed before
large-scale onboarding. Never treat timed-out directories as empty.

This endpoint is implemented locally; deployment, frontend/BFF wiring and real
claimant verification are separate rollout steps.
