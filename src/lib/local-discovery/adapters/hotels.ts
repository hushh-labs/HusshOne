/* Hotels adapter (deliverable #3): our rooftop-precise PostGIS `hotels` seed (crawler-sourced from Google
   Places / OSM) + live Google Places (New) `lodging` enrichment for freshness and coverage.

   Coverage is global — Google Places has worldwide lodging, so `supportedCountries: "all"`. The stored seed
   is US-heavy today, but that only means non-US searches lean on live enrichment; it never disqualifies the
   category for a country. */

import type { LocalDiscoveryAdapter } from "../types";
import { runAdapter } from "./shared";

export const hotelsAdapter: LocalDiscoveryAdapter = {
  category: "hotels",
  supportedCountries: "all",
  search: (ctx) =>
    runAdapter(ctx, {
      category: "hotels",
      seedVertical: "hotels",
      placeTypes: ["lodging"],
    }),
};
