import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { normalizeLinkedInUrl } from "@/lib/auth/identity";
import { persistConnectedProfile } from "@/lib/linkedin/connection";
import { buildLinkedInHandshakeProfile, hasUrlEnrichedLinkedInProfile } from "@/lib/linkedin/profile";
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

    // Only an invalid URL is a hard failure — we need a real /in/<handle> to anchor on.
    const normalizedUrl = normalizeLinkedInUrl(body.url);
    if (!normalizedUrl) {
      throw new LinkedInScraperError("Paste a valid LinkedIn personal profile URL (linkedin.com/in/…).", 400, "invalid_linkedin_url");
    }

    // Try the rich scrape. If the scraper VM is down/unreachable (throws) OR returns too thin a profile,
    // DON'T hard-block the user — persist a degraded URL-only handshake connection and signal `degraded` so
    // the client can retry/re-enrich in the background. A degraded profile fails hasUrlEnriched, so the
    // strict anchor gate stays closed until a retry upgrades it to the real rich profile (Phase-1 quality
    // is never run on a weak anchor). Only an invalid URL (above) is terminal.
    let profile = null as Awaited<ReturnType<typeof scrapeLinkedInProfileUrl>>["profile"] | null;
    try {
      const scraped = await scrapeLinkedInProfileUrl(body.url, verified.email);
      profile = scraped.profile;
    } catch (scrapeError) {
      // Re-throw genuine client errors (bad URL / not a personal profile); swallow transient VM failures.
      if (scrapeError instanceof LinkedInScraperError && scrapeError.code === "invalid_linkedin_url") throw scrapeError;
      profile = null;
    }

    if (profile && hasUrlEnrichedLinkedInProfile(profile)) {
      await persistConnectedProfile(verified, profile);
      // Connect-later: a refreshed career anchor re-grounds the preference layer via a recompute
      // (consent-gated, idempotent). Fire-and-forget — never blocks Add.
      void maybeEnqueueConnectRecompute(verified.uid).catch(() => undefined);
      return NextResponse.json({ ok: true, profile, normalizedUrl });
    }

    // Degraded: VM down or sparse read → URL-only handshake so a transient outage never blocks signup.
    const handshake = buildLinkedInHandshakeProfile(normalizedUrl);
    if (!handshake) {
      throw new LinkedInScraperError("Paste a valid LinkedIn personal profile URL (linkedin.com/in/…).", 400, "invalid_linkedin_url");
    }
    await persistConnectedProfile(verified, handshake).catch(() => undefined);
    return NextResponse.json({ ok: true, degraded: true, profile: handshake, normalizedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
