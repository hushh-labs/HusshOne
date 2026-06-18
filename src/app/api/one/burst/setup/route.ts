/* GET /api/one/burst/setup — the guided "2-minute GCP setup" steps One shows the user
   to connect their own cloud. Auth-gated (it's part of the signed-in onboarding). */
import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { REQUIRED_PERMISSIONS, setupSteps } from "@/lib/burst/setup";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await verifyOneRequest(request.headers.get("authorization"));
    const url = new URL(request.url);
    const region = url.searchParams.get("region") || "us-central1";
    return NextResponse.json({
      ok: true,
      region,
      requiredPermissions: REQUIRED_PERMISSIONS,
      steps: setupSteps(region),
    });
  } catch (error) {
    const status =
      typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: number }).statusCode) || 401
        : 401;
    const message = error instanceof Error ? error.message : "Unauthorized";
    return NextResponse.json({ ok: false, error: message }, { status: status >= 400 ? status : 401 });
  }
}
