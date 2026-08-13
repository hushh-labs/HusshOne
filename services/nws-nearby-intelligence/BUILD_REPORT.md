# Build and Validation Report

Validation date: 2026-08-14

## Source validation

```text
Python                           3.13.13
NWS pytest                       118 passed
Insider Holdings Node tests      176 passed
CI-scoped Ruff gate               passed
targeted mypy (8 source files)    passed
uv lock consistency               passed
workflow YAML parsing             passed
```

The targeted Ruff gate is the same source surface enforced by
`.github/workflows/nws-nearby-ci.yml`: the public API, coverage resolver, settings, security,
bootstrap data, and their API/security tests. The wider reference implementation has pre-existing
lint debt outside the deployed public-path surface; it is not silently represented as a clean full
repository lint.

## Verified release contract

- The packaged 2025 Census geography resolves 33,791 five-digit ZCTAs, including `60637` at
  `41.782504, -87.602734`; ZIP+4 input uses its five-digit prefix.
- `60637` exercises the national hybrid request path and can return 60 public-professional
  associations from the governed CMS NPPES and SEC Section 16 sources. This is an acceptance
  example, not a promise that every ZIP has 60 eligible records.
- `47.6715, -122.2133` remains in the curated Kirkland market and returns its 60 reviewed
  public-association records.
- Legacy `{"postal_code":"98033"}` and explicit `{"postal_code":"98033","country_code":"US"}`
  are compatible.
- A coordinate inside the Census US boundary routes to the national index. A valid India
  coordinate returns `200`, `NOT_COVERED`, and no results.
- `{"postal_code":"110001","country_code":"IN"}` returns `200`,
  `LOCATION_UNRESOLVED`, and no results until canonical postal geography is loaded.
- Missing API key returns `401`; `GET /health`, `GET /ready`, and wildcard non-cookie CORS behavior
  remain covered by tests.

## Scope truthfulness

The release is a US public-professional association index, not a live-person tracker or global
people directory. National results come from public practice postal areas and issuer business
offices; they are not residences or claims of physical presence. Scores are provisional and use no
holdings value, compensation, AUM, property, phone, email, or street-address data. The curated
Kirkland release remains a preferred reviewed source inside its market. Sparse areas may return
fewer than the requested result count.

Production deployment proof is recorded from the GitHub workflow and Cloud Run revision after a
source SHA reaches HusshOne `main`; this local report is not a substitute for that proof.
