import { cleanUrlList, redactText, uniqueCleanList } from "./sanitize";
import type {
  ConfidenceLevel,
  LocationMode,
  OneDashboardResult,
  OneEvidenceItem,
  OneProfileLink,
  OneRichReport,
  OneSafeFinding,
  OneSubjectInput,
  ShadowProfile,
  ShadowReport,
  ShadowReportResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app";
const SHADOW_PATH = "/v1/hushh-shadow/report";

function baseUrl() {
  return (process.env.RIA_INTELLIGENCE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function shadowApiKey() {
  return (process.env.HUSHH_SHADOW_API_KEY || process.env.PERSON_INTELLIGENCE_API_KEY || "").trim();
}

/* Shadow runs Gemini grounding ×2 + four reasoning agents + synthesis, so it is
   a multi-minute call. Default just above the upstream's own 600s ceiling. */
function timeoutMs() {
  const value = Number.parseInt(process.env.ONE_SHADOW_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 60_000), 900_000) : 615_000;
}

/* Retrying a 5–10 min, four-LLM call is expensive and risks blowing the request
   ceiling, so default to NO retry. The person-intelligence fallback is the real
   resilience layer. */
function retryCount() {
  const value = Number.parseInt(process.env.ONE_SHADOW_RETRIES || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 2) : 0;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  if ("upstreamStatus" in error && typeof error.upstreamStatus === "number") {
    return error.upstreamStatus;
  }
  return null;
}

function shouldRetry(error: unknown) {
  const status = errorStatus(error);
  return status !== null && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

function buildShadowBody(input: OneSubjectInput) {
  const body: Record<string, unknown> = {
    name: input.name,
    email: input.email,
    consentAttestation: true,
    purpose: "self_audit",
  };
  // latitude + longitude must be supplied together or the upstream rejects (422/400).
  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    body.latitude = input.latitude;
    body.longitude = input.longitude;
  }
  if (input.zipCode) body.zipCode = input.zipCode;
  if (input.phone) body.phone = input.phone;
  return body;
}

async function postShadowOnce(input: OneSubjectInput): Promise<ShadowReportResponse> {
  const apiKey = shadowApiKey();
  if (!apiKey) {
    throw Object.assign(new Error("Hushh Shadow API key is not configured"), { statusCode: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const response = await fetch(`${baseUrl()}${SHADOW_PATH}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(buildShadowBody(input)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "one.hushh_shadow.upstream_error",
          path: SHADOW_PATH,
          status: response.status,
          baseUrl: baseUrl(),
        }),
      );
      throw Object.assign(new Error("Hushh Shadow intelligence is temporarily unavailable"), {
        statusCode: response.status,
        upstreamStatus: response.status,
        payload,
      });
    }
    return payload as ShadowReportResponse;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(
        JSON.stringify({
          event: "one.hushh_shadow.timeout",
          path: SHADOW_PATH,
          timeoutMs: timeoutMs(),
          baseUrl: baseUrl(),
        }),
      );
      throw Object.assign(new Error("Hushh Shadow intelligence timed out"), {
        statusCode: 504,
        upstreamStatus: 504,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchShadowReport(input: OneSubjectInput): Promise<ShadowReportResponse> {
  if (process.env.ONE_ENABLE_MOCK_RIA === "true") {
    const delay = Number.parseInt(process.env.ONE_MOCK_RIA_DELAY_MS || "", 10);
    if (Number.isFinite(delay) && delay > 0) await sleep(Math.min(delay, 900_000));
    return mockShadowResponse(input);
  }

  const retries = retryCount();
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await postShadowOnce(input);
    } catch (error) {
      if (!shouldRetry(error) || attempt > retries) throw error;
      const delayMs = 800 * attempt;
      console.warn(
        JSON.stringify({
          event: "one.hushh_shadow.retry",
          path: SHADOW_PATH,
          status: errorStatus(error),
          attempt,
          delayMs,
        }),
      );
      await sleep(delayMs);
    }
  }
  throw Object.assign(new Error("Hushh Shadow intelligence is temporarily unavailable"), {
    statusCode: 502,
    upstreamStatus: 502,
  });
}

/* ── mapping: Shadow report → sanitized OneDashboardResult ──────────────────
   The upstream omits null fields, so every read is guarded. Free text is
   redacted; URLs are preserved via cleanUrlList. */

function coerceConfidence(value: unknown): ConfidenceLevel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "low" || v === "medium" || v === "high" ? v : null;
}

function confidenceToScore(level: ConfidenceLevel | null, sourceCount: number | null) {
  if (level === "high") return 90;
  if (level === "medium") return 68;
  if (level === "low") return 44;
  if (typeof sourceCount === "number") return Math.max(8, Math.min(96, 40 + sourceCount * 6));
  return null;
}

function redactOne(value: unknown, redactions: Set<string>): string {
  const out = redactText(value);
  out.redactions.forEach((label) => redactions.add(label));
  return out.text;
}

function profileLines(profiles: ShadowProfile[] | undefined, redactions: Set<string>): string[] {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .map((p) => {
      const platform = redactOne(p?.platform, redactions);
      const url = cleanUrlList([p?.url])[0] || "";
      return [platform, url].filter(Boolean).join(" — ");
    })
    .filter(Boolean)
    .slice(0, 8);
}

function toProfileLinks(profiles: ShadowProfile[] | undefined, redactions: Set<string>): OneProfileLink[] {
  if (!Array.isArray(profiles)) return [];
  return profiles
    .map((p) => ({
      platform: redactOne(p?.platform, redactions) || "Profile",
      url: cleanUrlList([p?.url])[0] || null,
      confidence: coerceConfidence(p?.confidence),
    }))
    .filter((p) => p.platform || p.url)
    .slice(0, 12);
}

function findingConfidence(detail: string): OneSafeFinding["confidence"] {
  return /https?:\/\/|source|public|profile|official/i.test(detail) ? "source-backed" : "possible";
}

export function mapShadowReport(
  report: ShadowReport,
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
  status: string,
): OneDashboardResult {
  const redactions = new Set<string>();
  const r = report || {};

  const overallConfidence = coerceConfidence(r.confidence?.overall);
  const sourceUrls = cleanUrlList([...(r.sourceUrls || []), ...(r.subject?.sourceUrls || [])]);
  const sourceCount =
    (typeof r.confidence?.sourceCount === "number" ? r.confidence.sourceCount : null) ??
    (typeof r.intelligence?.evidenceDensity?.sourceCount === "number"
      ? r.intelligence.evidenceDensity.sourceCount
      : null) ??
    (sourceUrls.length || null);

  // legacy categories (kept so the email category sections + any fallback UI work)
  const socials = [
    ...profileLines(r.digitalFootprint?.profiles, redactions),
    ...uniqueCleanList(r.digitalFootprint?.handles, redactions),
  ].slice(0, 8);
  const education = uniqueCleanList(
    [r.education?.summary, ...(r.education?.validatedClaims || [])],
    redactions,
  );
  const newsAndMedia = uniqueCleanList(
    [
      ...(r.evidence || []).filter((e) => e?.category === "public_work").map((e) => e?.claim),
      ...(r.intelligence?.sourceBackedFindings || []),
    ],
    redactions,
  );
  const connectedIdentities = uniqueCleanList(
    (r.network?.associates || []).map((a) =>
      [a?.name, a?.relation].filter(Boolean).join(" — "),
    ),
    redactions,
  );
  const otherFootprints = uniqueCleanList(
    [
      r.discovery?.summary,
      ...(r.discovery?.sourceMap || []).map((s) => [s?.title, s?.url].filter(Boolean).join(" — ")),
      ...(r.intelligence?.strongestFindings || []),
    ],
    redactions,
  );

  const privateDataEstimation: OneSafeFinding[] = uniqueCleanList(
    [
      ...(r.preferenceSignals?.inferred || []),
      ...(r.intelligence?.possibleSignals || []),
      ...(r.preferenceSignals?.unknown || []),
    ],
    redactions,
    6,
  ).map((detail, index) => ({
    id: `private-${index + 1}`,
    label: `Signal ${index + 1}`,
    detail,
    confidence: findingConfidence(detail),
  }));

  const evidence: OneEvidenceItem[] = (r.evidence || [])
    .map((e) => ({
      claim: redactOne(e?.claim, redactions),
      category: e?.category ? String(e.category) : null,
      confidence: coerceConfidence(e?.confidence),
      support: redactOne(e?.support, redactions) || null,
      sources: cleanUrlList(e?.sources, 6),
    }))
    .filter((e) => e.claim)
    .slice(0, 24);

  const rich: OneRichReport = {
    overallConfidence,
    confidenceScore: confidenceToScore(overallConfidence, sourceCount),
    sourceCount,
    professional: r.professional
      ? {
          currentRole: redactOne(r.professional.currentRole, redactions) || null,
          validatedClaims: uniqueCleanList(r.professional.validatedClaims, redactions),
          unverifiedClaims: uniqueCleanList(r.professional.unverifiedClaims, redactions),
          confidence: coerceConfidence(r.professional.confidence),
        }
      : null,
    education: r.education
      ? {
          summary: redactOne(r.education.summary, redactions) || null,
          validatedClaims: uniqueCleanList(r.education.validatedClaims, redactions),
          confidence: coerceConfidence(r.education.confidence),
        }
      : null,
    digitalFootprint: r.digitalFootprint
      ? {
          profiles: toProfileLinks(r.digitalFootprint.profiles, redactions),
          handles: uniqueCleanList(r.digitalFootprint.handles, redactions),
        }
      : null,
    network: r.network
      ? {
          associates: (r.network.associates || [])
            .map((a) => ({
              name: redactOne(a?.name, redactions),
              relation: redactOne(a?.relation, redactions) || null,
              confidence: coerceConfidence(a?.confidence),
            }))
            .filter((a) => a.name)
            .slice(0, 12),
        }
      : null,
    preferenceSignals: r.preferenceSignals
      ? {
          supported: uniqueCleanList(r.preferenceSignals.supported, redactions),
          inferred: uniqueCleanList(r.preferenceSignals.inferred, redactions),
          unknown: uniqueCleanList(r.preferenceSignals.unknown, redactions),
        }
      : null,
    evidence,
    discovery: r.discovery
      ? {
          summary: redactOne(r.discovery.summary, redactions) || null,
          queryExpansion: uniqueCleanList(r.discovery.queryExpansion, redactions, 12),
          sources: (r.discovery.sourceMap || [])
            .map((s) => ({
              platform: redactOne(s?.title, redactions) || "Source",
              url: cleanUrlList([s?.url])[0] || null,
              confidence: null,
            }))
            .filter((s) => s.url || s.platform)
            .slice(0, 12),
        }
      : null,
    conflicts: uniqueCleanList(r.conflicts, redactions, 12),
    missingEvidence: uniqueCleanList(r.missingEvidence, redactions, 12),
    sourceUrls,
  };

  const locationBits = [
    redactOne(r.subject?.location, redactions),
    r.confidence?.locationGrounding?.usage ? `Location used for ${r.confidence.locationGrounding.usage}.` : "",
  ].filter(Boolean);

  const warnings = [
    "Unsupported breach, dark-web, voter, legal, and wealth-style claims are shown as unverified.",
    "One stores sanitized dashboard results by default.",
  ];
  if (status === "partial") {
    warnings.push("This is a partial result — some public sources or expert models did not finish, so findings may be incomplete.");
  }
  if (mode === "limited") {
    warnings.push("Location was limited, so the result may miss coordinate-backed context.");
  }

  const summary =
    redactOne(r.summary, redactions) ||
    (r.intelligence?.strongestFindings && r.intelligence.strongestFindings.length
      ? redactOne(r.intelligence.strongestFindings[0], redactions)
      : "") ||
    "One organized a public-footprint report from source-backed signals.";

  return {
    scanRunId,
    mode,
    source: "shadow",
    subject: { name: input.name, email: input.email },
    entityId: redactOne(r.subject?.name, redactions) || redactOne(r.title, redactions) || input.name,
    summary,
    categories: { newsAndMedia, socials, education, government: [], otherFootprints, connectedIdentities },
    privateDataEstimation,
    locationIntelligence: locationBits.join(" ") || null,
    auditJobId: null,
    redactions: Array.from(redactions).sort(),
    warnings,
    rich,
  };
}

/* ── local mock (ONE_ENABLE_MOCK_RIA=true) ─────────────────────────────────
   Representative so the rich UI + email have something to render offline. */
function mockShadowResponse(input: OneSubjectInput): ShadowReportResponse {
  const located = typeof input.latitude === "number" && typeof input.longitude === "number";
  return {
    success: true,
    status: "completed",
    report: {
      title: `Intelligence Report: ${input.name}`,
      status: "completed",
      summary: `${input.name} has a source-backed public footprint across professional, education, and open-web signals. This is local mock data while the Hushh Shadow key is not configured.`,
      confidence: {
        overall: "medium",
        sourceCount: 7,
        locationGrounding: {
          source: located ? "google_maps_reverse_geocode" : "local_postal_fallback",
          confidence: 90,
          usage: "search/disambiguation only",
        },
      },
      subject: {
        name: input.name,
        location: located ? "Pune, Maharashtra, India" : "Limited location context",
        confidence: "medium",
        evidence: ["Public professional profile matches the provided name."],
        sourceUrls: ["https://example.com/profile"],
      },
      professional: {
        currentRole: "Product engineer",
        validatedClaims: ["Product engineering role appears across public profiles."],
        unverifiedClaims: ["Leadership scope not source-confirmed."],
        confidence: "medium",
      },
      education: {
        summary: "Engineering background indicated by public sources.",
        validatedClaims: ["University affiliation appears in public listings."],
        confidence: "low",
      },
      digitalFootprint: {
        profiles: [
          { platform: "GitHub", url: "https://github.com/example", confidence: "medium", source: "grounding" },
          { platform: "LinkedIn", url: "https://linkedin.com/in/example", confidence: "medium", source: "grounding" },
        ],
        handles: ["example"],
        confidence: "medium",
      },
      preferenceSignals: {
        supported: ["Open-source contribution interest"],
        inferred: ["Likely interested in developer tooling"],
        unknown: ["Lifestyle and private preferences"],
        confidence: "low",
      },
      network: {
        associates: [{ name: "Public collaborator", relation: "Co-contributor", confidence: "low", support: "Shared public repo" }],
        confidence: "low",
      },
      evidence: [
        {
          claim: "Product engineering signal appears in the public grounding pack.",
          category: "professional",
          confidence: "medium",
          support: "Multiple public profiles reference the role.",
          sources: ["https://example.com/profile"],
        },
        {
          claim: "Active public code presence.",
          category: "public_work",
          confidence: "medium",
          support: "Public repositories with recent activity.",
          sources: ["https://github.com/example"],
        },
      ],
      discovery: {
        summary: "Broad public-web grounding plus a context-enriched expansion pass.",
        queryExpansion: [`"${input.name}" product engineer`, `"${input.name}" github`],
        sourceMap: [
          { title: "Public profile", url: "https://example.com/profile", usedFor: ["identity"] },
          { title: "Code host", url: "https://github.com/example", usedFor: ["public_work"] },
        ],
        discoveredProfiles: [],
        groundingPasses: [
          { name: "Broad public-web grounding", status: "completed", sourceCount: 5 },
          { name: "Context-enriched expansion", status: "completed", sourceCount: 2 },
        ],
      },
      intelligence: {
        strongestFindings: ["Source-backed product engineering identity."],
        sourceBackedFindings: ["Public code presence is consistent across sources."],
        possibleSignals: ["May contribute to developer communities."],
        evidenceDensity: { sourceCount: 7, profileCandidateCount: 2, queryCount: 4, crossReviewCount: 4, groundingPassCount: 2, promotedEvidenceCount: 2 },
        unresolvedQuestions: ["Exact current employer not confirmed."],
      },
      conflicts: [],
      missingEvidence: ["No confirmed contact details (kept private by design)."],
      sourceUrls: ["https://example.com/profile", "https://github.com/example"],
      guardrails: { consentPurpose: "self_audit" },
    },
  };
}
