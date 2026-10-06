// OpenStreetMap lodging ingest via the Overpass API — the free, full-coverage
// backbone. One query per US state pulls every hotel/motel/resort, which we map to
// hotel records and upsert. Places later enriches these same rows (by dedup_key)
// with ratings/price/phone. Scope is hotels/motels/resorts only — hostels and
// guest houses are intentionally excluded.

import { config } from "./config.mjs";
import { mapOsmElementToHotel } from "./hotels.mjs";
import { upsertHotel, query } from "./db.mjs";

// ISO 3166-2 codes for the 50 states + DC + the five inhabited territories.
// Overpass selects each area by ISO3166-2, so this list drives the whole sweep.
export const US_STATE_CODES = [
  "US-AL", "US-AK", "US-AZ", "US-AR", "US-CA", "US-CO", "US-CT", "US-DE", "US-FL",
  "US-GA", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY", "US-LA",
  "US-ME", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT", "US-NE",
  "US-NV", "US-NH", "US-NJ", "US-NM", "US-NY", "US-NC", "US-ND", "US-OH", "US-OK",
  "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT", "US-VT",
  "US-VA", "US-WA", "US-WV", "US-WI", "US-WY", "US-DC",
  "US-PR", "US-VI", "US-GU", "US-MP", "US-AS",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kirkland's state first so OSM coverage, like the Places crawl, starts at home.
export function orderedStateCodes(startState = "US-WA") {
  const rest = US_STATE_CODES.filter((c) => c !== startState);
  return US_STATE_CODES.includes(startState) ? [startState, ...rest] : US_STATE_CODES.slice();
}

export function buildOverpassQuery(stateCode) {
  // `nwr` = node|way|relation; `out center tags` gives ways/relations a centroid.
  return `[out:json][timeout:${config.osm.timeoutSec}];
area["ISO3166-2"="${stateCode}"][admin_level~"4|3"]->.a;
(
  nwr["tourism"~"^(hotel|motel|resort)$"](area.a);
  nwr["building"="hotel"](area.a);
);
out center tags;`;
}

// Fetch one state's lodging elements, retrying Overpass overload (429/504) with
// exponential backoff. Returns the raw elements array.
export async function fetchStateLodging(stateCode, { maxAttempts = 6 } = {}) {
  const q = buildOverpassQuery(stateCode);
  let attempt = 0;
  for (;;) {
    attempt++;
    let res;
    try {
      res = await fetch(config.osm.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": config.osm.userAgent,
        },
        body: "data=" + encodeURIComponent(q),
      });
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      await backoff(stateCode, attempt, err.message);
      continue;
    }
    // Overpass signals overload with 429 or 504 — back off and retry.
    if (res.status === 429 || res.status === 504) {
      if (attempt >= maxAttempts) throw new Error(`Overpass ${res.status} for ${stateCode} (giving up)`);
      await backoff(stateCode, attempt, `HTTP ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Overpass HTTP ${res.status} for ${stateCode}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data.elements) ? data.elements : [];
  }
}

async function backoff(stateCode, attempt, reason) {
  const ms = Math.min(config.worker.maxBackoffMs, 5000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
  console.log(JSON.stringify({ event: "osm.backoff", stateCode, attempt, reason, backoffMs: ms }));
  await sleep(ms);
}

// Ingest one state: fetch → map → upsert. Marks that state's ZIPs osm_status='done'
// for progress visibility (OSM is state-scoped, not per-ZIP). Returns a summary.
export async function ingestState(stateCode) {
  const started = Date.now();
  const elements = await fetchStateLodging(stateCode);
  let upserted = 0;
  let inserted = 0;
  let skipped = 0;
  for (const el of elements) {
    const rec = mapOsmElementToHotel(el, null);
    if (!rec) {
      skipped++;
      continue;
    }
    const out = await upsertHotel(rec);
    if (out) {
      upserted++;
      if (out.inserted) inserted++;
    }
  }
  // stateCode is "US-XX"; zips.state stores the bare "XX".
  const bare = stateCode.replace(/^US-/, "");
  await query(`UPDATE zips SET osm_status = 'done', updated_at = now() WHERE state = $1`, [bare]);
  const summary = {
    event: "osm.state_done",
    stateCode,
    elements: elements.length,
    upserted,
    inserted,
    skipped,
    ms: Date.now() - started,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

// Sweep every state (Kirkland's first). `gapMs` spaces out queries to be a polite
// Overpass citizen. Continues past a failed state rather than aborting the sweep.
export async function ingestAllStates({ startState = "US-WA", gapMs = 3000, only = null } = {}) {
  const codes = only && only.length ? only : orderedStateCodes(startState);
  const results = [];
  for (const code of codes) {
    try {
      results.push(await ingestState(code));
    } catch (err) {
      console.log(JSON.stringify({ event: "osm.state_error", stateCode: code, message: err.message }));
      results.push({ stateCode: code, error: err.message });
    }
    await sleep(gapMs);
  }
  const totals = results.reduce(
    (acc, r) => {
      acc.upserted += r.upserted || 0;
      acc.inserted += r.inserted || 0;
      acc.errors += r.error ? 1 : 0;
      return acc;
    },
    { upserted: 0, inserted: 0, errors: 0 },
  );
  console.log(JSON.stringify({ event: "osm.sweep_done", states: results.length, ...totals }));
  return { results, totals };
}
