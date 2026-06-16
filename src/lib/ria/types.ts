import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
import type { InstagramProfileFull } from "@/lib/instagram/profile";

export type LocationMode = "precise" | "limited";
export type ConfidenceLevel = "low" | "medium" | "high";
export type ResultSource = "shadow" | "person_intelligence" | "temporary" | "deep_research";

/** A public profile/link surfaced in Phase-0 discovery for the user to confirm/reject.
    Pure data shown as a click-only pivot card — never an identity claim until confirmed. */
export interface DiscoverCandidate {
  /** Stable id within a discovery session (used as the React key + selection key). */
  id: string;
  /** Bucket, e.g. "Dev/code", "Professional", "Social", "Articles". */
  category: string;
  /** Platform/site label, e.g. "GitHub", "LinkedIn", "Medium". */
  platform: string;
  /** Handle/username/title shown on the card. */
  handle: string;
  /** Optional fuller display name. */
  displayName?: string;
  /** Canonical profile/page URL — also the dedupe + exclude key across cycles. */
  url: string;
  /** Optional avatar/thumbnail URL. */
  avatarUrl?: string;
  /** One-line "why this might be you" context. */
  context: string;
  /** Optional rough confidence hint (e.g. "strong" | "possible"). */
  confidenceHint?: string;
}

/** A Phase-0 candidate the subject confirmed is theirs ("this is me").
    These are the verified ground-truth anchors threaded into BOTH Phase 1 and Phase 2. */
export interface ConfirmedProfile {
  platform: string;
  handle: string;
  url: string;
  category: string;
}

export interface OneSubjectInput {
  name: string;
  email: string;
  latitude?: number;
  longitude?: number;
  zipCode?: string;
  /** Phone number — used by the Hushh Shadow endpoint for disambiguation only. */
  phone?: string;
  /** Phase-0 subject-confirmed profiles ("this is me"). Ground-truth anchors that seed
      the Phase-1 research prompt AND the Phase-2 synthesis (disambiguation). */
  confirmedProfiles?: ConfirmedProfile[];
  /** The FULL verified LinkedIn profile pulled via the MCP "Connect LinkedIn" step
      (structured experience/education/skills/certs on top of name/photo/headline). When
      present, Phase-1 treats identity as SOLVED and seeds its search budget from the real
      career spine instead of re-discovering who the subject is. */
  linkedinProfile?: LinkedInProfileFull;
  /** Optional public social profiles enriched through standalone workers. These support
      Phase-1 footprint discovery, but LinkedIn remains the identity/career ground truth. */
  socialProfiles?: InstagramProfileFull[];
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

  /* ── Progressive Tier-2 ("deep") sections ─────────────────────────────────
     Filled in the background AFTER the fast 6-section Tier-1 lands, by the
     /api/one/research/[id]/deep batch endpoint. Stored inside this same blob
     (ScanRun.normalizedResult is schemaless jsonb — no migration). The UI renders
     report + deepReport and auto-appends as batches complete. */
  /** Deep-tier lifecycle. undefined = not started yet. */
  deepStatus?: "running" | "completed" | "failed";
  /** Accumulated markdown of completed deep batches, rendered below `report`. */
  deepReport?: string;
  /** Index of the next DEEP_BATCHES entry to run (0-based). */
  deepCursor?: number;
  /** Upstream DR job id for the batch currently in flight (null between batches). */
  deepJobId?: string | null;
  /** Epoch ms the current batch job started (deep-side staleness guard). */
  deepStartedAt?: number;
  /** Citations gathered across deep batches. */
  deepCitations?: unknown[];

  /* ── Background image-intelligence pipeline ───────────────────────────────
     Filled in the background AFTER Tier-1 lands, by /api/one/research/[id]/image:
     reverse-image search (Cloud Vision WEB_DETECTION) on the LinkedIn photo +
     synthesis. Stored in this same schemaless blob (no migration). Mirrors the
     deep-tier fields above. */
  /** Image-pipeline lifecycle. undefined = not started. */
  imageStatus?: "running" | "completed" | "failed";
  /** Markdown "Image intelligence" section, rendered below `report`/`deepReport`. */
  imageReport?: string;
  /** Index of the next image stage to run (0-based). */
  imageCursor?: number;
  /** Upstream DR job id for the in-flight image synthesis batch (null between stages). */
  imageJobId?: string | null;
  /** Epoch ms the current image stage started (staleness guard). */
  imageStartedAt?: number;
  /** Citations gathered by the image pipeline. */
  imageCitations?: unknown[];
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
