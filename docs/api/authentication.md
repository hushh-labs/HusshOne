# Authentication

The One Developer API authenticates every request with a bearer API key issued by hushh.

## API keys

Keys are provisioned by hushh out-of-band — there is no self-serve signup or key-generation endpoint. Once you have a key, keep it secret: it is a long-lived credential that acts on your behalf.

Every authenticated request sends the key in the `Authorization` header as a bearer token:

```bash
Authorization: Bearer $ONE_API_KEY
```

The header is required verbatim. A missing header, a header without the `bearer ` prefix, or an empty token is treated as unauthenticated.

## Public vs. key-gated endpoints

Two endpoints are public and require no key:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Service health probe. See [Health](/docs/health). |
| `GET` | `/api/v1/openapi.json` | The OpenAPI document. See [OpenAPI](/docs/openapi). |

Every other endpoint is key-gated. Requests without a valid bearer key are rejected with `401`. This includes `POST /api/v1/scan` and all of its sub-resources (`GET /api/v1/scan/{id}`, `GET /api/v1/scan/{id}/stream`, `GET /api/v1/scan/{id}/preferences`).

## Making an authenticated request

Base URL: `https://one.hushh.ai`

```bash
curl -X POST https://one.hushh.ai/api/v1/scan \
  -H "Authorization: Bearer $ONE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "zipCode": "94040"
  }'
```

A successful call to `POST /api/v1/scan` returns `202 Accepted`. From there, poll or stream the scan — see [Quickstart](/docs/quickstart).

## The 401 response

When a request is rejected for authentication, the API returns HTTP `401` with the standard JSON error envelope:

```json
{
  "ok": false,
  "error": "Invalid or missing API key",
  "code": "unauthorized"
}
```

The `error` field carries a human-readable message. Two other messages can appear with the same `401` / `unauthorized` shape:

| `error` message | Meaning |
| --- | --- |
| `Invalid or missing API key` | No bearer token was sent, or the token did not match any issued key. |
| `Developer API is not configured` | No keys are provisioned on the server; the API fails closed. |

See [Status codes](/docs/status-codes) for the full list and [Error handling](/docs/error-handling) for the envelope format.

## Per-key ownership

Each scan is owned by the key that created it. Scans are namespaced to a synthetic owner derived from your key, so keys are fully isolated from one another.

A key can only read scans it created. If you request a scan created by a different key, the API responds `404` (not `403`) — the scan is simply invisible to your key, so you cannot tell whether an unknown scan id belongs to another tenant or does not exist at all.

```bash
# Reading another key's scan id → 404, as if it did not exist
curl https://one.hushh.ai/api/v1/scan/<someone-elses-scan-id> \
  -H "Authorization: Bearer $ONE_API_KEY"
```

## CORS

Cross-origin requests are allowed from any origin:

| Header | Value |
| --- | --- |
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type` |

Preflight (`OPTIONS`) requests return `204 No Content`. Open CORS does not weaken auth: every non-public endpoint still requires a valid bearer key regardless of the calling origin. Because keys are secret credentials, do not embed them in browser-facing code — call the API from a server you control.

## Next steps

- [Quickstart](/docs/quickstart) — start your first scan end-to-end.
- [Status codes](/docs/status-codes) — every status the API returns.
- [Error handling](/docs/error-handling) — the error envelope in detail.
