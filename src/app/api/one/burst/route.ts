/* Hussh One — Xtreme Compute Burst: submit a heavy workload.
   Decides placement (local "One Puppy" Mac vs cloud burst), and for a cloud burst
   provisions a GCP GPU instance and streams NDJSON progress while it runs — same
   protocol as /api/one/research. Teardown runs on completion, failure, AND the soft
   deadline so a burst instance is never left running (cost control). BYOC: the
   customer's GCP creds (optional `byoc` block) are used in memory only, never stored. */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { resolveGcpCreds } from "@/lib/burst/credentials";
import { decidePlacement, DEFAULT_PUPPY_PROFILE } from "@/lib/burst/placement";
import { mockBurstEnabled, pollBurst, startBurst, teardownBurst } from "@/lib/burst/client";
import { createBurstJob, completeBurstJob, failBurstJob, markBurstProvisioned } from "@/lib/db/burst-store";
import type {
  AcceleratorKind,
  BurstProviderId,
  DeviceProfile,
  JobSpec,
  RequestByocCreds,
  WorkloadEstimate,
} from "@/lib/burst/types";

export const runtime = "nodejs";
// A burst can run for many minutes; allow the route to run long where honored.
export const maxDuration = 1800;

// Poll cadence and the soft-deadline handoff are env-tunable (defaults below) so they
// can be tuned per environment and driven deterministically in tests.
function pollIntervalMs() {
  const v = Number.parseInt(process.env.ONE_BURST_POLL_INTERVAL_MS || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 5000;
}
// Soft deadline: hand off before Cloud Run's hard kill so a long burst is never lost
// without tearing the instance down. Recovery (GET /[id]) resumes the poll + teardown.
function deadlineMs() {
  const v = Number.parseInt(process.env.ONE_BURST_DEADLINE_MS || "", 10);
  return Number.isFinite(v) ? v : 1_650_000;
}

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseEstimate(value: unknown): WorkloadEstimate {
  const e = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    vramGb: num(e.vramGb),
    unifiedMemoryGb: num(e.unifiedMemoryGb),
    vcpus: num(e.vcpus),
    diskGb: num(e.diskGb),
    estimatedMinutes: num(e.estimatedMinutes),
  };
}

function parseDeviceProfile(value: unknown): DeviceProfile {
  const d = (value && typeof value === "object" ? value : {}) as Partial<DeviceProfile>;
  // Caller sends a partial snapshot of their Mac; fill gaps from the reference Puppy.
  return { ...DEFAULT_PUPPY_PROFILE, ...d };
}

function normalizeSpec(body: Record<string, unknown>): JobSpec {
  const image = typeof body.image === "string" ? body.image.trim() : "";
  if (!image) throw Object.assign(new Error("A container image is required"), { statusCode: 400 });

  const acceleratorKind: AcceleratorKind = body.acceleratorKind === "tpu" ? "tpu" : "gpu";
  const acceleratorCount = Math.round(num(body.acceleratorCount, 1));
  if (acceleratorCount < 1 || acceleratorCount > 8) {
    throw Object.assign(new Error("acceleratorCount must be between 1 and 8"), { statusCode: 400 });
  }

  const command = Array.isArray(body.command)
    ? body.command.filter((c): c is string => typeof c === "string").slice(0, 64)
    : undefined;
  const env =
    body.env && typeof body.env === "object" && !Array.isArray(body.env)
      ? Object.fromEntries(
          Object.entries(body.env as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string]),
        )
      : undefined;

  return {
    image,
    command,
    env,
    acceleratorKind,
    acceleratorCount,
    machineType: typeof body.machineType === "string" ? body.machineType.trim() : undefined,
    region: typeof body.region === "string" ? body.region.trim() : undefined,
    zone: typeof body.zone === "string" ? body.zone.trim() : undefined,
    estimate: parseEstimate(body.estimate),
  };
}

function parseByoc(value: unknown): RequestByocCreds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  return {
    serviceAccountJson: typeof b.serviceAccountJson === "string" ? b.serviceAccountJson : undefined,
    projectId: typeof b.projectId === "string" ? b.projectId : undefined,
    region: typeof b.region === "string" ? b.region : undefined,
  };
}

