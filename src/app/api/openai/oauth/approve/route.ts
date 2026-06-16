import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { createAuthorizationCode } from "@/lib/openai-connector/oauth";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const statusCode =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  const status = Number.isFinite(statusCode) && statusCode >= 400 ? statusCode : 500;
  const message = error instanceof Error ? error.message : "Could not authorize one by hushh connector.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const code = await createAuthorizationCode(request, verified, body);
    const redirectUri = String(body.redirect_uri || "");
    const state = typeof body.state === "string" ? body.state : "";
    const redirectTo = new URL(redirectUri);
    redirectTo.searchParams.set("code", code);
    if (state) redirectTo.searchParams.set("state", state);
    return NextResponse.json({ ok: true, redirectTo: redirectTo.toString() });
  } catch (error) {
    return errorResponse(error);
  }
}
