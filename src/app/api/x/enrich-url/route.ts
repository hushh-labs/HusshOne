import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { persistXAccessRecord, persistXProfile } from "@/lib/x/connection";
import { hasXProfile } from "@/lib/x/profile";
import { scrapeXProfileUrl, XScraperError } from "@/lib/x/scraper-profile";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof XScraperError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.statusCode });
  }
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "X enrichment failed.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const result = await scrapeXProfileUrl(body.url);
    if (result.status === "access_pending") {
      await persistXAccessRecord(verified, result.normalizedUrl, result.access, result.profileSnapshot, result.raw);
      return NextResponse.json(
        {
          ok: false,
          code: "x_access_pending",
          error: result.access.reason || "X follow request is pending owner approval.",
          access: result.access,
          profile: result.profileSnapshot,
          normalizedUrl: result.normalizedUrl,
        },
        { status: 202 },
      );
    }
    const { profile, normalizedUrl, raw, access } = result;
    if (!hasXProfile(profile)) {
      throw Object.assign(
        new Error("We could not read enough X profile detail. Check that the profile is public/visible and try again."),
        { statusCode: 422 },
      );
    }
    await persistXProfile(verified, profile);
    if (access) await persistXAccessRecord(verified, normalizedUrl, access, profile, raw);
    return NextResponse.json({ ok: true, profile, normalizedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
