/* TPU burst path (the real Cloud TPU API v2 path).
   TPUs are NOT Compute Engine guestAccelerators — they are a distinct resource with
   their own lifecycle. This module provisions a Cloud TPU node, runs the workload via
   the node's startup-script, returns the result through a GCS object the node writes,
   and deletes the node. Result channel is GCS because TPU nodes (unlike GCE instances)
   don't expose a guest-attributes read API to the control plane.

   Config: set ONE_BURST_TPU_RESULT_BUCKET to a bucket the TPU node's service account can
   write to and the control plane can read. Absent → provision throws a clear 503. */
import {
  STORAGE_BASE,
  STORAGE_UPLOAD_BASE,
  TPU_BASE,
  callGcp,
  defaultTpuRuntime,
  defaultTpuType,
  errorStatus,
  mintAccessToken,
  shellQuote,
  teardownEnabled,
  tpuResultBucket,
  zoneFor,
} from "./gcp-common";
import type { BurstPollResult, JobSpec, ProvisionResult, ResolvedGcpCreds } from "../types";

const OBJECT_PREFIX = "hushh-burst";

function objectName(jobId: string, leaf: string): string {
  return `${OBJECT_PREFIX}/${jobId}/${leaf}`;
}

/** Startup-script for the TPU node: mint a metadata token, run the workload container,
    and upload status/exitCode/result to GCS so the control plane can read the outcome. */
export function buildTpuStartupScript(spec: JobSpec, bucket: string, jobId: string): string {
  const md = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
  const envFlags = Object.entries(spec.env ?? {})
    .map(([k, v]) => `-e ${shellQuote(k)}=${shellQuote(v)}`)
    .join(" ");
  const cmd = (spec.command ?? []).map(shellQuote).join(" ");
  const up = `${STORAGE_UPLOAD_BASE}/b/${bucket}/o`;
  return `#!/bin/bash
set -uo pipefail
TOKEN=$(curl -s -H "Metadata-Flavor: Google" "${md}" | sed -n 's/.*"access_token":"\\([^"]*\\)".*/\\1/p')
put() { curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" \
  --data-binary "$2" "${up}?uploadType=media&name=${OBJECT_PREFIX}/${jobId}/$1" >/dev/null; }
put status running
OUT=$(docker run --rm ${envFlags} ${shellQuote(spec.image)} ${cmd} 2>&1)
CODE=$?
put result "$(printf '%s' "$OUT" | tail -c 8000)"
put exitCode "$CODE"
if [ "$CODE" -eq 0 ]; then put status completed; else put status failed; fi
`;
}

export async function provisionTpu(spec: JobSpec, creds: ResolvedGcpCreds): Promise<ProvisionResult> {
  const bucket = tpuResultBucket();
  if (!bucket) {
    throw Object.assign(
      new Error("TPU burst requires ONE_BURST_TPU_RESULT_BUCKET (a GCS bucket for the node's result)."),
      { statusCode: 503 },
    );
  }
  const token = await mintAccessToken(creds);
  const zone = zoneFor(spec, creds);
  const jobId = crypto.randomUUID();
  const nodeId = `hushh-burst-${jobId.slice(0, 18)}`;
  const acceleratorType = spec.machineType?.trim() || defaultTpuType();

  const body = {
    acceleratorType,
    runtimeVersion: defaultTpuRuntime(),
    metadata: { "startup-script": buildTpuStartupScript(spec, bucket, jobId) },
    labels: { "hushh-burst": "1" },
  };
  const url = `${TPU_BASE}/projects/${creds.projectId}/locations/${zone}/nodes?nodeId=${nodeId}`;
  const op = await callGcp<{ name?: string }>(token, "POST", url, body);
  return { providerJobId: jobId, instanceName: nodeId, zone, kind: "tpu", raw: op };
}

async function readObject(token: string, bucket: string, name: string, fast?: boolean): Promise<string | null> {
  const url = `${STORAGE_BASE}/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`;
  try {
    const res = await callGcp<Response>(token, "GET", url, undefined, { fast, raw: true });
    return (await res.text()).trim();
  } catch (error) {
    if (errorStatus(error) === 404) return null; // not written yet
    throw error;
  }
}

export async function pollTpu(
  prov: ProvisionResult,
  creds: ResolvedGcpCreds,
  opts?: { fast?: boolean },
): Promise<BurstPollResult> {
  const token = await mintAccessToken(creds);
  const bucket = tpuResultBucket();
  const zone = prov.zone || creds.region;

  // The GCS status object is the source of truth for the workload's terminal state.
  const status = bucket ? await readObject(token, bucket, objectName(prov.providerJobId, "status"), opts?.fast) : null;

  if (status === "completed" || status === "failed") {
    const exitRaw = await readObject(token, bucket, objectName(prov.providerJobId, "exitCode"), opts?.fast);
    const result = await readObject(token, bucket, objectName(prov.providerJobId, "result"), opts?.fast);
    const exitCode = exitRaw !== null ? Number.parseInt(exitRaw, 10) : null;
    return status === "completed"
      ? { status: "completed", progress: "TPU workload finished.", result, exitCode, error: null }
      : { status: "failed", progress: null, result, exitCode, error: `TPU workload exited with code ${exitCode ?? "unknown"}` };
  }
  if (status === "running") {
    return { status: "running", progress: "Running workload on the TPU…", result: null, exitCode: null, error: null };
  }

  // No status object yet → distinguish "still creating the node" from "node up, booting".
  const node = await callGcp<{ state?: string }>(
    token,
    "GET",
    `${TPU_BASE}/projects/${creds.projectId}/locations/${zone}/nodes/${prov.instanceName}`,
    undefined,
    opts,
  );
  if (node.state && node.state !== "READY" && node.state !== "CREATING") {
    // STOPPED / DELETING / PREEMPTED / TERMINATED before any result → failed.
    if (["STOPPED", "DELETING", "PREEMPTED", "TERMINATED"].includes(node.state)) {
      return { status: "failed", progress: null, result: null, exitCode: null, error: `TPU node entered ${node.state}` };
    }
  }
  return { status: "provisioning", progress: "Provisioning TPU node…", result: null, exitCode: null, error: null };
}

export async function teardownTpu(prov: ProvisionResult, creds: ResolvedGcpCreds): Promise<void> {
  if (!prov.instanceName || !teardownEnabled()) return;
  const token = await mintAccessToken(creds);
  const zone = prov.zone || creds.region;
  // Delete the node (the cost driver). 404 = already gone.
  try {
    await callGcp(token, "DELETE", `${TPU_BASE}/projects/${creds.projectId}/locations/${zone}/nodes/${prov.instanceName}`);
  } catch (error) {
    if (errorStatus(error) !== 404) throw error;
  }
  // Best-effort: remove the result objects so the bucket doesn't accumulate.
  const bucket = tpuResultBucket();
  if (bucket) {
    for (const leaf of ["status", "exitCode", "result"]) {
      try {
        await callGcp(
          token,
          "DELETE",
          `${STORAGE_BASE}/b/${bucket}/o/${encodeURIComponent(objectName(prov.providerJobId, leaf))}`,
          undefined,
          { fast: true },
        );
      } catch {
        /* best-effort cleanup; the node delete above is what controls cost */
      }
    }
  }
}
