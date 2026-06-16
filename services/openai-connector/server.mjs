import crypto from "node:crypto";
import http from "node:http";

const port = Number(process.env.PORT || 8080);
const authorizationOrigin = trimOrigin(process.env.CONNECTOR_AUTHORIZATION_ORIGIN || "https://one.hushh.ai");
const oneToolUrl = process.env.ONE_CONNECTOR_TOOL_URL || "https://one.hushh.ai/api/openai/connector/tool";
const oneToolApiKey = String(process.env.ONE_CONNECTOR_TOOL_API_KEY || "").trim();
const jwtSecret = String(process.env.CONNECTOR_JWT_SECRET || "").trim();
const configuredOrigin = trimOrigin(process.env.CONNECTOR_PUBLIC_ORIGIN || "");
const configuredResource = trimOrigin(process.env.CONNECTOR_RESOURCE || "");
const configuredIssuer = trimOrigin(process.env.CONNECTOR_ISSUER || "");
const appChallengeToken = String(process.env.OPENAI_APPS_CHALLENGE_TOKEN || "").trim();

const CONNECTOR_SCOPES = ["one.profile.read", "one.social.read", "one.scan.read", "one.social.write"];

const readSecurity = [{ type: "oauth2", scopes: ["one.profile.read", "one.social.read", "one.scan.read"] }];
const socialWriteSecurity = [{ type: "oauth2", scopes: ["one.profile.read", "one.social.read", "one.social.write"] }];

const searchOutputSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          metadata: { type: "object", additionalProperties: true },
        },
        required: ["id", "title", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const recordOutputSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    text: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["id", "title", "url", "text"],
  additionalProperties: false,
};

const accountOutputSchema = {
  type: "object",
  properties: { account: { type: ["object", "null"], additionalProperties: true } },
  required: ["account"],
  additionalProperties: false,
};

const socialProfileOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    normalizedUrl: { type: "string" },
    profile: { type: "object", additionalProperties: true },
    access: { type: "object", additionalProperties: true },
    code: { type: "string" },
  },
  required: ["ok", "normalizedUrl"],
  additionalProperties: true,
};

const scanStatusOutputSchema = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    scanRunId: { type: ["string", "null"] },
    status: { type: "string" },
    result: { type: ["object", "array", "string", "number", "boolean", "null"] },
    error: { type: ["string", "null"] },
    emailDelivery: { type: ["object", "null"], additionalProperties: true },
    createdAt: { type: ["string", "null"] },
  },
  required: ["ok", "scanRunId", "status", "result", "error", "emailDelivery"],
  additionalProperties: false,
};

const connectorTools = [
  {
    name: "search",
    title: "Search HushhOne",
    description: "Use this when the user asks to search their HushhOne profile, connected social context, scan reports, or public-footprint findings.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query over the linked user's HushhOne records." },
        type: { type: "string", enum: ["all", "account", "linkedin", "social", "social_access", "scan"], default: "all" },
        limit: { type: "number", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "fetch",
    title: "Fetch HushhOne record",
    description: "Use this when the user needs the full contents of a HushhOne search result by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Opaque id returned by search." } },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: recordOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "one_get_account_context",
    title: "Get HushhOne account context",
    description: "Use this when the user asks what HushhOne knows about their linked account, profile connections, or latest scan state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: accountOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readSecurity,
  },
  {
    name: "one_connect_linkedin_url",
    title: "Connect LinkedIn URL",
    description: "Use this when the user explicitly asks to connect or refresh their LinkedIn profile URL in HushhOne.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "LinkedIn personal profile URL, usually https://www.linkedin.com/in/<handle>/." } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: socialProfileOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    securitySchemes: socialWriteSecurity,
  },
  {
    name: "one_connect_instagram_url",
    title: "Connect Instagram URL",
    description: "Use this when the user explicitly asks to connect or refresh an Instagram profile URL in HushhOne. This can request access for private profiles.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Instagram profile URL, usually https://www.instagram.com/<handle>/." } },
      required: ["url"],
      additionalProperties: false,
    },
    outputSchema: socialProfileOutputSchema,
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    securitySchemes: socialWriteSecurity,
  },
  {
    name: "one_get_scan_status",
    title: "Get HushhOne scan status",
    description: "Use this when the user asks for a specific HushhOne scan status by scanRunId, or asks for their latest saved scan state.",
    inputSchema: {
      type: "object",
      properties: { scanRunId: { type: "string", description: "Optional scan id returned by HushhOne. Omit to return the linked user's latest scan." } },
      additionalProperties: false,
    },
    outputSchema: scanStatusOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: [{ type: "oauth2", scopes: ["one.scan.read"] }],
  },
];

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    if (request.method === "OPTIONS") return sendText(response, 204, "");

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        service: "hushhone-openai-connector",
        mode: "standalone",
        origin: connectorOrigin(request),
        authorizationOrigin,
        oneToolUrl,
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method === "GET" && requestUrl.pathname === "/.well-known/openai-apps-challenge") {
      if (!appChallengeToken) return sendJson(response, 404, { error: "OpenAI app domain challenge token is not configured." });
      return sendText(response, 200, appChallengeToken, { "Content-Type": "text/plain; charset=utf-8" });
    }

    if (request.method === "GET" && requestUrl.pathname === "/.well-known/oauth-protected-resource") {
      return sendJson(response, 200, protectedResourceMetadata(request));
    }

    if (
      request.method === "GET" &&
      (requestUrl.pathname === "/.well-known/oauth-authorization-server" || requestUrl.pathname === "/.well-known/openid-configuration")
    ) {
      return sendJson(response, 200, authorizationServerMetadata(request));
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/openai/oauth/register") {
      return sendJson(response, 201, await dynamicClientRegistration(request));
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/openai/oauth/token") {
      const form = new URLSearchParams(await readText(request));
      const grantType = form.get("grant_type");
      if (grantType === "authorization_code") return sendJson(response, 200, exchangeAuthorizationCode(request, form));
      if (grantType === "refresh_token") return sendJson(response, 200, refreshConnectorAccessToken(request, form));
      return sendJson(response, 400, { error: "unsupported_grant_type", error_description: "Use authorization_code or refresh_token." });
    }

    if (request.method === "GET" && requestUrl.pathname === "/mcp") {
      return sendJson(response, 200, { ok: true, service: "hushhone-openai-connector", mode: "standalone", endpoint: "/mcp" });
    }

    if (request.method === "POST" && requestUrl.pathname === "/mcp") {
      return sendJson(response, 200, await handleMcpRequest(request), { "Mcp-Session-Id": "hushhone-openai-connector" });
    }

    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(JSON.stringify({ event: "request.failed", error: error instanceof Error ? error.message : String(error) }));
    return sendJson(response, error?.statusCode || 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, () => {
  console.log(JSON.stringify({ event: "server.started", service: "hushhone-openai-connector", port }));
});

