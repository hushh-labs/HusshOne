# LinkedIn URL Enrichment

This document describes the LinkedIn profile enrichment path used by One before starting Phase 1 Deep Research.

## Production Shape

- User-facing site: `https://one.hushh.ai`
- One Cloud Run project/service: `hushone-app` / `one`
- Standalone worker code: `services/linkedin-scraper`
- One route: `POST /api/linkedin/enrich-url`
- Upstream scraper base URL: `https://linkedin-scraper.136.114.82.27.sslip.io`
- Upstream scraper path: `POST /scrape`
- Upstream request body: `{ "url": "<normalized linkedin.com/in profile URL>" }`
- Upstream auth: `Authorization: Bearer <LINKEDIN_SCRAPER_API_KEY>`

The browser never receives the scraper API key. The browser sends only a LinkedIn profile URL to One, and One performs the scraper call server-side after verifying the signed-in One user.

See `services/linkedin-scraper/README.md` for the worker runtime, persistent Chrome/noVNC model, local run commands, VM deployment helper, and failure modes.

## Environment

Production env on Cloud Run:

```bash
LINKEDIN_SCRAPER_URL=https://linkedin-scraper.136.114.82.27.sslip.io
LINKEDIN_SCRAPER_API_KEY=<Secret Manager: linkedin-scraper-api-key>
LINKEDIN_SCRAPER_TIMEOUT_MS=180000
```

Do not print, commit, or expose `LINKEDIN_SCRAPER_API_KEY`.

## Flow

1. The user signs in to One and pastes a personal LinkedIn `/in/` URL.
2. `src/app/api/linkedin/enrich-url/route.ts` verifies the One request.
3. `scrapeLinkedInProfileUrl()` normalizes the LinkedIn URL and calls the scraper.
4. The scraper returns raw templates, currently including:
   - `linkedinProfileScraper`
   - `staffSpyStyle`
5. `mapScraperResponseToLinkedInProfile()` converts those templates into `LinkedInProfileFull`.
6. The normalized profile is persisted via `persistConnectedProfile()`.
7. `/api/one/research` requires that URL-enriched LinkedIn profile before starting Phase 1.
8. `buildPersonDossierQuestion()` injects the normalized LinkedIn JSON into Prompt 1.

Raw scraper/session/cookie material is intentionally excluded from Prompt 1. The prompt receives the normalized profile object only.

## Normalized Payload

`LinkedInProfileFull` can include:

```ts
{
  sub: string;
  name: string;
  givenName: string;
  familyName: string;
  email: string | null;
  emailVerified: boolean;
  locale: string | null;
  pictureUrl: string | null;
  profileUrl: string | null;
  headline: string | null;
  location?: string | null;
  about?: string | null;
  experience?: Array<{
    title: string;
    company: string;
    employmentType?: string;
    location?: string;
    startDate?: string;
    endDate?: string;
    current?: boolean;
    description?: string;
  }>;
  education?: Array<{
    school: string;
    degree?: string;
    field?: string;
    startDate?: string;
    endDate?: string;
    grade?: string;
    description?: string;
  }>;
  skills?: string[];
  certifications?: Array<{
    name: string;
    authority?: string;
    date?: string;
  }>;
  profileStats?: {
    followers?: string;
    connections?: string;
    isConnection?: boolean;
    premium?: boolean;
    creator?: boolean;
  };
  verifications: string[];
  grantedScopes: string[];
  source: "scraper";
}
```

The `email` field is the signed-in One account email that One passes into the mapper. The scraper does not reliably return a LinkedIn member email.

## Graceful Edge Handling

LinkedIn often returns relationship text like `· 2nd` or `· 3rd` in the top-card title slot. That is not a headline. One drops that UI label, then derives a useful headline from real current experience when available, for example:

```text
Developer at Oracle
```

The mapper also strips LinkedIn recommendation rail leakage such as `More profiles for you`, `Connect`, `Follow`, and recommended people from experiences, education, and skills. This prevents another person's profile from becoming the subject's job, school, or skill.

## Prompt 1 Handoff

`/api/one/research` sanitizes the connected LinkedIn profile and passes it into `buildPersonDossierQuestion()`.

Prompt 1 includes:

- `SUBJECT_INTELLIGENCE_CONTEXT_JSON`
- `LINKEDIN_ENRICHED_PROFILE_JSON`
- a professional spine derived from structured experience first, then headline fallback

Prompt 1 instructs Deep Research to treat LinkedIn/user-provided JSON as locked ground truth, avoid fetching/citing signed LinkedIn media URLs, reject same-name strangers, and use public web only for corroboration and enrichment.

## Production Checks

Check the One Cloud Run env without printing secrets:

```bash
gcloud run services describe one \
  --project=hushone-app \
  --region=us-central1 \
  --format='yaml(status.latestReadyRevisionName,spec.template.spec.containers[0].env)'
```

Watch One logs around a scan:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="one" AND timestamp>="YYYY-MM-DDTHH:MM:SSZ"' \
  --project=hushone-app \
  --limit=100 \
  --order=desc
```

Directly smoke the scraper from a trusted shell:

```bash
API_KEY="$(gcloud secrets versions access latest --secret=linkedin-scraper-api-key --project=hushone-app)"
curl -sS --max-time 180 \
  -X POST 'https://linkedin-scraper.136.114.82.27.sslip.io/scrape' \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"url":"https://www.linkedin.com/in/example/"}'
```

Do not paste the API key or raw output into chats if the output includes signed media URLs or private session material.

## Key Files

- `services/linkedin-scraper/README.md`
- `services/linkedin-scraper/server.mjs`
- `src/app/api/linkedin/enrich-url/route.ts`
- `src/lib/linkedin/scraper-profile.ts`
- `src/lib/linkedin/profile.ts`
- `src/app/api/one/research/route.ts`
- `src/lib/research/dossier.ts`
- `src/lib/linkedin/scraper-profile.test.ts`
