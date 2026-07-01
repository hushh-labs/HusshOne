/* Developer API — GET /api/v1/scan/{id}/stream  (Server-Sent Events)
   Auth: ONE_DEV_API_KEYS (Bearer). Live, re-attachable SSE that mirrors one.hushh.ai: two tracks run in
   PARALLEL and are multiplexed onto one connection —
     • Track A (research): advance the Deep Research job to completion (Phase-1 poll → Phase-2 synthesis)
       via the shared recoverScan() (keeps its double-finalize guard); emits `progress` then `dossier`.
     • Track B (preferences): poll the per-subject preference profile; emits `preferences` (fast-pass →
       v3 + lifestyle) as it fills in.
   Frames: `start`, `progress`, `dossier`, `preferences`, `ping` (~7s heartbeat), and one terminal of
   `done` | `error` | `pending`. A soft deadline (< Cloud Run's 1800s wall) closes with `pending` so the
   dev re-attaches or polls. Auth/404 are returned as JSON before the stream opens. */
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { recoverScan } from "@/lib/research/recover";
import { getResearchJob } from "@/lib/db/scan-store";
import { readDevPreferences } from "@/lib/api/v1-preferences";
import { apiError, requestOrigin, sseFrame, sseHeaders } from "@/lib/api/http";
import { SHADOW_PHASES, shadowPhaseIndex } from "@/lib/ria/progress";
import type { OneSubjectInput } from "@/lib/ria/types";

export const runtime = "nodejs";
export const maxDuration = 1800;

const POLL_MS = 6000;
const HEARTBEAT_MS = 7000;
const DEADLINE_MS = 1_650_000; // 27.5 min — self-close before the 1800s Cloud Run wall

export function OPTIONS() {
  return new Response(null, { status: 204, headers: sseHeaders() });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let keyId: string;
  try {
    ({ keyId } = verifyDevApiRequest(request));
  } catch (error) {
    return apiError(401, "unauthorized", error instanceof Error ? error.message : "Unauthorized");
  }

  const { id } = await context.params;
  if (!id) return apiError(400, "invalid_input", "Missing scan id");
  const uid = apiOwnerUid(keyId);

  const scan0 = await getResearchJob(uid, id);
  if (!scan0) return apiError(404, "not_found", "Scan not found");
  const storedInput = (scan0.input ?? {}) as Partial<OneSubjectInput>;
  const origin = requestOrigin(request);

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)));
        } catch {
          closed = true;
        }
      };
      // Independent heartbeat so the connection stays alive even during the long Phase-2 finalize (which
      // blocks the poll loop for a while inside recoverScan).
      const heartbeat = setInterval(() => send("ping", { elapsedMs: Date.now() - startedAt }), HEARTBEAT_MS);
      const end = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send("start", { scanId: id, status: "running" });

      let researchTerminal = false;
      let finalResult: unknown = null;
      let lastPrefKey = "";

      try {
        while (!closed) {
          const elapsedMs = Date.now() - startedAt;

          // ── Track A: advance research (single poll + finalize-if-done; double-finalize-safe). ──
          if (!researchTerminal) {
            const { body } = await recoverScan({ uid, id, origin });
            if (body.status === "completed") {
              researchTerminal = true;
              finalResult = body.result ?? null;
              send("dossier", { status: "completed", result: finalResult });
            } else if (body.status === "failed") {
              send("error", { code: "research_failed", error: typeof body.error === "string" ? body.error : "Research failed" });
              end();
              break;
            } else {
              const phaseIndex = shadowPhaseIndex(elapsedMs);
              send("progress", { phaseIndex, phase: SHADOW_PHASES[phaseIndex] ?? "Working", elapsedMs });
            }
          }

          // ── Track B: preferences (fast-pass → v3 + lifestyle). Emit only on change. ──
          const pref = await readDevPreferences(keyId, storedInput).catch(() => ({ status: "skipped" as const, profile: null }));
          const prefKey = `${pref.status}:${(pref.profile as { generatedAt?: string } | null)?.generatedAt ?? ""}`;
          if (pref.profile && prefKey !== lastPrefKey) {
            lastPrefKey = prefKey;
            send("preferences", { status: pref.status, profile: pref.profile });
          }

          // ── Terminal: research done AND preferences settled (completed or skipped). ──
          const prefSettled = pref.status === "completed" || pref.status === "skipped";
          if (researchTerminal && prefSettled) {
            send("done", { scan: finalResult, preferences: { status: pref.status, profile: pref.profile } });
            end();
            break;
          }

          // ── Soft deadline. ──
          if (Date.now() - startedAt > DEADLINE_MS) {
            if (!researchTerminal) {
              send("pending", { reason: "deadline", scanId: id, message: "Still working — re-attach this stream or poll GET /api/v1/scan/{id}." });
            } else {
              // Research done but the deep preference pipeline is still enriching — return best-available.
              send("done", { scan: finalResult, preferences: { status: pref.status, profile: pref.profile } });
            }
            end();
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } catch (error) {
        send("error", { code: "stream_error", error: error instanceof Error ? error.message : "stream error" });
        end();
      } finally {
        clearInterval(heartbeat);
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
