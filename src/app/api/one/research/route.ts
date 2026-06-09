import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import { isValidEmail, normalizeEmail, normalizeName } from "@/lib/auth/identity";
import { createConsentAndScan, completeScanRun, failScanRun, upsertOneUser } from "@/lib/db/scan-store";
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
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    input = normalizeInput(await parseBody(request), verified.email);
    mode = typeof input.latitude === "number" && typeof input.longitude === "number" ? "precise" : "limited";
    const depth: ResearchDepth = process.env.DEEP_RESEARCH_DEPTH === "fast" ? "fast" : "max";

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
      const stageNow = () => (phase2 ? SHADOW_PHASES.length - 1 : shadowPhaseIndex(Date.now() - startedAt));
      const scanningNow = () =>
        phase2 ? "One is composing your report…" : oneVoiceProgress(latestRawProgress, stageNow());

      send({ type: "start", scanRunId, stage: 0, elapsedMs: 0, scanning: oneVoiceProgress(null, 0) });
      heartbeat = setInterval(() => {
        send({ type: "progress", stage: stageNow(), elapsedMs: Date.now() - startedAt, scanning: scanningNow() });
      }, 7000);

      try {
        let report: string | null = null;
        let citations: unknown[] = [];
        for (;;) {
          if (closed) return; // client disconnected; recovery route will resume
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

        // Phase 2: refine into the focused, disambiguated final dossier (fail-safe to raw).
        phase2 = true; // heartbeats now show "One is composing your report…"
        send({ type: "progress", stage: SHADOW_PHASES.length - 1, elapsedMs: Date.now() - startedAt, scanning: "One is composing your report…" });
        const result = await finalizeResearch(report, citations, input, mode, scanRunId);
        await completeScanRun(scanRunId, toJsonValue(result), result.summary);

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
        console.info(JSON.stringify({ event: "one.research.completed", severity: "INFO", scanRunId, source: result.source }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "One could not complete the research";
        console.error(JSON.stringify({ event: "one.research.failed", severity: "ERROR", scanRunId, message }));
        await failScanRun(scanRunId, message).catch(() => undefined);
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
