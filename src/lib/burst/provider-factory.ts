/* Selects the active compute-burst provider.
   ONE_ENABLE_MOCK_BURST=true forces the mock provider everywhere (local dev / tests /
   demos with no GCP creds). Otherwise the requested provider id is honored. */
import { gcpBurstProvider } from "./providers/gcp";
import { mockBurstProvider } from "./providers/mock";
import type { BurstProviderId, ComputeBurstProvider } from "./types";

export function mockBurstEnabled(): boolean {
  return process.env.ONE_ENABLE_MOCK_BURST === "true";
}

export function getBurstProvider(providerId: BurstProviderId): ComputeBurstProvider {
  if (mockBurstEnabled() || providerId === "mock") return mockBurstProvider;
  if (providerId === "gcp") return gcpBurstProvider;
  throw Object.assign(new Error(`Unknown burst provider: ${providerId}`), { statusCode: 400 });
}
