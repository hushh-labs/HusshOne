/* Hussh One — Xtreme Compute Burst: shared types (pure, no I/O).
   v1 ships GCP (GPU) + the on-device "One Puppy" Mac tier. The provider surface is
   abstracted so Azure / AWS / Neo clouds drop in later without touching the routes. */

/** Accelerator family a workload asks for. GPU is fully implemented on GCE; TPU is a
    documented contract (Cloud TPU API) — real path returns 501, mock simulates it. */
export type AcceleratorKind = "gpu" | "tpu";

/** Cloud backends. "mock" is the local/test provider; only "gcp" is real in v1. */
export type BurstProviderId = "gcp" | "mock";

/** Where a job actually runs: the user's local Mac ("One Puppy") or a cloud burst. */
export type PlacementTarget = "puppy" | "gcp";

export type BurstStatus =
  | "pending"
  | "provisioning"
  | "running"
  | "completed"
  | "failed"
  | "tearing_down";

/** A coarse resource estimate for a workload — drives the Puppy-vs-cloud decision. */
export interface WorkloadEstimate {
  /** Accelerator (GPU/unified) memory the job needs, in GB. */
  vramGb: number;
  /** Host RAM the job needs, in GB. On Apple Silicon this is unified memory. */
  unifiedMemoryGb: number;
  vcpus: number;
  diskGb: number;
  estimatedMinutes: number;
}

/** A snapshot of the local "One Puppy" device (a high-end Mac personal supercomputer). */
export interface DeviceProfile {
  id: string;
  label: string;
  cpuCores: number;
  /** Apple GPU core count (informational; capacity is gated on unified memory). */
  gpuCores: number;
  /** Unified memory in GB (e.g. 192 on a maxed M3 Ultra). */
  unifiedMemoryGb: number;
  diskFreeGb: number;
  networkMbps: number;
  online: boolean;
}

/** The workload to run: a container image + command, plus its accelerator ask. */
export interface JobSpec {
  /** Container image reference, e.g. "us-docker.pkg.dev/proj/repo/trainer:latest". */
  image: string;
  command?: string[];
  env?: Record<string, string>;
  acceleratorKind: AcceleratorKind;
  acceleratorCount: number;
  machineType?: string;
  region?: string;
  zone?: string;
  estimate: WorkloadEstimate;
  timeoutMs?: number;
}

export interface PlacementDecision {
  target: PlacementTarget;
  reason: string;
  fitsLocally: boolean;
  /** Spare capacity on the Puppy when it fits locally (negative = the binding deficit). */
  headroom?: { memoryGb: number; diskGb: number };
}

/** Resolved BYOC credentials for a cloud provider (never persisted with the SA key). */
export interface ResolvedGcpCreds {
  projectId: string;
  region: string;
  /** Provenance of the creds, recorded for audit (never the key material itself). */
  source: "request" | "env" | "adc";
  serviceAccountJson?: {
    client_email: string;
    private_key: string;
    project_id: string;
  };
}

/** Optional BYOC credential block a caller may include on the POST body. */
export interface RequestByocCreds {
  /** Raw service-account JSON string. Held in memory only; never written to the DB. */
  serviceAccountJson?: string;
  projectId?: string;
  region?: string;
}

export interface ProvisionResult {
  providerJobId: string;
  instanceName?: string;
  zone?: string;
  raw?: unknown;
}

export interface BurstPollResult {
  status: BurstStatus;
  progress: string | null;
  /** Workload result blob (stdout tail / structured output) when completed. */
  result: unknown | null;
  exitCode: number | null;
  error: string | null;
}

/** A pluggable cloud burst backend. The GCP implementation is real; mock simulates it. */
export interface ComputeBurstProvider {
  readonly id: BurstProviderId;
  provision(spec: JobSpec, creds: ResolvedGcpCreds | null): Promise<ProvisionResult>;
  /** May be a no-op when the provisioned instance auto-runs the workload on boot. */
  submit(spec: JobSpec, prov: ProvisionResult, creds: ResolvedGcpCreds | null): Promise<void>;
  pollStatus(
    prov: ProvisionResult,
    creds: ResolvedGcpCreds | null,
    opts?: { fast?: boolean },
  ): Promise<BurstPollResult>;
  /** Tear down provisioned resources. MUST be idempotent and safe to call on failure. */
  teardown(prov: ProvisionResult, creds: ResolvedGcpCreds | null): Promise<void>;
}
