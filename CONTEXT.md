# CONTEXT — "One" by Hussh

Shared engineering baseline for **One**, Hushh's "personal intelligence" / public-footprint self-audit product.
A signed-in user triggers a scan with their **name + email + location**; the app calls an upstream **RIA
Intelligence API**, sanitizes the result, stores it, emails it, and renders a dashboard.

This doc is the durable reference for the whole flow so that when one contract changes, we already know
**what else moves with it** (see §4, the cascade map).

**Status:** latest working version, **not yet in production**. Targets **Google Cloud** (`.gcloudignore`
present) but the deployment pipeline is **not built yet** (no Dockerfile / Cloud Build / CI). See §6.

> ⚠️ This is a **non-standard Next.js 16.2.7** (see `AGENTS.md`). APIs/conventions may differ from defaults —
> consult `node_modules/next/dist/docs/` before changing routing/config.

---

## 0. Update — Hushh Shadow ensemble is now the primary intelligence source

`POST /api/one/dashboard` now drives the **Hushh Shadow** endpoint `POST /v1/hushh-shadow/report` (Gemini
grounding ×2 + four reasoning agents + synthesis → one rich `report`). Key points:
- **Same Cloud Run service & auth** as before — only the path changed. `x-api-key` = `HUSHH_SHADOW_API_KEY`
  (falls back to `PERSON_INTELLIGENCE_API_KEY`, the same secret).
