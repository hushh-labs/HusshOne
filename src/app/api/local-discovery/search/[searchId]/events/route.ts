/* GET /api/local-discovery/search/{searchId}/events — Server-Sent Events stream for a discovery search
   (deliverable #2). Mirrors the /api/v1/scan stream idiom (sseHeaders/sseFrame + ReadableStream + heartbeat).

   The stream ATTACHES to a session, replays its buffered events (via a cursor so replay + live never gap or
   double-send), and subscribes for new ones. Attaching is also what DRIVES the work: `ensureSearchStarted`
   is idempotent, so whichever client connects first starts the fan-out and every client sees the full
   sequence. If the session isn't found on this instance (cross-instance routing or TTL expiry), it is
   rebuilt from the query params the client carries — so the stream is robust without a shared session store.

   Terminal conditions: the orchestrator's `search_complete` event, or a wall-clock deadline (after which the
   client may reconnect to continue). A bad/missing location on the rebuild path returns JSON before the
   stream opens. */

import { apiError, sseFrame, sseHeaders } from "@/lib/api/http";
import { V1InputError } from "@/lib/api/v1-input";
import {
  createDiscoverySearch,
  ensureSearchStarted,
  getDiscoverySession,
  searchParamsToBody,
  subscribeToSession,
  type DiscoverySession,
} from "@/lib/local-discovery/orchestrator";

export const runtime = "nodejs";
export const maxDuration = 60;

const HEARTBEAT_MS = 7_000;
const DEADLINE_MS = 45_000;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: sseHeaders() });
}

export async function GET(request: Request, context: { params: Promise<{ searchId: string }> }) {
  const { searchId } = await context.params;
  if (!searchId) return apiError(400, "invalid_input", "Missing searchId.");

  let session = getDiscoverySession(searchId);
  if (!session) {
    // Cross-instance / expired fallback: rebuild an equivalent session from the query params the client carries.
    const sp = new URL(request.url).searchParams;
    if ([...sp.keys()].length === 0) {
      return apiError(404, "not_found", "Search not found or expired. Start a new search.");
    }
    try {
      ({ session } = await createDiscoverySearch(searchParamsToBody(sp), { searchId }));
    } catch (error) {
      const isInput = error instanceof V1InputError;
      const status = isInput ? error.statusCode : 502;
      const code = isInput ? error.code : "discovery_search_failed";
      const message = error instanceof Error ? error.message : "Search could not be started.";
      return apiError(status, code, isInput ? message : "Search could not be started.");
    }
  }

  const active: DiscoverySession = session;
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => send("ping", { elapsedMs: Date.now() - startedAt }), HEARTBEAT_MS);
      let unsubscribe = () => {};
      let deadline: ReturnType<typeof setInterval> | undefined;

      const end = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (deadline) clearInterval(deadline);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Cursor-based drain: replays buffered events and streams new ones without gaps or duplicates
      // (single-threaded — no await between reading and advancing the cursor).
      let cursor = 0;
      const pump = () => {
        while (!closed && cursor < active.events.length) {
          const evt = active.events[cursor++];
          send(evt.type, evt);
          if (evt.type === "search_complete") {
            end();
            return;
          }
        }
      };

      unsubscribe = subscribeToSession(active, pump);
      ensureSearchStarted(active); // idempotent — starts the fan-out if this is the first attach
      pump(); // drain anything already buffered (and any events emitted synchronously above)

      // Only arm the deadline if the stream didn't already finish during the initial drain
      // (an already-complete session buffers `search_complete`, so pump() ends it synchronously).
      if (!closed) {
        deadline = setInterval(() => {
          if (closed) return;
          if (Date.now() - startedAt > DEADLINE_MS) {
            if (!active.done) {
              send("timeout", {
                searchId,
                message: "Still working — reconnect to this stream to keep receiving results.",
              });
            }
            end();
          }
        }, 1_000);
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