export async function POST(request: Request) {
  // Phase 1 (synchronous): auth, validate, decide placement, and — for a cloud burst —
  // provision the instance. Errors here return clean JSON (the stream never opens).
  let spec: JobSpec;
  let providerId: BurstProviderId;
  let burstJobId: string | null = null;
  let started: Awaited<ReturnType<typeof startBurst>>;
  let creds: ReturnType<typeof resolveGcpCreds> | null = null;
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = await parseBody(request);
    spec = normalizeSpec(body);
    const device = parseDeviceProfile(body.deviceProfile);
    const placement = decidePlacement(spec.estimate, device, spec.acceleratorKind);
    providerId = mockBurstEnabled() ? "mock" : "gcp";

    // Resolve BYOC creds up front (only needed for a cloud burst, but validate early
    // so a bad SA JSON fails fast rather than after we've told the client "bursting").
    creds = placement.target === "gcp" && providerId === "gcp" ? resolveGcpCreds(parseByoc(body.byoc)) : null;

    if (placement.target === "puppy") {
      // The Mac-side "One Puppy" agent runs this locally. We record the decision and
      // return a handshake; local execution + result reporting is the native boundary
      // (POST /api/one/burst/[id]/puppy-result, defined in docs as the next step).
      const { burstJobId: puppyJobId } = await createBurstJob({
        firebaseUid: verified.uid,
        provider: providerId,
        spec,
        region: creds?.region || spec.region || "local",
        machineType: spec.machineType || "apple-silicon",
        placement: "puppy",
        placementReason: placement.reason,
        credsSource: creds?.source ?? null,
        status: "running",
      });
      return NextResponse.json({
        ok: true,
        placement: "puppy",
        reason: placement.reason,
        headroom: placement.headroom ?? null,
        burstJobId: puppyJobId,
        handshake: {
          target: "puppy",
          jobId: puppyJobId,
          spec,
          reportResultEndpoint: puppyJobId ? `/api/one/burst/${puppyJobId}/puppy-result` : null,
        },
      });
    }

    // Cloud burst → create the row, then provision the instance.
    const created = await createBurstJob({
      firebaseUid: verified.uid,
      provider: providerId,
      spec,
      region: creds?.region || spec.region || "us-central1",
      machineType: spec.machineType || (process.env.ONE_BURST_DEFAULT_MACHINE_TYPE || "n1-standard-8"),
      placement: "gcp",
      placementReason: placement.reason,
      credsSource: creds?.source ?? null,
      status: "provisioning",
    });
    burstJobId = created.burstJobId;

    const provisionStart = Date.now();
    started = await startBurst(spec, creds, providerId);
    await markBurstProvisioned(burstJobId, {
      providerJobId: started.provision.providerJobId,
      instanceName: started.provision.instanceName,
      provisionMs: Date.now() - provisionStart,
    });
  } catch (error) {
    const status = statusCodeOf(error) ?? 500;
    const message = error instanceof Error ? error.message : "Could not start the burst";
    if (burstJobId) await failBurstJob(burstJobId, message).catch(() => undefined);
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.burst.precheck_failed", status, message }),
    );
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 500 });
  }

  // Phase 2 (streamed): poll the burst with NDJSON heartbeats. Teardown is guaranteed
  // (completion, failure, deadline) so the instance never outlives the job.
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      const finish = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (!closed) {
          closed = true;
          controller.close();
        }
      };

      let latestProgress = "Provisioning burst instance…";
      send({ type: "start", burstJobId, placement: "gcp", provider: providerId, scanning: latestProgress, elapsedMs: 0 });
      heartbeat = setInterval(() => {
        send({ type: "progress", scanning: latestProgress, elapsedMs: Date.now() - startedAt });
      }, 7000);

      try {
        for (;;) {
          if (closed) return; // client disconnected — recovery route resumes + tears down
          if (Date.now() - startedAt > deadlineMs()) {
            // Hand off before the hard kill, tearing the instance down so it isn't orphaned.
            await teardownBurst(started.provider, started.provision, creds);
            await failBurstJob(burstJobId, "Burst exceeded the inline time budget", {
              totalMs: Date.now() - startedAt,
            }).catch(() => undefined);
            send({ type: "pending", reason: "deadline", burstJobId, message: "Burst is taking longer than usual — it was stopped to avoid runaway cost." });
            return;
          }

          const poll = await pollBurst(started.provider, started.provision, creds);
          if (poll.progress) latestProgress = poll.progress;

          if (poll.status === "completed") {
            const totalMs = Date.now() - startedAt;
            await teardownBurst(started.provider, started.provision, creds);
            await completeBurstJob(burstJobId, poll.result, { runMs: totalMs, totalMs });
            send({ type: "done", ok: true, burstJobId, result: poll.result, exitCode: poll.exitCode });
            console.info(JSON.stringify({ event: "one.burst.completed", severity: "INFO", burstJobId, provider: providerId, totalMs }));
            return;
          }
          if (poll.status === "failed") {
            throw Object.assign(new Error(poll.error || "Burst workload failed"), { statusCode: 502 });
          }

          send({ type: "progress", scanning: latestProgress, elapsedMs: Date.now() - startedAt });
          await sleep(pollIntervalMs());
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Burst could not complete";
        // Always tear down on failure — a half-provisioned instance is pure cost.
        await teardownBurst(started.provider, started.provision, creds);
        await failBurstJob(burstJobId, message, { totalMs: Date.now() - startedAt }).catch(() => undefined);
        console.error(JSON.stringify({ event: "one.burst.failed", severity: "ERROR", burstJobId, provider: providerId, message }));
        send({ type: "error", ok: false, error: message });
      } finally {
        finish();
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
