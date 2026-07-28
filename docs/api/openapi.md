# OpenAPI spec

A machine-readable OpenAPI 3.1 document describing every One Developer API endpoint, its request contract, and the SSE event schema.

`GET /api/v1/openapi.json` is public — no auth — and returns the full specification. Import it into Postman, Swagger UI, or a client-codegen tool to generate typed SDKs and request collections.

## Endpoint

```bash
curl https://one.hushh.ai/api/v1/openapi.json
```

No `Authorization` header is required to fetch the spec. The endpoints it documents are still gated by `Authorization: Bearer $ONE_API_KEY`.

Live document: https://one.hushh.ai/api/v1/openapi.json

## What it describes

The document declares `openapi: "3.1.0"`, an `info` block (title `One by hushh — Developer API`, version `1.0.0`), a single server (`https://one.hushh.ai`), a global `bearerAuth` HTTP bearer security scheme, and reusable component schemas (`Error`, `ScanRequest`, `ScanAccepted`, `Health`, `DirectoryRow`, `DirectoryResult`, `ScanResult`).

## Paths documented

| Path | Method | Summary |
| --- | --- | --- |
| `/api/v1/health` | `GET` | Service status (public, no auth) |
| `/api/v1/directory` | `GET` | Proximity directory search |
| `/api/v1/scan` | `POST` | Start a scan |
| `/api/v1/scan/{id}` | `GET` | Poll scan status, result, and preferences |
| `/api/v1/scan/{id}/stream` | `GET` | Live progress (Server-Sent Events) |
| `/api/v1/scan/{id}/preferences` | `GET` | Preference profile and lifestyle facts |

The `/api/v1/scan/{id}/stream` path documents the SSE contract (`text/event-stream`): the `start`, `progress`, `dossier`, `preferences`, and `ping` events, plus one terminal `done`, `error`, or `pending` event.

## Import into tooling

```bash
# Save locally, then import the file into your tool of choice
curl -o one-openapi.json https://one.hushh.ai/api/v1/openapi.json
```

Most tools also accept the URL directly:

- Swagger UI / Redoc: point the viewer at `https://one.hushh.ai/api/v1/openapi.json`.
- Postman: Import → Link → paste the URL.
- Codegen (openapi-generator, `openapi-typescript`, etc.): pass the URL or the saved file as the input schema.

## Related

- [API overview](/docs/api-overview) — the endpoints described here, in prose.
- [Start a scan](/docs/start-a-scan) and [Streaming](/docs/api-streaming) — the request and SSE contracts in detail.
- [Status codes](/docs/status-codes) and [Error handling](/docs/error-handling) — response codes referenced across the spec.
