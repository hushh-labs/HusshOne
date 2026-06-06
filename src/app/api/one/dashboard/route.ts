import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { verifyOneRequest } from "@/lib/auth/verify";
import { isValidEmail, normalizeEmail, normalizeName } from "@/lib/auth/identity";
import { createConsentAndScan, completeScanRun, failScanRun, upsertOneUser } from "@/lib/db/scan-store";
import { buildTemporaryDashboard, fetchDashboardIntelligence } from "@/lib/ria/client";
import { fetchShadowReport, mapShadowReport } from "@/lib/ria/shadow";
import { normalizeDashboardPayload } from "@/lib/ria/sanitize";
import { shadowPhaseIndex } from "@/lib/ria/progress";
import type { LocationMode, OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";
import { sendScanResultEmails } from "@/lib/notifications/scan-email";
import type { ScanEmailDeliverySummary } from "@/lib/notifications/types";

export const runtime = "nodejs";
// Shadow is a multi-minute call; allow the route to run long where the platform honors it.
export const maxDuration = 900;

const NAME_MAX = 80;

function clientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null
  );
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

function upstreamStatus(error: unknown) {
  if (typeof error === "object" && error && "upstreamStatus" in error) {
    const status = Number((error as { upstreamStatus?: number }).upstreamStatus);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function normalizeInput(body: Record<string, unknown>, verifiedEmail: string): OneSubjectInput {
  const name = normalizeName(body.name).slice(0, NAME_MAX);
  const email = normalizeEmail(body.email || verifiedEmail);
  const latitude = numberOrUndefined(body.latitude);
  const longitude = numberOrUndefined(body.longitude);
  const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : undefined;
  const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : undefined;

  if (!name) {
    throw Object.assign(new Error("Name is required"), { statusCode: 400 });
  }
  if (!isValidEmail(email)) {
    throw Object.assign(new Error("Valid email is required"), { statusCode: 400 });
  }
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

  return {
    name,
    email,
    latitude,
    longitude,
    zipCode,
    phone: phone || undefined,
    consentAttestation: true,
    purpose: "self_audit",
  };
}

const SUBJECT_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/* person-intelligence fallback: Shadow is P0; this only runs in the extreme
   case. Any PI failure still yields a temporary dashboard so the user always
   gets a saved result. */
async function fallbackResult(
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
): Promise<OneDashboardResult> {
  const subject = { name: input.name, email: input.email };
  try {
    const dashboard = await fetchDashboardIntelligence(input);
    return normalizeDashboardPayload({ scanRunId, mode, subject, dashboard, source: "person_intelligence" });
  } catch (piError) {
    console.warn(
      JSON.stringify({
        event: "one.dashboard.person_intelligence_fallback_failed",
        scanRunId,
        upstreamStatus: upstreamStatus(piError),
        message: piError instanceof Error ? piError.message : "unknown",
      }),
    );
    return normalizeDashboardPayload({
      scanRunId,
      mode,
      subject,
      dashboard: buildTemporaryDashboard(input),
      source: "temporary",
    });
  }
}

async function resolveResult(
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
): Promise<OneDashboardResult> {
  try {
    const shadow = await fetchShadowReport(input);
    const ok = shadow?.success && shadow.report && (shadow.status === "completed" || shadow.status === "partial");
    if (ok) {
      return mapShadowReport(shadow.report!, input, mode, scanRunId, String(shadow.status));
    }
    console.warn(
      JSON.stringify({
        event: "one.hushh_shadow.unusable_result",
        scanRunId,
        success: shadow?.success ?? null,
        status: shadow?.status ?? null,
      }),
    );
    return fallbackResult(input, mode, scanRunId);
  } catch (error) {
    const ust = upstreamStatus(error);
    const code = statusCodeOf(error);
    // Auth/config is fatal: PI shares the same key, so falling back would also fail.
    if (ust === 401 || ust === 403 || code === 503) {
      throw Object.assign(new Error("Personal intelligence is not configured. Please try again later."), {
        statusCode: 503,
        configError: true,
      });
    }
    // Everything else (timeout, 5xx, 429, even an unexpected 400/422) → fall back.
    console.warn(
      JSON.stringify({
        event: "one.hushh_shadow.failed_falling_back",
        scanRunId,
        upstreamStatus: ust,
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
    return fallbackResult(input, mode, scanRunId);
  }
}

export async function POST(request: Request) {
  // Phase 1 (synchronous, returns proper HTTP status on failure): auth + validate + create scan.
  let input: OneSubjectInput;
  let mode: LocationMode;
  let userId: string | null;
  let scanRunId: string | null;
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    input = normalizeInput(await parseBody(request), verified.email);
    mode = typeof input.latitude === "number" && typeof input.longitude === "number" ? "precise" : "limited";
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
      input: toJsonValue(input),
      latitude: input.latitude,
      longitude: input.longitude,
      zipCode: input.zipCode,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    scanRunId = scan.scanRunId;
  } catch (error) {
    const statusCode = statusCodeOf(error) ?? 500;
    const status = statusCode >= 400 ? statusCode : 500;
    const message = error instanceof Error ? error.message : "One could not start the scan";
    console.error(JSON.stringify({ event: "one.dashboard.precheck_failed", status, message }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }

  // Phase 2 (streamed): the long Shadow call, with NDJSON heartbeats so the
  // connection never idles and the UI can show live progress.
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

      send({ type: "start", scanRunId, stage: 0, elapsedMs: 0 });
      heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        send({ type: "progress", stage: shadowPhaseIndex(elapsedMs), elapsedMs });
      }, 7000);

      try {
        const result = await resolveResult(input, mode, scanRunId);
        await completeScanRun(scanRunId, toJsonValue(result), result.summary);

        let emailDelivery: ScanEmailDeliverySummary | null = null;
        try {
          emailDelivery = await sendScanResultEmails({ userId, scanRunId, result, audit: null });
        } catch (notificationError) {
          console.error(
            JSON.stringify({
              event: "one.scan_email.failed",
              scanRunId,
              message: notificationError instanceof Error ? notificationError.message : "Unknown email notification error",
            }),
          );
        }

        send({ type: "done", ok: true, result, source: result.source, audit: null, emailDelivery });
      } catch (error) {
        const statusCode = statusCodeOf(error) ?? 500;
        const status = statusCode >= 400 ? statusCode : 500;
        const message = error instanceof Error ? error.message : "One could not complete the scan";
        console.error(
          JSON.stringify({
            event: "one.dashboard.failed",
            status,
            scanRunId,
            message,
            upstreamStatus: upstreamStatus(error),
          }),
        );
        await failScanRun(scanRunId, message).catch(() => undefined);
        send({ type: "error", ok: false, error: message, status });
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
