/* Build the Deep Research question from the One subject, and map the returned
   markdown report into the OneDashboardResult the UI + DB already use. */
import type { DashboardCategoryMap, LocationMode, OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";
import { INTELLIGENCE_VERSION } from "./version";

function emptyCategories(): DashboardCategoryMap {
  return {
    newsAndMedia: [],
    socials: [],
    education: [],
    government: [],
    otherFootprints: [],
    connectedIdentities: [],
  };
}

/**
 * Phase-1 prompt for the Deep Research agent. Engineered to keep the agent's WORKLOAD low
 * (its runtime scales with how much it searches), which is what makes Phase-1 fast:
 *   - "Defuse" the LinkedIn anchor: when present, identity is SOLVED, so the agent must NOT
 *     spend its budget on identity resolution / same-name disambiguation (the biggest time sink).
 *   - Explicit search budget + stop-early.
 *   - A tight ~6-section scope (the discovery parts that need real search) instead of 21.
 *   - Current date injected (avoids stale-result retry loops).
 * See .claude/plans (defuse-LinkedIn) + Anthropic/promptingguide context-engineering guidance.
 */
export function buildPersonDossierQuestion(input: OneSubjectInput): string {
  const location =
    typeof input.latitude === "number" && typeof input.longitude === "number"
      ? `based near latitude ${input.latitude}, longitude ${input.longitude}`
      : input.zipCode
        ? `based in ZIP/postal ${input.zipCode}`
        : "location not provided";

  const today = new Date().toISOString().slice(0, 10);

  const anchors = (input.confirmedProfiles ?? []).filter((p) => p && p.url);
  const linkedinAnchor = anchors.find(
    (p) => /linkedin/i.test(p.platform || "") || /linkedin\.com\/in\//i.test(p.url),
  );
  const otherAnchors = anchors.filter((p) => p !== linkedinAnchor);
  const otherAnchorsLine = otherAnchors.length
    ? ` Already-known profiles for the same person: ${otherAnchors.map((p) => `${p.platform} ${p.url}`).join(", ")}.`
    : "";

  // When a confirmed LinkedIn URL is present, identity is SOLVED — the agent must not re-search
  // who this is or chase same-name look-alikes. That removes the largest source of wasted steps.
  const identityBlock = linkedinAnchor
    ? `IDENTITY IS ALREADY CONFIRMED — do NOT re-investigate who this is.
The subject is the exact person at this LinkedIn profile: ${linkedinAnchor.url}
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""} ${location}.${otherAnchorsLine}
Read this ONE LinkedIn profile once to lock the spine (current employer + title, education, location, vanity handle), then STOP confirming identity. Do not disambiguate or investigate same-name people — anything not clearly THIS person, simply ignore it.`
    : `SUBJECT — resolve identity from these, then gather findings:
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""} ${location}.${otherAnchorsLine}`;

  return `CONSENT-BASED PUBLIC INTELLIGENCE — PHASE 1. Today is ${today}.
The subject consented to a self-audit of their OWN public online footprint. Use only lawful, publicly accessible information.

${identityBlock}

SEARCH BUDGET — be fast and focused. Run roughly 8–12 targeted web searches total, seeded from the spine (the name with their employer / school / city, and their handle), then synthesize and STOP. Favor depth on this one confirmed person over breadth; do not exhaustively enumerate platforms — surface only what real, current search results show.

DELIVER a tight, evidence-backed markdown report with ONLY these sections:
1. Who they are — 1–2 lines anchored to the LinkedIn profile, with overall confidence (High / Medium / Low).
2. Public profiles & handles — the clearly-theirs profiles (LinkedIn, GitHub, X, etc.): platform · URL · confidence. Obvious matches only.
3. Career, education & notable projects — current and past roles, companies, education, and key public work.
4. News, media & public mentions — articles, press, interviews, talks, public-record mentions: title · URL · date · one-line context.
5. Public network & associations — notable public collaborators, companies, communities (public only).
6. Evidence — a short table: claim · source URL · date · confidence.

RULES: lawful public sources only; never expose secrets, credentials, leaked/breach data, exact home address, or private family/minor details; label uncertain items "possible / weak / unknown" and prefer "unknown" over guessing; back every non-obvious claim with a source URL. Keep it pointed and strictly about THIS person.`;
}

/* ── Progressive Tier-2 ("deep") batches ───────────────────────────────────
   Tier-1 ships the fast 6-section core. The remaining sections are produced in
   the BACKGROUND as bounded, priority-ordered batches — each its own small DR
   job (~8min, same lean budget) seeded with the Tier-1 findings so it does NOT
   re-discover identity. The /deep endpoint runs them one-by-one and appends each
   to deepReport. One giant deep job = the old 54-min runaway, so we batch. */
export interface DeepSection {
  heading: string;
  guidance: string;
}
export interface DeepBatch {
  key: string;
  label: string;
  sections: DeepSection[];
}

export const DEEP_BATCHES: DeepBatch[] = [
  {
    key: "professional-footprint",
    label: "Professional depth & footprint",
    sections: [
      { heading: "Technical & Domain Intelligence", guidance: "languages, frameworks, tools, notable repos/projects, and the quality + recency of their public work." },
      { heading: "Public Reputation & Credibility", guidance: "endorsements, recognition, media mentions, source consistency; give a Low/Medium/High read with evidence." },
      { heading: "Digital Footprint & Discoverability", guidance: "how visible/searchable they are, cross-linking across profiles, plus concrete cleanup/consolidation recommendations." },
      { heading: "Public Contact & Location Context", guidance: "only public/consented info — city/region, public email/handles. Never the exact home address or precise geolocation." },
    ],
  },
  {
    key: "safety-exposure",
    label: "Safety & exposure",
    sections: [
      { heading: "Breach & Exposure Awareness", guidance: "lawful breach-notification signals for the consented identifiers: affected platform, exposure category, date if known, risk level, and a revoke/reset action map. NEVER reveal a secret value." },
      { heading: "Security Hygiene Recommendations", guidance: "prioritized actions — password reset/MFA/passkeys, OAuth + session cleanup, old-account deletion, alias strategy." },
    ],
  },
  {
    key: "personal-signals",
    label: "Personal signals & context",
    sections: [
      { heading: "Preferences & Interests", guidance: "evidence-backed public interests, communities, content; confidence-labelled. No sensitive-trait inference." },
      { heading: "Lifestyle & Context Signals", guidance: "broad, non-invasive public signals only; confidence + caveats." },
      { heading: "Approximate Age & Life Stage", guidance: "only from public evidence (education/work timeline); output a RANGE with confidence. Never from photos." },
      { heading: "Relationship / Marital Status Signal", guidance: "only if self-declared publicly or in a public record; otherwise Unknown." },
      { heading: "Net-Worth Signal (speculative)", guidance: "a rough public-signal proxy as a RANGE, clearly labelled NOT actual net worth; evidence-based only." },
    ],
  },
];

/** Build a Tier-2 deep-batch prompt: identity is already CONFIRMED (no re-discovery), the
    Tier-1 report is provided as context, and the agent is asked for ONLY this batch's
    sections under a bounded search budget. */
export function buildDeepBatchQuestion(input: OneSubjectInput, tier1Report: string, batch: DeepBatch): string {
  const today = new Date().toISOString().slice(0, 10);
  const anchors = (input.confirmedProfiles ?? []).filter((p) => p && p.url);
  const linkedin = anchors.find((p) => /linkedin/i.test(p.platform || "") || /linkedin\.com\/in\//i.test(p.url));
  const anchorLine = linkedin ? ` Confirmed LinkedIn: ${linkedin.url}.` : "";
  const context = (tier1Report || "").slice(0, 6000); // resolved identity as context, not to re-derive

  return `CONSENT-BASED PUBLIC INTELLIGENCE — DEEP PASS: ${batch.label}. Today is ${today}.
The subject consented to a self-audit of their OWN public footprint. Use only lawful, publicly accessible information.

IDENTITY IS ALREADY CONFIRMED — do NOT re-investigate who this is, and do NOT disambiguate same-name people.${anchorLine}
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""}

ALREADY-ESTABLISHED FINDINGS about THIS person (context — build on these, do not repeat them):
"""
${context}
"""

SEARCH BUDGET — be fast and focused: run roughly 8–12 targeted searches, then synthesize and STOP.

DELIVER ONLY these markdown "##" sections — use these exact headings, in this order, and output NOTHING else (no intro, no extra sections):
${batch.sections.map((s) => `## ${s.heading}\n→ ${s.guidance}`).join("\n\n")}

RULES: lawful public sources only; never expose secrets, credentials, leaked/breach values, exact home address, or private family/minor details; label uncertain items "possible / weak / unknown" and prefer "unknown" over guessing; back non-obvious claims with a source URL. Strictly about THIS person.`;
}

/** Pull a short plain-text summary from the markdown report for the dashboard header. */
function deriveSummary(report: string, name: string): string {
  const lines = report.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("-")) continue;
    const text = line.replace(/[*_`]/g, "").trim();
    if (text.length > 30) return text.length > 240 ? `${text.slice(0, 239).trim()}…` : text;
  }
  return `One compiled a deep research dossier for ${name.split(" ")[0] || "you"} from public sources.`;
}

/** Map a completed Deep Research run into the existing dashboard result shape. */
export function mapResearchResult(
  report: string,
  citations: unknown[],
  input: OneSubjectInput,
  mode: LocationMode,
  scanRunId: string | null,
  rawReport?: string,
): OneDashboardResult {
  return {
    scanRunId,
    mode,
    source: "deep_research",
    subject: { name: input.name, email: input.email },
    summary: deriveSummary(report, input.name),
    entityId: input.name,
    categories: emptyCategories(),
    privateDataEstimation: [],
    locationIntelligence: null,
    auditJobId: null,
    redactions: [],
    warnings: [],
    rich: null,
    report,
    ...(rawReport && rawReport !== report ? { rawReport } : {}),
    citations: Array.isArray(citations) ? citations : [],
    intelligenceVersion: INTELLIGENCE_VERSION,
  };
}