async function handleMcpRequest(request) {
  let body;
  try {
    body = JSON.parse(await readText(request));
  } catch {
    return rpcError(null, -32700, "Invalid JSON-RPC body");
  }
  const calls = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(calls.map((item) => handleOne(request, item)))).filter(Boolean);
  if (!responses.length) return null;
  return Array.isArray(body) ? responses : responses[0];
}

async function handleOne(request, rpc) {
  if (!rpc?.id && String(rpc?.method || "").startsWith("notifications/")) return null;
  switch (rpc?.method) {
    case "initialize":
      return rpcResult(rpc.id, {
        protocolVersion: typeof rpc.params?.protocolVersion === "string" ? rpc.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "hushhone-openai-connector", version: "0.1.0" },
        instructions:
          "Use this connector only for the linked user's HushhOne account, profiles, social context, and scan records. Never expose secrets or scraper session data.",
      });
    case "tools/list":
      return rpcResult(rpc.id, { tools: connectorTools });
    case "tools/call":
      return rpcResult(rpc.id, await callConnectorTool(request, String(rpc.params?.name || ""), rpc.params?.arguments));
    case "ping":
      return rpcResult(rpc.id, {});
    default:
      return rpcError(rpc?.id, -32601, `Unsupported MCP method: ${rpc?.method || "unknown"}`);
  }
}

