/* Route-facing orchestration for Xtreme Compute Burst — analogous to
   src/lib/research/client.ts (startResearch / pollResearch). The API routes import
   ONLY this module, so tests can mock the whole burst layer at one seam. */
import { getBurstProvider, mockBurstEnabled } from "./provider-factory";
import type {
  BurstPollResult,
  BurstProviderId,
  ComputeBurstProvider,
  JobSpec,
  ProvisionResult,
  ResolvedGcpCreds,
} from "./types";

export interface StartedBurst {
  provider: ComputeBurstProvider;
  provision: ProvisionResult;
}

/** Provision (and, where applicable, submit) a burst job. Honors mock mode. */
export async function startBurst(
  spec: JobSpec,
  creds: ResolvedGcpCreds | null,
  providerId: BurstProviderId,
): Promise<StartedBurst> {
  const provider = getBurstProvider(providerId);
  // In mock mode the provider ignores creds; the real GCP provider requires them.
  const effectiveCreds = provider.id === "mock" ? null : creds;
  const provision = await provider.provision(spec, effectiveCreds);
  await provider.submit(spec, provision, effectiveCreds);
  return { provider, provision };
}

export async function pollBurst(
  provider: ComputeBurstProvider,
  provision: ProvisionResult,
  creds: ResolvedGcpCreds | null,
  opts?: { fast?: boolean },
): Promise<BurstPollResult> {
  const effectiveCreds = provider.id === "mock" ? null : creds;
  return provider.pollStatus(provision, effectiveCreds, opts);
}

/** Tear down the burst's resources. Best-effort: never throws (cost-control cleanup
    must run on completion, failure, and deadline without masking the original error). */
export async function teardownBurst(
  provider: ComputeBurstProvider,
  provision: ProvisionResult,
  creds: ResolvedGcpCreds | null,
): Promise<void> {
  const effectiveCreds = provider.id === "mock" ? null : creds;
  try {
    await provider.teardown(provision, effectiveCreds);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "one.burst.teardown_failed",
        severity: "ERROR",
        provider: provider.id,
        instanceName: provision.instanceName ?? null,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export { mockBurstEnabled };
