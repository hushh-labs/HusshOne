import { NextResponse } from "next/server";
import { verifyOneRequest } from "@/lib/auth/verify";
import { normalizeXUrl } from "@/lib/auth/identity";
import { persistXProfile } from "@/lib/x/connection";
import { buildXHandshakeProfile } from "@/lib/x/profile";
import { maybeEnqueueConnectDeepScrape } from "@/lib/social-intelligence/connect-pipeline";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  const raw =
    typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: number }).statusCode) : NaN;
  const status = Number.isFinite(raw) && raw >= 400 ? raw : 500;
  const message = error instanceof Error ? error.message : "X enrichment failed.";
  return NextResponse.json({ ok: false, error: message }, { status });
}

// Connect = lightweight handshake. We normalize the URL, persist the connection,
// and return "connected" immediately. The heavy post scrape runs later as a
// background deep-scrape job (enqueued, consent-gated, on Send One) — so Add
// never blocks on or fails because of the scraper being slow/rate-limited.
export async function POST(request: Request) {
  try {
    const verified = await verifyOneRequest(request.headers.get("authorization"));
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const normalizedUrl = normalizeXUrl(body.url);
    const profile = normalizedUrl ? buildXHandshakeProfile(normalizedUrl) : null;
    if (!normalizedUrl || !profile) {
      throw Object.assign(new Error("Paste a valid X profile URL (e.g. https://x.com/username)."), { statusCode: 422 });
    }
    await persistXProfile(verified, profile);
    // Connect-later: auto-kick the deep pipeline (consent-gated) so this platform's intelligence builds
    // without a re-scan. Fire-and-forget — never blocks/breaks the handshake response.
    void maybeEnqueueConnectDeepScrape({
      firebaseUid: verified.uid,
      platform: "x",
      username: profile.username,
      profileUrl: normalizedUrl,
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, profile, normalizedUrl });
  } catch (error) {
    return errorResponse(error);
  }
}
