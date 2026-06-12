import { NextRequest, NextResponse } from "next/server";
import { createOneCustomToken } from "@/lib/firebase/admin";
import { decodeJwt, fetchUserinfo, runDataProbes } from "@/lib/linkedin/oauth";
import { buildLinkedInProfile } from "@/lib/linkedin/profile";

export const runtime = "nodejs";

/* The LinkedIn-first front door. After OAuth (callback set li_token/li_idtoken),
   the app calls this once: we build the clean LinkedIn profile, mint a Firebase
   custom token keyed by the LinkedIn sub, and return both. The client then calls
   signInWithCustomToken → from there it's a normal Firebase session, so the whole
   existing backend (verifyOneRequest, the firebaseUid DB key, recovery) is untouched. */

type TokenCookie = { access_token?: string; scope?: string };

export async function POST(request: NextRequest) {
  const raw = request.cookies.get("li_token")?.value;
  if (!raw) {
    return NextResponse.json({ ok: false, error: "not_connected" }, { status: 401 });
  }

  let tok: TokenCookie;
  try {
    tok = JSON.parse(raw) as TokenCookie;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_token_cookie" }, { status: 400 });
  }

  const accessToken = tok.access_token ?? "";
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "no_access_token" }, { status: 401 });
  }

  const grantedScopes = (tok.scope ?? "").split(/[\s,]+/).filter(Boolean);
  const idTokenClaims = decodeJwt(request.cookies.get("li_idtoken")?.value || "")?.payload ?? null;

  try {
    const [userinfo, probes] = await Promise.all([fetchUserinfo(accessToken), runDataProbes(accessToken, grantedScopes)]);
    const profile = buildLinkedInProfile({ userinfo, probes, idTokenClaims, grantedScopes });

    // Observability: headline/profileUrl/verifications come from the "Verified on LinkedIn"
    // product, which on DEVELOPMENT tier returns data only for app admins — for everyone else
    // /identityMe + /verificationReport return non-200, so headline ends up null. Log that gate
    // (booleans + statuses only, no PII) so we can confirm it per-user and detect the moment a
    // Standard-tier upgrade lifts it. Not an error: the OIDC basics (name/email/photo) still flow.
    const probeStatus = (key: string) => probes.find((x) => x.key === key)?.result?.status ?? null;
    const idmeStatus = probeStatus("identity_me");
    const vrepStatus = probeStatus("verification_report");
    const idmeGated = grantedScopes.includes("r_profile_basicinfo") && idmeStatus !== 200;
    const vrepGated =
      (grantedScopes.includes("r_verify") || grantedScopes.includes("r_verify_details")) && vrepStatus !== 200;
    if (idmeGated || vrepGated) {
      console.warn(
        JSON.stringify({
          event: "linkedin.identity.gated",
          severity: "WARNING",
          sub: profile.sub,
          gotHeadline: Boolean(profile.headline),
          gotProfileUrl: Boolean(profile.profileUrl),
          verifications: profile.verifications.length,
          identityMeStatus: idmeStatus,
          verificationReportStatus: vrepStatus,
          grantedScopes,
          note: "Verified-on-LinkedIn Development tier is app-admin-only; upgrade to Standard tier to return identityMe/verificationReport for all members.",
        }),
      );
    }

    if (!profile.sub) {
      return NextResponse.json({ ok: false, error: "linkedin_userinfo_failed" }, { status: 502 });
    }
    // The scan backend keys on (and verifies) email — a LinkedIn account that didn't share
    // one can't proceed. Catch it here with a clear message instead of a confusing 400 later.
    if (!profile.email) {
      return NextResponse.json(
        { ok: false, error: "linkedin_email_missing", detail: "LinkedIn didn't share your email. Reconnect and allow email access." },
        { status: 400 },
      );
    }

    const customToken = await createOneCustomToken(`linkedin:${profile.sub}`, {
      email: profile.email.toLowerCase(),
      name: profile.name || undefined,
    });

    return NextResponse.json({ ok: true, customToken, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "session_mint_failed";
    return NextResponse.json({ ok: false, error: "session_mint_failed", detail: message }, { status: 500 });
  }
}
