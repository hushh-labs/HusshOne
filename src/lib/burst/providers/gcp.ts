/* GCP compute-burst provider (the real path), dispatching by accelerator family:
   - GPU → Compute Engine instance with guestAccelerators + a startup-script; result via
     the instance's guest attributes; torn down with instances.delete.
   - TPU → Cloud TPU API node (see gcp-tpu.ts); result via a GCS object; node deleted.
   Both speak REST over native fetch with shared retry/backoff/timeout (gcp-common.ts).
   Teardown is idempotent (404 = already gone) and safe on failure paths. */
import {
  COMPUTE_BASE,
  GUEST_ATTR_NAMESPACE,
  callGcp,
  defaultGpuType,
  defaultMachineType,
  errorStatus,
  mintAccessToken,
  shellQuote,
  teardownEnabled,
  zoneFor,
} from "./gcp-common";
import { provisionTpu, pollTpu, teardownTpu } from "./gcp-tpu";
import type { BurstPollResult, ComputeBurstProvider, JobSpec, ProvisionResult, ResolvedGcpCreds } from "../types";

/** Bash startup-script for a GPU instance: enable guest attributes, run the workload
    container, publish status/exitCode/result via the metadata server, then shut down. */
export function buildStartupScript(spec: JobSpec): string {
  const md = "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes";
  const envFlags = Object.entries(spec.env ?? {})
    .map(([k, v]) => `-e ${shellQuote(k)}=${shellQuote(v)}`)
    .join(" ");
  const cmd = (spec.command ?? []).map(shellQuote).join(" ");
  return `#!/bin/bash
set -uo pipefail
put() { curl -s -X PUT --data "$2" "${md}/${GUEST_ATTR_NAMESPACE}/$1" -H "Metadata-Flavor: Google"; }
put status running
OUT=$(docker run --rm ${envFlags} ${shellQuote(spec.image)} ${cmd} 2>&1)
CODE=$?
put result "$(printf '%s' "$OUT" | tail -c 8000)"
put exitCode "$CODE"
if [ "$CODE" -eq 0 ]; then put status completed; else put status failed; fi
shutdown -h now
`;
}

async function provisionGpu(spec: JobSpec, creds: ResolvedGcpCreds): Promise<ProvisionResult> {
  const token = await mintAccessToken(creds);
  const zone = zoneFor(spec, creds);
  const machineType = spec.machineType?.trim() || defaultMachineType();
  const gpuType = defaultGpuType();
  const jobId = crypto.randomUUID();
  const instanceName = `hussh-burst-${jobId.slice(0, 18)}`;

  const body = {
    name: instanceName,
    machineType: `zones/${zone}/machineTypes/${machineType}`,
    guestAccelerators: [
      { acceleratorType: `zones/${zone}/acceleratorTypes/${gpuType}`, acceleratorCount: spec.acceleratorCount },
    ],
    // GPUs cannot live-migrate — the VM MUST terminate on host maintenance.
    scheduling: { onHostMaintenance: "TERMINATE", automaticRestart: false },
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
          diskSizeGb: Math.max(spec.estimate.diskGb, 30),
        },
      },
    ],
    networkInterfaces: [{ accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }] }],
    metadata: {
      items: [
        { key: "enable-guest-attributes", value: "TRUE" },
        { key: "startup-script", value: buildStartupScript(spec) },
      ],
    },
    labels: { "hussh-burst": "1", "hussh-job": jobId.slice(0, 30) },
    tags: { items: ["hussh-burst"] },
  };

  const url = `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances`;
  const op = await callGcp<{ name?: string }>(token, "POST", url, body);
  return { providerJobId: jobId, instanceName, zone, kind: "gpu", raw: op };
}

async function pollGpu(
  prov: ProvisionResult,
  creds: ResolvedGcpCreds,
  opts?: { fast?: boolean },
): Promise<BurstPollResult> {
  const token = await mintAccessToken(creds);
  const zone = prov.zone || creds.region;
  const base = `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances/${prov.instanceName}`;

  let attrs: { queryValue?: { items?: Array<{ key?: string; value?: string }> } } = {};
  try {
    attrs = await callGcp(token, "GET", `${base}/getGuestAttributes?queryPath=${GUEST_ATTR_NAMESPACE}/`, undefined, opts);
  } catch (error) {
    // Guest attributes don't exist until the script first writes them — a 404 early in
    // the run just means "still provisioning", not a failure.
    if (errorStatus(error) === 404) {
      return { status: "provisioning", progress: "Provisioning burst instance…", result: null, exitCode: null, error: null };
    }
    throw error;
  }

  const items = attrs.queryValue?.items ?? [];
  const get = (key: string) => items.find((i) => i.key === key)?.value;
  const marker = get("status");
  const exitCodeRaw = get("exitCode");
  const exitCode = exitCodeRaw !== undefined ? Number.parseInt(exitCodeRaw, 10) : null;
  const result = get("result") ?? null;

  if (marker === "completed") return { status: "completed", progress: "Workload finished.", result, exitCode, error: null };
  if (marker === "failed") {
    return { status: "failed", progress: null, result, exitCode, error: `Workload exited with code ${exitCode ?? "unknown"}` };
  }
  if (marker === "running") {
    return { status: "running", progress: "Running workload on the burst instance…", result: null, exitCode: null, error: null };
  }
  return { status: "provisioning", progress: "Provisioning burst instance…", result: null, exitCode: null, error: null };
}

async function teardownGpu(prov: ProvisionResult, creds: ResolvedGcpCreds): Promise<void> {
  if (!prov.instanceName || !teardownEnabled()) return;
  const token = await mintAccessToken(creds);
  const zone = prov.zone || creds.region;
  try {
    await callGcp(token, "DELETE", `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances/${prov.instanceName}`);
  } catch (error) {
    if (errorStatus(error) === 404) return; // already gone — idempotent
    throw error;
  }
}

// Dispatch helper: a job is TPU when provision said so (prov.kind) or, for recovery
// where prov is reconstructed, when the kind is supplied. Defaults to GPU.
function isTpu(prov: ProvisionResult): boolean {
  return prov.kind === "tpu";
}

export const gcpBurstProvider: ComputeBurstProvider = {
  id: "gcp",

  async provision(spec, creds): Promise<ProvisionResult> {
    if (!creds) throw Object.assign(new Error("GCP credentials are required to burst"), { statusCode: 503 });
    return spec.acceleratorKind === "tpu" ? provisionTpu(spec, creds) : provisionGpu(spec, creds);
  },

  // The startup-script auto-runs the workload on boot, so submit is a no-op. Kept for
  // interface symmetry (and a future Cloud Batch swap, which separates submit).
  async submit() {
    /* no-op */
  },

  async pollStatus(prov, creds, opts): Promise<BurstPollResult> {
    if (!creds) throw Object.assign(new Error("GCP credentials are required to poll"), { statusCode: 503 });
    return isTpu(prov) ? pollTpu(prov, creds, opts) : pollGpu(prov, creds, opts);
  },

  async teardown(prov, creds): Promise<void> {
    if (!creds) return;
    return isTpu(prov) ? teardownTpu(prov, creds) : teardownGpu(prov, creds);
  },
};
