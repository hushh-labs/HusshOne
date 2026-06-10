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

/** Decimal degrees → "N 18° 33' 51.815''" style, matching the supplied prompt format. */
function toDms(value: number, pos: string, neg: string): string {
  const dir = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = ((minFloat - min) * 60).toFixed(3);
  return `${dir} ${deg}° ${min}' ${sec}''`;
}

/** The exact consent-based public-internet intelligence prompt, seeded with the subject's
    supplied identity parameters. Sent to phase 1 (Deep Research) verbatim. */
export function buildPersonDossierQuestion(input: OneSubjectInput): string {
  const location =
    typeof input.latitude === "number" && typeof input.longitude === "number"
      ? `location coordinates: latitude ${input.latitude} / ${toDms(input.latitude, "N", "S")}, longitude ${input.longitude} / ${toDms(input.longitude, "E", "W")}`
      : input.zipCode
        ? `location: ZIP/postal ${input.zipCode}`
        : "location: not provided";

  // The subject's pasted LinkedIn URL is the 110% SOURCE OF TRUTH. When present it LEADS the
  // whole prompt (top of the question, where the Deep Research agent weights most) so the agent
  // locks identity to it FIRST and stays pointed — no same-name drift. Other confirmed profiles
  // are cross-linked to that spine. Tuned for the fast agent: anchor-first, pointed, no bloat.
  const anchors = (input.confirmedProfiles ?? []).filter((p) => p && p.url);
  const linkedinAnchor = anchors.find(
    (p) => /linkedin/i.test(p.platform || "") || /linkedin\.com\/in\//i.test(p.url),
  );
  const otherAnchors = anchors.filter((p) => p !== linkedinAnchor);
  const otherAnchorsLine = otherAnchors.length
    ? `\nAlso subject-verified (definitive — cross-link these to the LinkedIn spine):\n${otherAnchors.map((p) => `- ${p.platform}: ${p.url}`).join("\n")}`
    : "";

  const sourceOfTruth = linkedinAnchor
    ? `SINGLE SOURCE OF TRUTH — START HERE.
The subject personally verified that THIS LinkedIn profile is them. Treat it as 110% authoritative ground truth — the spine of the entire report:
${linkedinAnchor.url}

1) RESOLVE IDENTITY FROM THIS PROFILE FIRST. Look up this exact LinkedIn profile and lock the subject's ground-truth spine: full name + variants, headline, current employer + title, full role history with dates, education + degrees + years, current city/region, the profile's vanity handle/slug, and listed skills.
2) MAKE EVERYTHING POINTED TO THIS PERSON. Use that spine as your search seeds — query the name with each employer, school, title and city, and search the LinkedIn vanity handle as a username across GitHub, X/Twitter, Instagram, Medium, Substack, Stack Overflow, YouTube, and personal sites. Cross-link every finding back to this profile and rate confidence by how tightly it connects (shared employer / school / location / handle / timeline ⇒ higher).
3) EXCLUDE SAME-NAME NOISE. Anyone who shares the name but does NOT line up with this LinkedIn profile (different career, location, or timeline) is a DIFFERENT person — mark "Likely false positive" and keep them out of the main findings.
The entire report must be about THIS exact person, anchored to this profile.${otherAnchorsLine}

`
    : anchors.length
      ? `VERIFIED IDENTITY ANCHORS (subject-confirmed — definitive ground truth; resolve the whole report around these and exclude same-name profiles that don't connect, marking them "Likely false positive"):
${anchors.map((p) => `- ${p.platform}: ${p.url}`).join("\n")}

`
      : "";

  return `CONSENT-BASED PUBLIC INTELLIGENCE — PHASE 1: PUBLIC INTERNET INTELLIGENCE DISCOVERY & REPORT GENERATION

${sourceOfTruth}The subject has explicitly consented to lawful public internet identity/context research, public profile enrichment, breach-exposure awareness, safety review, and consent-based personalization, for a self-audit of their own public footprint.

INPUT PARAMETERS (identity confirmation — the LinkedIn profile above is the primary key when provided):
- name: ${input.name}
- email: ${input.email}
- contact: ${input.phone || "not provided"}
- ${location}

ROLE:
You are a consent-based public intelligence analyst. Use only lawful publicly accessible information; build a rigorous public intelligence report; never expose secrets, stolen data, private credentials, or non-public information; clearly separate confirmed facts, probable matches, weak signals, inferred insights, unknowns, contradictions, and false-positive risks; and prefer "unknown" over guessing.

GLOBAL PRIVACY, SAFETY & LEGAL RULES:
1. Use only lawful, publicly accessible sources.
2. Do not access, download, reproduce, or expose stolen databases, credential dumps, hacked data, private messages, private files, paid data-broker records, or dark-web leak sources.
3. Do not reveal passwords, password hashes, OTPs, API keys, tokens, cookies, private credentials, private messages, private financial data, or full leaked records.
4. Do not expose exact home address, precise geolocation, daily routine, private family details, private friend lists, information about minors, or unrelated private contacts.
5. Do not infer sensitive traits (religion, caste, race, ethnicity, sexuality, political affiliation, health, criminality, medical info) unless the subject made it explicitly public AND it is directly relevant.
6. Do not infer private facts without evidence.
7. Mark every uncertain item as "possible," "inferred," "weak," "unverified," or "unknown."
8. Relationship status, approximate age, income context, lifestyle, preferences, and net-worth-like scoring must be evidence-based and confidence-labelled.
9. Do not guess from photos, appearance, stereotypes, gender, caste, religion, city, or clothing.
10. Every important claim must include evidence: source URL, title, source type, snippet/summary, date accessed, match reason, and confidence level.
11. If evidence is weak or conflicting, say so clearly.
12. The report must be useful for the subject's own awareness and remediation — not for stalking, harassment, impersonation, discrimination, or surveillance.
13. Never output secrets or stolen data, and never provide instructions to access them.
14. Never scrape dark-web marketplaces, private breach forums, leak groups, or credential dumps.
15. Breach intelligence is allowed only in a lawful, consented, remediation-first way: identify affected platform, exposure category, date if available, risk level, and revoke/reset actions — never the actual secret value.

OBJECTIVE:
Build an end-to-end structured public intelligence report that helps the subject understand their public identity footprint, professional/education/project footprint, technical footprint, public preferences, lifestyle/context signals, reputation, discoverability, possible exposure risks, breach/security awareness, and recommended cleanup/enrichment actions.

SEARCH SCOPE (only where publicly visible):
General public web and search engines; LinkedIn; GitHub, GitLab, Stack Overflow, Kaggle, npm, PyPI, Hugging Face; X/Twitter, Instagram, Facebook, YouTube, Reddit, Medium, Substack, Dev.to; personal websites/portfolios/blogs/docs; startup/company pages; university/school/college pages; event/hackathon/speaker/award/conference pages; Product Hunt, Crunchbase, Wellfound/AngelList, app stores, product pages; news articles, interviews, press releases; lawful public government/business-registry mentions; public court/legal mentions only if clearly relevant and public (never imply wrongdoing without evidence); public SEO/AEO pages; public association signals (company, school, co-founder, collaborator, team, advisor, mentor, investor, event); and lawful breach-notification/exposure-monitoring sources for the subject's consented identifiers.

SEARCH METHODOLOGY:
When a LinkedIn SOURCE OF TRUTH is provided above, derive your FIRST queries from its spine (the name with each employer / school / title / city, and the vanity handle as a cross-platform username) before broadening — this keeps the result pointed to the real person. Then use many query variations: exact name; exact email; exact contact (if provided and lawful); name + email/contact/location/company/school/college/university; name with LinkedIn/GitHub/GitLab/Stack Overflow/portfolio/resume/CV/PDF/founder/co-founder/engineer/developer/student/startup/news/award/hackathon/event/speaker/interview/blog/article/product; site-scoped queries (site:linkedin.com/in, site:github.com, site:gitlab.com, site:stackoverflow.com, site:medium.com, site:dev.to, site:substack.com, site:crunchbase.com, site:wellfound.com, site:producthunt.com, site:x.com OR site:twitter.com); email exact + email-prefix-as-username + username derivations; discovered aliases/handles; phone/contact exact only if provided and lawful.

IDENTITY RESOLUTION STANDARD — classify every potential match as one of: Confirmed (exact email/phone, official/self-linked profiles, or multiple high-quality independent sources); Probable (name + location/company/education/username/career overlap, no direct email/phone confirmation); Possible (partial overlap, needs verification); Weak/Unverified (low confidence, mark clearly); Likely false positive (similar name/username but conflicting details). For each matched profile explain why it may be the same person, supporting signals, weakening signals, confidence, false-positive risk, and verification needed.

REPORT OUTPUT STRUCTURE — return a complete report with these sections:
1. Executive Summary — who the subject appears to be publicly; strongest confirmed signals; main professional/education/project footprint; public visibility (Low/Medium/High); overall confidence (Low/Medium/High); top 5 useful findings; top 5 unknowns/weak areas; top 5 immediate safety/cleanup actions.
2. Confirmed Identity Signals — name variations; public usernames/handles; public email appearances; public contact appearances (if consented/visible); public city/region; workplace/school context; profile cross-links; websites; confidence per signal; evidence.
3. Possible Public Profiles — a table per platform with: platform, profile URL, display name, username, bio/headline, location shown, website/contact shown, public activity summary, match reason, confidence, false-positive risk, verification needed, evidence.
4. Public Contact & Location Context — only public/consented info: public email/contact appearances; city/region; workplace/school location; possible current city if supported; historic location mentions if relevant. Never include exact home address or routine locations. Confidence + evidence each.
5. Career, Education & Project Footprint — current/past roles; companies; founder/advisor signals; education + graduation year if public; certifications; public resumes/CVs; projects; repositories; open-source; technical stack; blogs/articles; hackathons; events; portfolio; product launches; awards; career timeline; confidence + evidence.
6. Technical & Domain Intelligence — languages, frameworks, tools, cloud/devops, AI/ML, data/analytics, product/design, business/startup; domains; quality + recency of public work; credibility indicators; strongest vs weak/outdated signals; notable repos/articles/projects; evidence.
7. Media, News, Newspaper, Government & Public Record Mentions — for each: URL, title, source, date, snippet, relevance, match confidence, false-positive risk, evidence.
8. Public Network & Association Signals — only public, relevant associations (companies, schools, co-founders, collaborators, event teammates, advisors, mentors, investors, org/community memberships), each classified Strong/Medium/Weak/Unknown with evidence. Never expose private friend lists, family, or minors.
9. Preference Intelligence Layer — only evidence-backed public preferences (professional/technical/startup/content interests; food/drink/fashion/travel/sports/gaming/reading; communities; explicit likes/dislikes). For each: item, category, direct or inferred, evidence source, confidence, recency, explanation, alternative interpretation, verification needed. No sensitive-trait inference; no single post = permanent preference; avoid stereotypes.
10. Lifestyle & Context Signals — only public, non-invasive signals (broad city lifestyle, professional lifestyle, public travel/activity, brand/event affinity, creator/community activity), confidence + caveats. Avoid exact address, routine, private relationships/family, financial accounts, medical inference.
11. Approximate Age & Life Stage — estimate only from public evidence (public DOB, education/graduation timeline, "class of," work timeline). Output an age RANGE (not exact unless publicly disclosed), evidence, confidence, caveat. Never estimate from photos.
12. Relationship / Marital Status Signal — only if self-declared publicly, in an official public record, or clearly stated on a public profile: Single/Married/In relationship/Unknown + evidence + confidence + caveat. Never infer from photos/tags/travel.
13. Net Worth Signal Score (NWS, 0–100) — a rough public-signal proxy, NOT actual net worth. NWS = 0.25×role/income-band + 0.15×seniority/company-quality + 0.15×business/founder/equity + 0.10×location cost-of-living + 0.10×public lifestyle/spending + 0.10×career trajectory + 0.10×education/network + 0.05×public asset/investment. For each component: 0–100, evidence, reasoning, confidence, caveat. Use public salary bands as broad benchmarks only; founder/equity is speculative unless funding/ownership/exit/filings are public; never infer debt/savings/assets without public evidence. Output NWS as a RANGE (e.g. 35–50/100), plus estimated earning-capacity category, financial-visibility level, net-worth confidence, and "what would improve confidence." Key caveat: this is not actual net worth.
14. Public Reputation & Credibility Score (0–100) — based on verified profiles, quality of public work, endorsements/recognition, project credibility, source consistency, media mentions, network strength, recency, public authority pages. Include score range, evidence, confidence, weaknesses, reputation risks, improvement suggestions.
15. Digital Footprint & Discoverability Score (0–100) — based on number of public profiles, search visibility, cross-linking, content depth, SEO/AEO visibility, recency, consistency, username uniqueness. Include Low/Medium/High classification, top searchable keywords, top public URLs, cleanup + consolidation recommendations.
16. Breach Exposure & Revoke Map — only lawful breach-notification/exposure-monitoring/public security-advisory sources for the consented identifiers. For each signal: exposure status (Found/Not found/Unknown); affected identifier; affected platform/service; breach/exposure date; data categories exposed (NEVER the secret value — e.g. "password hash reported" but never show it); risk level (Low/Medium/High/Critical); evidence (URL/title/summary/date/confidence); a user action map (change password, reset reused passwords, enable MFA/passkeys, revoke sessions + OAuth apps, rotate API keys/tokens, delete unused accounts, check login history + recovery email/phone + forwarding rules, use a password manager, set breach alerts, watch for phishing); and revoke/reset priority (Immediate / 24h / 7d / Monitor). Never display any secret value; never open/download/reproduce leaked data.
17. Security Hygiene Recommendations — prioritized actions based on exposure + footprint (password reset priority, MFA/passkeys, OAuth cleanup, session revocation, profile cleanup, old-account deletion, email-alias strategy, domain/privacy protection, GitHub secret scanning if a developer footprint exists, API-key rotation if exposure suspected, social privacy improvements, search-result cleanup).
18. Evidence Table — finding ID, claim, source URL, source title, source type, date published/updated, date accessed, evidence snippet/summary, match reason, confidence, false-positive risk, recommended verification step.
19. Contradictions & False-Positive Risks — similar names; conflicting locations/education/employment; outdated/duplicate profiles; common-name + username-collision risk; weak matches excluded and why; claims needing subject verification.
20. Data Quality & Confidence Matrix — rate each category (identity, contact, location, career, education, project, technical, media/news, preference, network, lifestyle, approximate age, relationship status, NWS, breach signal, overall) as High / Medium / Low / Unknown.
21. Recommended Next Consented Enrichment Steps — ethical next steps (verify matched profiles; approve/reject inferred preferences; verify location; connect LinkedIn/GitHub or upload resume only with explicit consent; run official breach checks personally; choose which categories to store + retention period; correction/edit/delete mechanism; consent dashboard with source/confidence/delete controls; audit log; revoke consent anytime).

STYLE: Be rigorous, cautious, evidence-first, privacy-preserving, useful, and actionable. Do not hallucinate. Prefer "unknown" over guessing. Clearly separate confirmed facts, probable matches, weak signals, inferred insights, unknowns, and false-positive risks. Never output secrets or stolen data.`;
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
