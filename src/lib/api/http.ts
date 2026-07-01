/* Shared HTTP helpers for the public developer API (/api/v1/*): permissive CORS (the API is public but
   Bearer-key gated, so any origin may call it with a key), a consistent JSON error envelope, and SSE
   framing. Framework-light (plain `Response`) so the SAME helpers work in JSON routes and streaming
   routes. The error body keeps the existing flat `error:"<message>"` string (no breaking change) and
   ADDS a machine-readable `code`. */

export const API_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

/** Merge the public CORS headers with any extras (extras win). */
export function withCors(headers: Record<string, string> = {}): Record<string, string> {
  return { ...API_CORS_HEADERS, ...headers };
}

/** CORS preflight response (204 No Content). Export as the route's `OPTIONS` handler. */
export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: API_CORS_HEADERS });
}

/** JSON response with CORS + consistent content type. */
export function apiJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors({ "Content-Type": "application/json; charset=utf-8", ...headers }),
  });
}

/** Canonical error: `{ ok:false, error:"<message>", code:"<machine_code>" }` + CORS. */
export function apiError(status: number, code: string, message: string): Response {
  return apiJson({ ok: false, error: message, code }, status);
}

/** Map a thrown value to an HTTP status (honors an attached `statusCode`), default 500. */
export function statusCodeOf(error: unknown, fallback = 500): number {
  if (typeof error === "object" && error && "statusCode" in error) {
    const n = Number((error as { statusCode?: number }).statusCode);
    if (Number.isFinite(n) && n >= 400) return n;
  }
  return fallback;
}

/** SSE response headers (text/event-stream, no proxy buffering, CORS). */
export function sseHeaders(): Record<string, string> {
  return withCors({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

/** Serialize one SSE frame: `event: <e>\ndata: <json>\n\n`. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Best-effort request origin for result-email links (null off-host / localhost). */
export function requestOrigin(request: Request): string | null {
  const explicit = request.headers.get("origin");
  if (explicit?.startsWith("http")) return explicit.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (!host) return null;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return null;
  return `${proto}://${host}`;
}
