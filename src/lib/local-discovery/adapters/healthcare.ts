/* Healthcare adapter (deliverable #3): NPPES registry seed (US only) + live Google Places (New) enrichment
   for clinics/hospitals/doctors.

   Country-awareness is the whole point here. NPPES is a US-only registry, so the *registry seed* is gated to
   US searches — a search in India must NEVER be seeded with US provider records. Live Places coverage, by
   contrast, is global, so the category itself stays `supportedCountries: "all"` and a non-US search still
   returns live results (with a warning that the authoritative registry seed was unavailable for that
   country). This is exactly the "US registries never used for India" requirement. */

import type { CountryCode, DiscoverySearchContext, LocalDiscoveryAdapter } from "../types";
import { runAdapter } from "./shared";

/** Google Places (New, Table A) health types. Nearby search returns the nearest of any listed type; a
 *  free-text specialty (ctx.filters.query, e.g. "pediatric") switches Places to Text Search automatically. */
const HEALTHCARE_PLACE_TYPES = ["doctor", "hospital"];

function isUS(country: CountryCode | undefined): boolean {
  return (country ?? "").toUpperCase() === "US";
}

export const healthcareAdapter: LocalDiscoveryAdapter = {
  category: "healthcare",
  // Live Places coverage is global; the NPPES registry seed is US-only and gated inside search().
  supportedCountries: "all",
  search: (ctx: DiscoverySearchContext) => {
    const us = isUS(ctx.countryCode);
    return runAdapter(ctx, {
      category: "healthcare",
      // NPPES is a US registry — never seed it for a non-US search.
      seedVertical: us ? "healthcare" : null,
      placeTypes: HEALTHCARE_PLACE_TYPES,
      extraWarnings: us
        ? []
        : [
            `registry seed skipped: NPPES covers the US only (country=${
              ctx.countryCode || "unknown"
            }); returning live results only`,
          ],
    });
  },
};
