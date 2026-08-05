/* Insurance adapter: state Department-of-Insurance producer-licence seed (US only) + live Google Places
   (New) enrichment for insurance agencies.

   Unlike the RIA adapter, Places DOES describe this category: `insurance_agency` is a real Table A type
   (Services), so this one uses the cheaper, proximity-ranked Nearby Search path.

   The honesty problem here is COVERAGE, not typing. There is no free national producer file — the
   authoritative cross-state source (NIPR's Producer Database) is paid — so the registry is built
   state-by-state from whichever DOIs publish a free bulk export. Today that is a small number of states.
   A search in an uncovered state therefore gets zero seed rows even though thousands of licensed agents
   are really there, which without a note reads as "there are none". `seedEmptyWarning` says so out loud.

   That warning is driven by the query returning nothing — NOT by a hardcoded list of covered states, which
   would go stale the moment a DOI is unblocked in services/insurance-directory. */

import type { CountryCode, DiscoverySearchContext, LocalDiscoveryAdapter } from "../types";
import { runAdapter } from "./shared";

/** Google Places (New) Table A, Services category. Verified against the published type list — a type that
 *  is not in Table A is rejected by places:searchNearby with HTTP 400 INVALID_ARGUMENT. */
const INSURANCE_PLACE_TYPES = ["insurance_agency"];

function isUS(country: CountryCode | undefined): boolean {
  return (country ?? "").toUpperCase() === "US";
}

export const insuranceAdapter: LocalDiscoveryAdapter = {
  category: "insurance",
  // Places has insurance agencies worldwide; the DOI licence seed is US-only and gated inside search().
  supportedCountries: "all",
  search: (ctx: DiscoverySearchContext) => {
    const us = isUS(ctx.countryCode);
    return runAdapter(ctx, {
      category: "insurance",
      // State DOI licensee files are US-only — never seed them for a non-US search.
      seedVertical: us ? "insurance" : null,
      placeTypes: INSURANCE_PLACE_TYPES,
      extraWarnings: us
        ? []
        : [
            `registry seed skipped: producer licences come from US state insurance departments (country=${
              ctx.countryCode || "unknown"
            }); returning live results only`,
          ],
      seedEmptyWarning:
        "no licensed producers on file for this area — our licence registry is built state-by-state from free DOI bulk exports and does not yet cover every state, so this is a coverage gap rather than an empty market",
    });
  },
};
