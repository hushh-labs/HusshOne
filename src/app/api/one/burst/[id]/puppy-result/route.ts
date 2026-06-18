/* "One Puppy" result callback: POST /api/one/burst/[id]/puppy-result.
   Closes the on-device contract. When a workload is placed on the local Mac, the native
   One Puppy agent runs it and reports the outcome here so the BurstJob row reflects the
   true terminal state (the control plane never sees the local execution directly).

   Owner-scoped and idempotent: only the job's owner may report, only a "puppy"-placed
   job accepts a report, and a job already in a terminal state is left unchanged. */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { completeBurstJob, failBurstJob, getOwnedBurstJobStatus } from "@/lib/db/burst-store";

export const runtime = "nodejs";

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const { id } = await context.params;
    if (!id) return NextResponse.json({ ok: false, error: "Missing burst id" }, { status: 400 });

    const body = (await request.json().catch(() => null)) as
      | { status?: string; result?: unknown; error?: string; runMs?: number }
      | null;
    if (!body || (body.status !== "completed" && body.status !== "failed")) {
      return NextResponse.json({ ok: false, error: "status must be 'completed' or 'failed'" }, { status: 400 });
    }

    const job = await getOwnedBurstJobStatus(verified.uid, id);
    if (!job) return NextResponse.json({ ok: false, error: "Unknown burst job" }, { status: 404 });
    if (job.placement !== "puppy") {
      // Cloud bursts are finalized by the control plane, not the device.
      return NextResponse.json({ ok: false, error: "This burst is not a Puppy (on-device) job" }, { status: 409 });
    }
    if (job.status === "completed" || job.status === "failed") {
      // Idempotent: a retried report after the job already settled is a no-op success.
      return NextResponse.json({ ok: true, status: job.status, idempotent: true });
    }

    const runMs = typeof body.runMs === "number" ? body.runMs : undefined;
    if (body.status === "completed") {
      await completeBurstJob(id, body.result ?? null, { runMs, totalMs: runMs });
      return NextResponse.json({ ok: true, status: "completed" });
    }
    await failBurstJob(id, body.error || "On-device run failed", { runMs, totalMs: runMs });
    return NextResponse.json({ ok: true, status: "failed" });
  } catch (error) {
    const status = statusCodeOf(error) ?? 401;
    const message = error instanceof Error ? error.message : "Could not record the result";
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 401 });
  }
}
