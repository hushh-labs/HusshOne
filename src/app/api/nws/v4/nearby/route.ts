import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { clientIp, rateLimited } from "@/lib/api/rate-limit";
import { verifyOneRequest } from "@/lib/auth/verify";
import {
  CoordinateConsentReceiptSchema,
  NWS_V4_MODEL_VERSION,
  NWS_V4_PROJECT_ID,
  NWS_V4_PURPOSE_ID,
  type NearbyV4ClientError,
  type NearbyV4NormalizedRequest,
  curateNearbyV4UpstreamResponse,
  validateNearbyV4ClientRequest,
} from "@/lib/nws/v4-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const DEFAULT_NWS_V4_BASE_URL =
  "https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app";
export const NWS_V4_DISCOVER_PATH = "/v4/net-worth/discover";
export const NWS_V4_CONSENT_PATH = "/v4/location-consent/receipt";
export const MAX_NWS_REQUEST_BYTES = 32 * 1_024;
export const NWS_UPSTREAM_TIMEOUT_MS = 25_000;

const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const MAX_CONSENT_RESPONSE_BYTES = 64 * 1_024;
const RATE_LIMIT_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ALLOWED_NWS_V4_ORIGINS = new Set([new URL(DEFAULT_NWS_V4_BASE_URL).origin]);

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

class BodyTooLargeError extends Error {}

function errorResponse(
  requestId: string,
  status: number,
  code: NearbyV4ClientError["code"],
  message: string,
  retryable: boolean,
  retryAfter?: number,
  nwsRequestId?: string | null,
) {
  const headers = new Headers(RESPONSE_HEADERS);
  headers.set("X-Request-ID", requestId);
  if (nwsRequestId) headers.set("X-NWS-Request-ID", nwsRequestId);
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));

  return Response.json(
    {
      ok: false,
      code,
      message,
      retryable,
    } satisfies NearbyV4ClientError,
    { status, headers },
  );
}

