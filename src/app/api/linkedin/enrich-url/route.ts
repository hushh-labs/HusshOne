import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { normalizeLinkedInUrl } from "@/lib/auth/identity";
import { persistConnectedProfile } from "@/lib/linkedin/connection";
import { buildLinkedInHandshakeProfile, hasUrlEnrichedLinkedInProfile } from "@/lib/linkedin/profile";
import { LinkedInScraperError, scrapeLinkedInProfileUrl } from "@/lib/linkedin/scraper-profile";
import { enqueueSocialRefreshJobs } from "@/lib/db/scan-store";

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

// LinkedIn is the Phase-1 ground-truth anchor, so we still try the full synchronous scrape first (best
// case, unchanged). But the scraper VM going down must NOT hard-block the user (esp. a guest, for whom
// LinkedIn is required): if the scrape fails or comes back too thin, we fall back to a degraded URL-only
// "handshake" connection and enqueue a background re-enrich. Only an invalid URL is a hard failure.
export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const normalizedUrl = normalizeLinkedInUrl(body.url);
    if (!normalizedUrl) {
      throw Object.assign(new Error("Paste a valid LinkedIn profile URL (linkedin.com/in/…)."), { statusCode: 422 });
    }

    let rich: Awaited<ReturnType<typeof scrapeLinkedInProfileUrl>>["profile"] | null = null;
    let resolvedUrl = normalizedUrl;
    try {
      const result = await scrapeLinkedInProfileUrl(body.url, verified.email);
      resolvedUrl = result.normalizedUrl || normalizedUrl;
      if (hasUrlEnrichedLinkedInProfile(result.profile)) rich = result.profile;
    } catch {
      // scraper VM unavailable / timeout / upstream error — degrade gracefully below (do NOT block).
    }

    if (rich) {
      await persistConnectedProfile(verified, rich);
      return NextResponse.json({ ok: true, profile: rich, normalizedUrl: resolvedUrl });
    }

    // Degraded connect: URL-only handshake so the user is never blocked; the background LinkedIn re-enrich
    // job (drained by the social-archive worker) overwrites this with the rich profile once the VM recovers.
    const handshake = buildLinkedInHandshakeProfile(resolvedUrl);
    if (!handshake) {
      throw Object.assign(new Error("Paste a valid LinkedIn profile URL (linkedin.com/in/…)."), { statusCode: 422 });
    }
    await persistConnectedProfile(verified, handshake);
    void enqueueSocialRefreshJobs({
      firebaseUid: verified.uid,
      jobs: [{ platform: "linkedin", publicId: handshake.sub, metadata: { url: resolvedUrl } }],
    }).catch(() => 0);
    return NextResponse.json({ ok: true, profile: handshake, normalizedUrl: resolvedUrl, degraded: true });
  } catch (error) {
    return errorResponse(error);
  }
}
