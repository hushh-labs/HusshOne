# Build and Validation Report

Validation date: 2026-08-12

## Source validation

```text
Python                           3.13.13
pytest                           44 passed
compileall                       passed
targeted Ruff gate               passed
uv lock consistency              passed
workflow YAML parsing            passed
```

The targeted Ruff gate is the same source surface enforced by
`.github/workflows/nws-nearby-ci.yml`: the public API, coverage resolver, settings, security,
bootstrap data, and their API/security tests. The wider reference implementation has pre-existing
lint debt outside the deployed public-path surface; it is not silently represented as a clean full
repository lint.

## Verified release contract

- `47.6715, -122.2133` is coarsened to `47.67, -122.21`, is `COVERED`, and returns the 11
  reviewed Kirkland public-association records.
- Legacy `{"postal_code":"98033"}` and explicit `{"postal_code":"98033","country_code":"US"}`
  are compatible.
- A valid India coordinate returns `200`, `NOT_COVERED`, and no results.
- `{"postal_code":"110001","country_code":"IN"}` returns `200`,
  `LOCATION_UNRESOLVED`, and no results until canonical postal geography is loaded.
- Missing API key returns `401`; `GET /health`, `GET /ready`, and wildcard non-cookie CORS behavior
  remain covered by tests.

## Scope truthfulness

The deployed public route is a finite `VERIFIED_PUBLIC_BOOTSTRAP` release, not a nationwide or
global people directory. It contains 11 reviewed public-association records and marks scores as
provisional. Internal reference modules, synthetic demo data, PostGIS schema, collectors, and
future graph architecture remain source material only; they are not exposed by the deployed route
and do not constitute a live national data plane.

Production deployment proof is recorded from the GitHub workflow and Cloud Run revision after a
source SHA reaches HusshOne `main`; this local report is not a substitute for that proof.
