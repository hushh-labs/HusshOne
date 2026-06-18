/* GCP compute-burst provider (the real path).
   Provisions a Compute Engine instance with an attached GPU, runs the workload
   container via a startup-script, reads the result back from the instance's guest
   attributes, and tears the instance down to control cost. Mirrors the retry/backoff/
   timeout/error conventions of src/lib/research/client.ts.

   GPU is fully implemented. TPU is a documented contract: TPUs are NOT Compute Engine
   guestAccelerators — they require the separate Cloud TPU API — so the TPU branch
   throws 501 here and is simulated only in the mock provider. */
import { mintAccessToken } from "../credentials";
import type {
  BurstPollResult,
  ComputeBurstProvider,
  JobSpec,
  ProvisionResult,
  ResolvedGcpCreds,
} from "../types";

const COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const GUEST_ATTR_NAMESPACE = "hushh-burst";

function defaultMachineType() {
  return (process.env.ONE_BURST_DEFAULT_MACHINE_TYPE || "n1-standard-8").trim();
}
function defaultGpuType() {
  return (process.env.ONE_BURST_DEFAULT_GPU_TYPE || "nvidia-tesla-t4").trim();
}
function teardownEnabled() {
  return process.env.ONE_BURST_TEARDOWN !== "false";
}
function timeoutMs() {
  const value = Number.parseInt(process.env.ONE_BURST_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 5_000), 120_000) : 60_000;
}
function statusTimeoutMs() {
  const value = Number.parseInt(process.env.ONE_BURST_STATUS_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 4_000), 60_000) : 25_000;
}
function retryCount() {
  const value = Number.parseInt(process.env.ONE_BURST_RETRIES || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 4) : 2;
}
function retryDelayMs(attempt: number, status: number | null) {
  const base = 450;
  const quotaMultiplier = status === 429 ? 2 : 1;
  return base * quotaMultiplier * attempt + Math.floor(Math.random() * 125);
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  if ("upstreamStatus" in error && typeof error.upstreamStatus === "number") return error.upstreamStatus;
  return null;
}
function shouldRetry(error: unknown) {
  const status = errorStatus(error);
  return status !== null && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function zoneFor(spec: JobSpec, creds: ResolvedGcpCreds): string {
  return spec.zone?.trim() || `${spec.region?.trim() || creds.region}-a`;
}

/** Bash startup-script: enable guest attributes, run the workload container, then
    publish status/exitCode/result back via the metadata server and shut down. This
    runs remotely on the burst VM — it is real, reviewable code, not a stub. */
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

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function callGcp<T>(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  opts?: { fast?: boolean },
): Promise<T> {
  const attempts = opts?.fast ? 1 : retryCount() + 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts?.fast ? statusTimeoutMs() : timeoutMs());
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const payload = (await response.json().catch(() => ({}))) as T & {
        error?: { message?: string };
      };
      if (!response.ok) {
        const message =
          (payload as { error?: { message?: string } })?.error?.message ||
          `GCP Compute API error (${response.status})`;
        throw Object.assign(new Error(message), { statusCode: 502, upstreamStatus: response.status });
      }
      return payload;
    } catch (error) {
      lastError = error;
      const isAbort = error instanceof Error && error.name === "AbortError";
      const retryable = isAbort || shouldRetry(error);
      if (!retryable || attempt >= attempts) throw error;
      await sleep(retryDelayMs(attempt, errorStatus(error)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export const gcpBurstProvider: ComputeBurstProvider = {
  id: "gcp",

  async provision(spec, creds): Promise<ProvisionResult> {
    if (!creds) throw Object.assign(new Error("GCP credentials are required to burst"), { statusCode: 503 });
    if (spec.acceleratorKind === "tpu") {
      // Documented contract: TPU bursting uses the Cloud TPU API (tpu.nodes /
      // queued resources), a different resource lifecycle than Compute Engine.
      throw Object.assign(
        new Error("TPU burst uses the Cloud TPU API and is not implemented in v1 (GPU is). Use mock mode to simulate."),
        { statusCode: 501 },
      );
    }

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
        {
          acceleratorType: `zones/${zone}/acceleratorTypes/${gpuType}`,
          acceleratorCount: spec.acceleratorCount,
        },
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
          // enable-guest-attributes lets the startup-script publish results back to us.
          { key: "enable-guest-attributes", value: "TRUE" },
          { key: "startup-script", value: buildStartupScript(spec) },
        ],
      },
      labels: { "hussh-burst": "1", "hussh-job": jobId.slice(0, 30) },
      tags: { items: ["hussh-burst"] },
    };

    const url = `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances`;
    const op = await callGcp<{ name?: string }>(token, "POST", url, body);
    return { providerJobId: jobId, instanceName, zone, raw: op };
  },

  // The startup-script auto-runs the workload on boot, so submit is a no-op. Kept for
  // interface symmetry (and a future Cloud Batch swap, which separates submit).
  async submit() {
    /* no-op */
  },

  async pollStatus(prov, creds, opts): Promise<BurstPollResult> {
    if (!creds) throw Object.assign(new Error("GCP credentials are required to poll"), { statusCode: 503 });
    const token = await mintAccessToken(creds);
    const zone = prov.zone || creds.region;
    const base = `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances/${prov.instanceName}`;

    // Read the workload markers the startup-script wrote to guest attributes.
    let attrs: { queryValue?: { items?: Array<{ key?: string; value?: string }> } } = {};
    try {
      attrs = await callGcp(token, "GET", `${base}/getGuestAttributes?queryPath=${GUEST_ATTR_NAMESPACE}/`, undefined, opts);
    } catch (error) {
      // Guest attributes don't exist until the script first writes them — that's a
      // 404 early in the run, which just means "still provisioning", not a failure.
      if (errorStatus(error) === 404) return { status: "provisioning", progress: "Provisioning burst instance…", result: null, exitCode: null, error: null };
      throw error;
    }

    const items = attrs.queryValue?.items ?? [];
    const get = (key: string) => items.find((i) => i.key === key)?.value;
    const marker = get("status");
    const exitCodeRaw = get("exitCode");
    const exitCode = exitCodeRaw !== undefined ? Number.parseInt(exitCodeRaw, 10) : null;
    const result = get("result") ?? null;

    if (marker === "completed") {
      return { status: "completed", progress: "Workload finished.", result, exitCode, error: null };
    }
    if (marker === "failed") {
      return {
        status: "failed",
        progress: null,
        result,
        exitCode,
        error: `Workload exited with code ${exitCode ?? "unknown"}`,
      };
    }
    if (marker === "running") {
      return { status: "running", progress: "Running workload on the burst instance…", result: null, exitCode: null, error: null };
    }
    return { status: "provisioning", progress: "Provisioning burst instance…", result: null, exitCode: null, error: null };
  },

  async teardown(prov, creds): Promise<void> {
    if (!creds || !prov.instanceName || !teardownEnabled()) return;
    const token = await mintAccessToken(creds);
    const zone = prov.zone || creds.region;
    const url = `${COMPUTE_BASE}/projects/${creds.projectId}/zones/${zone}/instances/${prov.instanceName}`;
    try {
      await callGcp(token, "DELETE", url);
    } catch (error) {
      // Already gone (404) is success — teardown is idempotent and safe on failure paths.
      if (errorStatus(error) === 404) return;
      throw error;
    }
  },
};
