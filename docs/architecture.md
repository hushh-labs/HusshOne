# One Architecture

This is the architecture README for One, the Hushh public-footprint self-audit product at `https://one.hushh.ai`.

The current production app is a Next.js 16 App Router service deployed as a Docker container on Google Cloud Run. Users sign in, connect a LinkedIn profile URL, One normalizes that LinkedIn data into a trusted profile object, then starts a multi-stage public-intelligence scan backed by the Deep Research API and stored in Postgres.

## Production Services

| Layer | Production value |
| --- | --- |
| User-facing URL | `https://one.hushh.ai` |
| GCP project | `hushone-app` |
| Cloud Run service | `one` |
| Current deployed revision | `one-00061-q56` |
| Container image | `us-central1-docker.pkg.dev/hushone-app/cloud-run-source-deploy/one:linkedin-enrichment-20260612171427` |
| Database | Cloud SQL Postgres: `hushone-app:us-central1:hushh-identity-pg` |
| LinkedIn scraper host | `https://linkedin-scraper.136.114.82.27.sslip.io` |
| Deep Research API default | `https://deep-research-api-bmrh3cdxwa-el.a.run.app` unless overridden by env |
| Email provider | Gmail SMTP/app-password env through Secret Manager |

## High-Level System

```mermaid
flowchart LR
  Browser["Browser: one.hushh.ai"] --> NextApp["Cloud Run: one"]
  NextApp --> Firebase["Firebase Auth/Admin"]
  NextApp --> CloudSQL["Cloud SQL Postgres"]
  NextApp --> LinkedInScraper["LinkedIn scraper service"]
  NextApp --> DeepResearch["Deep Research API"]
  NextApp --> Gmail["Gmail SMTP"]

  LinkedInScraper --> NextApp
  DeepResearch --> NextApp
  NextApp --> Browser
```

## Core Runtime Paths

| Concern | Code |
| --- | --- |
| Main app shell | `src/components/one/OneExperience.tsx` |
| LinkedIn URL enrichment route | `src/app/api/linkedin/enrich-url/route.ts` |
| LinkedIn scraper mapper | `src/lib/linkedin/scraper-profile.ts` |
| Standalone LinkedIn scraper worker | `services/linkedin-scraper` |
| LinkedIn profile contract | `src/lib/linkedin/profile.ts` |
| LinkedIn connection persistence | `src/lib/linkedin/connection.ts` |
| Main Phase 1 scan route | `src/app/api/one/research/route.ts` |
| Scan recovery route | `src/app/api/one/research/[id]/route.ts` |
| Progressive deep batches | `src/app/api/one/research/[id]/deep/route.ts` |
| Image intelligence tier | `src/app/api/one/research/[id]/image/route.ts` |
| Prompt builders and result mapper | `src/lib/research/dossier.ts` |
| Deep Research API client | `src/lib/research/client.ts` |
| Phase 2 final synthesis | `src/lib/research/finalize.ts` |
| DB scan/user/notification store | `src/lib/db/scan-store.ts` |
| Gmail result email | `src/lib/notifications/scan-email.ts` |
| Auth verification | `src/lib/auth/verify.ts` |

## User Journey

```mermaid
sequenceDiagram
  participant U as User
  participant B as Browser
  participant O as One Cloud Run
  participant L as LinkedIn Scraper
  participant DB as Postgres
  participant DR as Deep Research API
  participant G as Gmail

  U->>B: Opens one.hushh.ai
  B->>O: Authenticated request with Firebase bearer
  O->>O: verifyOneRequest()
  U->>B: Pastes LinkedIn profile URL
  B->>O: POST /api/linkedin/enrich-url
  O->>L: POST /scrape with normalized LinkedIn URL
  L-->>O: Raw scraper templates
  O->>O: Normalize to LinkedInProfileFull
  O->>DB: Persist LinkedInConnection
  U->>B: Starts scan
  B->>O: POST /api/one/research
  O->>DB: Create user, consent, ScanRun
  O->>DR: POST /v1/research with Prompt 1
  O-->>B: NDJSON progress stream
  O->>DR: Poll until Phase 1 completes
  O->>O: Phase 2 finalizeResearch()
  O->>DB: Complete ScanRun
  O->>G: Send result email
  O-->>B: Final dashboard result
```

## Auth Model

One routes expect a Firebase bearer token in the `Authorization` header. `verifyOneRequest()` validates that token and returns a stable user identity:

- `uid`
- `email`
- `name`
- `picture`

There is a development bypass guarded by `ONE_ENABLE_DEV_AUTH`, but production smoke verifies that `DEV_TOKEN` is rejected in production.

LinkedIn URL enrichment is not a public anonymous API. `POST /api/linkedin/enrich-url` verifies the One request before it calls the upstream scraper.

## LinkedIn Enrichment

