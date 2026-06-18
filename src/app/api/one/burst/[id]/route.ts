/* Recovery / resume endpoint for a burst whose streamed POST dropped (client
   disconnect or route timeout). Returns the saved result, or resumes the poll and —
   on completion/failure — tears the instance down and persists. Owner-scoped.

   Limitation (documented): per-request BYOC creds are never stored, so resuming a
   poll against a CUSTOMER project requires env/ADC creds. A burst started with
   per-request creds reports "running" here until its own stream finalizes it; mock
   and env/ADC bursts recover fully. */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { resolveGcpCreds } from "@/lib/burst/credentials";
import { getBurstProvider } from "@/lib/burst/provider-factory";
import { pollBurst, teardownBurst } from "@/lib/burst/client";
import { completeBurstJob, failBurstJob, getOwnedBurstJob } from "@/lib/db/burst-store";
import type { BurstProviderId, ProvisionResult, ResolvedGcpCreds } from "@/lib/burst/types";

export const runtime = "nodejs";

const STALE_MS = 2 * 60 * 60 * 1000; // a burst "running" past this is abandoned → fail it
const STALE_MESSAGE = "This burst ran past its time limit and didn't finish.";

// In-flight finalize guard (per instance): concurrent recovery GETs must not each
// finalize + tear down the same burst. Mirrors the research recovery route.
const finalizingNow = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { id } = await context.params;
    if (!id) return NextResponse.json({ ok: false, error: "Missing burst id" }, { status: 400 });

    const job = await getOwnedBurstJob(verified.uid, id);
    if (!job) return NextResponse.json({ ok: false, status: "unknown", result: null }, { status: 404 });

    if (job.status === "completed") {
      return NextResponse.json({ ok: true, status: "completed", placement: job.placement, result: job.result ?? null });
    }
    if (job.status === "failed") {
      return NextResponse.json({ ok: false, status: "failed", error: job.error ?? "Burst failed", result: null });
    }
    // The Puppy tier completes/reports out-of-band (native agent) — nothing to resume.
    if (job.placement === "puppy") {
      return NextResponse.json({ ok: false, status: "running", placement: "puppy", result: null });
    }

    // Abandoned running row → self-heal so the client doesn't spin forever.
    if (Date.now() - new Date(job.createdAt).getTime() > STALE_MS) {
      await failBurstJob(id, STALE_MESSAGE).catch(() => undefined);
      return NextResponse.json({ ok: false, status: "failed", error: STALE_MESSAGE, result: null });
    }

    if (!job.providerJobId || !job.instanceName) {
      return NextResponse.json({ ok: false, status: "running", result: null });
    }

    const provider = getBurstProvider(job.provider as BurstProviderId);
    const provision: ProvisionResult = {
      providerJobId: job.providerJobId,
      instanceName: job.instanceName,
      // zone wasn't stored separately; reconstruct the default zone from the region.
      zone: `${job.region}-a`,
      // Carry the accelerator family so poll/teardown dispatch to the right path.
      kind: job.acceleratorKind === "tpu" ? "tpu" : "gpu",
    };

    // Resume needs creds for the real GCP path. Per-request BYOC creds aren't stored,
    // so fall back to env/ADC; if none, we can only report "running".
    let creds: ResolvedGcpCreds | null = null;
    if (provider.id !== "mock") {
      try {
        creds = resolveGcpCreds();
      } catch {
        return NextResponse.json({ ok: false, status: "running", result: null });
      }
    }

    let poll;
    try {
      poll = await pollBurst(provider, provision, creds, { fast: true });
    } catch {
      return NextResponse.json({ ok: false, status: "running", result: null });
    }

    if (poll.status === "completed" || poll.status === "failed") {
      if (finalizingNow.has(id)) {
        return NextResponse.json({ ok: false, status: "running", result: null });
      }
      finalizingNow.add(id);
      try {
        // Re-check: another recovery on this instance may have just finalized it.
        const fresh = await getOwnedBurstJob(verified.uid, id);
        if (fresh && fresh.status === "completed") {
          return NextResponse.json({ ok: true, status: "completed", placement: fresh.placement, result: fresh.result ?? null });
        }
        if (fresh && fresh.status === "failed") {
          return NextResponse.json({ ok: false, status: "failed", error: fresh.error ?? "Burst failed", result: null });
        }

        await teardownBurst(provider, provision, creds);
        if (poll.status === "completed") {
          await completeBurstJob(id, poll.result, { totalMs: Date.now() - new Date(job.createdAt).getTime() });
          return NextResponse.json({ ok: true, status: "completed", placement: "gcp", result: poll.result });
        }
        const message = poll.error || "Burst workload failed";
        await failBurstJob(id, message).catch(() => undefined);
        return NextResponse.json({ ok: false, status: "failed", error: message, result: null });
      } finally {
        finalizingNow.delete(id);
      }
    }

    return NextResponse.json({ ok: false, status: "running", result: null });
  } catch (error) {
    const statusCode =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 401;
    const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 401;
    const message = error instanceof Error ? error.message : "Could not load burst status";
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
