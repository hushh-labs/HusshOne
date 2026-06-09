import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import { isValidEmail, normalizeEmail, normalizeName } from "@/lib/auth/identity";
import { createConsentAndScan, completeScanRun, failScanRun, recordScanDeadline, upsertOneUser } from "@/lib/db/scan-store";
import { startResearch, pollResearch, type ResearchDepth } from "@/lib/research/client";
import { buildPersonDossierQuestion } from "@/lib/research/dossier";
import { finalizeResearch } from "@/lib/research/finalize";
import { shadowPhaseIndex, SHADOW_PHASES, oneVoiceProgress } from "@/lib/ria/progress";
import type { LocationMode, OneSubjectInput } from "@/lib/ria/types";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";

export const runtime = "nodejs";
// Deep Research is a multi-minute job; allow the route to run long where honored.
export const maxDuration = 900;

const NAME_MAX = 80;
const SUBJECT_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const POLL_INTERVAL_MS = 8000;
// Soft deadline: close + hand off before Cloud Run's hard 900s kill (maxDuration=900),
// so a long scan is never silently lost — the DR job keeps running on its own 3600s
// service and the recovery route (fresh budget) finalizes + emails it.
const DEADLINE_MS = 840_000;
// Don't START Phase-2 inline if less than this remains before the deadline; recovery
// (a fresh request) runs synthesis instead so it isn't cut off mid-way.
const PHASE2_RESERVE_MS = 200_000;

function clientIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

function requestOrigin(request: Request): string | null {
  const explicit = request.headers.get("origin");
  if (explicit?.startsWith("http")) return explicit.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return null;
  return `${proto}://${host}`;
}

async function parseBody(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
  }
}