One uses LinkedIn as the identity and career anchor before starting Phase 1.

Flow:

1. Browser sends a LinkedIn `/in/` URL to `POST /api/linkedin/enrich-url`.
2. One verifies the Firebase bearer token.
3. `scrapeLinkedInProfileUrl()` normalizes the URL.
4. One calls the scraper: `POST ${LINKEDIN_SCRAPER_URL}/scrape`.
5. The upstream returns templates such as `linkedinProfileScraper` and `staffSpyStyle`.
6. `mapScraperResponseToLinkedInProfile()` maps those templates into `LinkedInProfileFull`.
7. `persistConnectedProfile()` saves it to `LinkedInConnection.profile`.
8. `/api/one/research` requires this URL-enriched LinkedIn profile before Deep Research starts.

The scraper API key is server-only. It must never be shipped to the browser, printed in logs, or committed.

See `docs/linkedin-enrichment.md` for the full app contract and `services/linkedin-scraper/README.md` for the standalone worker runtime/deploy guide.

## LinkedIn Data Contract

The normalized profile can include:

- identity: `sub`, `name`, `givenName`, `familyName`, signed-in `email`
- media/profile: `pictureUrl`, `profileUrl`, `headline`
- context: `location`, `about`
- structured career: `experience[]`
- structured education: `education[]`
- skills and certifications
- optional public stats: `profileStats`
- provenance: `source: "scraper"` and `grantedScopes`

Important behavior:

- `· 2nd`, `· 3rd`, buttons, and `More profiles for you` are LinkedIn UI noise, not profile facts.
- If the top-card title is only connection-degree text, One derives the headline from real current experience, for example `Developer at Oracle`.
- Sidebar/recommendation leakage is stripped before it reaches Prompt 1.
- Raw scraper/session/cookie data is intentionally excluded from Prompt 1.

## Prompt 1 Handoff

`buildPersonDossierQuestion()` builds the Phase 1 prompt in `src/lib/research/dossier.ts`.

When LinkedIn data is present, Prompt 1 includes:

- `SUBJECT_INTELLIGENCE_CONTEXT_JSON`
- `LINKEDIN_ENRICHED_PROFILE_JSON`
- a professional spine derived from structured LinkedIn experience first
- a headline parser fallback only when structured experience is missing

Prompt 1 instructs Deep Research to:

- treat LinkedIn/user-provided JSON as locked ground truth for identity and self-declared career facts
- avoid fetching or citing signed LinkedIn/media URLs
- reject same-name people unless they connect to the LinkedIn JSON or other strong anchors
- use public web only for corroboration, contradictions, and enrichment
- label claims as LinkedIn ground truth, public web evidence, or inference

## Scan Lifecycle

`POST /api/one/research` is the main scan route.

Phase 0:

- Verify Firebase token.
- Parse and sanitize the request body.
- Require a URL-enriched LinkedIn profile.
- Create/update `OneUser`.
- Create `ConsentEvent` and `ScanRun`.

Phase 1:

- Build Prompt 1.
- Call `startResearch(question, depth)`.
- Store `deepResearchJobId`.
- Stream NDJSON progress to the browser.
- Poll the Deep Research job until completion.

Phase 2:

- Run `finalizeResearch()` to turn the raw Phase 1 report into One's dashboard result shape.
- Persist `normalizedResult`, `summary`, timings, and outcome.
- Send result emails.

Recovery:

- If the browser disconnects or the route hits a soft deadline, the scan remains recoverable.
- `GET /api/one/research/[id]` resumes polling/finalization using the stored `deepResearchJobId`.
- `GET /api/one/scans/latest` lets the browser reattach to the most recent scan.

## Data Model

Main Prisma models:

- `OneUser`: user identity keyed by `firebaseUid`.
- `LinkedInConnection`: one connected normalized LinkedIn profile per user.
- `ConsentEvent`: durable consent/location-mode audit row per scan start.
- `ScanRun`: scan input, status, result, timings, outcome, and Deep Research job ID.
- `AuditJob`: optional legacy/adjacent audit job records.
- `OneNotification`: email send tracking for user/admin result delivery.
- `DataRequest`: account/data request lifecycle.

`ScanRun.input` stores the sanitized request input, including `linkedinProfile` and `deepResearchJobId`. `ScanRun.normalizedResult` stores the dashboard-ready result.

## Environment And Secrets

Production env names currently used by the service include:

- Firebase public env:
  - `NEXT_PUBLIC_FIREBASE_API_KEY`
  - `NEXT_PUBLIC_FIREBASE_APP_ID`
  - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
  - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
  - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
  - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- Auth/runtime:
  - `ONE_ENABLE_DEV_AUTH`
  - `NEXT_PUBLIC_ONE_ENABLE_DEV_AUTH`
  - `GOOGLE_CLOUD_PROJECT`
- Database:
  - `DATABASE_URL`
