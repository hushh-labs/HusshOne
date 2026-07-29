/* POST /api/local-discovery/search — open a real-time local discovery search (deliverable #2).

   Posture: same-origin / public / rate-limited (mirrors /api/localfinder), NOT the v1 Bearer API — the
   Phase-1 frontend is a same-origin browser page. This endpoint validates the request, resolves the
   location (coords OR postalCode+countryCode), registers a search session, and returns its id + the
   resolved query + a spend snapshot. It does NOT block on the fan-out: the actual per-category work is
   driven lazily by the SSE stream (GET .../{searchId}/events), so a POST that is never streamed spends
   nothing. A bad/missing location is the only thing that fails this call (4xx). */

import { apiError, apiJson, corsPreflight, statusCodeOf } from "@/lib/api/http";
import { clientIp, rateLimited } from "@/lib/api/rate-limit";
import { V1InputError } from "@/lib/api/v1-input";
import { createDiscoverySearch, streamPathForQuery } from "@/lib/local-discovery/orchestrator";
import { spendSnapshot } from "@/lib/local-discovery/spend";

export const runtime = "nodejs";
export const maxDuration = 30;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  try {
    if (rateLimited(clientIp(request))) {
      return apiError(429, "rate_limited", "Too many requests — please slow down.");
    }

    const body = await request.json().catch(() => ({}));
    const { session, query, warnings } = await createDiscoverySearch(body);

    const base = `/api/local-discovery/search/${session.searchId}`;
    return apiJson(
      {
        ok: true,
        searchId: session.searchId,
        query,
        warnings,
        // `stream` carries the query params so the SSE client can (re)attach on any instance (see orchestrator).
        links: { self: base, events: `${base}/events`, stream: streamPathForQuery(session.searchId, query) },
        spend: spendSnapshot(),
      },
      202,
    );
  } catch (error) {
    const isInput = error instanceof V1InputError;
    const status = isInput ? error.statusCode : statusCodeOf(error, 502);
    const code = isInput ? error.code : "discovery_search_failed";
    const message = error instanceof Error ? error.message : "Could not start discovery search";
    console[status >= 500 ? "error" : "warn"](
      JSON.stringify({
        event: "one.local_discovery.search_failed",
        severity: status >= 500 ? "ERROR" : "WARNING",
        status,
        code,
        message,
      }),
    );
    // Don't leak internal error detail to unauthenticated callers on 5xx; input errors carry a safe message.
    return apiError(status, code, isInput ? message : "Could not start discovery search");
  }
}
