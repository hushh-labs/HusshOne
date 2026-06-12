/**
 * LinkedIn OAuth 2.0 — standalone experiment helper for the local-only lab at
 * /labs/linkedin. Authorization-code flow with a confidential client (the token
 * exchange runs server-side with the client secret).
 *
 * This is intentionally isolated from the app's Firebase (Google) auth and from
 * the research pipeline — nothing here touches user identity or scans. It exists
 * only so we can run the OAuth dance, request the full scope catalog, and dump
 * whatever LinkedIn returns.
 *
 * Reality check on "all scopes": per LinkedIn's permissions doc, only
 * openid/profile/email (Sign In with LinkedIn using OpenID Connect) and
 * w_member_social (Share on LinkedIn) are self-serve. Everything else needs a
 * partner program, and requesting an unapproved scope fails the whole login with
 * `unauthorized_scope_error`. The callback handles that by dropping the rejected
 * scope(s) and retrying, so login always lands on whatever the app is approved for.
 */

export type LinkedInScope = {
  scope: string;
  product: string; // which LinkedIn product/program enables it
  selfServe: boolean; // addable in the Developer Portal without partner approval
  description: string;
};

// Full documented catalog (LinkedIn permissions reference, updated 2026-06-03).
// Only `selfServe: true` scopes are granted to a normal app; the rest require a
// partner program and are auto-dropped by the callback's fallback.
export const ALL_LINKEDIN_SCOPES: LinkedInScope[] = [
  // --- Open / self-serve (no LinkedIn approval needed) ---
  { scope: "openid", product: "Sign In with LinkedIn (OIDC)", selfServe: true, description: "OpenID Connect auth; returns an id_token." },
  { scope: "profile", product: "Sign In with LinkedIn (OIDC)", selfServe: true, description: "Authenticated member's name, headline, photo." },
  { scope: "email", product: "Sign In with LinkedIn (OIDC)", selfServe: true, description: "Authenticated member's primary email address." },
  { scope: "w_member_social", product: "Share on LinkedIn", selfServe: true, description: "Post, comment and like on behalf of the member." },
  { scope: "r_profile_basicinfo", product: "Verified on LinkedIn (Profile)", selfServe: true, description: "Name, email, public profile URL and photo via /rest/identityMe. (Dev tier: app admins only.)" },
  { scope: "r_verify", product: "Verified on LinkedIn", selfServe: true, description: "Identity/workplace verification status via /rest/verificationReport. (Dev tier: app admins only.)" },
  { scope: "r_verify_details", product: "Verified on LinkedIn (current scope name)", selfServe: false, description: "Newer standard form of r_verify for /rest/verificationReport." },

  // --- Sales Navigator (SNAP partner) ---
  { scope: "r_sales_nav_analytics", product: "Sales Navigator (SNAP)", selfServe: false, description: "Sales Navigator analytics retrieval." },
  { scope: "r_sales_nav_display", product: "Sales Navigator (SNAP)", selfServe: false, description: "Sales Navigator display services." },
  { scope: "r_sales_nav_validation", product: "Sales Navigator (SNAP)", selfServe: false, description: "CRM data validation (application auth)." },
  { scope: "r_sales_nav_profiles", product: "Sales Navigator (SNAP)", selfServe: false, description: "Matched public member profiles (application auth)." },

  // --- Marketing / Advertising (partner) ---
  { scope: "r_ads", product: "Marketing / Advertising API", selfServe: false, description: "Read ad accounts and campaigns." },
  { scope: "rw_ads", product: "Marketing / Advertising API", selfServe: false, description: "Read/write ad accounts and campaigns." },
  { scope: "r_ads_reporting", product: "Marketing / Advertising API", selfServe: false, description: "Ad reporting and analytics." },
  { scope: "rw_dmp_segments", product: "Marketing / Advertising API", selfServe: false, description: "Manage matched audiences (DMP segments)." },
  { scope: "r_marketing_leadgen_automation", product: "Marketing / Lead Gen", selfServe: false, description: "Read Lead Gen Form responses." },
  { scope: "r_organization_social", product: "Community Management API", selfServe: false, description: "Read organization posts, comments, reactions." },
  { scope: "w_organization_social", product: "Community Management API", selfServe: false, description: "Post on behalf of an organization." },
  { scope: "r_organization_admin", product: "Community Management API", selfServe: false, description: "Read pages the member administers." },
  { scope: "rw_organization_admin", product: "Community Management API", selfServe: false, description: "Manage pages the member administers." },
  { scope: "r_1st_connections_size", product: "Marketing", selfServe: false, description: "Member's 1st-degree connection count." },
  { scope: "r_1st_connections", product: "Marketing (approval-gated)", selfServe: false, description: "Full 1st-degree connection list (names/URNs)." },
  { scope: "r_basicprofile", product: "Marketing (legacy)", selfServe: false, description: "Legacy basic profile fields." },

  // --- Legacy member-data (pre-OIDC; deprecated Aug 2023, partner-gated) ---
  { scope: "r_liteprofile", product: "Sign In with LinkedIn (legacy)", selfServe: false, description: "Legacy lite profile (name + photo) via /v2/me." },
  { scope: "r_emailaddress", product: "Sign In with LinkedIn (legacy)", selfServe: false, description: "Legacy primary email via clientAwareMemberHandles." },

  // --- Compliance (closed — listed for reference, cannot be requested) ---
  { scope: "r_compliance", product: "Compliance (closed)", selfServe: false, description: "Read activity for compliance archiving." },
  { scope: "w_compliance", product: "Compliance (closed)", selfServe: false, description: "Manage/delete data for compliance." },

  // --- Member Data Portability (EU DMA) ---
  { scope: "r_dma_portability_3rd_party", product: "Member Data Portability (3rd party)", selfServe: false, description: "EU DMA: export another member's data with consent (~70 domains)." },
  { scope: "r_dma_portability_self_serve", product: "Member Data Portability (member, token tool)", selfServe: false, description: "EU DMA self-serve: export the member's own data (OAuth token generator)." },
  { scope: "r_dma_portability_member", product: "Member Data Portability (member, API docs)", selfServe: false, description: "EU DMA member path as named in the Snapshot/Changelog permission tables." },
];

