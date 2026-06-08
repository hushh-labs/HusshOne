/* Build the Deep Research question from the One subject, and map the returned
   markdown report into the OneDashboardResult the UI + DB already use. */
import type { DashboardCategoryMap, LocationMode, OneDashboardResult, OneSubjectInput } from "@/lib/ria/types";

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

  return (
    "Consent-based public internet intelligence request. Subject supplied the following consent parameters for an end-to-end identity/context research layer: " +
    `name: ${input.name}; email: ${input.email}; contact: ${input.phone || "not provided"}; ${location}. ` +
    "Search the public internet broadly and rigorously for this subject across public web, social/professional profiles including LinkedIn/GitHub if publicly visible, news/newspaper articles, government/public records sites, SEO/AEO-visible pages, blogs, non-blog pages, public social links, public non-social links, and public network/friend/association signals. " +
    "Use only lawful publicly accessible information and clearly mark unknown/unverified items. Do not infer private facts without evidence. Do not expose passwords, private credentials, or non-public data. " +
    "Return a structured intelligence report with: executive summary, confirmed identity signals, possible public profiles, public contact/location context, career/education/project footprint, media/news/government mentions, public network/associations, confidence levels, evidence table with URLs/titles/snippets, contradictions/false-positive risks, and recommended next consented enrichment steps."
  );
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
  };
}
