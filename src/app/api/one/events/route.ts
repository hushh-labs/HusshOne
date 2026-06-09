import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Lightweight, public client-behaviour beacon for one.hushh.ai. Receives UI
 * funnel events (stage transitions, drop-off branches) and writes them as
 * structured `one.ui.*` logs → Cloud Logging → Log Analytics / BigQuery.
 *
 * Deliberately:
 *  - anonymous (a client sessionId correlates a journey; no PII is logged here —
 *    authenticated identity is captured separately by one.scan.completed),
 *  - allowlisted (only known event names are accepted),
 *  - size-capped + always 204 (never reward probing with error detail),
 *  - non-blocking (fire-and-forget from the client via fetch keepalive).
 */
const ALLOWED_EVENTS = new Set([
  "stage_landing",
  "stage_manual",
  "stage_precollect",
  "stage_collect",
  "stage_dashboard",
  "stage_empty",
  "stage_error",
  "stage_settings",
  "stage_location",
  "stage_pending",
  "signed_in",
  "phone_entered",
  "scan_started",
  "geo_denied",
  "started_over",
  "account_deleted",
  "client_error",
]);

const noContent = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return noContent();
  }

  const event = typeof body.event === "string" ? body.event : "";
  if (!ALLOWED_EVENTS.has(event)) return noContent();

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 64) : null;

  let props: unknown;
  try {
    const serialized = JSON.stringify(body.props ?? null);
    if (serialized && serialized.length <= 1024) props = body.props;
  } catch {
    props = undefined;
  }

  // Client crashes (from the error boundary / window hooks) carry a message + source so
  // they're actually visible in Cloud Logging — logged at ERROR severity to surface them.
  const isClientError = event === "client_error";
  const message = isClientError && typeof body.message === "string" ? body.message.slice(0, 500) : undefined;
  const source = isClientError && typeof body.source === "string" ? body.source.slice(0, 200) : undefined;

  console.info(
    JSON.stringify({
      event: `one.ui.${event}`,
      severity: isClientError ? "ERROR" : "INFO",
      sessionId,
      message,
      source,
      props,
    }),
  );

  return noContent();
}
