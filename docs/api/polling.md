# Polling

Poll a scan by id to check its status and read the result once it finishes.

After you [start a scan](/docs/start-a-scan), the work runs asynchronously. Poll `GET /api/v1/scan/{id}` every ~10 seconds until `status` is `completed` or `failed`, then read the `result` and `preferences` from the same response.

## Request

```
GET /api/v1/scan/{id}
```

Base URL: `https://one.hushh.ai`

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer $ONE_API_KEY` |

A key only sees scans it created; requesting an id created by another key returns `404`.

```bash
curl https://one.hushh.ai/api/v1/scan/SCAN_ID \
  -H "Authorization: Bearer $ONE_API_KEY"
```

## Response

```json
{
  "ok": true,
  "scanId": "SCAN_ID",
  "status": "completed",
  "profiles": {
    "linkedin": null,
    "instagram": null,
    "threads": null,
    "x": null
  },
  "result": { },
  "preferences": {
    "status": "completed",
    "profile": { }
  }
}
```

| Field | Type | Description |
| --- | --- | --- |
| `ok` | boolean | `true` only when the scan has `completed`; `false` while `running` and on failure. |
| `scanId` | string | The scan id you requested. |
| `status` | string | Scan status. One of `running`, `completed`, `failed`, `unknown`. |
| `profiles` | object | The per-platform contracts echoed from the scan input, keyed by `linkedin`, `instagram`, `threads`, `x`. Each key is `null` when no input was supplied for that platform. |
| `result` | object \| null | One's dossier (`OneDashboardResult`). `null` until the scan completes. |
| `preferences` | object | The subject's preference/lifestyle profile — see [Preferences](/docs/preferences). Contains `status` and `profile`. |
| `error` | string | Present only when the scan failed; describes what went wrong. |

The `preferences` block is read per-subject and starts as a fast-pass profile that upgrades as the async pipeline finishes. If it cannot be read, it degrades to `{ "status": "skipped", "profile": null }` rather than failing the request. For the full profile shape and section list, use the dedicated preferences endpoint documented in [Preferences](/docs/preferences).

### Status values

| `status` | Meaning |
| --- | --- |
| `running` | The scan is still in progress. Keep polling. |
| `completed` | The scan finished. `result` is populated. |
| `failed` | The scan stopped with an error. See the `error` field. |
| `unknown` | The scan id was not found under this key (returned with a `404`). |

### Not found

A missing or foreign scan id returns HTTP `404` with a minimal body — note there is no `code` or `error` field:

```json
{
  "ok": false,
  "scanId": "SCAN_ID",
  "status": "unknown",
  "result": null
}
```

Other error responses (`401` unauthorized, `400` invalid input, `500` server error) carry a `code` and `error` field. See [Status codes](/docs/status-codes).

## Poll loop

```js
const BASE = "https://one.hushh.ai";

async function pollScan(scanId, apiKey, { intervalMs = 10_000 } = {}) {
  while (true) {
    const res = await fetch(`${BASE}/api/v1/scan/${scanId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json();

    if (res.status === 404) {
      throw new Error(`scan ${scanId} not found`);
    }
    if (body.status === "completed") {
      return body; // body.result and body.preferences are ready
    }
    if (body.status === "failed") {
      throw new Error(body.error ?? "scan failed");
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

## Poll or stream?

Polling is the simplest way to wait for a result: one request, repeated on an interval. Use it when you only need the final `result` and don't care about intermediate progress.

If you want live progress events as the scan runs, use Server-Sent Events instead — see [Streaming](/docs/api-streaming). Streaming holds one connection open and pushes updates, which avoids repeated requests for long-running scans. Either way, the terminal states are the same: `completed` or `failed`.

## Related

- [Start a scan](/docs/start-a-scan)
- [Streaming](/docs/api-streaming)
- [Preferences](/docs/preferences)
- [Status codes](/docs/status-codes)