export const ALL_SCOPE_NAMES: string[] = ALL_LINKEDIN_SCOPES.map((s) => s.scope);
export const SELF_SERVE_SCOPES: string[] = ALL_LINKEDIN_SCOPES.filter((s) => s.selfServe).map((s) => s.scope);
/** The only scopes that work on a normal (non-partner) app. */
export const DEFAULT_SCOPES: string[] = [...SELF_SERVE_SCOPES];

const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LEGACY_ME_URL = "https://api.linkedin.com/v2/me";
const FETCH_TIMEOUT_MS = 15_000;

/** OIDC issuer — live id_token `iss` is this; the discovery doc lists the bare host too. */
export const LINKEDIN_ISSUER = "https://www.linkedin.com/oauth";
export const LINKEDIN_ISSUERS = ["https://www.linkedin.com/oauth", "https://www.linkedin.com"];
/** Lab cookie path. Kept at "/" (not /api/linkedin): scoping it stranded stale
 * cookies across a path change so /me kept reading a revoked token. Logout clears
 * both paths (see logout route) to nuke any leftover scoped cookies. */
export const COOKIE_PATH = "/";
export const LEGACY_COOKIE_PATH = "/api/linkedin";

export type LinkedInConfig = { clientId: string; clientSecret: string; redirectUri: string };

export const DEFAULT_LINKEDIN_REDIRECT_URI = "http://localhost:3000/api/linkedin/callback";

function configError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 500 });
}

export function getLinkedInConfig(override?: { redirectUri?: string }): LinkedInConfig {
  const clientId = process.env.LINKEDIN_CLIENT_ID ?? "";
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET ?? "";
  const redirectUri = override?.redirectUri ?? process.env.LINKEDIN_REDIRECT_URI ?? DEFAULT_LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret) {
    throw configError("LinkedIn OAuth is not configured — set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in .env.local.");
  }
  return { clientId, clientSecret, redirectUri };
}

