# Choosing inputs

A guide to deciding what identity and profile URLs to send to `POST /api/v1/scan` so One has enough signal to work with.

Every scan starts from a small identity block plus any public profile URLs you choose to attach. One scrapes each URL you provide, then runs its deep‑research and preference pipeline on the result. Sending more good signal produces a richer dossier and preference profile — but only three fields are actually required, and any URL that is missing, private, or fails is simply reported and skipped. This page explains what each input adds so you can send the right subset.

For the exact request/response contract, see [Start a scan](/docs/start-a-scan). For the shapes of what comes back per platform, see [Profile contracts](/docs/profile-contracts). For the preference/lifestyle layer, see [Preferences](/docs/preferences).

## Required identity

Three things must be present or the scan is rejected with `400`:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Subject's full name. Trimmed and capped at 80 characters. Empty → `400`. |
| `email` | string | Subject's contact email — identity only, not login‑matched. Must be a valid address, else `400`. |
| a location | — | Either `latitude` + `longitude`, or `zipCode`. Neither → `400`. |

### Location: precise vs limited

Location is required, but you choose how precise it is:

| You send | Mode | Effect |
|---|---|---|
| `latitude` **and** `longitude` (both numbers) | precise | Highest‑resolution place/context signal. |
| `zipCode` (string) | limited | Coarser location context, used when `latitude`/`longitude` are absent. |

If you send both a lat/lon pair and a `zipCode`, the coordinates take precedence and the scan runs in precise mode. Numbers may be sent as JSON numbers or numeric strings; a lat/lon pair only counts as "present" when both values parse as finite numbers.

```json
{
  "name": "Sundar Pichai",
  "email": "subject@example.com",
  "latitude": 37.4221,
  "longitude": -122.0841
}
```

## Optional profile URLs

Every social URL is optional, and you can send any subset — none, one, or all four. Each one is scraped in parallel during the `POST`, and each contributes different signal.

| Field | What it adds |
|---|---|
| `linkedinUrl` | Professional signal (roles, employers, background) and preference signal. |
| `instagramUrl` | Best input for lifestyle. Photos are read into brands, colours, places, and eyewear. |
| `xUrl` | Public posts. Send as part of any subset. |
| `threadsUrl` | Public posts. Send as part of any subset. |
| `phone` | Footprint enrichment only — it does not scrape a profile. |

A confirmed LinkedIn profile is categorised as `Professional`; Instagram, X, and Threads are categorised as `Social`. If none of the four social URLs yields a usable profile, the scan still runs on the public web and produces a dossier — the preference layer just has less feed to work from.

### Which URLs to send

- **Lifestyle and preferences are the goal** → prioritise `instagramUrl`. The image pipeline turns photos into brands, colours, places, and eyewear, which is what drives the richest preference profile.
- **Professional context is the goal** → send `linkedinUrl`.
- **Maximise coverage** → send whatever public URLs you legitimately have. There is no penalty for sending all four; unavailable ones are reported and skipped.
- **You only have a phone number** → send `phone`. It adds footprint enrichment but is not a substitute for a profile URL.

```json
{
  "name": "Sundar Pichai",
  "email": "subject@example.com",
  "zipCode": "94040",
  "linkedinUrl":  "https://www.linkedin.com/in/sundarpichai/",
  "instagramUrl": "https://www.instagram.com/sundarpichai/",
  "xUrl":         "https://x.com/sundarpichai",
  "threadsUrl":   "https://www.threads.net/@sundarpichai"
}
```

## What happens when a URL is omitted, private, or fails

Scraping is fault‑tolerant: a profile that is not provided, cannot be reached, is private, or errors **never** stops the scan. Each URL you send is reported back under a `profiles` map in the response, keyed by platform (`linkedin`, `instagram`, `threads`, `x`), so you can see exactly what happened to each one.

| `profiles[platform]` value | Meaning |
|---|---|
| full profile object | Scraped successfully; this profile feeds the scan. |
| `null` | URL was not provided. |
| `{ "access": "<state>", "profileUrl": "…" }` | Reachable but gated — private / login required. Not used. |
| `{ "status": "too_thin", "profileUrl": "…" }` | Reachable but too little public data to be useful. Not used. |
| `{ "status": "failed", "error": "…" }` | The scrape errored. Not used. |

Only successfully scraped profiles are attached to the scan input; every other outcome is recorded in `profiles` and omitted. The deep‑research dossier runs regardless. See [Profile contracts](/docs/profile-contracts) for the full per‑platform shapes.

## Consent flags

Two optional booleans travel with identity and default to `true`. They are lenient: absent or `null` uses the default, and the strings `"false"`, `"0"`, `"no"` (any case) read as `false`.

| Field | Default | Effect |
|---|---|---|
| `consentAttestation` | `true` | By calling, the key holder attests they are authorized to audit this subject. Setting it `false` rejects the request with `403` and starts nothing. |
| `socialPreferenceConsent` | `true` | Gates the preference/lifestyle layer. Set it `false` for a dossier‑only scan. |

See [Consent & privacy](/docs/consent-privacy) for the full policy.

## A minimal request

The smallest valid body is just the required identity — no social URLs at all. It produces a dossier from the public web; the preference layer is skipped for lack of a feed.

```bash
curl -s https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "Sundar Pichai",
    "email": "subject@example.com",
    "zipCode": "94040"
  }'
```

Add `instagramUrl` for lifestyle signal, `linkedinUrl` for professional context, and `xUrl` / `threadsUrl` to broaden coverage — sending only what you actually have.

## Next

- [Start a scan](/docs/start-a-scan) — the full request/response contract.
- [Profile contracts](/docs/profile-contracts) — per‑platform scraped shapes.
- [Preferences](/docs/preferences) — the 6‑section preference profile + lifestyle facts.
