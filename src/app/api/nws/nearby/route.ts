import { clientIp, rateLimited } from "@/lib/api/rate-limit";
import {
  type NearbyClientError,
  curateNearbyUpstreamResponse,
  validateNearbyClientRequest,
} from "@/lib/nws/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const NWS_UPSTREAM_URL =
  "https://nws-nearby-intelligence-fro3hygenq-uc.a.run.app/v3/nearby-net-worth/discover";
export const MAX_NWS_REQUEST_BYTES = 32 * 1_024;
export const NWS_UPSTREAM_TIMEOUT_MS = 25_000;

const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1_024 * 1_024;
const RATE_LIMIT_REQUESTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

class BodyTooLargeError extends Error {}

function errorResponse(
  status: number,
  code: NearbyClientError["code"],
  message: string,
  retryable: boolean,
  retryAfter?: number,
) {
  const headers = new Headers(RESPONSE_HEADERS);
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));

  return Response.json(
    {
      ok: false,
      code,
      message,
      retryable,
    } satisfies NearbyClientError,
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

function mapUpstreamError(response: Response) {
  if (response.status === 413) {
    return errorResponse(413, "request_too_large", "Request is too large.", false);
  }
  if (response.status === 422) {
    return errorResponse(422, "invalid_request", "Check the location and try again.", false);
  }
  if (response.status === 429) {
    return errorResponse(
      429,
      "rate_limited",
      "Too many searches. Try again shortly.",
      true,
      safeRetryAfter(response.headers.get("retry-after")),
    );
  }
  if (response.status === 401 || response.status === 403) {
    return errorResponse(503, "service_unavailable", "Nearby search is unavailable.", true, 60);
  }
  if (response.status >= 500) {
    return errorResponse(503, "service_unavailable", "Nearby search is unavailable.", true, 30);
  }

  return errorResponse(
    502,
    "invalid_upstream_response",
    "Nearby search returned an invalid response.",
    true,
    30,
  );
}

export async function POST(request: Request) {
  if (rateLimited(`nws:${clientIp(request)}`, RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)) {
    return errorResponse(
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
      415,
      "unsupported_media_type",
      "Send a JSON request.",
      false,
    );
  }

  const apiKey = process.env.NWS_NEARBY_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(503, "service_unavailable", "Nearby search is unavailable.", true, 60);
  }

  let input: unknown;
  try {
    input = await readJsonWithinLimit(request.body, MAX_NWS_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return errorResponse(413, "request_too_large", "Request is too large.", false);
    }
    return errorResponse(400, "invalid_json", "Send valid JSON.", false);
  }

  const parsedRequest = validateNearbyClientRequest(input);
  if (!parsedRequest.success) {
    return errorResponse(422, "invalid_request", "Check the location and try again.", false);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NWS_UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(NWS_UPSTREAM_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-NWS-API-Key": apiKey,
      },
      body: JSON.stringify(parsedRequest.data),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });

    if (!upstream.ok) return mapUpstreamError(upstream);

    let upstreamBody: unknown;
    try {
      upstreamBody = await readJsonWithinLimit(upstream.body, MAX_UPSTREAM_RESPONSE_BYTES);
    } catch {
      if (controller.signal.aborted) {
        return errorResponse(504, "upstream_timeout", "Nearby search timed out.", true, 15);
      }
      return errorResponse(
        502,
        "invalid_upstream_response",
        "Nearby search returned an invalid response.",
        true,
        30,
      );
    }

    try {
      const curated = curateNearbyUpstreamResponse(upstreamBody);
      return Response.json(curated, { status: 200, headers: RESPONSE_HEADERS });
    } catch {
      return errorResponse(
        502,
        "invalid_upstream_response",
        "Nearby search returned an invalid response.",
        true,
        30,
      );
    }
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return errorResponse(504, "upstream_timeout", "Nearby search timed out.", true, 15);
    }
    return errorResponse(503, "service_unavailable", "Nearby search is unavailable.", true, 30);
  } finally {
    clearTimeout(timeout);
  }
}
