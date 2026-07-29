// Adapter registry — one module per state DOI, keyed by 2-letter code.
//
// Every adapter is a plain object:
//   {
//     code: 'TX',                       // 2-letter state code (uppercase)
//     label: 'Texas Department of ...', // human description of the source
//     kind: 'download'|'api'|'search'|'blocked',
//     datasets: string[],              // citable source URLs (may be empty)
//     note?: string,                   // required for kind:'blocked' — why + unblock path
//     async *records({ log, fetchImpl }) { yield normalizedProducerRecord }
//   }
//
// To add a state: create scripts/lib/adapters/<code>.mjs exporting such an object,
// import it here, and add it to ALL. A `download` adapter wires a real open-data CSV
// (see tx.mjs); a `blocked` adapter yields nothing and explains what it would take
// to unblock (see wa.mjs). That is the entire extension surface.

import { TX } from "./tx.mjs";
import { WA } from "./wa.mjs";
import { CA } from "./ca.mjs";
import { FL } from "./fl.mjs";
import { NY } from "./ny.mjs";

export const ALL = [TX, WA, CA, FL, NY];

const BY_CODE = new Map(ALL.map((a) => [a.code, a]));

export function getAdapter(code) {
  return BY_CODE.get(String(code || "").trim().toUpperCase()) || null;
}

// Resolve the configured state codes to adapters. Unknown codes (no module yet) are
// returned in `missing` rather than throwing, so a typo in INSURANCE_STATES surfaces
// in logs instead of crashing the worker.
export function selectedAdapters(states) {
  const adapters = [];
  const missing = [];
  for (const code of states || []) {
    const a = getAdapter(code);
    if (a) adapters.push(a);
    else missing.push(String(code || "").trim().toUpperCase());
  }
  return { adapters, missing };
}
