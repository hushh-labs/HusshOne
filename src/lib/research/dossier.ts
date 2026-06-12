/* Build the Deep Research question from the One subject, and map the returned
   markdown report into the OneDashboardResult the UI + DB already use. */
import type { DashboardCategoryMap, LocationMode, OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";
import type { LinkedInProfileFull } from "@/lib/linkedin/profile";
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

/** Parse a LinkedIn headline ("<current title/org> | Ex <org> | Ex <org> …") into the
 * current role + ordered former affiliations. The headline is the subject's VERIFIED career
 * spine; splitting it HERE (instead of dumping the raw string) stops the research agent
 * misreading an "Ex" company as the present job, and hands it ready-made search seeds. We
 * keep each segment's text intact (role qualifiers and all) and let the seed instruction tell
 * the agent to search the ORG within each — robust across the wildly varied real-world
 * formats. `past` is capped so a very long headline can't blow the bounded Phase-1 budget. */
export function parseHeadlineSpine(headline: string): { current: string; past: string[] } {
  const segments = headline.split("|").map((s) => s.trim()).filter(Boolean);
  const past: string[] = [];
  let current = "";
  for (const seg of segments) {
    const former = seg.match(/^(?:ex|former|prev(?:iously)?)\.?[\s.\-:]+(.+)$/i);
    if (former) past.push(former[1].trim());
    else if (!current) current = seg; // first non-"Ex" segment is the present role
  }
  if (!current && segments.length) current = segments[0]; // all-"Ex" headline → take the first
  return { current, past: past.slice(0, 4) }; // cap former ties (search-budget guard)
}

/** Build the career spine from the FULL LinkedIn profile's STRUCTURED experience (MCP connect)
 * — strictly better than parsing the headline string: the current role is the one LinkedIn flags
 * current (or open-ended), and former employers are exact org names in recency order. Returns
 * null when there's no structured experience, so the caller falls back to parseHeadlineSpine. */
export function structuredSpine(li?: LinkedInProfileFull): { current: string; past: string[] } | null {
  const exp = li?.experience;
  if (!exp || !exp.length) return null;
  const currentRole = exp.find((e) => e.current) ?? exp.find((e) => !e.endDate) ?? exp[0];
  const current = currentRole ? [currentRole.title, currentRole.company].filter(Boolean).join(" at ") : "";
  const seen = new Set<string>();
  if (currentRole?.company) seen.add(currentRole.company.toLowerCase());
  const past: string[] = [];
  for (const e of exp) {
    const company = (e.company || "").trim();
    if (!company) continue;
    const key = company.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    past.push(company);
    if (past.length >= 4) break; // cap former ties (search-budget guard)
  }
  return { current, past };
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

  // LinkedIn-first flow: the subject authenticated with their OWN LinkedIn, so identity is
  // GROUND TRUTH (verified name/email/photo/profile + LinkedIn's own verification). The agent
  // must not re-confirm identity or chase same-name look-alikes — it spends the whole budget
  // enriching. This is the largest accuracy + speed win.
  const li = input.linkedinProfile;
  const liUrl = li ? li.profileUrl || linkedinAnchor?.url || "" : "";
  // We already hold the FULL profile (URL-paste scraper enrichment / MCP), and LinkedIn is
  // bot-blocked to the grounded search engine — so even though the pasted URL is a clean public
  // /in/ link, there's nothing to gain by "reading" it. Force the no-fetch spine whenever we have
  // enriched data (about / structured experience / scraper source), and drive searches off it.
  const haveFullProfile = !!(li && (li.about || (li.experience && li.experience.length) || li.source === "scraper" || li.source === "mcp"));
  const fetchableLinkedIn =
    /linkedin\.com\/in\//i.test(liUrl) && !/profile-thirdparty-redirect/i.test(liUrl) && !haveFullProfile;
  const liNameExtra = li
    ? [li.givenName && `given: ${li.givenName}`, li.familyName && `family: ${li.familyName}`].filter(Boolean).join("; ")
    : "";
  // The career spine = current role + former orgs in recency order. Prefer the FULL profile's
  // STRUCTURED experience (MCP connect) — exact, correctly ordered, current-flagged — and fall
  // back to parsing the headline string only when there's no structured history. Either way the
  // agent seeds searches off real companies (not a URL it can't fetch) and can't misread an "Ex".
  const structured = structuredSpine(li);
  const spine = structured ?? (li?.headline ? parseHeadlineSpine(li.headline) : { current: "", past: [] });
  const haveSpine = Boolean(spine.current || spine.past.length);
  const spineSource = structured
    ? "the subject's verified LinkedIn work history"
    : li?.headline
      ? `the subject's verbatim self-declared headline "${li.headline}"`
      : "the verified LinkedIn profile";
  const emailLocalPart = ((li?.email || input.email || "").split("@")[0] || "").trim();
  const spineBlock = haveSpine
    ? `PROFESSIONAL SPINE — from ${spineSource} (the authoritative career graph; do NOT re-derive it from the profile URL):
${spine.current ? `  • CURRENT (who they are today): ${spine.current}\n` : ""}${spine.past.length ? `  • FORMER (newest→oldest; NEVER write any of these up as the present job): ${spine.past.join(", ")}\n` : ""}For each entry the search seed is the ORGANISATION in it (ignore role words like "Intern"/"Mentee"). Use ONLY these organisations as seeds — never invent or add employers, schools, or handles not listed here.`
    : "";
  // Compact education / skills anchors (MCP full profile) — reference facts that help the agent
  // recognise the right person; kept short so they don't eat the bounded search budget.
  const eduLine = li?.education?.length
    ? `- Education: ${li.education.slice(0, 2).map((e) => [e.degree, e.field, e.school].filter(Boolean).join(" ")).filter(Boolean).join("; ")}`
    : "";
  const skillsLine = li?.skills?.length ? `- Skills (self-listed, for recognition only): ${li.skills.slice(0, 8).join(", ")}` : "";
  // The "About" is the richest single signal — the subject's own summary of who they are. Inject
  // it verbatim (bounded) so the agent seeds searches off the orgs / domains / specialities it names.
  const aboutBlock = li?.about
    ? `SELF-SUMMARY (verbatim from the subject's own LinkedIn "About" — the strongest context; seed searches off the organisations, domains, and specialities named here):\n"""\n${li.about}\n"""`
    : "";
  const statedLocation = li?.location ? `- Stated location (from their LinkedIn): ${li.location}` : "";
  const liSpine = fetchableLinkedIn
    ? "Read that ONE public /in/ profile once to confirm the spine, then STOP confirming identity and spend the ENTIRE remaining budget ENRICHING the sections below for THIS person."
    : `Do NOT open, fetch, or "verify" any LinkedIn URL — LinkedIn is bot-blocked here and the link above is an opaque redirect that does not resolve, so any attempt is wasted budget. ${haveSpine ? "The parsed spine above IS the locked spine — take those organisations as your literal search seeds" : "Use the verified facts above as the spine"} and spend the ENTIRE remaining budget ENRICHING the sections below for THIS one confirmed person.${haveSpine ? " When you report a role, label it CURRENT vs FORMER exactly as parsed; if a search result conflicts, the headline wins." : ""}`;
  const identityBlock = li
    ? [
        "IDENTITY IS SOLVED — verified ground truth from the subject's OWN authenticated LinkedIn. Never re-confirm who this is and never disambiguate same-name people; anything not clearly THIS exact person, ignore.",
        "VERIFIED FACTS (treat as locked ground truth):",
        `- Name: ${li.name || input.name}${liNameExtra ? ` (${liNameExtra})` : ""}`,
        `- Email: ${li.email || input.email}${li.emailVerified ? " (verified)" : ""}${emailLocalPart ? ` — local-part "${emailLocalPart}" is a POSSIBLE cross-platform handle, not confirmed; only report it if a search actually returns it` : ""}`,
        li.verifications.length ? `- LinkedIn-verified: ${li.verifications.join(", ")} — LinkedIn itself attested this, so the current-employer claim is already proven.` : "",
        liUrl ? `- LinkedIn profile (reference only — LinkedIn is bot-blocked to web search, so never open, fetch, or cite it; the full profile is already provided below): ${liUrl}` : "",
        `- Profile photo (reference only — do NOT fetch, reverse-search, or cite this signed URL): ${li.pictureUrl || "(not provided)"}`,
        `- ${location}.${otherAnchorsLine}`,
        statedLocation,
        eduLine,
        skillsLine,
        aboutBlock,
        spineBlock,
        liSpine,
      ].filter(Boolean).join("\n")
    : linkedinAnchor
      ? `IDENTITY IS ALREADY CONFIRMED — do NOT re-investigate who this is.
The subject is the exact person at this LinkedIn profile: ${linkedinAnchor.url}
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""} ${location}.${otherAnchorsLine}
Read this ONE LinkedIn profile once to lock the spine (current employer + title, education, location, vanity handle), then STOP confirming identity. Do not disambiguate or investigate same-name people — anything not clearly THIS person, simply ignore it.`
      : `SUBJECT — resolve identity from these, then gather findings:
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""} ${location}.${otherAnchorsLine}`;

  // When we have a parsed LinkedIn spine, the budget becomes a MECHANICAL, capped seed plan
  // (name × one org per query) so the agent spends — not discovers — its searches. Otherwise
  // keep the generic lean budget. Hard cap 12 keeps Phase-1 fast.
  const searchBudget =
    li && haveSpine
      ? `SEARCH BUDGET — be fast and focused (HARD CAP 12 searches), built MECHANICALLY from the parsed spine: pair the quoted full name with exactly ONE organisation per query (never two) so grounding stays locked to this person.
- 1 identity lock-on: "${li.name || input.name}"${spine.current ? ` with ${spine.current}` : ""}.
- up to 2 on the CURRENT organisation (role/title; plus github OR x.com OR personal site OR press/talks).
- 1 each on the FORMER organisations listed above, newest→oldest (at most 4).
- up to 2 handle / owned-profile: "${li.name || input.name}" with (github.com OR x.com)${emailLocalPart ? `, and "${li.name || input.name}" ${emailLocalPart}` : ""} — only REPORT a handle a result actually returns.
Then synthesize and STOP at or before 12 searches. Discard any same-name stranger; never chase or disambiguate.`
      : `SEARCH BUDGET — be fast and focused. Run roughly 8–12 targeted web searches total, seeded from the spine (the name with their employer / school / city, and their handle), then synthesize and STOP. Favor depth on this one confirmed person over breadth; do not exhaustively enumerate platforms — surface only what real, current search results show.`;

  return `CONSENT-BASED PUBLIC INTELLIGENCE — PHASE 1. Today is ${today}.
The subject consented to a self-audit of their OWN public online footprint. Use only lawful, publicly accessible information.

${identityBlock}

${searchBudget}

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
