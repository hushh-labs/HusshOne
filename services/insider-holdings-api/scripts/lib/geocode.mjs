/**
 * Street-level coordinates from the US Census batch geocoder.
 *
 * Free, and genuinely keyless — the "Request a Key" button on the Census *developers*
 * page belongs to the Census Data API, not the geocoder. Census states its own limit in
 * the error it returns when you exceed it: "There is no limit as to how many batch
 * geocoding requests you can submit, however each request must be limited to 10,000
 * records."
 *
 * Why this matters: today every issuer sits at its postcode's centroid, so all 183
 * people at ZIP 10017 land on one dot. Measured against the real index, street-level
 * coordinates move the median issuer 1.79 km, and 68.5% of issuers by more than 1 km.
 *
 * IMPORTANT: this geocodes ISSUER business addresses only. It is never given a person's
 * address, because this service never reads one.
 */

const ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";

/** Census enforces this; submitting 10,500 returns HTTP 400. */
export const MAX_BATCH = 10000;

/**
 * Benchmarks are tried in order. `Current` is the primary; `Census2020` is a genuinely
 * different vintage that recovered 58 addresses Current missed on the real index, so
 * the retry is worth its (free) cost rather than being redundant.
 */
export const BENCHMARKS = Object.freeze(["Public_AR_Current", "Public_AR_Census2020"]);

const SPELLED_NUMBERS = Object.freeze({
  ONE: "1", TWO: "2", THREE: "3", FOUR: "4", FIVE: "5",
  SIX: "6", SEVEN: "7", EIGHT: "8", NINE: "9", TEN: "10",
});

/**
 * An alternate spelling of a street line, or null when there is nothing to try.
 *
 * TIGER stores house numbers as digits, so "ONE APPLE PARK WAY" misses while
 * "1 APPLE PARK WAY" matches. But a leading number-word is not reliably a house number:
 * "Seven Hills Road" is a place name, and rewriting it to "7 Hills Road" breaks a match
 * that already worked.
 *
 * There is no rule that separates the two — "Four Times Square" is a real house number
 * and "Five Points Road" is not. So this does not decide. It offers a variant, and
 * `geocodeAll` sends it only for addresses the literal form failed to match, which
 * turns an unanswerable guess into a free second attempt.
 */
export function streetVariant(street) {
  const raw = String(street || "").trim();
  if (!raw) return null;

  const [first, ...rest] = raw.split(/\s+/);
  const digit = SPELLED_NUMBERS[first.toUpperCase()];
  if (!digit || rest.length === 0) return null;

  const variant = [digit, ...rest].join(" ");
  return variant === raw ? null : variant;
}

/** Census wants headerless CSV: id, street, city, state, zip. */
export function toCsv(rows) {
  const escape = (value) => {
    const text = String(value ?? "").replace(/"/g, "");
    return /[,]/.test(text) ? `"${text}"` : text;
  };
  return rows
    .map((row) => [row.id, escape(row.street), escape(row.city), escape(row.state), escape(row.zip)].join(","))
    .join("\n");
}

/**
 * Parse the geocoder's CSV reply.
 *
 * Matched rows carry coordinates as "lng,lat" — longitude FIRST, which is the reverse
 * of every other coordinate in this service and the easiest thing in the file to get
 * backwards. Swapping them silently relocates every company to the wrong hemisphere.
 */
export function parseResponse(text) {
  const results = new Map();

  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;

    const cells = line.match(/("([^"]*)"|[^,]+)/g);
    if (!cells || cells.length < 3) continue;

    const clean = cells.map((cell) => cell.replace(/^"|"$/g, "").trim());
    const [id, , status] = clean;
    if (status !== "Match") continue;

    const coordinates = clean[5];
    if (!coordinates || !coordinates.includes(",")) continue;

    const [lng, lat] = coordinates.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    results.set(id, { lat, lng, matchedAddress: clean[4] || null });
  }

  return results;
}

/** Geocode one batch against one benchmark. Returns an empty map on any failure. */
export async function geocodeBatch(rows, benchmark, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  if (rows.length === 0) return new Map();
  if (rows.length > MAX_BATCH) throw new Error(`Batch of ${rows.length} exceeds the ${MAX_BATCH} limit`);

  const form = new FormData();
  form.append("addressFile", new Blob([toCsv(rows)], { type: "text/csv" }), "addresses.csv");
  form.append("benchmark", benchmark);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(ENDPOINT, { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) return new Map();
    return parseResponse(await response.text());
  } catch {
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode every address, retrying misses on the next benchmark.
 *
 * Returns only what matched. The caller keeps its existing ZIP centroid for the rest —
 * a straight replacement would LOSE coverage, since centroids place ~3,708 issuers and
 * street-level places ~3,217. Cascade, never swap.
 */
export async function geocodeAll(rows, { onProgress = () => {}, ...options } = {}) {
  const matched = new Map();

  const pass = async (candidates, benchmark, label) => {
    const misses = [];
    for (let offset = 0; offset < candidates.length; offset += MAX_BATCH) {
      const slice = candidates.slice(offset, offset + MAX_BATCH);
      const found = await geocodeBatch(slice, benchmark, options);
      for (const [id, point] of found) matched.set(id, { ...point, benchmark });
      for (const row of slice) if (!matched.has(String(row.id))) misses.push(row);
      onProgress({ benchmark: label, done: matched.size, total: rows.length });
    }
    return misses;
  };

  // Pass 1-2: the address exactly as filed, against each benchmark vintage.
  let pending = rows;
  for (const benchmark of BENCHMARKS) {
    if (pending.length === 0) break;
    pending = await pass(pending, benchmark, benchmark);
  }

  // Pass 3: only for what is still unmatched, retry with a spelled house number
  // rewritten as a digit. Confined to failures, so it can add matches but never
  // replace a good one.
  const variants = pending
    .map((row) => ({ row, street: streetVariant(row.street) }))
    .filter(({ street }) => street)
    .map(({ row, street }) => ({ ...row, street }));

  if (variants.length > 0) await pass(variants, BENCHMARKS[0], "spelled-number retry");

  return matched;
}