function numberOrUndefined(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInput(body: Record<string, unknown>, verifiedEmail: string): OneSubjectInput {
  const name = normalizeName(body.name).slice(0, NAME_MAX);
  const email = normalizeEmail(body.email || verifiedEmail);
  const latitude = numberOrUndefined(body.latitude);
  const longitude = numberOrUndefined(body.longitude);
  const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : undefined;
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : undefined;

  if (!name) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
  if (!isValidEmail(email)) throw Object.assign(new Error("Valid email is required"), { statusCode: 400 });
  if (email !== verifiedEmail) {
    throw Object.assign(new Error("Signed-in Google email does not match the requested subject"), { statusCode: 403 });
  }
  if (body.consentAttestation !== true) {
    throw Object.assign(new Error("Consent attestation is required"), { statusCode: 400 });
  }
  if (body.purpose !== "self_audit") {
    throw Object.assign(new Error("Only self_audit purpose is supported"), { statusCode: 400 });
  }
  if ((latitude === undefined || longitude === undefined) && !zipCode) {
    throw Object.assign(new Error("Browser coordinates or zip code are required"), { statusCode: 400 });
  }

  return { name, email, latitude, longitude, zipCode, phone: phone || undefined, consentAttestation: true, purpose: "self_audit" };
}

export async function POST(request: Request) {
  // Phase 1 (synchronous): auth + validate + start the Deep Research job + create the scan.
  let input: OneSubjectInput;
  let mode: LocationMode;
  let userId: string | null;
  let scanRunId: string | null;
  let jobId: string;
  let sessionId: string | null = null;
  let depth: ResearchDepth = "max";
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = await parseBody(request);
    input = normalizeInput(body, verified.email);
    // Client analytics session id (one_sid) — links this scan's server events to the
    // user's UI funnel events for end-to-end tracing.
    sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;
    mode = typeof input.latitude === "number" && typeof input.longitude === "number" ? "precise" : "limited";
    depth = process.env.DEEP_RESEARCH_DEPTH === "fast" ? "fast" : "max";

    ({ jobId } = await startResearch(buildPersonDossierQuestion(input), depth));

    const user = await upsertOneUser({
      firebaseUid: verified.uid,
      email: input.email,
      name: input.name || verified.name,
      photoUrl: verified.picture,
    });
    userId = user?.id ?? null;
    const scan = await createConsentAndScan({
      userId: user?.id || SUBJECT_PLACEHOLDER,
      mode,
      purpose: input.purpose,
      input: toJsonValue({ ...input, deepResearchJobId: jobId }),
      latitude: input.latitude,
      longitude: input.longitude,
      zipCode: input.zipCode,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    scanRunId = scan.scanRunId;
  } catch (error) {
    const status = statusCodeOf(error) ?? 500;
    const message = error instanceof Error ? error.message : "One could not start the research";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.research.precheck_failed", status, message }),
    );
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 500 });
  }

  // Phase 2 (streamed): poll the Deep Research job with NDJSON heartbeats so the
  // connection never idles and the UI shows live progress (same protocol as /dashboard).
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

      // Live progress, personalized as One acting. Phase 1 → driven by the real DR
      // progress (dr.progress); Phase 2 (synthesis) → a fixed "composing" line.
      let latestRawProgress: string | null = null;
      let phase2 = false;
      let phase1Ms = 0; // set when Phase-1 finishes; readable in catch for time-to-failure
      const stageNow = () => (phase2 ? SHADOW_PHASES.length - 1 : shadowPhaseIndex(Date.now() - startedAt));
      const scanningNow = () =>
        phase2 ? "One is composing your report…" : oneVoiceProgress(latestRawProgress, stageNow());

      // Soft-deadline handoff: close cleanly BEFORE the 900s hard kill so the scan is
      // never lost without a trace. The DR job keeps running on its own 3600s service;
      // the recovery route (a fresh request) finalizes + emails. `at` records where we bailed.
      const handoffDeadline = async (elapsedMs: number, at: "phase1" | "phase2_reserve") => {
        console.warn(
          JSON.stringify({
            event: "one.research.deadline",
            severity: "WARNING",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            depth,
            at,
            phase1Ms: elapsedMs,
            elapsedMs,
          }),
        );
        await recordScanDeadline(scanRunId, { phase1Ms: elapsedMs, sessionId, deepResearchJobId: jobId }).catch(() => undefined);
        send({
          type: "pending",
          reason: "deadline",
          scanRunId,
          message: "One is taking longer than usual — it'll keep working and email you the moment it's done.",
        });
      };

      send({ type: "start", scanRunId, stage: 0, elapsedMs: 0, scanning: oneVoiceProgress(null, 0) });
      heartbeat = setInterval(() => {
        send({ type: "progress", stage: stageNow(), elapsedMs: Date.now() - startedAt, scanning: scanningNow() });
      }, 7000);

      try {
        let report: string | null = null;
        let citations: unknown[] = [];
        for (;;) {
          if (closed) return; // client disconnected; recovery route will resume
          // Soft deadline reached during Phase-1 → hand off (don't wait for the hard kill).
          if (Date.now() - startedAt > DEADLINE_MS) {
            await handoffDeadline(Date.now() - startedAt, "phase1");
            return;
          }
          const dr = await pollResearch(jobId);
          if (dr.progress) latestRawProgress = dr.progress; // keep the latest real signal
          if (dr.status === "completed" && dr.report) {
            report = dr.report;
            citations = dr.citations;
            break;
          }
          if (dr.status === "failed") {
            throw Object.assign(new Error(dr.error || "Deep Research could not complete"), { statusCode: 502 });
          }
          // push a fresh One-voiced line right after each poll (don't wait for the heartbeat)
          send({ type: "progress", stage: stageNow(), elapsedMs: Date.now() - startedAt, scanning: scanningNow() });
          await sleep(POLL_INTERVAL_MS);
        }

        // Phase 1 done — record how long Gemini took.
        phase1Ms = Date.now() - startedAt;
        console.info(
          JSON.stringify({ event: "one.research.phase1_done", severity: "INFO", scanRunId, sessionId, email: input.email, jobId, phase1Ms }),
        );

        // Too little budget left to also run Phase-2 inline before the wall → hand off;
        // recovery (a fresh request) will synthesize + email rather than be cut off.
        if (Date.now() - startedAt > DEADLINE_MS - PHASE2_RESERVE_MS) {
          await handoffDeadline(phase1Ms, "phase2_reserve");
          return;
        }

        // Phase 2: refine into the focused, disambiguated final dossier (fail-safe to raw).
        phase2 = true; // heartbeats now show "One is composing your report…"
        send({ type: "progress", stage: SHADOW_PHASES.length - 1, elapsedMs: Date.now() - startedAt, scanning: "One is composing your report…" });
        const { result, phase2Ms } = await finalizeResearch(report, citations, input, mode, scanRunId);
        const totalMs = Date.now() - startedAt;
        await completeScanRun(scanRunId, toJsonValue(result), result.summary, {
          phase1Ms,
          phase2Ms,
          totalMs,
          outcome: "completed",
          sessionId,
          deepResearchJobId: jobId,
        });

        let emailDelivery: ScanEmailDeliverySummary | null = null;
        try {
          emailDelivery = await sendScanResultEmails({
            userId,
            scanRunId,
            result,
            audit: null,
            siteUrl: requestOrigin(request),
          });
        } catch (notificationError) {
          console.error(
            JSON.stringify({
              event: "one.research_email.failed",
              severity: "ERROR",
              scanRunId,
              message: notificationError instanceof Error ? notificationError.message : "unknown",
            }),
          );
        }

        send({ type: "done", ok: true, result, source: result.source, audit: null, emailDelivery });
        console.info(
          JSON.stringify({
            event: "one.research.completed",
            severity: "INFO",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            phase1Ms,
            phase2Ms,
            totalMs,
            outcome: "completed",
            source: result.source,
          }),
        );
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        const failMs = phase1Ms || elapsedMs; // time-to-failure when Phase-1 itself errored
        const message = error instanceof Error ? error.message : "One could not complete the research";
        console.error(
          JSON.stringify({
            event: "one.research.failed",
            severity: "ERROR",
            scanRunId,
            sessionId,
            email: input.email,
            jobId,
            phase1Ms: failMs,
            elapsedMs,
            message,
          }),
        );
        await failScanRun(scanRunId, message, { phase1Ms: failMs, sessionId, deepResearchJobId: jobId }).catch(() => undefined);
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
