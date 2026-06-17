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

function linkedInProfilePromptJson(li: LinkedInProfileFull): string {
  const normalized = {
    sub: li.sub,
    name: li.name,
    givenName: li.givenName,
    familyName: li.familyName,
    email: li.email,
    emailVerified: li.emailVerified,
    locale: li.locale,
    pictureUrl: li.pictureUrl,
    profileUrl: li.profileUrl,
    headline: li.headline,
    location: li.location ?? null,
    about: li.about ?? null,
    experience: li.experience ?? [],
    education: li.education ?? [],
    skills: li.skills ?? [],
    certifications: li.certifications ?? [],
    profileStats: li.profileStats ?? null,
    verifications: li.verifications ?? [],
    grantedScopes: li.grantedScopes ?? [],
    source: li.source ?? "oauth",
  };
  return JSON.stringify(normalized, null, 2);
}

function socialProfilesPromptJson(input: OneSubjectInput): string {
  const profiles = (input.socialProfiles ?? []).map((profile) => ({
    platform: profile.platform,
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    externalUrl: profile.externalUrl,
    profileUrl: profile.profileUrl,
    isVerified: profile.isVerified ?? null,
    isPrivate: profile.isPrivate ?? null,
    stats: profile.stats ?? null,
    highlights: "highlights" in profile ? profile.highlights ?? [] : [],
    recentPublicPosts: "recentPublicPosts" in profile ? profile.recentPublicPosts ?? [] : [],
    recentThreads: "recentThreads" in profile ? profile.recentThreads ?? [] : [],
    visibleProfileText: profile.visibleProfileText ?? [],
    source: profile.source,
    connectedAt: profile.connectedAt ?? null,
  }));
  return JSON.stringify(profiles, null, 2);
}

function subjectInputPromptJson(input: OneSubjectInput): string {
  const payload = {
    subject: {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      purpose: input.purpose,
      consentAttestation: input.consentAttestation === true,
      location: {
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        zipCode: input.zipCode ?? null,
      },
    },
    confirmedProfiles: input.confirmedProfiles ?? [],
    linkedinProfile: input.linkedinProfile ? JSON.parse(linkedInProfilePromptJson(input.linkedinProfile)) : null,
    socialProfiles: input.socialProfiles ?? [],
  };
  return JSON.stringify(payload, null, 2);
}

function renderSubjectIntelligenceContext(input: OneSubjectInput): string {
  const li = input.linkedinProfile;
  const socials = input.socialProfiles ?? [];
  const linkedInBlock = li
    ? `\n\nLINKEDIN_ENRICHED_PROFILE_JSON (complete normalized LinkedIn profile; raw scraper/session/cookie data intentionally excluded):\n\`\`\`json\n${linkedInProfilePromptJson(li)}\n\`\`\`\nTreat this JSON as LOCKED GROUND TRUTH for identity, career, education, skills, profile context, and self-declared About.`
    : "";
  const socialBlock = socials.length
    ? `\n\nSOCIAL_ENRICHED_PROFILES_JSON (optional public profile context; raw scraper/session/cookie data intentionally excluded):\n\`\`\`json\n${socialProfilesPromptJson(input)}\n\`\`\`\nTreat these profiles as supporting cross-platform context only. Do not treat social bios, avatars, follower counts, posts, or handles as identity/career ground truth unless public web evidence corroborates them.`
    : "";

  return `SUBJECT_INTELLIGENCE_CONTEXT_JSON (all currently consented inputs available to One; secret/session/raw-scraper fields intentionally excluded):
\`\`\`json
${subjectInputPromptJson(input)}
\`\`\`${linkedInBlock}${socialBlock}`;
}

