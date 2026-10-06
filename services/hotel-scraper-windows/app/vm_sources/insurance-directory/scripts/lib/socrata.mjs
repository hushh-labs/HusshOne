// Socrata open-data client — pages a public dataset's `.csv` export via SoQL
// $limit/$offset with a stable $order, retrying 429/5xx with exponential backoff.
// Used by the download adapters (e.g. data.texas.gov). No dependency, no auth
// required; an app token (optional) only lifts the anonymous throttling ceiling.

import { config } from "./config.mjs";
import { parseCsv } from "./csv.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SocrataRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "SocrataRateLimitError";
  }
}

// Build the CSV resource URL for one page.
export function buildResourceUrl({ domain, resourceId, limit, offset, order = ":id" }) {
  const url = new URL(`https://${domain}/resource/${resourceId}.csv`);
  url.searchParams.set("$limit", String(limit));
  url.searchParams.set("$offset", String(offset));
  if (order) url.searchParams.set("$order", order);
  return url.toString();
}

// Fetch one CSV page, throwing SocrataRateLimitError on 429/5xx (retryable).
async function fetchCsvPage(doFetch, url, appToken) {
  const headers = { Accept: "text/csv" };
  if (appToken) headers["X-App-Token"] = appToken;
  const res = await doFetch(url, { headers });
  if (res.status === 429 || res.status >= 500) {
    throw new SocrataRateLimitError(`Socrata HTTP ${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Socrata HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.text();
}

async function fetchWithBackoff(doFetch, url, appToken, maxBackoffMs, log) {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchCsvPage(doFetch, url, appToken);
    } catch (err) {
      if (!(err instanceof SocrataRateLimitError)) throw err;
      attempt++;
      if (attempt > 8) throw err;
      const backoff = Math.min(maxBackoffMs, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      log?.({ event: "socrata.backoff", url, attempt, backoffMs: backoff, reason: err.message });
      await sleep(backoff);
    }
  }
}

// Async-generate every row (as an object) from a Socrata dataset, paging until a
// short page is returned or `maxRecords` is reached. Deps (fetchImpl) are injected
// so the pagination logic is unit-testable without network.
export async function* streamResourceRows({
  domain,
  resourceId,
  order = ":id",
  pageSize = config.socrata.pageSize,
  appToken = config.socrata.appToken,
  maxRecords = config.socrata.maxRecords,
  maxBackoffMs = config.worker.maxBackoffMs,
  fetchImpl,
  log,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!domain || !resourceId) throw new Error("streamResourceRows requires { domain, resourceId }");
  let offset = 0;
  let emitted = 0;
  for (;;) {
    const limit = Math.min(pageSize, maxRecords - emitted);
    if (limit <= 0) break;
    const url = buildResourceUrl({ domain, resourceId, limit, offset, order });
    const text = await fetchWithBackoff(doFetch, url, appToken, maxBackoffMs, log);
    const rows = parseCsv(text);
    if (!rows.length) break;
    for (const row of rows) {
      yield row;
      emitted++;
      if (emitted >= maxRecords) break;
    }
    if (rows.length < limit) break; // last (short) page
    offset += rows.length;
  }
}
