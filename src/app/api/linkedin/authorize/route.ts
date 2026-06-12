import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_PATH,
  buildAuthorizeUrl,
  defaultRequestedScopes,
  isLocalhostRedirectUri,
  linkedInCallbackUriForOrigin,
  sanitizeScopes,
} from "@/lib/linkedin/oauth";

export const runtime = "nodejs";

/* Kicks off the LinkedIn OAuth dance: mint a CSRF `state`, stash it (plus the
   requested scopes and retry counter) in an httpOnly cookie, then redirect the
   browser to LinkedIn's consent screen. The callback validates `state` against
   this cookie and uses the stashed scopes to drive the unauthorized-scope retry. */

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where to send the browser after the dance. Same-origin relative paths only. */
function safeReturnTo(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/labs/linkedin";
}

/** External base URL — Cloud Run's request.url is the internal 0.0.0.0:8080 bind address. */
function appBaseUrl(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return `${proto}://${host}`;
  return request.nextUrl.origin;
}

function redirectUriForRequest(request: NextRequest): string {
  const requestRedirectUri = linkedInCallbackUriForOrigin(appBaseUrl(request));
  const configured = process.env.LINKEDIN_REDIRECT_URI?.trim();
  if (configured && !isLocalhostRedirectUri(configured)) return configured;
  return requestRedirectUri;
}

export function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  let scopes = sanitizeScopes(sp.get("scopes"));
  if (!scopes.length) scopes = defaultRequestedScopes();
  const attempt = Number(sp.get("attempt") ?? "0") || 0;
  const returnTo = safeReturnTo(sp.get("returnTo"));
  const state = randomState();
  const redirectUri = redirectUriForRequest(request);

  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl({ scopes, state, redirectUri });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LinkedIn OAuth is not configured.";
    return NextResponse.redirect(new URL(`${returnTo}?error=config_error&error_description=${encodeURIComponent(message)}`, appBaseUrl(request)));
  }

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set("li_oauth_state", JSON.stringify({ state, scopes, attempt, returnTo, redirectUri }), {
    httpOnly: true,
    sameSite: "lax", // sent on LinkedIn's top-level GET redirect back to /callback
    secure: request.nextUrl.protocol === "https:",
    path: COOKIE_PATH,
    maxAge: 600,
  });
  return res;
}
