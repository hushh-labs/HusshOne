# Error handling

Every One Developer API endpoint reports failures through a single, predictable envelope so you can branch on a machine code rather than parsing prose.

## The error envelope

All error responses share the same JSON shape and always carry the correct HTTP status:

```json
{
  "ok": false,
  "error": "consentAttestation must be true to run a scan.",
  "code": "consent_required"
}
```

| Field   | Type      | Notes                                                                 |
| ------- | --------- | -------------------------------------------------------------------- |
| `ok`    | `boolean` | Always `false` on an error.                                          |
| `error` | `string`  | Human-readable message. For display and logs — do not branch on it.  |
| `code`  | `string`  | Stable machine code. Branch on this.                                 |

Every response also includes permissive CORS headers, so browser clients see the body even on failure.

Branch on `code`, not `error`:

```js
const res = await fetch("https://one.hushh.ai/api/v1/scan", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.ONE_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const data = await res.json();
if (!data.ok) {
  switch (data.code) {
    case "unauthorized":     /* fix the key */ break;
    case "consent_required": /* fix the request */ break;
    case "scan_start_failed":/* transient — retry with backoff */ break;
    default:                 /* fix the request or report */ break;
  }
}
```

## The one exception: unknown scan (404)

A 404 from `GET /api/v1/scan/{id}` (and from the preferences endpoint) does **not** use the standard envelope. Instead of `code`/`error`, it returns a `status` of `"unknown"`:

```json
{
  "ok": false,
  "scanId": "abc123",
  "status": "unknown",
  "result": null
}
```

There is no `code` and no `error` field here. Detect this case by combining the HTTP status with the body:

```js
const res = await fetch(`https://one.hushh.ai/api/v1/scan/${id}`, {
  headers: { Authorization: `Bearer ${process.env.ONE_API_KEY}` },
});
const data = await res.json();
if (res.status === 404 && data.status === "unknown") {
  // The scan id was never created under this key, or is not visible to it.
}
```

Ownership is enforced per key: a key only sees scans it created, so a scan started with a different key reads back as `unknown` rather than as another key's data.

## Codes by endpoint

### `POST /api/v1/scan`

| HTTP | `code`              | Meaning                                                    | Retryable                     |
| ---- | ------------------- | ---------------------------------------------------------- | ----------------------------- |
| 401  | `unauthorized`      | Missing or invalid Bearer key.                             | No — fix the key.             |
| 400  | `bad_input`         | The request body failed validation.                       | No — fix the request.         |
| 403  | `consent_required`  | `consentAttestation` was explicitly `false`.              | No — fix the request.         |
| 502  | `scan_start_failed` | The scan could not be started (upstream/transient).        | Yes — retry with backoff.     |

Notes:

- Input validation (`400 bad_input`) is applied before the scan begins. The `error` message names what was rejected.
- `consentAttestation` defaults to `true`; you only see `403 consent_required` if you send it as `false`.
- `502 scan_start_failed` is the fallback for any non-input error while starting the scan. It is the one transient failure on this endpoint — retry with exponential backoff.

### `GET /api/v1/scan/{id}`

| HTTP | Shape / `code`                   | Meaning                                     | Retryable                 |
| ---- | -------------------------------- | ------------------------------------------- | ------------------------- |
| 401  | `unauthorized`                   | Missing or invalid Bearer key.              | No — fix the key.         |
| 400  | `invalid_input`                  | Missing scan id in the path.                | No — fix the request.     |
| 404  | `{ status: "unknown" }`          | Unknown scan for this key (see above).      | No.                       |
| 500  | `scan_read_failed`               | The scan could not be loaded.               | Yes — retry with backoff. |

On success this endpoint returns `ok:true` with `status` of `running`, `completed`, or `failed`. A `failed` scan is a successful `200` read — inspect `status` and the `error` field in the body, not the HTTP code. See [Polling](/docs/polling).

### `GET /api/v1/scan/{id}/stream`

Authentication and a missing-scan check happen **before** the stream opens, and are returned as normal JSON errors — not as SSE frames:

| HTTP | `code`          | Meaning                          |
| ---- | --------------- | -------------------------------- |
| 401  | `unauthorized`  | Missing or invalid Bearer key.   |
| 400  | `invalid_input` | Missing scan id in the path.     |
| 404  | `not_found`     | Scan not found for this key.     |

Once the connection opens it returns `200` and switches to Server-Sent Events. Errors that occur during the stream arrive as SSE frames, described next.

## Stream (SSE) errors

The stream multiplexes progress onto one connection and ends with exactly one terminal frame: `done`, `error`, or `pending`. Handle the last two.

### Terminal `error`

Carries the same `code`/`error` pair as the JSON envelope, delivered as an SSE frame:

```
event: error
data: {"code":"research_failed","error":"Research failed"}
```

Emitted `code` values on the stream:

| `code`            | Meaning                                                   |
| ----------------- | -------------------------------------------------------- |
| `research_failed` | The underlying research job reported `failed`.           |
| `stream_error`    | An unexpected error while running the stream.            |

After an `error` frame the stream closes; do not expect further frames.

### Terminal `pending`

Not an error — the stream self-closes before the Cloud Run wall while work is still running, so the connection never dies mid-scan. It carries a `reason` and a `message` instead of a `code`/`error`:

```
event: pending
data: {"reason":"deadline","scanId":"abc123","message":"Still working — re-attach this stream or poll GET /api/v1/scan/{id}."}
```

On `pending`, either re-attach to `GET /api/v1/scan/{id}/stream` or poll `GET /api/v1/scan/{id}` until the scan reaches a terminal state.

```js
es.addEventListener("pending", (e) => {
  const { reason } = JSON.parse(e.data); // "deadline"
  es.close();
  // Re-attach the stream, or fall back to polling.
});

es.addEventListener("error", (e) => {
  const { code, error } = JSON.parse(e.data);
  es.close();
  // Terminal failure — surface `error`, branch on `code`.
});
```

Long scans are the common reason you will see `pending`; see [Long-running scans](/docs/long-scans) for the deadline behaviour and re-attach pattern, and [Streaming with SSE](/docs/api-streaming) for the full frame catalogue.

## Retry guidance

| Situation                                   | Action                                                              |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `502 scan_start_failed`                     | Transient. Retry with exponential backoff.                         |
| `500 scan_read_failed`                      | Transient. Retry with backoff.                                     |
| `400 bad_input` / `400 invalid_input`       | Not retryable. Fix the request and resend.                         |
| `403 consent_required`                      | Not retryable. Set `consentAttestation` to `true`.                 |
| `401 unauthorized`                          | Not retryable. Check the `Authorization: Bearer $ONE_API_KEY` header. |
| `404` + `status:"unknown"` / `not_found`    | Not retryable. Verify the scan id and that it was created by this key. |
| Stream `pending`                            | Re-attach the stream or poll.                                      |
| Stream `error` (`research_failed`)          | Not retryable by re-streaming — start a new scan.                  |

## See also

- [HTTP status codes](/docs/status-codes) — the complete status reference.
- [Long-running scans](/docs/long-scans) — deadlines, `pending`, and re-attach.
- [Streaming with SSE](/docs/api-streaming) — every frame the stream emits.
- [Polling](/docs/polling) — reading scan state without a stream.
- [Authentication](/docs/authentication) — Bearer keys and per-key ownership.