- **Source priority:** Shadow is P0; on any non-auth failure it falls back to the legacy
  `/v1/person-intelligence/dashboard`, then to a temporary dashboard — the user always gets a saved result.
  Auth/config failure (401/403) surfaces a clear 503 (PI shares the key, so fallback can't help).
- **Latency / no-timeout:** Shadow is multi-minute. The route streams **NDJSON** (`{type:"start"|"progress"|"done"|"error"}`)
  with ~7s heartbeats so the connection never idles; `ONE_SHADOW_TIMEOUT_MS≈615s`, `ONE_SHADOW_RETRIES=0`,
  route `maxDuration=900`, and (when deployed) Cloud Run `--timeout=900`.
- **Rich UI + email:** `OneDashboardResult.rich` (mapped + sanitized in [src/lib/ria/shadow.ts](src/lib/ria/shadow.ts))
  carries professional/education/digitalFootprint/network/preferenceSignals/evidence ledger/discovery/confidence/
  conflicts/missingEvidence/sources. URLs are preserved; free text is redacted.
- **Live wait-state:** `CollectionOverlay` shows a phase stepper + paced canvas + elapsed timer (phases in
  [src/lib/ria/progress.ts](src/lib/ria/progress.ts)). A **required** `phone` is captured in PreCollect (clean field, "Send One" disabled until valid); `email`/`name` come from Google sign-in and coordinates from the browser dialog.
- **New recovery route:** `GET /api/one/scans/[scanRunId]` returns the saved result if the stream drops.
- **New env:** `HUSHH_SHADOW_API_KEY`, `ONE_SHADOW_TIMEOUT_MS`, `ONE_SHADOW_RETRIES`, `ONE_MOCK_RIA_DELAY_MS`.
- `startAudit` / the `AuditJob` async path are no longer called (`audit` is `null`); Shadow does the deep work.

The sections below describe the original baseline; the bullets above are the current behavior where they differ.

---

## 1. Product view (non-technical / PM)

**End to end:**
1. Single-page experience → **"Continue with Google"** (Firebase Google sign-in).
2. App reads **name + email** from the Google identity (or a manual fallback form).
3. App requests browser **geolocation** (lat/long); if denied, falls back to a **zip code**.
4. User consents and taps **"Send One"** → one POST to `/api/one/dashboard`.
5. Backend fans out to the **RIA Intelligence API** to (a) build a *dashboard* and (b) start a deeper *audit*.
6. Results are **sanitized** (phones/emails/addresses/secrets redacted; unverifiable claims flagged),
   **saved**, and **emailed** to the user **and** an internal admin allowlist.
7. Dashboard renders: Identity, Confidence, Social, News & media, Links, Education, Public records, Location,
   Private-data estimation, plus warnings/redactions notices.

**Data collected:** name, email, precise location (or zip), client IP + user-agent (stored **hashed**),
consent metadata (version, purpose, timestamp).

**Privacy posture (a product feature):** redaction-first — raw contact data is stripped before display/email;
consent is logged atomically with every scan; backed by the `ConsentEvent` / `DataRequest` models.

**Self-audit only, today:** `purpose` must be `"self_audit"` and `consentAttestation` must be `true` (both hard-required).

---

## 2. The API — `POST /api/one/dashboard`

**File:** `src/app/api/one/dashboard/route.ts` · `runtime = "nodejs"`

### Request
- **Headers:** `Authorization: Bearer <Firebase ID token>` (required), `Content-Type: application/json`.
  IP from `x-forwarded-for` / `x-real-ip`; `user-agent` captured.
- **Body:** `{ name, email, latitude?, longitude?, zipCode?, consentAttestation: true, purpose: "self_audit" }`

### Auth — `src/lib/auth/verify.ts`
- Bearer token → `verifyFirebaseIdToken()` (Firebase Admin, `checkRevoked=true`). Returns `{ uid, email, name, picture }`.
- **Dev bypass:** `ONE_ENABLE_DEV_AUTH=true` + literal token `"DEV_TOKEN"` → fake `dev.one@hushh.ai` user (no Firebase call).

### Validation — `normalizeInput()` (route.ts:57-92)
| Rule | Failure |
|------|---------|
| `name` non-empty after whitespace-collapse | 400 |
| `email` matches basic regex | 400 |
| body `email` **===** Firebase-verified email | **403** (anti-impersonation) |
| `consentAttestation === true` | 400 |
| `purpose === "self_audit"` | 400 |
| `latitude+longitude` (finite) **OR** non-empty `zipCode` | 400 |

`mode` derived (route.ts:100): both coords present → `"precise"`, else `"limited"`.

### Handler flow (route.ts:94-212)
1. Verify token → parse + validate body → derive `mode`.
2. **DB:** `upsertOneUser()` (by `firebaseUid`) → `createConsentAndScan()` (`ConsentEvent` +
   `ScanRun(status="running")` in one transaction; IP/UA hashed SHA-256).
3. **Fan out (parallel, `Promise.allSettled`):** `fetchDashboardIntelligence(input)` + `startAudit(input)`.
4. `createAuditJob()` records upstream audit metadata.
5. **Dashboard selection (graceful degradation):** success → use it; else if audit started →
   `buildAuditPendingDashboard()`; else if upstream error is temporary (408/429/5xx) →
   `buildTemporaryDashboard()`; else throw.
6. `normalizeDashboardPayload()` → sanitized `OneDashboardResult`.
7. `completeScanRun()` stores `normalizedResult` + summary, status `"completed"`.
8. `sendScanResultEmails()` — **wrapped in try/catch; email failure does NOT fail the request.**
9. Respond `{ ok: true, result, audit, emailDelivery }`.

### Response / errors
- **Success:** `{ ok, result: OneDashboardResult, audit: PersonAuditStatus|null, emailDelivery }`.
- **Errors:** `{ ok: false, error }` with `400 | 401 | 403 | 500` (failed scans marked via `failScanRun`).
- Every branch logs **structured JSON** (`event: "one.dashboard.*"`) → searchable in Cloud Logging.

### Secondary endpoint
`GET /api/one/audits/[jobId]/report` (`src/app/api/one/audits/[jobId]/report/route.ts`) — same auth,
proxies RIA `…/audits/{jobId}/report`. Used to poll the deeper async audit after the initial scan.

---

## 3. Architecture

**Stack:** Next.js **16.2.7** (App Router) · React **19.2.4** · Prisma **6.19** → **PostgreSQL** ·
Firebase (client auth + admin verify) · Gmail API (service-account JWT) · upstream **RIA Intelligence API** ·
Vitest. Node `>=20.19`. Path alias `@/* → src/*`.

```
Browser ── OneExperience.tsx (state machine: landing→manual→precollect→collect→dashboard/empty/error)
   │  Firebase Google sign-in → ID token; browser geolocation → lat/long
   ▼  POST /api/one/dashboard  (Bearer token + name/email/location)
API route.ts ──► auth/verify ──► db/scan-store (Prisma) ──► ria/client (upstream) ──► ria/sanitize
                                       │                                                    │
                                       └──► notifications/scan-email ──► gmail (JWT) ────────┘
                                       (writes OneNotification rows; admin allowlist)
```

**Frontend caller:** `src/components/one/OneExperience.tsx` — `runScan()` (≈682-690) builds the exact POST
body; `Dashboard` (356-546) consumes nearly every field of `OneDashboardResult`.

**Data model — `prisma/schema.prisma` (6 models):**
`OneUser` (identity, by `firebaseUid`) · `ConsentEvent` (purpose, location, hashed IP/UA, consent version) ·
`ScanRun` (the scan; `input` + `normalizedResult` JSON, status lifecycle) · `AuditJob` (upstream job link,
shard counts, report) · `OneNotification` (email delivery audit; unique on
`(scanRunId, notificationType, recipientEmail)`) · `DataRequest` (GDPR/CCPA; not used by this endpoint yet).
**Graceful no-DB mode:** every helper returns `null` if `DATABASE_URL` is unset (`src/lib/db/prisma.ts`) —
the scan still runs, just unpersisted.

**Upstream RIA contract — `src/lib/ria/client.ts`:**
- Base: `RIA_INTELLIGENCE_API_BASE_URL` (default `…hushh-ria-intelligence-api-53407187172.us-central1.run.app`),
  auth header `x-api-key: PERSON_INTELLIGENCE_API_KEY`.
- Endpoints: `POST /v1/person-intelligence/dashboard` (precise) → on failure falls back to `POST …/footprint`
  (reshaped into a dashboard); `POST /v1/intelligence/osint-profile` (zip/limited); `POST …/audits`
  (precise only); `GET …/audits/{id}/report`.
- Resilience: timeout (`ONE_RIA_TIMEOUT_MS`, default 180s), retries (`ONE_RIA_RETRIES`, default 2) on
  408/429/5xx with jittered backoff (×2 for 429). `ONE_ENABLE_MOCK_RIA=true` returns canned data (no key needed).

**Sanitization — `src/lib/ria/sanitize.ts`:** redacts email/phone/address/secret patterns; dedups + caps
categories at 8; classifies private-data findings as `source-backed | possible | not-verified`; emits
warnings (limited mode, unverifiable claims).

**Notifications — `src/lib/notifications/`:** `scan-email.ts` sends to the user **and** the hardcoded admin
allowlist (`allowlist.ts`); `gmail.ts` does service-account JWT → OAuth token → Gmail send (sender default
`ankit@hushh.ai`).

---

## 4. ⭐ Cascade map — "change this API → change that API"

Three contracts; touching any one ripples to a fixed set of files.

### Contract A — Inbound request `{ name, email, latitude, longitude, zipCode, consent, purpose }`
- `src/components/one/OneExperience.tsx` `runScan()` body (~682-690) — the only sender.
- `src/app/api/one/dashboard/route.ts` `normalizeInput()` (57-92) — validation + `mode` rule (100).
- `src/lib/ria/types.ts` `OneSubjectInput` (3-11).
- `src/lib/db/scan-store.ts` — what's persisted into `ScanRun.input` / `ConsentEvent` (+ possible migration).
- `src/lib/ria/client.ts` — upstream request bodies (294-403) re-send these fields.

### Contract B — Upstream RIA (`PersonDashboardResponse`, `PersonAuditStatus`) — most likely "aggregation" change
- `src/lib/ria/types.ts` `PersonDashboardResponse` / `DashboardCategoryMap` / `PersonAuditStatus`.
- `src/lib/ria/client.ts` — request bodies **and** response parsing **and all four builders that must keep
  emitting a valid `PersonDashboardResponse`**: `mockDashboard`, `dashboardFromFootprint`,
  `buildAuditPendingDashboard`, `buildTemporaryDashboard` (easy to forget the fallbacks).
- `src/lib/ria/sanitize.ts` — consumes the upstream shape → produces `OneDashboardResult`.

### Contract C — Outbound result `OneDashboardResult` (what UI + email read)
- `src/lib/ria/types.ts` `OneDashboardResult` / `OneSafeFinding`.
- `src/lib/ria/sanitize.ts` `normalizeDashboardPayload()` (the producer).
- `src/app/api/one/dashboard/route.ts` response (192) + `ScanRun.normalizedResult` persistence.
- `src/components/one/OneExperience.tsx` `Dashboard` / `coverageScore` (330-546) — many field reads.
- `src/lib/notifications/scan-email-template.ts` — email rendering reads the same fields.

**Tests pinning these contracts** (update alongside): `route.test.ts`, `client.test.ts`, `sanitize.test.ts`,
`scan-email.test.ts`, `identity.test.ts`.

---

## 5. Environments & feature flags
| Flag | Effect |
|------|--------|
| `ONE_ENABLE_DEV_AUTH` / `NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH` | accept `DEV_TOKEN`, skip Firebase (backend + client) |
| `ONE_ENABLE_MOCK_RIA` | return canned RIA data; no API key / network needed |
| `ONE_RIA_TIMEOUT_MS` / `ONE_RIA_RETRIES` / `ONE_RIA_RETRY_BASE_DELAY_MS` | upstream resilience tuning |
| `ONE_CONSENT_VERSION` | stamped onto each `ConsentEvent` |

---

## 6. Deployment pipeline — current state + gaps

**Today:** never deployed. Targets GCP (`.gcloudignore` excludes `.git/.next/node_modules/.env*`).
`next.config.ts` is **default SSR** (not `standalone`/`export`) + a rewrite proxying `/__/auth/*` to
`hushone-app.firebaseapp.com`. Build/run = `next build` → `next start` (port 3000; honor Cloud Run `$PORT`).
DB = PostgreSQL with **one** migration (`prisma/migrations/20260605190000_init`); `postinstall` runs
`prisma generate`. Firebase admin uses `FIREBASE_ADMIN_CREDENTIALS_JSON` **or** Application Default
Credentials (ADC) — ADC is the clean Cloud Run path.

**Intended shape:** containerized **Cloud Run** → **Cloud SQL** Postgres → RIA (itself a Cloud Run service) →
Gmail API. **Cloud Run request timeout must exceed the 180s RIA timeout.**

**Gaps before production (not yet in repo):** Dockerfile · Cloud Build / CI (lint+typecheck+test+build+deploy) ·
Cloud Run service config (env + secrets, memory, timeout) · Secret Manager wiring · Cloud SQL instance +
connection · Gmail service-account domain delegation.

**Env vars:** public `NEXT_PUBLIC_FIREBASE_*` (6) + `NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH` + `NEXT_PUBLIC_ONE_SITE_URL`;
secrets `FIREBASE_ADMIN_CREDENTIALS_JSON`, `DATABASE_URL`, `PERSON_INTELLIGENCE_API_KEY`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`; config `RIA_INTELLIGENCE_API_BASE_URL`, `ONE_RIA_*`,
`ONE_CONSENT_VERSION`, `GMAIL_SENDER_EMAIL`, `ONE_SITE_URL`. See `.env.example`.

---

## 7. Run & verify locally
```bash
npm install
npm run db:generate && npm run db:migrate   # needs DATABASE_URL
npm run dev -- --port 3000                   # http://localhost:3000
# Fastest end-to-end without external deps:
#   ONE_ENABLE_DEV_AUTH=true + NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH=true + ONE_ENABLE_MOCK_RIA=true
npm run typecheck && npm run lint && npm test && npm run build
```
For any change, run the relevant contract tests (§4) and, when previewable, exercise the dev-auth + mock-RIA
path in the browser.
