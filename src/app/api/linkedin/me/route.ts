import { NextRequest, NextResponse } from "next/server";
import { LINKEDIN_ISSUERS, decodeJwt, fetchUserinfo, runDataProbes } from "@/lib/linkedin/oauth";

export const runtime = "nodejs";

/* Reads the httpOnly cookies set by /callback and pulls everything LinkedIn will
   give us with this token: the OIDC userinfo, the decoded id_token claims, and a
   per-scope read battery (runDataProbes) covering legacy profile, email,
   connections count, org ACLs and the DMA snapshot. Raw responses are passed
   through verbatim so the page shows both successes and errors. The access token
   itself is never returned in full — only a masked preview and metadata. */

type TokenCookie = {
  access_token?: string;
  scope?: string;
  token_type?: string;
  expires_at?: number;
  has_id_token?: boolean;
  has_refresh_token?: boolean;
};

export async function GET(request: NextRequest) {
  const raw = request.cookies.get("li_token")?.value;
  if (!raw) {
    return NextResponse.json({ ok: false, connected: false, error: "not_connected" }, { status: 401 });
  }

  let tok: TokenCookie;
  try {
    tok = JSON.parse(raw) as TokenCookie;
  } catch {
    return NextResponse.json({ ok: false, connected: false, error: "bad_token_cookie" }, { status: 400 });
  }

  const accessToken = tok.access_token ?? "";
  if (!accessToken) {
    return NextResponse.json({ ok: false, connected: false, error: "no_access_token" }, { status: 401 });
  }

  // Token already expired → don't bother hitting LinkedIn; tell the client to re-auth.
  if (tok.expires_at && tok.expires_at < Date.now()) {
    return NextResponse.json({ ok: false, connected: false, error: "token_expired" }, { status: 401 });
  }

  const grantedScopes = (tok.scope ?? "").split(/[\s,]+/).filter(Boolean);

  // Decode the id_token (display only — signature not verified; see decodeJwt).
  // We still surface lightweight iss/aud checks so the UI can flag a wrong issuer/audience.
  const idTokenRaw = request.cookies.get("li_idtoken")?.value || "";
  const idToken = idTokenRaw ? decodeJwt(idTokenRaw) : null;
  const claims = idToken?.payload && typeof idToken.payload === "object" ? (idToken.payload as Record<string, unknown>) : null;
  const clientId = process.env.LINKEDIN_CLIENT_ID ?? "";
  const issOk = claims ? LINKEDIN_ISSUERS.includes(String(claims.iss)) : null;
  const audOk = claims && clientId ? claims.aud === clientId : null;

  const [userinfo, probes] = await Promise.all([fetchUserinfo(accessToken), runDataProbes(accessToken, grantedScopes)]);

  const maskedToken = accessToken.length > 12 ? `${accessToken.slice(0, 6)}…${accessToken.slice(-4)}` : "••••";
  const expiresAt = tok.expires_at ?? null;

  return NextResponse.json({
    ok: true,
    connected: true,
    granted_scopes: grantedScopes,
    token_meta: {
      token_type: tok.token_type ?? "Bearer",
      masked_token: maskedToken,
      token_length: accessToken.length,
      expires_at: expiresAt,
      expires_in_seconds: expiresAt ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : null,
      has_id_token: Boolean(idToken) || Boolean(tok.has_id_token),
      has_refresh_token: Boolean(tok.has_refresh_token),
    },
    id_token: idToken
      ? { present: true, header: idToken.header, payload: idToken.payload, error: idToken.error ?? null, iss_ok: issOk, aud_ok: audOk }
      : { present: false },
    userinfo, // { ok, status, data } — OIDC profile/email/picture
    probes, // per-scope read battery — what each granted scope returns (or "not granted")
  });
}
