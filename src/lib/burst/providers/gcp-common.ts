/* Shared plumbing for the GCP burst providers (GPU on Compute Engine, TPU on the
   Cloud TPU API). Both speak REST over native fetch with the same retry/backoff/
   timeout/error conventions as src/lib/research/client.ts. */
import { mintAccessToken } from "../credentials";
import type { JobSpec, ResolvedGcpCreds } from "../types";

export const COMPUTE_BASE = "https://compute.googleapis.com/compute/v1";
export const TPU_BASE = "https://tpu.googleapis.com/v2";
export const STORAGE_BASE = "https://storage.googleapis.com/storage/v1";
export const STORAGE_UPLOAD_BASE = "https://storage.googleapis.com/upload/storage/v1";
export const GUEST_ATTR_NAMESPACE = "hushh-burst";

const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export function defaultMachineType() {
  return (process.env.ONE_BURST_DEFAULT_MACHINE_TYPE || "n1-standard-8").trim();
}
export function defaultGpuType() {
  return (process.env.ONE_BURST_DEFAULT_GPU_TYPE || "nvidia-tesla-t4").trim();
}
export function defaultTpuType() {
  return (process.env.ONE_BURST_DEFAULT_TPU_TYPE || "v5litepod-8").trim();
}
export function defaultTpuRuntime() {
  return (process.env.ONE_BURST_TPU_RUNTIME || "tpu-ubuntu2204-base").trim();
}
/** GCS bucket the TPU node writes its result to (the control plane reads it back).
    Required for the real TPU path; absent → a clear 503 at provision time. */
export function tpuResultBucket() {
  return process.env.ONE_BURST_TPU_RESULT_BUCKET?.trim() || "";
}
export function teardownEnabled() {
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

export function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if ("upstreamStatus" in error && typeof error.upstreamStatus === "number") return error.upstreamStatus;
  return null;
}
function shouldRetry(error: unknown) {
  const status = errorStatus(error);
  return status !== null && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

/** A zone for the workload (TPU + GPU both need a zone). */
export function zoneFor(spec: JobSpec, creds: ResolvedGcpCreds): string {
  return spec.zone?.trim() || `${spec.region?.trim() || creds.region}-a`;
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export { mintAccessToken };

/** REST call to a Google API with bearer auth, transient-retry, and an abort timeout.
    `raw` returns the Response (for media downloads); otherwise JSON is parsed. */
export async function callGcp<T>(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  opts?: { fast?: boolean; raw?: boolean; contentType?: string },
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
          ...(body !== undefined ? { "Content-Type": opts?.contentType || "application/json" } : {}),
        },
        ...(body !== undefined
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        const message = payload?.error?.message || `GCP API error (${response.status})`;
        throw Object.assign(new Error(message), { statusCode: 502, upstreamStatus: response.status });
      }
      if (opts?.raw) return response as unknown as T;
      return (await response.json().catch(() => ({}))) as T;
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
