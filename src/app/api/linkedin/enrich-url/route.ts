import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { persistConnectedProfile } from "@/lib/linkedin/connection";
import { hasUrlEnrichedLinkedInProfile } from "@/lib/linkedin/profile";
import { LinkedInScraperError, scrapeLinkedInProfileUrl } from "@/lib/linkedin/scraper-profile";
import { maybeEnqueueConnectRecompute } from "@/lib/social-intelligence/connect-pipeline";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof LinkedInScraperError) {
    return NextResponse.json({ ok: false, error: error.message, code: error.code }, { status: error.statusCode });
  }
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "LinkedIn enrichment failed.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const { profile, normalizedUrl } = await scrapeLinkedInProfileUrl(body.url, verified.email);
    if (!hasUrlEnrichedLinkedInProfile(profile)) {
      throw Object.assign(
        new Error("We could not read enough LinkedIn profile detail. Check that the profile is public/visible and try again."),
        { statusCode: 422 },
      );
    }
    await persistConnectedProfile(verified, profile);
    // Connect-later: LinkedIn is a profile (not a post feed), so a refreshed career anchor should re-ground
    // the preference layer via a recompute (consent-gated, idempotent). Fire-and-forget — never blocks Add.
    void maybeEnqueueConnectRecompute(verified.uid).catch(() => undefined);
    return NextResponse.json({ ok: true, profile, normalizedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
