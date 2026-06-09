export type LocationMode = "precise" | "limited";
export type ConfidenceLevel = "low" | "medium" | "high";
export type ResultSource = "shadow" | "person_intelligence" | "temporary" | "deep_research";

export interface OneSubjectInput {
  name: string;
  email: string;
  latitude?: number;
  longitude?: number;
  zipCode?: string;
  /** Phone number — used by the Hushh Shadow endpoint for disambiguation only. */
  phone?: string;
  consentAttestation: boolean;
  purpose: "self_audit";
}

export interface DashboardCategoryMap {
  newsAndMedia: string[];
  socials: string[];
  education: string[];
  government: string[];
  otherFootprints: string[];
  connectedIdentities: string[];
}

export interface PersonDashboardResponse {
  entityId: string | null;
  summary: string | null;
  categorizedData: DashboardCategoryMap;
  privateDataEstimation: string[];
  locationIntelligence: string | null;
}

export interface OneSafeFinding {
  id: string;
  label: string;
  detail: string;
  confidence: "source-backed" | "possible" | "not-verified";
}

/* ── Hushh Shadow ensemble contract (POST /v1/hushh-shadow/report) ──────────
   Mirrors docs/HUSHH_SHADOW_ENSEMBLE_CONTRACT.md. The upstream uses
   response_model_exclude_none=true, so EVERY field below may be absent — keep
   everything optional and null-guard on read. */

export interface ShadowProfile {
  platform?: string;
  url?: string;
  confidence?: string;
  source?: string;
}

export interface ShadowEvidenceItem {
  claim?: string;
  category?: string;
  confidence?: string;
  support?: string;
  sources?: string[];
}

export interface ShadowAssociate {
  name?: string;
  relation?: string;
  confidence?: string;
  support?: string;
}

export interface ShadowReport {
  title?: string;
  status?: string;
  summary?: string;
  confidence?: {
    overall?: string;
    sourceCount?: number;
    locationGrounding?: {
      source?: string;
      confidence?: number;
      usage?: string;
    };
  };
  subject?: {
    name?: string;
    location?: string;
    confidence?: string;
    evidence?: string[];
    sourceUrls?: string[];
  };
  professional?: {
    currentRole?: string;
    validatedClaims?: string[];
    unverifiedClaims?: string[];
    confidence?: string;
  };
  education?: {
    summary?: string;
    validatedClaims?: string[];
    confidence?: string;
  };
  digitalFootprint?: {
    profiles?: ShadowProfile[];
    handles?: string[];
    confidence?: string;
  };
  preferenceSignals?: {
    supported?: string[];
    inferred?: string[];
    unknown?: string[];
    confidence?: string;
  };
  network?: {
    associates?: ShadowAssociate[];
    confidence?: string;
  };
  evidence?: ShadowEvidenceItem[];
  discovery?: {
    summary?: string;
    queryExpansion?: string[];
    sourceMap?: { title?: string; url?: string; usedFor?: string[] }[];
    discoveredProfiles?: unknown[];
    groundingPasses?: { name?: string; status?: string; sourceCount?: number }[];
  };
  intelligence?: {
    strongestFindings?: string[];
    sourceBackedFindings?: string[];
    possibleSignals?: string[];
    evidenceDensity?: Record<string, number>;
    unresolvedQuestions?: string[];
  };
  conflicts?: string[];
  missingEvidence?: string[];
  sourceUrls?: string[];
  guardrails?: Record<string, unknown>;
}

export type ShadowStatus = "completed" | "partial" | "failed";

export interface ShadowReportResponse {
  success: boolean;
  status: ShadowStatus | string;
  report?: ShadowReport;
}

/* ── Sanitized rich result rendered by the UI + email ───────────────────── */

export interface OneProfileLink {
  platform: string;
  url: string | null;
  confidence: ConfidenceLevel | null;
}

/** A cleaned, categorized, personalized source link for display (dashboard + email). */
export interface OneSourceCard {
  /** Final (resolved) URL — never a raw vertexaisearch grounding-redirect. */
  url: string;
  /** Bare hostname, e.g. "github.com". */
  domain: string;
  /** Personalized professional label, e.g. "Ankit's GitHub" or "AIT Pune". */
  label: string;
  /** Bucket: Professional | Code | Education | News & media | App | Social | Public web. */
  category: string;
  /** Favicon URL for the domain (best-effort). */
  favicon: string | null;
}

export interface OneEvidenceItem {
  claim: string;
  category: string | null;
  confidence: ConfidenceLevel | null;
  support: string | null;
  sources: string[];
}

export interface OneAssociate {
  name: string;
  relation: string | null;
  confidence: ConfidenceLevel | null;
}

export interface OneRichReport {
  overallConfidence: ConfidenceLevel | null;
  /** 0–100, derived for the confidence ring. */
  confidenceScore: number | null;
  sourceCount: number | null;
  professional: {
    currentRole: string | null;
    validatedClaims: string[];
    unverifiedClaims: string[];
    confidence: ConfidenceLevel | null;
  } | null;
  education: {
    summary: string | null;
    validatedClaims: string[];
    confidence: ConfidenceLevel | null;
  } | null;
  digitalFootprint: {
    profiles: OneProfileLink[];
    handles: string[];
  } | null;
  network: {
    associates: OneAssociate[];
  } | null;
  preferenceSignals: {
    supported: string[];
    inferred: string[];
    unknown: string[];
  } | null;
  evidence: OneEvidenceItem[];
  discovery: {
    summary: string | null;
    queryExpansion: string[];
    sources: OneProfileLink[];
  } | null;
  conflicts: string[];
  missingEvidence: string[];
  sourceUrls: string[];
  /** Cleaned + personalized source cards (resolved from sourceUrls). */
  sourceCards: OneSourceCard[];
  /** Count of public-web sources verified but not individually named (Hushh summary). */
  verifiedWebCount: number;
}

export interface OneDashboardResult {
  scanRunId: string | null;
  mode: LocationMode;
  source: ResultSource;
  subject: {
    name: string;
    email: string;
  };
  summary: string;
  entityId: string | null;
  categories: DashboardCategoryMap;
  privateDataEstimation: OneSafeFinding[];
  locationIntelligence: string | null;
  auditJobId: string | null;
  redactions: string[];
  warnings: string[];
  /** Full Shadow report, sanitized. Null on the person-intelligence / temporary paths. */
  rich: OneRichReport | null;
  /** Deep Research markdown report (deep_research source only). FINAL = Phase 2 (Opus synthesis). */
  report?: string;
  /** Raw phase-1 (Gemini) dossier, retained for audit; not rendered. */
  rawReport?: string;
  /** Deep Research citations (deep_research source only). */
  citations?: unknown[];
  /** Intelligence-layer version (INTELLIGENCE_VERSION) that produced this result.
      On load, a recovered scan whose version !== current is treated as stale → re-scan. */
  intelligenceVersion?: string;
}

export interface PersonAuditStatus {
  jobId: string;
  status: "queued" | "running" | "completed" | "partial" | "failed";
  totalShards: number;
  completedShards: number;
  failedShards: number;
  reportAvailable: boolean;
  errors: string[];
}
