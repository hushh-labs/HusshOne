// Per-ZIP enrichment: run a Places Text Search for one ZIP, map each result to a
// hotel record, and upsert (merging onto any OSM row via dedup_key). This is the
// unit of work the 24/7 worker repeats, ordered outward from Kirkland.

import { searchLodging } from "./places-client.mjs";
import { mapPlaceToHotel } from "./hotels.mjs";
import { upsertHotel, countHotelsForQueryZip } from "./db.mjs";

// Query text for a ZIP. Including city/state (when known) sharpens Places results
// vs. a bare 5-digit number, which Google sometimes reads as an area code.
export function buildQuery(zipRow) {
  const { zip, city, state } = zipRow;
  if (city && state) return `hotels in ${city}, ${state} ${zip}`;
  if (state) return `hotels in ${zip}, ${state}`;
  return `hotels in ${zip}`;
}

// Process one claimed ZIP row. Returns { placesCalls, hotelsFound, results,
// inserted } — the worker passes placesCalls/hotelsFound to markZipDone.
export async function processZip(zipRow, deps = {}) {
  const search = deps.searchLodging || searchLodging;
  const upsert = deps.upsertHotel || upsertHotel;
  const countForZip = deps.countHotelsForQueryZip || countHotelsForQueryZip;

  const zip = zipRow.zip;
  const query = buildQuery(zipRow);
  const { places, calls } = await search(query);

  let inserted = 0;
  let mapped = 0;
  for (const place of places) {
    const rec = mapPlaceToHotel(place, zip);
    if (!rec) continue;
    mapped++;
    const out = await upsert(rec);
    if (out?.inserted) inserted++;
  }

  // Total hotels now attributed to this ZIP (includes OSM rows we just enriched).
  const hotelsFound = await countForZip(zip);
  return { placesCalls: calls, results: places.length, mapped, inserted, hotelsFound };
}
