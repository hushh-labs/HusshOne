import crypto from "node:crypto";
import { connectorJwtSecret } from "./config";

export interface SignedTokenPayload {
  typ: "oauth_code" | "access_token" | "refresh_token";
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  name?: string | null;
  scope?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  resource?: string;
  iat?: number;
  exp?: number;
  jti?: string;
}

function b64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function jsonB64(value: unknown) {
  return b64url(JSON.stringify(value));
}

function sign(data: string) {
  return crypto.createHmac("sha256", connectorJwtSecret()).update(data).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function pkceS256(verifier: string) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function signConnectorToken(payload: Omit<SignedTokenPayload, "iat" | "exp" | "jti">, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body: SignedTokenPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const encoded = `${jsonB64({ alg: "HS256", typ: "JWT" })}.${jsonB64(body)}`;
  return `${encoded}.${sign(encoded)}`;
}

export function verifyConnectorToken(token: string, expectedType: SignedTokenPayload["typ"]): SignedTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed connector token");
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  if (!safeEqual(signature, expected)) throw new Error("Invalid connector token signature");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SignedTokenPayload;
  if (decoded.typ !== expectedType) throw new Error("Unexpected connector token type");
  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.exp !== "number" || decoded.exp <= now) throw new Error("Connector token expired");
  if (typeof decoded.iat === "number" && decoded.iat > now + 60) throw new Error("Connector token not active");
  return decoded;
}
