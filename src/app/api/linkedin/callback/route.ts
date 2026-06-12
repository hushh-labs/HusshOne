import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_PATH,
  DEFAULT_SCOPES,
  SELF_SERVE_SCOPES,
  exchangeCodeForToken,
  linkedInCallbackUriForOrigin,
  parseUnauthorizedScopes,
} from "@/lib/linkedin/oauth";

export const runtime = "nodejs";

/* LinkedIn redirects here after consent. We:
   1. Validate `state` against the cookie set by /authorize (CSRF).
   2. On `unauthorized_scope_error`, drop the rejected scope(s) and bounce back to
      /authorize to retry — bounded — so login lands on whatever the app is approved
      for instead of hard-failing on "all scopes".
   3. On success, exchange the code for a token and stash it in an httpOnly cookie,
      then send the user to the page which reads it via /api/linkedin/me. */

// Only a handful of scope tiers exist (self-serve, partner, closed, DMA); LinkedIn
// usually rejects all unapproved scopes in one error, so a few retries is plenty.
const MAX_ATTEMPTS = 5;

/* The EXTERNAL base URL. On Cloud Run, request.url / nextUrl is the container's internal
   bind address (http://0.0.0.0:8080), so redirects built from it send the browser to a dead
   host. Derive the public origin from the forwarded/Host headers instead; fall back to
   nextUrl.origin only for local dev. */
function appBaseUrl(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (host && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host)) return `${proto}://${host}`;
  return request.nextUrl.origin;
}

function pageRedirect(request: NextRequest, base: string, params: Record<string, string>): NextResponse {
  const url = new URL(base, appBaseUrl(request));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

function callbackUriForRequest(request: NextRequest): string {
  return linkedInCallbackUriForOrigin(appBaseUrl(request));
}

function savedRedirectUri(request: NextRequest, value: unknown): string {
  const fallback = callbackUriForRequest(request);
  if (typeof value !== "string") return fallback;
  try {
    const candidate = new URL(value);
    const fallbackUrl = new URL(fallback);
    const configured = process.env.LINKEDIN_REDIRECT_URI?.trim();
    if (candidate.pathname === "/api/linkedin/callback" && (candidate.origin === fallbackUrl.origin || value === configured)) {
      return value;
    }
  } catch {
    /* ignore unsafe saved redirect URI */
  }
  return fallback;
}

// Order-insensitive set comparison so the termination guard can't be fooled by a
// reordered-but-equal scope set.
function sameScopes(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((s) => set.has(s));
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const code = sp.get("code");
  const state = sp.get("state");
  const error = sp.get("error");
  const errorDescription = sp.get("error_description");

  let saved: { state?: string; scopes?: string[]; attempt?: number; returnTo?: string; redirectUri?: string } = {};
  const rawCookie = request.cookies.get("li_oauth_state")?.value;
  if (rawCookie) {
    try {
      saved = JSON.parse(rawCookie);
    } catch {
      /* ignore malformed cookie — treated as state mismatch below */
    }
  }

  // Where to send the browser back to. The lab page reads ?connected=1; the prod app
  // (returnTo="/") reads ?li=1. Same-origin relative paths only.
  const returnTo =
    typeof saved.returnTo === "string" && saved.returnTo.startsWith("/") && !saved.returnTo.startsWith("//")
      ? saved.returnTo
      : "/labs/linkedin";
  const successMarker = returnTo.startsWith("/labs/linkedin") ? "connected" : "li";

  // CSRF: the returned state must match what we stored.
  if (!state || !saved.state || state !== saved.state) {
    return pageRedirect(request, returnTo, { error: "state_mismatch", error_description: "OAuth state did not match (possible CSRF or expired session). Try again." });
  }

  const requested = Array.isArray(saved.scopes) && saved.scopes.length ? saved.scopes : DEFAULT_SCOPES;
  const attempt = typeof saved.attempt === "number" ? saved.attempt : 0;
  const redirectUri = savedRedirectUri(request, saved.redirectUri);

  if (error) {
    // Scope fallback: trim the unauthorized scope(s) and retry.
    if (error === "unauthorized_scope_error" && attempt < MAX_ATTEMPTS) {
      const rejected = parseUnauthorizedScopes(errorDescription);
      let next = rejected.length
        ? requested.filter((s) => !rejected.includes(s))
        : requested.filter((s) => SELF_SERVE_SCOPES.includes(s)); // couldn't parse → drop all gated at once

      // No forward progress → collapse to the guaranteed open set.
      if (!next.length || sameScopes(next, requested)) next = DEFAULT_SCOPES;

      // Already at the open set and still rejected → the OIDC product likely isn't
      // enabled on the app. Stop looping and surface the error.
      if (sameScopes(next, requested)) {
        return pageRedirect(request, returnTo, {
          error: "unauthorized_scope_error",
          error_description: errorDescription ?? "Even the base scopes were rejected — add the 'Sign In with LinkedIn using OpenID Connect' product to your LinkedIn app.",
        });
      }

      const authUrl = new URL("/api/linkedin/authorize", appBaseUrl(request));
      authUrl.searchParams.set("scopes", next.join(","));
      authUrl.searchParams.set("attempt", String(attempt + 1));
      authUrl.searchParams.set("returnTo", returnTo);
      return NextResponse.redirect(authUrl);
    }
    return pageRedirect(request, returnTo, { error, error_description: errorDescription ?? "" });
  }

  if (!code) {
    return pageRedirect(request, returnTo, { error: "missing_code", error_description: "LinkedIn returned no authorization code." });
  }

  try {
    const token = await exchangeCodeForToken(code, redirectUri);
    const grantedScope = token.scope ?? requested.join(" ");
    const expiresIn = token.expires_in ?? 3600;

    const res = pageRedirect(request, returnTo, { [successMarker]: "1" });
    res.cookies.set(
      "li_token",
      JSON.stringify({
        access_token: token.access_token,
        scope: grantedScope,
        token_type: token.token_type ?? "Bearer",
        expires_at: Date.now() + expiresIn * 1000,
        has_id_token: Boolean(token.id_token),
        has_refresh_token: Boolean(token.refresh_token),
      }),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: COOKIE_PATH,
        maxAge: expiresIn,
      },
    );
    // Stash the id_token (OIDC) in its own cookie so the page can decode and show
    // its claims. Kept separate from li_token so neither cookie risks the 4KB cap.
    if (token.id_token) {
      res.cookies.set("li_idtoken", token.id_token, {
        httpOnly: true,
        sameSite: "lax",
        secure: request.nextUrl.protocol === "https:",
        path: COOKIE_PATH,
        maxAge: expiresIn,
      });
    } else {
      res.cookies.set("li_idtoken", "", { path: COOKIE_PATH, maxAge: 0 });
    }
    // One-shot state cookie — clear it now that the dance is done.
    res.cookies.set("li_oauth_state", "", { path: COOKIE_PATH, maxAge: 0 });
    return res;
  } catch (error) {
    const message = error instanceof Error ? error.message : "token_exchange_failed";
    return pageRedirect(request, returnTo, { error: "token_exchange_failed", error_description: message });
  }
}