export function linkedInCallbackUriForOrigin(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/linkedin/callback`;
}

export function isLocalhostRedirectUri(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Keep only known scope names, de-duped, original order preserved. */
export function sanitizeScopes(input: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(input) ? input : (input ?? "").split(/[\s,]+/);
  const known = new Set(ALL_SCOPE_NAMES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    const v = s.trim();
    if (v && known.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Scopes to request when the caller didn't specify any. Env override wins. */
export function defaultRequestedScopes(): string[] {
  const fromEnv = sanitizeScopes(process.env.LINKEDIN_SCOPES);
  return fromEnv.length ? fromEnv : DEFAULT_SCOPES;
}

export function buildAuthorizeUrl(params: { scopes: string[]; state: string; redirectUri?: string }): string {
  const { clientId, redirectUri } = getLinkedInConfig({ redirectUri: params.redirectUri });
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("scope", params.scopes.join(" "));
  return url.toString();
}

/**
 * Pull scope names out of an `unauthorized_scope_error` description so the
 * callback can drop exactly the offending scope(s) and retry. The boundary check
 * stops `r_ads` from also matching inside `r_ads_reporting`.
 */
export function parseUnauthorizedScopes(errorDescription: string | null | undefined): string[] {
  if (!errorDescription) return [];
  const found: string[] = [];
  for (const name of ALL_SCOPE_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z_])${escaped}([^a-z_]|$)`, "i");
    if (re.test(errorDescription)) found.push(name);
  }
  return found;
}

export type TokenResponse = {
  access_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

export async function exchangeCodeForToken(code: string, redirectUriOverride?: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = getLinkedInConfig({ redirectUri: redirectUriOverride });
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`LinkedIn token exchange failed (${res.status}): ${text.slice(0, 500)}`), { statusCode: 502 });
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw Object.assign(new Error(`LinkedIn returned 200 but a non-JSON token body: ${text.slice(0, 200)}`), { statusCode: 502 });
  }
}

/**
 * Decode a JWT (the OIDC id_token) for DISPLAY ONLY — base64url-decode the header
 * and payload. The signature is NOT verified here; we received this token directly
 * from LinkedIn's token endpoint over TLS, and this lab only shows its contents.
 * (Production verification would check the signature against LinkedIn's JWKS at
 * https://www.linkedin.com/oauth/openid/jwks.)
 */
export type DecodedJwt = { header: unknown; payload: unknown; error?: string };