async function callConnectorTool(request, name, args) {
  let user;
  try {
    user = connectorUserFromAuthorization(request);
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "Authentication required: link your HushhOne account to continue." }],
      _meta: oauthChallengeMeta(request),
    };
  }

  if (!oneToolApiKey) {
    return {
      isError: true,
      structuredContent: { ok: false, code: "bridge_not_configured" },
      content: [{ type: "text", text: "The HushhOne connector data bridge is not configured." }],
    };
  }

  const upstream = await fetch(oneToolUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${oneToolApiKey}`,
    },
    body: JSON.stringify({ user, name, arguments: args || {} }),
  });
  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { isError: true, content: [{ type: "text", text: text || "HushhOne bridge returned a non-JSON response." }] };
  }
  if (!upstream.ok) {
    return {
      isError: true,
      structuredContent: { ok: false, code: "bridge_error", status: upstream.status, detail: payload },
      content: [{ type: "text", text: payload?.error || "HushhOne bridge request failed." }],
    };
  }
  return payload;
}

function exchangeAuthorizationCode(request, form) {
  const code = form.get("code") || "";
  const verifier = form.get("code_verifier") || "";
  const clientId = form.get("client_id") || "";
  const redirectUri = form.get("redirect_uri") || "";
  const resource = form.get("resource") || connectorResource(request);
  const decoded = verifyConnectorToken(code, "oauth_code");
  if (!verifier || pkceS256(verifier) !== decoded.code_challenge) throw oauthError("Invalid PKCE verifier");
  if (decoded.client_id !== clientId) throw oauthError("OAuth client mismatch");
  if (decoded.redirect_uri !== redirectUri) throw oauthError("OAuth redirect mismatch");
  if ((decoded.resource || decoded.aud) !== resource) throw oauthError("OAuth resource mismatch");
  return issueConnectorTokens(request, decoded, resource);
}

function refreshConnectorAccessToken(request, form) {
  const refreshToken = form.get("refresh_token") || "";
  const decoded = verifyConnectorToken(refreshToken, "refresh_token");
  return issueConnectorTokens(request, decoded, decoded.resource || decoded.aud || connectorResource(request));
}

function issueConnectorTokens(request, decoded, resource) {
  const scope = decoded.scope || scopeString(CONNECTOR_SCOPES);
  const base = {
    iss: connectorIssuer(request),
    aud: resource,
    sub: decoded.sub,
    email: decoded.email,
    name: decoded.name,
    resource,
    scope,
  };
  const accessToken = signConnectorToken({ ...base, typ: "access_token" }, 60 * 60);
  const refreshToken = signConnectorToken({ ...base, typ: "refresh_token" }, 60 * 60 * 24 * 30);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 3600, scope };
}

function connectorUserFromAuthorization(request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw oauthError("Missing connector bearer token", 401);
  const decoded = verifyConnectorToken(token, "access_token");
  const expectedResource = connectorResource(request);
  if (decoded.aud !== expectedResource && decoded.resource !== expectedResource) throw oauthError("Connector token audience mismatch", 401);
  if (!decoded.email) throw oauthError("Connector token is missing email", 401);
  return {
    firebaseUid: decoded.sub,
    email: decoded.email,
    name: decoded.name ?? null,
    picture: null,
    scopes: String(decoded.scope || "").split(/\s+/).filter(Boolean),
  };
}

function protectedResourceMetadata(request) {
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

function authorizationServerMetadata(request) {
  const origin = connectorOrigin(request);
  return {
    issuer: connectorIssuer(request),
    authorization_endpoint: `${authorizationOrigin}/connector/oauth/authorize`,
    token_endpoint: `${origin}/api/openai/oauth/token`,
    registration_endpoint: `${origin}/api/openai/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: CONNECTOR_SCOPES,
    resource_parameter_supported: true,
  };
}

async function dynamicClientRegistration(request) {
  const bodyText = await readText(request);
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw oauthError("Invalid dynamic client registration body");
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((item) => typeof item === "string" && validRedirectUri(item))
    : [];
  if (!redirectUris.length) throw oauthError("Dynamic registration requires at least one supported redirect_uri");
  return {
    client_id: "hushhone-chatgpt",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: scopeString(CONNECTOR_SCOPES),
  };
}

function validRedirectUri(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com" && url.pathname.startsWith("/connector/oauth/");
  } catch {
    return false;
  }
}

function oauthChallengeMeta(request, message = "Link your HushhOne account to continue.") {
  const resourceUrl = `${connectorOrigin(request)}/.well-known/oauth-protected-resource`;
  return {
    "mcp/www_authenticate": [
      `Bearer resource_metadata="${resourceUrl}", error="insufficient_scope", error_description="${message}"`,
    ],
  };
}

function connectorOrigin(request) {
  if (configuredOrigin) return configuredOrigin;
  const proto = String(request.headers["x-forwarded-proto"] || "https").split(",")[0].trim() || "https";
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return host ? trimOrigin(`${proto}://${host}`) : "http://localhost";
}

function connectorResource(request) {
  return configuredResource || connectorOrigin(request);
}

function connectorIssuer(request) {
  return configuredIssuer || connectorOrigin(request);
}

function scopeString(scopes = CONNECTOR_SCOPES) {
  return scopes.join(" ");
}

function trimOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function oauthError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function pkceS256(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function signConnectorToken(payload, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds, jti: crypto.randomUUID() };
  const encoded = `${jsonB64({ alg: "HS256", typ: "JWT" })}.${jsonB64(body)}`;
  return `${encoded}.${sign(encoded)}`;
}

function verifyConnectorToken(token, expectedType) {
  if (!jwtSecret) throw oauthError("OpenAI connector token secret is not configured.", 503);
  const parts = token.split(".");
  if (parts.length !== 3) throw oauthError("Malformed connector token");
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  if (!safeEqual(signature, expected)) throw oauthError("Invalid connector token signature");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (decoded.typ !== expectedType) throw oauthError("Unexpected connector token type");
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp !== "number" || decoded.exp <= now) throw oauthError("Connector token expired");
  if (typeof decoded.iat === "number" && decoded.iat > now + 60) throw oauthError("Connector token not active");
  return decoded;
}

function sign(data) {
  return crypto.createHmac("sha256", jwtSecret).update(data).digest("base64url");
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function jsonB64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function rpcResult(id, value) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(),
    ...extraHeaders,
  });
  response.end(body === null ? "" : JSON.stringify(body));
}

function sendText(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    ...corsHeaders(),
    ...extraHeaders,
  });
  response.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
