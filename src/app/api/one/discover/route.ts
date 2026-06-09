import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { isValidEmail, normalizeEmail, normalizeName } from "@/lib/auth/identity";
import { startDiscover, pollDiscover } from "@/lib/research/client";

export const runtime = "nodejs";
// Phase-0 uses the DR fast agent — a multi-minute background job. Allow headroom.
export const maxDuration = 600;

const NAME_MAX = 80;
const POLL_INTERVAL_MS = 5000;
const MAX_EXCLUDE = 400;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusCodeOf(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error) {
    const status = Number((error as { statusCode?: number }).statusCode);
    return Number.isFinite(status) ? status : null;
  }
  return null;
}

function numberOrUndefined(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/* Phase 0 — candidate discovery. Surfaces public-profile pivots for the user to
   confirm ("this is me") BEFORE the expensive Phase-1 research runs. Streams NDJSON
   heartbeats while polling the DR fast job (same protocol as /api/one/research), then
   returns the structured candidates. Ephemeral — no scan run / DB row is created. */
export async function POST(request: Request) {
  let name: string;
  let email: string;
  let phone: string | undefined;
  let location: string | undefined;
  let excludeUrls: string[];
  let jobId: string;
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => {
      throw Object.assign(new Error("Invalid JSON body"), { statusCode: 400 });
    })) as Record<string, unknown>;

    name = normalizeName(body.name).slice(0, NAME_MAX);
    email = normalizeEmail(body.email || verified.email);
    const latitude = numberOrUndefined(body.latitude);
    const longitude = numberOrUndefined(body.longitude);
    const zipCode = typeof body.zipCode === "string" ? body.zipCode.trim() : undefined;
    phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) || undefined : undefined;

    if (!name) throw Object.assign(new Error("Name is required"), { statusCode: 400 });
    if (!isValidEmail(email)) throw Object.assign(new Error("Valid email is required"), { statusCode: 400 });
    if (email !== verified.email) {
      throw Object.assign(new Error("Signed-in Google email does not match the requested subject"), { statusCode: 403 });
    }
    if ((latitude === undefined || longitude === undefined) && !zipCode) {
      throw Object.assign(new Error("Browser coordinates or zip code are required"), { statusCode: 400 });
    }

    location =
      latitude !== undefined && longitude !== undefined
        ? `lat ${latitude.toFixed(3)}, lon ${longitude.toFixed(3)}`
        : zipCode;
    excludeUrls = Array.isArray(body.excludeUrls)
      ? (body.excludeUrls.filter((u) => typeof u === "string") as string[]).slice(0, MAX_EXCLUDE)
      : [];

    ({ jobId } = await startDiscover({ name, email, phone, location, excludeUrls }));
  } catch (error) {
    const status = statusCodeOf(error) ?? 500;
    const message = error instanceof Error ? error.message : "One could not start discovery";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({ event: "one.discover.precheck_failed", status, message }),
    );
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 500 });
  }

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

      const scanning = () => "One is finding your public profiles…";
      send({ type: "start", elapsedMs: 0, scanning: scanning() });
      heartbeat = setInterval(() => {
        send({ type: "progress", elapsedMs: Date.now() - startedAt, scanning: scanning() });
      }, 7000);

      try {
        let candidates: unknown[] = [];
        for (;;) {
          if (closed) return; // client disconnected
          const dr = await pollDiscover(jobId);
          if (dr.status === "completed") {
            candidates = dr.candidates;
            break;
          }
          if (dr.status === "failed") {
            throw Object.assign(new Error(dr.error || "Discovery could not complete"), { statusCode: 502 });
          }
          send({ type: "progress", elapsedMs: Date.now() - startedAt, scanning: scanning() });
          await sleep(POLL_INTERVAL_MS);
        }
        send({ type: "done", ok: true, candidates });
        console.info(JSON.stringify({ event: "one.discover.completed", severity: "INFO", count: candidates.length }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "One could not complete discovery";
        console.error(JSON.stringify({ event: "one.discover.failed", severity: "ERROR", message }));
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
