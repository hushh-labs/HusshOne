// Google Places API (New) — Text Search client for lodging enrichment.
// One searchText call returns rich fields (rating, price, phone, website) for up
// to 20 results; nextPageToken pages up to ~60 per query. We bill at Enterprise
// tier (the field mask includes rating/price), so no separate Place Details call.

import { config, assertPlacesKey } from "./config.mjs";

// Requesting only what we store keeps the response small and the billing tier
// predictable. `nextPageToken` must be top-level (not under `places.`).
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
  // Photo *references* ride along free: places.photos is Pro-tier, below the
  // Enterprise tier this mask already bills at (rating/priceLevel/userRatingCount).
  // These names are only an early "has photos" signal — the resolver re-derives
  // fresh names via Place Details at resolve time (ToS: names are not cacheable).
  "places.photos",
  "nextPageToken",
].join(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
}

// One page. Throws RateLimitError on 429/RESOURCE_EXHAUSTED so the caller can
// back off; throws a plain Error on other non-2xx.
async function searchTextPage(textQuery, pageToken) {
  assertPlacesKey();
  const body = {
    textQuery,
    pageSize: config.places.pageSize,
    regionCode: "US",
    includedType: "lodging",
    languageCode: "en",
  };
  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(config.places.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": config.places.apiKey,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    throw new RateLimitError("Places 429 rate limited");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (/RESOURCE_EXHAUSTED/i.test(text)) throw new RateLimitError("Places RESOURCE_EXHAUSTED");
    throw new Error(`Places HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Full Text Search for a query with pagination + 429 backoff. Returns
// { places: [...raw Place], calls } — `calls` is the number of billed requests
// (for the cost estimate). Google needs a short delay before a pageToken is valid.
export async function searchLodging(
  textQuery,
  { maxPages = config.places.maxPages, maxBackoffMs = config.worker.maxBackoffMs, pageTokenDelayMs = 2000 } = {},
) {
  const places = [];
  let pageToken = null;
  let calls = 0;

  for (let page = 0; page < maxPages; page++) {
    let attempt = 0;
    // Retry only rate-limit errors; surface everything else.
    for (;;) {
      try {
        const data = await searchTextPage(textQuery, pageToken);
        calls++;
        if (Array.isArray(data.places)) places.push(...data.places);
        pageToken = data.nextPageToken || null;
        break;
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err;
        attempt++;
        const backoff = Math.min(maxBackoffMs, 1000 * 2 ** attempt);
        const jitter = Math.floor(Math.random() * 500);
        console.log(
          JSON.stringify({ event: "places.backoff", textQuery, attempt, backoffMs: backoff + jitter }),
        );
        await sleep(backoff + jitter);
      }
    }
    if (!pageToken) break;
    // Google needs a short delay before a freshly issued pageToken is valid.
    if (pageTokenDelayMs > 0) await sleep(pageTokenDelayMs);
  }

  return { places, calls };
}

// -- Photos ------------------------------------------------------------------
// Two calls make up a resolved photo:
//   getPlacePhotos()  — Place Details, field mask "photos". Returns the current
//                       photo objects {name,widthPx,heightPx,authorAttributions}.
//                       Billed at Place Details IDs-Only tier = FREE/unlimited.
//   resolvePhotoUri() — Place Photo media with skipHttpRedirect=true, returns the
//                       actual image link {name, photoUri}. This is the PAID part
//                       ($7 / 1000 successful fetches).
// Per ToS §3.2.3(b) photo resource names are NOT cacheable and can expire, so we
// always fetch names fresh here rather than trusting stored refs.

// GET https://places.googleapis.com/v1/places/{placeId}  (fieldMask: photos)
// Retries rate-limit responses with capped exponential backoff, then throws a
// RateLimitError once maxAttempts is reached so a single stuck row can't wedge the
// worker forever during sustained quota exhaustion.
export async function getPlacePhotos(
  placeId,
  { maxBackoffMs = config.worker.maxBackoffMs, maxAttempts = config.photos.maxAttempts } = {},
) {
  assertPlacesKey();
  if (!placeId) return [];
  const url = `${config.places.detailsEndpoint}/${encodeURIComponent(placeId)}`;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": config.places.apiKey,
        "X-Goog-FieldMask": "photos",
      },
    });
    // Quota can surface as 429, or as 403/other with a RESOURCE_EXHAUSTED body.
    let rateLimited = res.status === 429;
    let bodyText = "";
    if (!rateLimited && !res.ok) {
      bodyText = await res.text().catch(() => "");
      rateLimited = /RESOURCE_EXHAUSTED/i.test(bodyText) || (res.status === 403 && /quota/i.test(bodyText));
    }
    if (rateLimited) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw new RateLimitError(`Place Details rate-limited after ${attempt} attempts (placeId=${placeId})`);
      }
      const wait = Math.min(maxBackoffMs, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.log(JSON.stringify({ event: "places.photos.backoff", placeId, attempt, waitMs: wait }));
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      // 404/NOT_FOUND means the place_id has drifted or is stale — surface it.
      throw new Error(`Place Details HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    const data = await res.json();
    return Array.isArray(data.photos) ? data.photos : [];
  }
}

// GET https://places.googleapis.com/v1/{name}/media?maxWidthPx=..&skipHttpRedirect=true
// `name` is the photo resource name "places/{pid}/photos/{ref}". Returns the
// resolved image URL string, or null if the media call fails softly.
export async function resolvePhotoUri(
  name,
  {
    maxWidthPx = config.photos.maxWidthPx,
    maxBackoffMs = config.worker.maxBackoffMs,
    maxAttempts = config.photos.maxAttempts,
  } = {},
) {
  assertPlacesKey();
  if (!name) return null;
  // maxWidthPx must be 1..4800 per the Place Photo docs.
  const w = Math.max(1, Math.min(4800, Math.round(maxWidthPx) || 1200));
  const url =
    `${config.places.detailsEndpoint.replace(/\/places$/, "")}/${name}/media` +
    `?maxWidthPx=${w}&skipHttpRedirect=true`;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Goog-Api-Key": config.places.apiKey },
    });
    let rateLimited = res.status === 429;
    let bodyText = "";
    if (!rateLimited && !res.ok) {
      bodyText = await res.text().catch(() => "");
      rateLimited = /RESOURCE_EXHAUSTED/i.test(bodyText) || (res.status === 403 && /quota/i.test(bodyText));
    }
    if (rateLimited) {
      attempt++;
      if (attempt >= maxAttempts) {
        throw new RateLimitError(`Place Photo rate-limited after ${attempt} attempts`);
      }
      const wait = Math.min(maxBackoffMs, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
      console.log(JSON.stringify({ event: "places.media.backoff", attempt, waitMs: wait }));
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Place Photo HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.photoUri || null;
  }
}
