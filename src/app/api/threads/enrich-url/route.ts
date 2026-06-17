import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { persistThreadsAccessRecord, persistThreadsProfile } from "@/lib/threads/connection";
import { hasThreadsProfile } from "@/lib/threads/profile";
import { scrapeThreadsProfileUrl, ThreadsScraperError } from "@/lib/threads/scraper-profile";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof ThreadsScraperError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.statusCode });
  }
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "Threads enrichment failed.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const result = await scrapeThreadsProfileUrl(body.url);
    if (result.status === "access_pending") {
      await persistThreadsAccessRecord(verified, result.normalizedUrl, result.access, result.profileSnapshot, result.raw);
      return NextResponse.json(
        {
          ok: false,
          code: "threads_access_pending",
          error: result.access.reason || "Threads follow request is pending owner approval.",
          access: result.access,
          profile: result.profileSnapshot,
          normalizedUrl: result.normalizedUrl,
        },
        { status: 202 },
      );
    }
    const { profile, normalizedUrl, raw, access } = result;
    if (!hasThreadsProfile(profile)) {
      throw Object.assign(
        new Error("We could not read enough Threads profile detail. Check that the profile is public/visible and try again."),
        { statusCode: 422 },
      );
    }
    await persistThreadsProfile(verified, profile);
    if (access) await persistThreadsAccessRecord(verified, normalizedUrl, access, profile, raw);
    return NextResponse.json({ ok: true, profile, normalizedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
