/* Mock compute-burst provider.
   Simulates the provision → run → complete lifecycle with timed fake progress so the
   whole burst flow (placement → API stream → recovery → teardown) runs end-to-end
   locally and in tests without any GCP creds. Enabled by ONE_ENABLE_MOCK_BURST=true
   (see provider-factory), mirroring the ONE_ENABLE_MOCK_RESEARCH convention. */
import type { BurstPollResult, ComputeBurstProvider, JobSpec, ProvisionResult } from "../types";

// How long the simulated job "runs" before completing (kept short for snappy dev/tests).
// Read at call-time so an env override set after module load still applies.
function mockDurationMs() {
  return Number.parseInt(process.env.ONE_BURST_MOCK_DURATION_MS || "", 10) || 1_200;
}
const PROVISION_FRACTION = 0.35; // first third of the run reads as "provisioning"

interface MockJob {
  startedAt: number;
  durationMs: number;
  fail: boolean;
}

const jobs = new Map<string, MockJob>();

export const mockBurstProvider: ComputeBurstProvider = {
  id: "mock",

  async provision(spec: JobSpec): Promise<ProvisionResult> {
    const providerJobId = crypto.randomUUID();
    jobs.set(providerJobId, {
      startedAt: Date.now(),
      durationMs: mockDurationMs(),
      // A "fail://" image lets tests exercise the failure + teardown path deterministically.
      fail: spec.image.startsWith("fail://"),
    });
    return { providerJobId, instanceName: `mock-${providerJobId.slice(0, 8)}`, zone: spec.zone || "mock-zone-a" };
  },

  async submit() {
    /* no-op: the mock "runs" on a timer from provision */
  },

  async pollStatus(prov): Promise<BurstPollResult> {
    const job = jobs.get(prov.providerJobId);
    if (!job) {
      return { status: "failed", progress: null, result: null, exitCode: null, error: "Unknown mock burst job" };
    }
    const elapsed = Date.now() - job.startedAt;
    if (elapsed < job.durationMs * PROVISION_FRACTION) {
      return { status: "provisioning", progress: "Provisioning burst instance…", result: null, exitCode: null, error: null };
    }
    if (elapsed < job.durationMs) {
      const pct = Math.min(99, Math.round((elapsed / job.durationMs) * 100));
      return { status: "running", progress: `Running workload… ${pct}%`, result: null, exitCode: null, error: null };
    }
    if (job.fail) {
      return { status: "failed", progress: null, result: null, exitCode: 1, error: "Mock workload failed" };
    }
    return {
      status: "completed",
      progress: "Workload finished.",
      result: { mock: true, message: "Mock burst completed", durationMs: job.durationMs },
      exitCode: 0,
      error: null,
    };
  },

  async teardown(prov): Promise<void> {
    jobs.delete(prov.providerJobId);
  },
};
