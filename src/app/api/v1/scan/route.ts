/* Developer API — POST /api/v1/scan
   Auth: ONE_DEV_API_KEYS (Bearer). Body: name+email+location (required) + optional LinkedIn/X/Threads/
   Instagram URLs + phone + consent flags. Each provided URL is scraped via its service VM, preloaded
   into Phase-1 (exactly like the One web app), the scan is started, and — when consent + a social feed
   are present — the preference/lifestyle pipeline is enabled per-subject. Returns 202 with the scanId,
   the scraped per-platform contracts, and links to poll / stream / read preferences. Behaves like
   one.hushh.ai: stream GET /api/v1/scan/{id}/stream for live progress, or poll GET /api/v1/scan/{id}. */
import type { Prisma } from "@prisma/client";
import { verifyDevApiRequest, apiOwnerUid } from "@/lib/auth/dev-api";
import { buildV1ScanInput, V1InputError } from "@/lib/api/v1-input";
import { buildPersonDossierQuestion } from "@/lib/research/dossier";
import { startResearch, type ResearchDepth } from "@/lib/research/client";
import { createConsentAndScan, upsertOneUser } from "@/lib/db/scan-store";
import { enableDevPreferences } from "@/lib/api/v1-preferences";
import { apiError, apiJson, corsPreflight, statusCodeOf } from "@/lib/api/http";
import type { LocationMode } from "@/lib/ria/types";

export const runtime = "nodejs";
export const maxDuration = 300; // live scraping (VM browser) can take tens of seconds per platform

export function OPTIONS() {
  return corsPreflight();
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

export async function POST(request: Request) {
  let keyId: string;
  try {
    ({ keyId } = verifyDevApiRequest(request));
  } catch (error) {
    return apiError(401, "unauthorized", error instanceof Error ? error.message : "Unauthorized");
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { input, profiles } = await buildV1ScanInput(body);

    // Consent is part of the contract (default true; the API-key holder attests authorization). If the
    // dev explicitly sends consentAttestation:false, we do not scan.
    if (!input.consentAttestation) {
      return apiError(403, "consent_required", "consentAttestation must be true to run a scan.");
    }

    const ownerUid = apiOwnerUid(keyId);
    const user = await upsertOneUser({
      firebaseUid: ownerUid,
      email: `api+${keyId}@one.hushh.ai`, // stable owner identity; the SUBJECT email lives in input
      name: `API ${keyId}`,
      photoUrl: null,
      provider: "api",
    });

    const depth: ResearchDepth = process.env.DEEP_RESEARCH_DEPTH === "max" ? "max" : "fast";
    const { jobId } = await startResearch(buildPersonDossierQuestion(input), depth);

    const mode: LocationMode = typeof input.latitude === "number" && typeof input.longitude === "number" ? "precise" : "limited";
    const scan = await createConsentAndScan({
      userId: user?.id || ownerUid,
      mode,
      purpose: input.purpose,
      // Persist the scraped contracts (apiProfiles) so GET can echo them; deepResearchJobId drives finalize.
      input: toJsonValue({ ...input, deepResearchJobId: jobId, apiProfiles: profiles, apiKeyId: keyId }),
      latitude: input.latitude,
      longitude: input.longitude,
      zipCode: input.zipCode,
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    // Enable the preference/lifestyle layer per-subject (own synthetic user → no cross-subject collision):
    // inline fast-pass now + enqueue the deep climb (→ media-analyze → recompute → v3 + lifestyle). Best-effort.
    const prefEnabled = await enableDevPreferences({ keyId, input, scanRunId: scan.scanRunId }).catch(() => null);

    const base = scan.scanRunId ? `/api/v1/scan/${scan.scanRunId}` : null;
    return apiJson(
      {
        ok: true,
        scanId: scan.scanRunId,
        status: "running",
        statusUrl: base, // back-compat
        links: base ? { self: base, stream: `${base}/stream`, preferences: `${base}/preferences` } : null,
        preferences: { enabled: Boolean(prefEnabled), status: prefEnabled ? "running" : "skipped" },
        profiles,
      },
      202,
    );
  } catch (error) {
    const status = error instanceof V1InputError ? error.statusCode : statusCodeOf(error, 502);
    const code = error instanceof V1InputError ? error.code : "scan_start_failed";
    const message = error instanceof Error ? error.message : "Could not start the scan";
    console[status >= 500 ? "error" : "warn"](JSON.stringify({ event: "one.v1.scan_start_failed", severity: status >= 500 ? "ERROR" : "WARNING", keyId, status, code, message }));
    return apiError(status, code, message);
  }
}