- Deep Research:
  - `DEEP_RESEARCH_API_TOKEN`
  - `DEEP_RESEARCH_DEPTH`
  - `DEEP_RESEARCH_API_BASE_URL` if overriding the default
- LinkedIn OAuth:
  - `LINKEDIN_REDIRECT_URI`
  - `LINKEDIN_CLIENT_ID`
  - `LINKEDIN_CLIENT_SECRET`
- LinkedIn URL enrichment:
  - `LINKEDIN_SCRAPER_URL`
  - `LINKEDIN_SCRAPER_API_KEY`
  - `LINKEDIN_SCRAPER_TIMEOUT_MS`
- Email:
  - `GMAIL_USER`
  - `GMAIL_APP_PASSWORD`
  - `ONE_SITE_URL`
- Legacy/RIA compatibility:
  - `PERSON_INTELLIGENCE_API_KEY`
  - `RIA_INTELLIGENCE_API_BASE_URL`
  - `ONE_RIA_TIMEOUT_MS`
  - `ONE_SHADOW_TIMEOUT_MS`
  - `ONE_SHADOW_RETRIES`

Never expose secret values in docs, logs, screenshots, or browser bundles. Give names and Secret Manager locations only.

## Deployment

The app uses `next.config.ts` with `output: "standalone"` and a multi-stage Dockerfile.

Local preflight:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Build and push a production image:

```bash
IMAGE="us-central1-docker.pkg.dev/hushone-app/cloud-run-source-deploy/one:<tag>"
gcloud builds submit --project=hushone-app --tag "$IMAGE" .
```

Deploy to Cloud Run:

```bash
gcloud run deploy one \
  --project=hushone-app \
  --region=us-central1 \
  --image "$IMAGE" \
  --platform=managed \
  --quiet
```

Check deployed revision and env names:

```bash
gcloud run services describe one \
  --project=hushone-app \
  --region=us-central1 \
  --format='json(status.latestReadyRevisionName,status.traffic,spec.template.spec.containers[0].image,spec.template.spec.containers[0].env)'
```

## Verification

Production smoke:

```bash
BASE_URL=https://one.hushh.ai node scripts/prod-smoke.mjs
```

Expected current smoke coverage:

- homepage returns 200
- homepage renders One
- scan/dashboard APIs require auth
- dev auth is off in production
- events beacon accepts valid events and ignores unknown events
- wrong method on scan API returns 405

LinkedIn route auth smoke:

```bash
curl -sS -X POST https://one.hushh.ai/api/linkedin/enrich-url \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.linkedin.com/in/example/"}'
```

Expected without a Firebase bearer: `401 Missing authorization header`.

## Observability

Cloud Logging query for the live service:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="one" AND timestamp>="YYYY-MM-DDTHH:MM:SSZ"' \
  --project=hushone-app \
  --limit=100 \
  --order=desc
```

Important structured events:

- `one.ui.stage_*`: browser funnel events
- `one.ui.linkedin_connect_started`
- `one.ui.linkedin_connected`
- `one.research.phase1_done`
- `one.research.synth_ok`
- `one.research.completed`
- `one.research.failed`
- `one.research.deadline`
- `one.research_email.failed`

Dashboard and alert definitions live under `observability/`.

## Failure Modes

LinkedIn enrichment:

- `401` from One route means missing/invalid Firebase bearer.
- `linkedin_scraper_not_configured` means `LINKEDIN_SCRAPER_API_KEY` is missing.
- `linkedin_scraper_timeout` means the scraper exceeded `LINKEDIN_SCRAPER_TIMEOUT_MS`.
- Authwall/checkpoint/session errors usually mean the upstream LinkedIn session needs attention.
- Sparse profile output should still gracefully preserve any real about, experience, education, skills, certifications, and profile stats.

Deep Research:

- Missing token returns `Deep Research API token is not configured`.
- Upstream 429/5xx is retried by `src/lib/research/client.ts`.
- Long Phase 1 scans can hand off to recovery instead of losing the job.

Database:

- Timing columns are treated defensively because deploys may run before migrations in some environments.
- `LinkedInConnection` reads/writes are defensive so missing migration state does not break connect.

Email:

- Email send failures are logged and tracked, but the scan result can still complete.

## Security And Privacy Boundaries

- Use only user-consented inputs and lawful public web data.
- Do not expose raw LinkedIn sessions, cookies, scraper keys, SMTP passwords, database URLs, or Firebase admin material.
- Do not fetch/cite signed LinkedIn media URLs in Deep Research output.
- Do not report exact home address, private messages, leaked secrets, private family/minor details, or non-consented private account data.
- Prefer `unknown` over guessing.

## Related Docs

- `docs/linkedin-enrichment.md`
- `docs/RIA_SHADOW_STREAMING_SPEC.md`
- `README.md`
- `CONTEXT.md`
