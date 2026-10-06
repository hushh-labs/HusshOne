// Texas — WORKING `download` adapter.
//
// The Texas Department of Insurance (TDI) publishes its full licensee data as
// public open datasets on data.texas.gov (Socrata), downloadable as CSV/JSON with
// no key and no CAPTCHA:
//   - kxv3-diwf  "Insurance agents, adjusters, and people approved to manage
//                 insurance-related products or claims"  (~960k individual licenses)
//                 https://data.texas.gov/d/kxv3-diwf
//   - 3yqc-fcdt  "Insurance agencies and businesses approved to manage
//                 insurance-related products"            (agencies)
//                 https://data.texas.gov/d/3yqc-fcdt
//
// We stream both via SoQL $limit/$offset paging and yield normalized producer
// records. One row = one license (a person with multiple licenses appears multiple
// times); upsertProducer merges those onto one row per (source_state, license_no),
// unioning license_types / lines_of_authority.

import { streamResourceRows } from "../socrata.mjs";
import { mapTxIndividualRow, mapTxAgencyRow } from "../producers.mjs";

const DOMAIN = "data.texas.gov";
const INDIVIDUALS = "kxv3-diwf";
const AGENCIES = "3yqc-fcdt";

export const TX = {
  code: "TX",
  label: "Texas Department of Insurance (data.texas.gov open data)",
  kind: "download",
  datasets: [
    `https://${DOMAIN}/d/${INDIVIDUALS}`,
    `https://${DOMAIN}/d/${AGENCIES}`,
  ],

  async *records({ log, fetchImpl } = {}) {
    const now = new Date();
    // Individuals (agents + adjusters).
    for await (const row of streamResourceRows({ domain: DOMAIN, resourceId: INDIVIDUALS, fetchImpl, log })) {
      const rec = mapTxIndividualRow(row, now);
      if (rec) yield rec;
    }
    // Agencies / businesses.
    for await (const row of streamResourceRows({ domain: DOMAIN, resourceId: AGENCIES, fetchImpl, log })) {
      const rec = mapTxAgencyRow(row, now);
      if (rec) yield rec;
    }
  },
};

export default TX;