function intelligenceOperatingProtocol(): string {
  return `ONE INTELLIGENCE OPERATING PROTOCOL:
- Source hierarchy: (1) LinkedIn/user-provided JSON = locked ground truth for identity and self-declared career/profile facts; (2) public web evidence = citations and enrichment; (3) inference = clearly labelled, low/medium/high confidence, never stated as fact.
  - Optional social-profile JSON is supporting context only. Use Instagram/Threads handles, bios, and public/visible post metadata as search seeds and corroboration clues, not as proof of identity, employment, education, or private activity.
- Do not re-open, fetch, reverse-search, or cite signed LinkedIn/media URLs. LinkedIn is already provided as data. Spend search effort on public corroboration, adjacent footprint, contradictions, and useful new findings.
- Reject same-name people unless they connect to the LinkedIn JSON, confirmed profiles, email local-part, employer/school timeline, or another strong anchor.
- For every important claim, include source type label: LinkedIn ground truth, public web evidence, or inference. Prefer "unknown" over guessing.
- If public results conflict with LinkedIn ground truth, report the contradiction and confidence instead of silently overwriting the ground truth.
- Privacy/safety boundary: use lawful public web and consented inputs only. Never expose secrets, leaked values, private messages, exact home address, private family/minor details, tokens, cookies, or non-consented private account data.`;
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
  const contextBlock = renderSubjectIntelligenceContext(input);
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
        contextBlock,
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
  // keep the generic lean budget. Fast mode stays bounded by stopping when signal drops.
  const searchBudget =
    li && haveSpine
      ? `FAST-MODE ADAPTIVE SEARCH STRATEGY — prioritize accuracy, intelligence, and pace. Build searches mechanically from the parsed spine: pair the quoted full name with exactly ONE organisation/profile seed per query so grounding stays locked to this person.
- Start with 1 identity lock-on: "${li.name || input.name}"${spine.current ? ` with ${spine.current}` : ""}.
- Search the CURRENT organisation for role/title plus one high-signal owned footprint axis (GitHub, X, personal site, press, talks, product pages, or articles).
- Search FORMER organisations newest→oldest only while they add signal; stop when marginal value drops.
- Search handle/owned-profile candidates from the email local-part and LinkedIn data, but only report handles a result actually returns.
Use as many targeted searches as needed within fast-depth constraints, then synthesize. Discard same-name strangers; never chase broad disambiguation.`
      : `FAST-MODE ADAPTIVE SEARCH STRATEGY — prioritize accuracy, intelligence, and pace. Use enough targeted web searches to resolve the high-confidence public footprint, seeded from name, email local-part, confirmed profiles, employer/school/city context, then stop when marginal signal drops. Favor depth on this one confirmed person over breadth; surface only real, current results.`;

  return `CONSENT-BASED PUBLIC INTELLIGENCE — PHASE 1. Today is ${today}.
The subject consented to a self-audit of their OWN public online footprint. Use only lawful, publicly accessible information.

${intelligenceOperatingProtocol()}

${identityBlock}

${searchBudget}

DELIVER a premium, evidence-backed markdown report with ONLY these sections:
1. Who they are / Executive Snapshot — 2–4 lines anchored to LinkedIn ground truth, public corroboration, and overall confidence.
2. Public Profiles & Handles — clearly-theirs profiles only: platform · URL · source label · confidence · why it matches.
3. Career, Education & Notable Projects — LinkedIn career graph + public corroboration + notable public work/projects.
4. News, Media & Public Mentions — articles, press, interviews, talks, public-record mentions: title · URL · date · context · confidence.
5. Public Network & Associations — notable public companies, schools, collaborators, communities, investors/advisors/mentors if public; confidence-labelled.
6. Evidence Ledger — table with claim · source label (LinkedIn ground truth / public web evidence / inference) · source URL if public · date/accessed context · confidence · contradiction/verification note.

FINAL QUALITY BAR: this is the first thing the user sees. Be precise, high-confidence, useful, and calm. Unknown beats guessing. Every non-obvious claim needs evidence or a clear LinkedIn-ground-truth/inference label. Keep it strictly about THIS person.`;
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
  const subjectContext = renderSubjectIntelligenceContext(input);

  return `CONSENT-BASED PUBLIC INTELLIGENCE — DEEP PASS: ${batch.label}. Today is ${today}.
The subject consented to a self-audit of their OWN public footprint. Use only lawful, publicly accessible information.

${intelligenceOperatingProtocol()}

${subjectContext}

IDENTITY IS ALREADY CONFIRMED — do NOT re-investigate who this is, and do NOT disambiguate same-name people.${anchorLine}
Name: ${input.name}. Email: ${input.email}.${input.phone ? ` Contact: ${input.phone}.` : ""}

ALREADY-ESTABLISHED FINDINGS about THIS person (context — build on these, do not repeat them):
"""
${context}
"""

FAST-MODE ADAPTIVE SEARCH STRATEGY — be focused and high-confidence. Use targeted searches only for this batch's sections, seeded from the subject context + Tier-1 findings. Search as much as needed within fast-depth constraints, then stop when marginal signal drops.

DELIVER ONLY these markdown "##" sections — use these exact headings, in this order, and output NOTHING else (no intro, no extra sections). Each section must label important claims as LinkedIn ground truth, public web evidence, or inference; include confidence and public source URLs where available:
${batch.sections.map((s) => `## ${s.heading}\n→ ${s.guidance}`).join("\n\n")}

RULES: lawful public sources + consented inputs only; never expose secrets, credentials, leaked values, exact home address, private messages, private family/minor details, tokens, cookies, or non-consented account data. Prefer "unknown" over guessing; back non-obvious claims with source URLs or mark them as LinkedIn ground truth/inference. Strictly about THIS person.`;
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
