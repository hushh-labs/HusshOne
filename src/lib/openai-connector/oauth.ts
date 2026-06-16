import type { VerifiedOneUser } from "@/lib/auth/verify";
import { upsertOneUser } from "@/lib/db/scan-store";
import {
  connectorIssuer,
  connectorResource,
  CONNECTOR_SCOPES,
  parseScopes,
  protectedResourceMetadata,
  scopeString,
} from "./config";
import { pkceS256, signConnectorToken, verifyConnectorToken, type SignedTokenPayload } from "./jwt";

export interface ConnectorUser {
  firebaseUid: string;
  email: string;
  name: string | null;
  picture: string | null;
  scopes: string[];
}

export function wwwAuthenticate(request?: Request, scope = scopeString()) {
  return `Bearer resource_metadata="${connectorOriginForHeader(request)}/.well-known/oauth-protected-resource", scope="${scope}"`;
}

function connectorOriginForHeader(request?: Request) {
  const origin = protectedResourceMetadata(request).resource;
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

export function oauthChallengeMeta(request?: Request, message = "Link your one.hushh.ai account to continue.") {
  return {
    "mcp/www_authenticate": [
      `Bearer resource_metadata="${connectorOriginForHeader(request)}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="${message}"`,
    ],
  };
}

function validRedirectUri(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith("/connector/oauth/")) return true;
    if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function createAuthorizationCode(request: Request, verified: VerifiedOneUser, params: Record<string, unknown>) {
  const responseType = String(params.response_type || "");
  const clientId = String(params.client_id || "");
  const redirectUri = String(params.redirect_uri || "");
  const codeChallenge = String(params.code_challenge || "");
  const challengeMethod = String(params.code_challenge_method || "S256");
  const resource = String(params.resource || connectorResource(request));
  const scopes = parseScopes(params.scope);
  if (responseType !== "code") throw Object.assign(new Error("Unsupported OAuth response_type"), { statusCode: 400 });
  if (!clientId) throw Object.assign(new Error("Missing OAuth client_id"), { statusCode: 400 });
  if (!validRedirectUri(redirectUri)) throw Object.assign(new Error("Unsupported OAuth redirect_uri"), { statusCode: 400 });
  if (!codeChallenge || challengeMethod !== "S256") throw Object.assign(new Error("PKCE S256 is required"), { statusCode: 400 });
  if (!scopes.length) throw Object.assign(new Error("No supported one by hushh connector scopes requested"), { statusCode: 400 });

  await upsertOneUser({
    firebaseUid: verified.uid,
    email: verified.email,
    name: verified.name,
    photoUrl: verified.picture,
  }).catch(() => null);

  return signConnectorToken(
    {
      typ: "oauth_code",
      iss: connectorIssuer(request),
      aud: resource,
      sub: verified.uid,
      email: verified.email,
      name: verified.name,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      resource,
      scope: scopeString(scopes),
    },
    5 * 60,
  );
}

export function exchangeAuthorizationCode(request: Request, form: URLSearchParams) {
  const code = form.get("code") || "";
  const verifier = form.get("code_verifier") || "";
  const clientId = form.get("client_id") || "";
  const redirectUri = form.get("redirect_uri") || "";
  const resource = form.get("resource") || connectorResource(request);
  const decoded = verifyConnectorToken(code, "oauth_code");
  if (!verifier || pkceS256(verifier) !== decoded.code_challenge) throw new Error("Invalid PKCE verifier");
  if (decoded.client_id !== clientId) throw new Error("OAuth client mismatch");
  if (decoded.redirect_uri !== redirectUri) throw new Error("OAuth redirect mismatch");
  if ((decoded.resource || decoded.aud) !== resource) throw new Error("OAuth resource mismatch");
  return issueConnectorTokens(request, decoded);
}

export function refreshConnectorAccessToken(request: Request, form: URLSearchParams) {
  const refreshToken = form.get("refresh_token") || "";
  const decoded = verifyConnectorToken(refreshToken, "refresh_token");
  return issueConnectorTokens(request, decoded);
}

function issueConnectorTokens(request: Request, decoded: SignedTokenPayload) {
  const scope = decoded.scope || scopeString(CONNECTOR_SCOPES);
  const base = {
    iss: connectorIssuer(request),
    aud: decoded.resource || decoded.aud || connectorResource(request),
    sub: decoded.sub,
    email: decoded.email,
    name: decoded.name,
    resource: decoded.resource || decoded.aud || connectorResource(request),
    scope,
  };
  const accessToken = signConnectorToken({ ...base, typ: "access_token" }, 60 * 60);
  const refreshToken = signConnectorToken({ ...base, typ: "refresh_token" }, 60 * 60 * 24 * 30);
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope,
  };
}

export function connectorUserFromAuthorization(request: Request): ConnectorUser {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw Object.assign(new Error("Missing connector bearer token"), { statusCode: 401 });
  const decoded = verifyConnectorToken(token, "access_token");
  const expectedResource = connectorResource(request);
  if (decoded.aud !== expectedResource && decoded.resource !== expectedResource) {
    throw Object.assign(new Error("Connector token audience mismatch"), { statusCode: 401 });
  }
  if (!decoded.email) throw Object.assign(new Error("Connector token is missing email"), { statusCode: 401 });
  return {
    firebaseUid: decoded.sub,
    email: decoded.email,
    name: decoded.name ?? null,
    picture: null,
    scopes: (decoded.scope || "").split(/\s+/).filter(Boolean),
  };
}

export function verifiedOneUserFromConnector(user: ConnectorUser): VerifiedOneUser {
  return { uid: user.firebaseUid, email: user.email, name: user.name, picture: user.picture };
}

export function requireConnectorScopes(user: ConnectorUser, scopes: string[]) {
  const owned = new Set(user.scopes);
  const missing = scopes.filter((scope) => !owned.has(scope));
  if (missing.length) {
    throw Object.assign(new Error(`Missing connector scope: ${missing.join(", ")}`), { statusCode: 403 });
  }
}
