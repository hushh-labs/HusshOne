/* RIA adapter: SEC IAPD / Form ADV registry seed (US only) + live Google Places (New) enrichment for
   investment-advisory offices.

   Two things make this adapter different from hotels/healthcare, and both are deliberate:

   1. NO PLACE TYPE EXISTS. Google Places (New) Table A has no investment-adviser / financial-planner /
      wealth-manager type — its whole Finance category is `accounting`, `atm`, `bank`, none of which
      describe an RIA (an accountant is not an adviser, and passing a Table B type to `includedTypes` is a
      hard 400 from searchNearby). So this category enriches through TEXT SEARCH with a baseline query
      instead of Nearby Search. That is why `placeTypes` is empty and `textQuery` is set.

   2. FIRMS, NOT PEOPLE. The `ria` vertical seeds from the SEC `firms` table only. The Form ADV individual
      feed exists, but advisers in it almost never carry a mappable business address (`geog` is NULL), so
      they cannot answer a proximity query at all. "Advisers near you" is therefore honestly "adviser FIRMS
      near you" — the normalizer and the UI label both say firms.

   Country-awareness mirrors healthcare: "Registered Investment Adviser" is a US SEC registration, so the
   registry seed is gated to US searches and a non-US search is told plainly that what it is getting is
   unverified local advisory businesses from Places, not SEC-registered RIAs. */

import type { CountryCode, DiscoverySearchContext, LocalDiscoveryAdapter } from "../types";
import { runAdapter } from "./shared";

/** Baseline Places text query. Kept close to the registry's own language so the live results and the
 *  seeded SEC rows describe the same kind of business (and therefore dedupe against each other). */
const RIA_TEXT_QUERY = "registered investment adviser financial advisor firm";

function isUS(country: CountryCode | undefined): boolean {
  return (country ?? "").toUpperCase() === "US";
}

export const riaAdapter: LocalDiscoveryAdapter = {
  category: "ria",
  // Places text search has global coverage; the SEC registry seed is US-only and gated inside search().
  supportedCountries: "all",
  search: (ctx: DiscoverySearchContext) => {
    const us = isUS(ctx.countryCode);
    return runAdapter(ctx, {
      category: "ria",
      // SEC IAPD is a US registry — never seed it for a non-US search.
      seedVertical: us ? "ria" : null,
      placeTypes: [], // see (1) above — no Table A type describes an RIA
      textQuery: RIA_TEXT_QUERY,
      extraWarnings: us
        ? []
        : [
            `registry seed skipped: "registered investment adviser" is a US SEC registration (country=${
              ctx.countryCode || "unknown"
            }); these are local advisory businesses from Google Places, not SEC-registered RIAs`,
          ],
      seedEmptyWarning:
        "no SEC-registered adviser firms in this radius — Form ADV geo-tags firms to their main-office ZIP, so branch offices may not appear",
    });
  },
};
