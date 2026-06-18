/* Shared-secret guard for internal worker routes (Cloud Scheduler → /api/internal/*). The token is
   ONE_INTERNAL_JOB_TOKEN (Secret Manager). Never exposed to the browser; only the Scheduler and the
   Cloud Run service hold it. Constant-time compare to avoid timing oracles. */
import crypto from "node:crypto";

export class InternalAuthError extends Error {
  statusCode = 401;
  constructor(message = "Unauthorized internal request") {
    super(message);
    this.name = "InternalAuthError";
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Throws InternalAuthError unless the request carries the configured internal job token, either as
 *  `Authorization: Bearer <token>` or the `x-one-job-token` header. Refuses if the token is unset. */
export function verifyInternalJobRequest(request: Request): void {
  const configured = (process.env.ONE_INTERNAL_JOB_TOKEN || "").trim();
  if (!configured) throw new InternalAuthError("Internal job token is not configured");
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const direct = (request.headers.get("x-one-job-token") || "").trim();
  const provided = bearer || direct;
  if (!provided || !constantTimeEquals(provided, configured)) throw new InternalAuthError();
}