export function decodeJwt(jwt: string | null | undefined): DecodedJwt | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return { header: null, payload: null, error: "not a JWT (expected 3 dot-separated parts)" };
  const decodePart = (part: string): unknown => {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  };
  try {
    return { header: decodePart(parts[0]), payload: decodePart(parts[1]) };
  } catch (error) {
    return { header: null, payload: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Raw pass-through of a LinkedIn API call so the page can show successes AND errors verbatim. */
export type RawApiResult = { ok: boolean; status: number; data: unknown };

async function getJson(url: string, token: string, extraHeaders?: Record<string, string>): Promise<RawApiResult> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ...(extraHeaders ?? {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/** OIDC userinfo — sub, name, given_name, family_name, picture, locale, email, email_verified. Needs openid/profile/email. */
export function fetchUserinfo(token: string): Promise<RawApiResult> {
  return getJson(USERINFO_URL, token);
}

/**
 * The post-OAuth "what does each scope return" battery. Every readable member-data
 * endpoint LinkedIn exposes, mapped to the scope(s) that unlock it (endpoints +
 * scopes verified against the current Microsoft Learn LinkedIn docs). For a normal
 * (non-partner) app only the OIDC scopes are granted, so the gated probes report
 * "not granted" — which is exactly the per-scope picture this lab is for.
 *
 * Linkedin-Version uses the current YYYYMM moniker; /rest endpoints require it.
 */
const LINKEDIN_VERSION = "202510";

export type DataProbe = {
  key: string;
  label: string;
  description: string;
  kind: "read" | "write-only";
  requiredAnyScope: string[];
  method: string;
  url: string;
  headers?: Record<string, string>;
};

export const DATA_PROBES: DataProbe[] = [
  {
    key: "identity_me",
    label: "Profile details (/identityMe)",
    description: "Verified-on-LinkedIn profile: name, email, public profile URL, photo. (Dev tier: app admins only.)",
    kind: "read",
    requiredAnyScope: ["r_profile_basicinfo"],
    method: "GET",
    url: "https://api.linkedin.com/rest/identityMe",
    headers: { "LinkedIn-Version": LINKEDIN_VERSION },
  },
  {
    key: "verification_report",
    label: "Verification status (/verificationReport)",
    description: "Identity & workplace verification categories. (Dev tier: app admins only.)",
    kind: "read",
    requiredAnyScope: ["r_verify", "r_verify_details"],
    method: "GET",
    url: "https://api.linkedin.com/rest/verificationReport",
    headers: { "LinkedIn-Version": LINKEDIN_VERSION },
  },
  {
    key: "legacy_me",
    label: "Lite/basic profile",
    description: "Legacy /v2/me — id, name, headline, vanityName, profile photo. (Pre-OIDC apps only.)",
    kind: "read",
    requiredAnyScope: ["r_liteprofile", "r_basicprofile"],
    method: "GET",
    url: `${LEGACY_ME_URL}?projection=(id,localizedFirstName,localizedLastName,localizedHeadline,vanityName,profilePicture(displayImage~digitalmediaAsset:playableStreams))`,
    headers: { "X-Restli-Protocol-Version": "2.0.0" },
  },
  {
    key: "legacy_email",
    label: "Primary email (legacy)",
    description: "Email via /v2/clientAwareMemberHandles (the OIDC userinfo email is the modern path).",
    kind: "read",
    requiredAnyScope: ["r_emailaddress"],
    method: "GET",
    url: "https://api.linkedin.com/v2/clientAwareMemberHandles?q=members&projection=(elements*(primary,type,handle~))",
    headers: { "X-Restli-Protocol-Version": "2.0.0" },
  },
  {
    key: "connections_size",
    label: "1st-degree connections (count)",
    description: "Connection count only (paging.total) — the list itself needs the gated r_1st_connections.",
    kind: "read",
    requiredAnyScope: ["r_1st_connections_size", "r_1st_connections"],
    method: "GET",
    url: "https://api.linkedin.com/v2/connections?q=viewer&projection=(paging)",
    headers: { "X-Restli-Protocol-Version": "2.0.0" },
  },
  {
    key: "org_acls",
    label: "Administered organizations",
    description: "Pages this member administers, with role + state (organizationAcls).",
    kind: "read",
    requiredAnyScope: ["r_organization_admin", "rw_organization_admin"],
    method: "GET",
    url: "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee",
    headers: { "X-Restli-Protocol-Version": "2.0.0", "LinkedIn-Version": LINKEDIN_VERSION },
  },
  {
    key: "dma_snapshot",
    label: "DMA member snapshot",
    description: "EU DMA full member-data export across ~70 domains (richest; EEA-gated, partner approval).",
    kind: "read",
    requiredAnyScope: ["r_dma_portability_3rd_party", "r_dma_portability_self_serve", "r_dma_portability_member"],
    method: "GET",
    url: "https://api.linkedin.com/rest/memberSnapshotData?q=criteria",
    headers: { "LinkedIn-Version": LINKEDIN_VERSION },
  },
  {
    key: "w_member_social",
    label: "Share on LinkedIn",
    description: "Write-only — create posts/comments/likes (POST /v2/ugcPosts). No readable member data.",
    kind: "write-only",
    requiredAnyScope: ["w_member_social"],
    method: "POST",
    url: "https://api.linkedin.com/v2/ugcPosts",
    headers: {},
  },
];

export type ProbeResult = {
  key: string;
  label: string;
  description: string;
  kind: "read" | "write-only";
  requiredAnyScope: string[];
  method: string;
  url: string;
  granted: boolean;
  attempted: boolean;
  result?: RawApiResult;
  note?: string;
};

function probeMeta(p: DataProbe) {
  return {
    key: p.key,
    label: p.label,
    description: p.description,
    kind: p.kind,
    requiredAnyScope: p.requiredAnyScope,
    method: p.method,
    url: p.url,
  };
}

/**
 * Run EVERY read probe (granted or not) so the page shows the real raw response —
 * actual data for granted scopes, and the verbatim 401/403 for scopes the app
 * isn't approved for. Write-only scopes (w_member_social) are never called (that
 * would publish a post); they're reported as such. This powers the page's
 * per-scope "here's exactly what LinkedIn returns" breakdown.
 */
export async function runDataProbes(token: string, grantedScopes: string[]): Promise<ProbeResult[]> {
  const granted = new Set(grantedScopes);
  return Promise.all(
    DATA_PROBES.map(async (p): Promise<ProbeResult> => {
      const isGranted = p.requiredAnyScope.some((s) => granted.has(s));
      if (p.kind === "write-only") {
        return {
          ...probeMeta(p),
          granted: isGranted,
          attempted: false,
          note: isGranted ? "Granted — but write-only; there is no endpoint to read member data with this scope." : "Not granted.",
        };
      }
      const result = await getJson(p.url, token, p.headers);
      return {
        ...probeMeta(p),
        granted: isGranted,
        attempted: true,
        result,
        note: isGranted ? undefined : `Scope not granted — showing the raw API response (needs ${p.requiredAnyScope.join(" or ")}).`,
      };
    }),
  );
}
