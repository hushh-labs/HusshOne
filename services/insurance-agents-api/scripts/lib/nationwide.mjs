// Nationwide agency-locator client — the keyless `search-api` the locator itself calls.
//
// Contract confirmed live: GET .../search-api?q=<zip>&agencyName=&product= → HTTP 200 JSON
//   {
//     resultCount, resultsPerPage: 50, currentPage,
//     queryLocation: { city, state, zip, latitude, longitude, geolocated },
//     locations: [ { loc: {...agency...}, url, containedLocations } ],
//     ...
//   }
//
// Two operational realities encoded here:
//  1. It sits behind Akamai — a bare programmatic UA gets challenged, so we send a
//     browser-shaped User-Agent + Referer and pace ourselves. A challenge comes back as
//     NON-JSON (an HTML/JS interstitial), so a JSON parse failure is treated as a bot block,
//     not a generic error — surfaced distinctly so the caller/logs can tell them apart.
//  2. The input is a text `q` (ZIP or "City, ST"), geocoded server-side into queryLocation.

import { config } from "./config.mjs";

export class NationwideError extends Error {
  constructor(message, { retriable = false, botChallenge = false } = {}) {
    super(message);
    this.name = "NationwideError";
    this.retriable = retriable;
    this.botChallenge = botChallenge;
  }
}

function buildUrl({ q, page }) {
  const params = new URLSearchParams({ q, agencyName: "", product: "" });
  if (page && page > 1) params.set("page", String(page));
  return `${config.nationwide.searchApi}?${params.toString()}`;
}

async function getJson(url, context) {
  let lastError;
  for (let attempt = 0; attempt <= config.nationwide.retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(6000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": config.nationwide.userAgent,
          referer: config.nationwide.referer,
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "cors",
          "accept-language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(config.nationwide.timeoutMs),
      });
      if (response.status === 429 || response.status === 403 || response.status >= 500) {
        lastError = new NationwideError(`Nationwide HTTP ${response.status} (${context})`, {
          retriable: true,
          botChallenge: response.status === 403 || response.status === 429,
        });
        continue;
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        // A 200 that isn't JSON is an Akamai interstitial — retry, then fail as a bot block.
        lastError = new NationwideError(`Nationwide returned a non-JSON body (${context}) — likely a bot challenge`, {
          retriable: true,
          botChallenge: true,
        });
      }
    } catch (error) {
      if (error instanceof NationwideError && !error.retriable) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new NationwideError(`Nationwide request failed (${context})`);
}

/** One page. Returns { total, resultsPerPage, queryLocation, locations }. */
export async function searchPage({ q, page = 1 }) {
  const body = await getJson(buildUrl({ q, page }), `q=${q} page=${page}`);
  if (!body || !Array.isArray(body.locations)) {
    throw new NationwideError("Nationwide payload had no locations array");
  }
  return {
    total: Number(body.resultCount) || body.locations.length,
    resultsPerPage: Number(body.resultsPerPage) || config.nationwide.resultsPerPage,
    queryLocation: body.queryLocation || null,
    locations: body.locations,
  };
}

/** Bounded-concurrency map, order-preserving; failures → null. */
export async function pooled(items, worker, limit = config.nationwide.concurrency) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try {
          out[i] = await worker(items[i], i);
        } catch {
          out[i] = null;
        }
        if (config.nationwide.gapMs) await new Promise((r) => setTimeout(r, config.nationwide.gapMs));
      }
    }),
  );
  return out;
}
