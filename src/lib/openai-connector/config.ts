export const CONNECTOR_SCOPES = [
  "one.profile.read",
  "one.social.read",
  "one.scan.read",
  "one.social.write",
] as const;

export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

const DEFAULT_ORIGIN = "https://one.hushh.ai";

export function connectorOrigin(request?: Request): string {
  const configured = (process.env.CONNECTOR_PUBLIC_ORIGIN || process.env.ONE_SITE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (request) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
    if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  }
  return DEFAULT_ORIGIN;
}

export function connectorResource(request?: Request): string {
  return (process.env.CONNECTOR_RESOURCE || connectorOrigin(request)).trim().replace(/\/+$/, "");
}

export function connectorIssuer(request?: Request): string {
  return (process.env.CONNECTOR_ISSUER || connectorOrigin(request)).trim().replace(/\/+$/, "");
}

export function connectorJwtSecret(): string {
  const secret = (process.env.CONNECTOR_JWT_SECRET || "").trim();
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "local-dev-openai-connector-secret";
  throw Object.assign(new Error("OpenAI connector token secret is not configured."), { statusCode: 503 });
}

export function scopeString(scopes: readonly string[] = CONNECTOR_SCOPES): string {
  return scopes.join(" ");
}

export function parseScopes(value: unknown): ConnectorScope[] {
  const requested = typeof value === "string" && value.trim() ? value.split(/\s+/) : [...CONNECTOR_SCOPES];
  const allowed = new Set<string>(CONNECTOR_SCOPES);
  return requested.filter((scope): scope is ConnectorScope => allowed.has(scope));
}

export function protectedResourceMetadata(request?: Request) {
  const origin = connectorOrigin(request);
  const resource = connectorResource(request);
  return {
    resource,
    authorization_servers: [connectorIssuer(request)],
    scopes_supported: CONNECTOR_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/docs/openai-connector`,
  };
}

export function authorizationServerMetadata(request?: Request) {
  const origin = connectorOrigin(request);
  const issuer = connectorIssuer(request);
  return {
    issuer,
    authorization_endpoint: `${origin}/connector/oauth/authorize`,
    token_endpoint: `${origin}/api/openai/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: CONNECTOR_SCOPES,
    resource_parameter_supported: true,
  };
}
