/* POST /api/one/burst/setup/validate — probe the user's GCP project with their key and
   return a pass/fail checklist (auth, permissions, GPU quota). Powers the onboarding
   "you're set / here's the gap" moment. The key is used in-memory only, never persisted. */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { validateByocSetup } from "@/lib/burst/setup";
import type { RequestByocCreds } from "@/lib/burst/types";

export const runtime = "nodejs";

function parseByoc(value: unknown): RequestByocCreds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  return {
    serviceAccountJson: typeof b.serviceAccountJson === "string" ? b.serviceAccountJson : undefined,
    projectId: typeof b.projectId === "string" ? b.projectId : undefined,
    region: typeof b.region === "string" ? b.region : undefined,
  };
}

export async function POST(request: Request) {
  try {
    await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { byoc?: unknown };
    const validation = await validateByocSetup(parseByoc(body.byoc));
    return NextResponse.json({ ok: true, ...validation });
  } catch (error) {
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode) || 401
        : 401;
    const message = error instanceof Error ? error.message : "Could not validate setup";
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 401 });
  }
}
