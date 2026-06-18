/* BYOC (bring-your-own-cloud) GCP credentials for Xtreme Compute Burst.
   Mirrors the dual-mode loader in src/lib/firebase/admin.ts, with one addition: a
   customer may pass their OWN service-account JSON per request so burst jobs run in
   THEIR project. Precedence: per-request creds → BYOC_GCP_* env → Application Default.

   Security: the SA private key lives in memory for the duration of a request only.
   It is NEVER persisted — the BurstJob row stores projectId/region/source, never the
   key. Production hardening (not built here): store an encrypted credential reference
   in Secret Manager (KMS envelope) keyed per user, and resolve it by ref at runtime. */
import { GoogleAuth, JWT } from "google-auth-library";
import { BoundedLru } from "./lru";
import type { RequestByocCreds, ResolvedGcpCreds } from "./types";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_REGION = "us-central1";

/* Minimal token-source contract satisfied by both a service-account JWT and an ADC
   client. getAccessToken() caches the token internally and only refreshes it shortly
   before expiry — so reusing ONE client per credential avoids re-signing a JWT (or
   re-reading ADC) on every status poll. */
interface TokenSource {
  getAccessToken(): Promise<{ token?: string | null }>;
}

// Cap the auth-client cache so a process serving many distinct BYOC service accounts
// keeps memory flat (LRU-evicts cold tenants) rather than retaining a JWT per tenant
// forever. 256 hot tenants is plenty; an evicted client is simply rebuilt on next use.
const MAX_CACHED_CLIENTS = Number.parseInt(process.env.ONE_BURST_AUTH_CACHE_SIZE || "", 10) || 256;
const clientCache = new BoundedLru<string, TokenSource>(MAX_CACHED_CLIENTS);

function credentialKey(creds: ResolvedGcpCreds): string {
  return creds.serviceAccountJson
    ? `sa:${creds.serviceAccountJson.client_email}`
    : `adc:${creds.projectId}`;
}

/** Test-only: drop the cached auth clients so a test starts from a clean slate. */
export function __resetAuthClientCacheForTests(): void {
  clientCache.clear();
}

type ServiceAccountJson = NonNullable<ResolvedGcpCreds["serviceAccountJson"]>;

function parseServiceAccountJson(raw: string): ServiceAccountJson {
  let parsed: { client_email?: string; private_key?: string; project_id?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("BYOC service-account JSON is not valid JSON"), { statusCode: 400 });
  }
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    throw Object.assign(
      new Error("BYOC service-account JSON must include client_email, private_key, and project_id"),
      { statusCode: 400 },
    );
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, project_id: parsed.project_id };
}

/**
 * Resolve the GCP credentials + target project/region for a burst, honoring
 * per-request BYOC creds first, then BYOC_GCP_* env, then Application Default.
 * Throws (statusCode 400/503) when no usable project can be determined.
 */
export function resolveGcpCreds(req?: RequestByocCreds): ResolvedGcpCreds {
  const region = (req?.region || process.env.BYOC_GCP_REGION || DEFAULT_REGION).trim();

  // 1) Per-request service account (the BYOC happy path).
  const requestSaRaw = req?.serviceAccountJson?.trim();
  if (requestSaRaw) {
    const serviceAccountJson = parseServiceAccountJson(requestSaRaw);
    return {
      projectId: (req?.projectId || serviceAccountJson.project_id).trim(),
      region,
      source: "request",
      serviceAccountJson,
    };
  }

  // 2) Server-configured BYOC service account (dogfood / single-tenant deploys).
  const envSaRaw = process.env.BYOC_GCP_SERVICE_ACCOUNT_JSON?.trim();
  if (envSaRaw) {
    const serviceAccountJson = parseServiceAccountJson(envSaRaw);
    return {
      projectId: (req?.projectId || process.env.BYOC_GCP_PROJECT_ID || serviceAccountJson.project_id).trim(),
      region,
      source: "env",
      serviceAccountJson,
    };
  }

  // 3) Application Default Credentials (the Cloud Run runtime service account).
  const projectId = (req?.projectId || process.env.BYOC_GCP_PROJECT_ID || "").trim();
  if (!projectId) {
    throw Object.assign(
      new Error("No GCP project configured for burst — supply BYOC creds or set BYOC_GCP_PROJECT_ID"),
      { statusCode: 503 },
    );
  }
  return { projectId, region, source: "adc" };
}

/**
 * Mint a short-lived OAuth2 access token (cloud-platform scope) for the resolved
 * creds. This is the ONLY use of google-auth-library — every Compute Engine REST
 * call uses the returned bearer token with native fetch.
 *
 * The underlying auth client is cached per credential and reused, so a tight status-
 * poll loop reuses the library's in-memory token (refreshed only near expiry) instead
 * of re-signing a JWT / re-reading ADC on every call.
 */
export async function mintAccessToken(creds: ResolvedGcpCreds): Promise<string> {
  const key = credentialKey(creds);
  let client = clientCache.get(key);
  if (!client) {
    client = creds.serviceAccountJson
      ? new JWT({
          email: creds.serviceAccountJson.client_email,
          key: creds.serviceAccountJson.private_key,
          scopes: [CLOUD_PLATFORM_SCOPE],
        })
      : ((await new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }).getClient()) as unknown as TokenSource);
    clientCache.set(key, client);
  }

  const { token } = await client.getAccessToken();
  if (!token) {
    throw Object.assign(new Error(`Could not mint a GCP access token (${creds.source})`), { statusCode: 502 });
  }
  return token;
}
