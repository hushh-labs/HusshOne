/* A2A Agent Card discovery endpoint: GET /.well-known/agent.json (RFC 8615).
   Lets the Gemini Enterprise Agent Platform (Agent Engine / Cloud API Registry) and any
   A2A client discover the Xtreme Compute Burst agent, its skills, endpoint, and auth.
   Public + cacheable; the card's URLs are derived from the request origin. */
import { NextResponse } from "next/server";
import { buildAgentCard } from "@/lib/burst/agent-card";

export const runtime = "nodejs";

function requestOrigin(request: Request): string {
  const explicit = request.headers.get("origin");
  if (explicit?.startsWith("http")) return explicit.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  // Fall back to the canonical site URL when the host header is unusable.
  if (!host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) {
    return (process.env.ONE_SITE_URL || `${proto}://${host || "one.hushh.ai"}`).replace(/\/+$/, "");
  }
  return `${proto}://${host}`;
}

export async function GET(request: Request) {
  const card = buildAgentCard(requestOrigin(request));
  return NextResponse.json(card, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Discovery doc — safe to cache at the edge; revalidate hourly.
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
