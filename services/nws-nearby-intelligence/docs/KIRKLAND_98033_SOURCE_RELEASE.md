# Kirkland 98033 reviewed public-association release

## Release identity

| Field | Value |
| --- | --- |
| Release id | `us-wa-kirkland-public-association-2026-08-13` |
| Market | `us-wa-kirkland-public-association` / US `98033` |
| Data mode | `REVIEWED_PUBLIC_ASSOCIATION_RELEASE` |
| Review date | 2026-08-13 |
| Source retrieval date | 2026-08-13 |
| Model version | `nws-v2.3.0-kirkland.2026-08-13` |
| Candidate count | 60 |
| Score status | `PROVISIONAL` |
| Query route | `POST /v2/nearby-network/discover` |

The executable manifest is
[`data/markets/us-wa-kirkland/2026-08-13/release.json`](../data/markets/us-wa-kirkland/2026-08-13/release.json).
The API returns a SHA-256 for the candidate set, source registry, and whole manifest under
`release`, so a client or reviewer can identify the exact release used for a response.

## What the 60 records mean

Every record is a reviewed public-professional association with a public organization, civic
office, campus, or Chamber board office. It is not a claim that the person lives at, works from,
or is currently present at the public venue. The API never returns a private address, exact person
coordinate, raw device coordinate, personal contact data, or financial net-worth claim.

| Source grouping | Records | Primary official source family |
| --- | ---: | --- |
| Individual reviewed organization records | 7 | Employer or institution pages |
| City of Kirkland leaders and councilmembers | 9 | City of Kirkland |
| Lake Washington Institute of Technology executive cabinet | 10 | LWTech |
| Northwest University cabinet and academic leaders | 11 | Northwest University |
| GenCap Construction leadership | 8 | GenCap Construction |
| Compass Construction leadership | 6 | Compass Construction |
| Kirkland Chamber Executive Board | 9 | Kirkland Chamber of Commerce |
| **Total** | **60** | |

The current sources are official pages for the [City Council](https://www.kirklandwa.gov/Government/City-Council),
[LWTech Executive Staff](https://www.lwtech.edu/about-us/executive-staff/index.aspx),
[Northwest University Cabinet](https://www.northwestu.edu/president/cabinet),
[GenCap leadership](https://gencapgc.com/people/),
[Compass leadership](https://www.compass-gc.com/about/leadership/), and the
[Kirkland Chamber board](https://www.kirklandchamber.org/the-board-of-directors).
Each person’s exact citations and the fact types they support are in the API response and manifest.

## Evidence and scoring disclosure

`score_status` remains `PROVISIONAL`. The present release uses a conservative role-taxonomy proxy
and reviewed public facts; it is not a completed regional graph, a financial score, or proof of a
person’s current location. The score breakdown shows its components, evidence count, coverage
multiplier, integrity penalty, and local relevance.

The loader treats evidence facts and source families separately:

- A record must have identity, current-role, organization-identity, and public-association facts.
- A record needs at least four reviewed facts to be publishable.
- Multiple URLs on one domain count as one source family, trigger a concentration warning, and set
  `revalidation_required: true`; they are not presented as independent corroboration.
- `ROLE_REFRESH_REQUIRED` is carried for Yun Zhang’s historical CEO wording. His current release
  claim is limited to the public co-founder/office association until a newer first-party role
  source is reviewed.

## Safe use by product teams

Call through each product’s server-side BFF using `X-NWS-API-Key`; CORS is intentionally open for
non-cookie requests, but an API key placed in browser JavaScript or a mobile bundle is public.

For a consented device location, send a latitude/longitude pair and optional country context. The
service coarsens it before coverage lookup. For manual location, send `postal_code` with
`country_code`; legacy `{"postal_code":"98033"}` remains US-compatible.

Only `COVERED` currently returns people. Valid locations outside this approved market return a
normal `200` with `NOT_COVERED` or `LOCATION_UNRESOLVED`, an empty `results` list, and no
Kirkland fallback. Never display the results as people physically around the user.

This release must not be used to make decisions about employment, housing, credit, insurance,
healthcare, legal status, public benefits, or law enforcement.

## Refresh and expansion procedure

1. Use only a source allowed by `docs/SCRAPER_CATALOG.md` and its source contract. Official public
   organization, government, university, healthcare, and nonprofit pages are preferred.
2. Do not add personal social profiles, home/residence data, check-ins, authenticated/private
   pages, CAPTCHA-bypassed content, or unlicensed data. A VM does not make a source permitted.
3. Add or update citations, fact types, a public venue association, review flags, and the source
   release date in `release.json`. Do not hand-edit a score or a per-person strength value.
4. Run `uv run --extra dev python -m pytest -q`, Ruff, and compilation in the service directory.
5. Review the manifest hashes and the `98033` response; verify every returned record is public-safe.
6. Merge to `main`. The path-scoped NWS workflow builds and deploys only this standalone Cloud Run
   service, then checks `/health` and `/ready`.

For a new country, postal area, or coordinate market, add approved country-qualified geography and
a separately reviewed market release first. Do not map a valid global coordinate to this Kirkland
dataset just because it passes input validation.