async function readStreamWithinLimit(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

async function readJsonWithinLimit(stream: ReadableStream<Uint8Array> | null, maximumBytes: number) {
  const text = await readStreamWithinLimit(stream, maximumBytes);
  return JSON.parse(text) as unknown;
}

function safeRetryAfter(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 60;
  return Math.min(3_600, Math.max(1, Number.parseInt(value, 10)));
}

function safeNwsRequestId(response: Response): string | null {
  const value = response.headers.get("x-request-id")?.trim() ?? "";
  return /^req-[0-9a-f]{32}$/.test(value) ? value : null;
}

function mapUpstreamError(
  requestId: string,
  response: Response,
  stage: "consent" | "discover",
) {
  const nwsRequestId = safeNwsRequestId(response);
  if (response.status === 413) {
    return errorResponse(
      requestId,
      413,
      "request_too_large",
      "Request is too large.",
      false,
      undefined,
      nwsRequestId,
    );
  }
  if (response.status === 429) {
    return errorResponse(
      requestId,
      429,
      "rate_limited",
      "Too many searches. Try again shortly.",
      true,
      safeRetryAfter(response.headers.get("retry-after")),
      nwsRequestId,
    );
  }
  if (response.status === 409 && stage === "discover") {
    return errorResponse(
      requestId,
      409,
      "coverage_unavailable",
      "This search cannot be satisfied yet.",
      false,
      undefined,
      nwsRequestId,
    );
  }
  if (response.status === 422 && stage === "discover") {
    return errorResponse(
      requestId,
      422,
      "invalid_request",
      "Check the location and try again.",
      false,
      undefined,
      nwsRequestId,
    );
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 422 ||
    response.status >= 500
  ) {
    return errorResponse(
      requestId,
      503,
      "service_unavailable",
      "Nearby search is unavailable.",
      true,
      30,
      nwsRequestId,
    );
  }

  return errorResponse(
    requestId,
    502,
    "invalid_upstream_response",
    "Nearby search returned an invalid response.",
    true,
    30,
    nwsRequestId,
  );
}

function resolveUpstreamBaseUrl(): URL | null {
  const raw = process.env.NWS_NEARBY_V4_BASE_URL?.trim() || DEFAULT_NWS_V4_BASE_URL;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !ALLOWED_NWS_V4_ORIGINS.has(url.origin) ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function upstreamUrl(baseUrl: URL, pathname: string): string {
  return new URL(pathname, baseUrl).toString();
}

function upstreamHeaders(apiKey: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-NWS-API-Key": apiKey,
  };
}

async function fetchUpstream(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
) {
  return fetch(url, {
    method: "POST",
    headers: upstreamHeaders(apiKey),
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
    signal,
  });
}

function discoveryBody(
  request: NearbyV4NormalizedRequest,
  auditActor: string,
  coordinateConsent?: unknown,
) {
  return {
    query: request.query,
    selection: {
      count: request.count,
      financial_mode: "estimated",
      geography_mode: "nearest-count",
    },
    filters: {
      minimum_confidence: "C",
      minimum_coverage: 0.55,
      asset_families: [],
    },
    caller_context: {
      project_id: NWS_V4_PROJECT_ID,
      purpose_id: NWS_V4_PURPOSE_ID,
      authorization_scope: "PUBLIC_SAFE",
      requested_data_tier: "PUBLIC_SAFE",
      audit_actor: auditActor,
      model_version: NWS_V4_MODEL_VERSION,
    },
    ...(coordinateConsent === undefined ? {} : { coordinate_consent: coordinateConsent }),
  };
}

function auditActorForUser(uid: string, actorHmacKey: string): string {
  const reference = createHmac("sha256", actorHmacKey)
    .update(`${NWS_V4_PROJECT_ID}\0${uid}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `one-user:${reference}`;
}

function auditActorReference(auditActor: string): string {
  const reference = createHash("sha256")
    .update(`${NWS_V4_PROJECT_ID}\0${auditActor}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `actor_${reference}`;
}

export async function POST(request: Request) {
  const requestId = `nwsbff_${randomUUID()}`;
  if (rateLimited(`nws-v4:${clientIp(request)}`, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return errorResponse(
      requestId,
      429,
      "rate_limited",
      "Too many searches. Try again shortly.",
      true,
      60,
    );
  }

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(
      requestId,
      415,
      "unsupported_media_type",
      "Send a JSON request.",
      false,
    );
  }

  let verifiedUser: Awaited<ReturnType<typeof verifyOneRequest>>;
  try {
    verifiedUser = await verifyOneRequest(request.headers.get("authorization"));
  } catch (error) {
    const status =
      error instanceof Error && "statusCode" in error && error.statusCode === 401 ? 401 : 503;
    return errorResponse(
      requestId,
      status,
      status === 401 ? "authentication_required" : "service_unavailable",
      status === 401 ? "Sign in to search." : "Nearby search is unavailable.",
      status !== 401,
      status === 401 ? undefined : 30,
    );
  }

  const apiKey = process.env.NWS_NEARBY_V4_API_KEY?.trim();
  const actorHmacKey = process.env.NWS_NEARBY_V4_ACTOR_HMAC_KEY?.trim();
  const baseUrl = resolveUpstreamBaseUrl();
  if (
    !apiKey ||
    !actorHmacKey ||
    Buffer.byteLength(actorHmacKey, "utf8") < 32 ||
    Buffer.byteLength(actorHmacKey, "utf8") > 4_096 ||
    !baseUrl
  ) {
    return errorResponse(
      requestId,
      503,
      "service_unavailable",
      "Nearby search is unavailable.",
      true,
      60,
    );
  }
  const auditActor = auditActorForUser(verifiedUser.uid, actorHmacKey);

  let input: unknown;
  try {
    input = await readJsonWithinLimit(request.body, MAX_NWS_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return errorResponse(
        requestId,
        413,
        "request_too_large",
        "Request is too large.",
        false,
      );
    }
    return errorResponse(requestId, 400, "invalid_json", "Send valid JSON.", false);
  }

  const parsedRequest = validateNearbyV4ClientRequest(input);
  if (!parsedRequest.success) {
    return errorResponse(
      requestId,
      422,
      "invalid_request",
      "Check the location and try again.",
      false,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NWS_UPSTREAM_TIMEOUT_MS);
  const usesCoordinates = "latitude" in parsedRequest.data.query;

  try {
    let coordinateConsent: unknown;
    let consentNwsRequestId: string | null = null;
    if (usesCoordinates) {
      console.info(
        "nws_location_consent",
        JSON.stringify({
          actor_reference: auditActor,
          consent_granted: true,
          project_id: NWS_V4_PROJECT_ID,
          purpose_id: NWS_V4_PURPOSE_ID,
          request_id: requestId,
          scope: "APPROXIMATE_LOCATION_QUERY",
        }),
      );
      const consentResponse = await fetchUpstream(
        upstreamUrl(baseUrl, NWS_V4_CONSENT_PATH),
        apiKey,
        {
          project_id: NWS_V4_PROJECT_ID,
          purpose_id: NWS_V4_PURPOSE_ID,
          audit_actor: auditActor,
          scope: "APPROXIMATE_LOCATION_QUERY",
          consent_granted: true,
        },
        controller.signal,
      );
      consentNwsRequestId = safeNwsRequestId(consentResponse);
      if (!consentResponse.ok) return mapUpstreamError(requestId, consentResponse, "consent");

      try {
        const parsedConsent = CoordinateConsentReceiptSchema.parse(
          await readJsonWithinLimit(consentResponse.body, MAX_CONSENT_RESPONSE_BYTES),
        );
        if (parsedConsent.audit_actor !== auditActor) {
          throw new Error("Consent receipt actor mismatch");
        }
        coordinateConsent = parsedConsent;
      } catch {
        return errorResponse(
          requestId,
          502,
          "invalid_upstream_response",
          "Nearby search returned an invalid response.",
          true,
          30,
          consentNwsRequestId,
        );
      }
    }

    const upstream = await fetchUpstream(
      upstreamUrl(baseUrl, NWS_V4_DISCOVER_PATH),
      apiKey,
      discoveryBody(parsedRequest.data, auditActor, coordinateConsent),
      controller.signal,
    );
    const discoverNwsRequestId = safeNwsRequestId(upstream);
    if (!upstream.ok) return mapUpstreamError(requestId, upstream, "discover");

    let upstreamBody: unknown;
    try {
      upstreamBody = await readJsonWithinLimit(upstream.body, MAX_UPSTREAM_RESPONSE_BYTES);
    } catch {
      if (controller.signal.aborted) {
        return errorResponse(
          requestId,
          504,
          "upstream_timeout",
          "Nearby search timed out.",
          true,
          15,
          discoverNwsRequestId,
        );
      }
      return errorResponse(
        requestId,
        502,
        "invalid_upstream_response",
        "Nearby search returned an invalid response.",
        true,
        30,
        discoverNwsRequestId,
      );
    }

    try {
      const curated = curateNearbyV4UpstreamResponse(upstreamBody, {
        auditActorReference: auditActorReference(auditActor),
        count: parsedRequest.data.count,
        queryMode: usesCoordinates ? "COARSE_COORDINATE" : "POSTAL_CODE",
      });
      const headers = new Headers(RESPONSE_HEADERS);
      headers.set("X-Request-ID", requestId);
      if (discoverNwsRequestId) headers.set("X-NWS-Request-ID", discoverNwsRequestId);
      console.info(
        "nws_request_complete",
        JSON.stringify({
          consent_nws_request_id: consentNwsRequestId,
          nws_request_id: discoverNwsRequestId,
          request_id: requestId,
        }),
      );
      return Response.json(curated, { status: 200, headers });
    } catch {
      return errorResponse(
        requestId,
        502,
        "invalid_upstream_response",
        "Nearby search returned an invalid response.",
        true,
        30,
        discoverNwsRequestId,
      );
    }
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return errorResponse(
        requestId,
        504,
        "upstream_timeout",
        "Nearby search timed out.",
        true,
        15,
      );
    }
    return errorResponse(
      requestId,
      503,
      "service_unavailable",
      "Nearby search is unavailable.",
      true,
      30,
    );
  } finally {
    clearTimeout(timeout);
  }
}
