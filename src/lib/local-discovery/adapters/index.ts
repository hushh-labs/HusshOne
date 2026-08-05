/* Adapter registry (deliverable #3): category → adapter, plus country-aware selection so a category that
   cannot serve a country is skipped rather than returning misleading data.

   Note: every adapter advertises `supportedCountries: "all"` because Google Places gives global live
   coverage; the US-only *registry seeds* (NPPES, SEC IAPD, state DOI) are gated INSIDE the healthcare, ria
   and insurance adapters, not at this selection layer. `supportsCountry` still exists as the general
   primitive so a future registry-bound adapter can restrict itself with an explicit allow-list. */

import type { CountryCode, DiscoveryCategory, LocalDiscoveryAdapter } from "../types";
import { hotelsAdapter } from "./hotels";
import { healthcareAdapter } from "./healthcare";
import { riaAdapter } from "./ria";
import { insuranceAdapter } from "./insurance";

export { runAdapter } from "./shared";
export type { AdapterConfig } from "./shared";

export const ADAPTERS: Record<DiscoveryCategory, LocalDiscoveryAdapter> = {
  hotels: hotelsAdapter,
  healthcare: healthcareAdapter,
  ria: riaAdapter,
  insurance: insuranceAdapter,
};

export function adapterFor(category: DiscoveryCategory): LocalDiscoveryAdapter {
  return ADAPTERS[category];
}

/** Whether an adapter can serve the given country ("all" → always; otherwise a case-insensitive allow-list). */
export function supportsCountry(adapter: LocalDiscoveryAdapter, country: CountryCode | undefined): boolean {
  if (adapter.supportedCountries === "all") return true;
  const c = (country ?? "").toUpperCase();
  return adapter.supportedCountries.some((cc) => cc.toUpperCase() === c);
}

/** The adapters that can serve `categories` in `country`, preserving the requested order and dropping any
 *  unknown category or one whose adapter doesn't cover the country. */
export function adaptersForCountry(
  categories: readonly DiscoveryCategory[],
  country: CountryCode | undefined,
): LocalDiscoveryAdapter[] {
  return categories
    .map((c) => ADAPTERS[c])
    .filter((a): a is LocalDiscoveryAdapter => Boolean(a) && supportsCountry(a, country));
}
