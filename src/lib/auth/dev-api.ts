/* Shared-API-key auth for the developer API (/api/v1/*). Keys live in ONE_DEV_API_KEYS (Secret
   Manager) as comma-separated `keyId:secret` pairs, e.g. "acme:sk_live_…,mobile:sk_live_…". A request
   presents `Authorization: Bearer <secret>`; on match we resolve the `keyId`, and the v1 routes own all
   scans under a synthetic user `api:<keyId>` (mirrors the `guest:` convention). Constant-time compare. */
import crypto from "node:crypto";

export class DevApiAuthError extends Error {
  statusCode = 401;
  constructor(message = "Invalid or missing API key") {
    super(message);
    this.name = "DevApiAuthError";
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

interface DevApiKey {
  keyId: string;
  secret: string;
}

function parseKeys(): DevApiKey[] {
  const raw = (process.env.ONE_DEV_API_KEYS || "").trim();
  if (!raw) return [];
  const out: DevApiKey[] = [];
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue; // need a non-empty keyId before ":"
    const keyId = trimmed.slice(0, idx).trim();
    const secret = trimmed.slice(idx + 1).trim();
    if (keyId && secret) out.push({ keyId, secret });
  }
  return out;
}

/** Verify the Bearer secret against ONE_DEV_API_KEYS. Returns the matched `keyId` or throws
 *  DevApiAuthError (401). Fails closed when no keys are configured. */
export function verifyDevApiRequest(request: Request): { keyId: string } {
  const keys = parseKeys();
  if (!keys.length) throw new DevApiAuthError("Developer API is not configured");
  const header = request.headers.get("authorization") || "";
  const provided = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!provided) throw new DevApiAuthError();
  for (const key of keys) {
    if (constantTimeEquals(provided, key.secret)) return { keyId: key.keyId };
  }
  throw new DevApiAuthError();
}

/** Synthetic owner uid for a dev key — mirrors the `guest:<uuid>` convention. */
export function apiOwnerUid(keyId: string): string {
  return `api:${keyId}`;
}
