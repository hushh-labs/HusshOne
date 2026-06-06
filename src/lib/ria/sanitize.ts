import type {
  DashboardCategoryMap,
  OneDashboardResult,
  OneSafeFinding,
  PersonDashboardResponse,
  ResultSource,
} from "./types";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3,5}\)?[\s.-]?)\d{3,5}[\s.-]?\d{4,6}\b/g;
const SECRET_PATTERN =
  /\b(?:api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token|bearer\s+token|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{8,}/gi;
const ADDRESS_PATTERN =
  /\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|apartment|apt|suite|unit|flat|society)\b/gi;
const UNSUPPORTED_CLAIM_PATTERN =
  /\b(?:dark web|voter|criminal|arrest|lawsuit|court record|breach|leaked password|net worth|wealth estimate)\b/gi;

const CATEGORY_KEYS: (keyof DashboardCategoryMap)[] = [
  "newsAndMedia",
  "socials",
  "education",
  "government",
  "otherFootprints",
  "connectedIdentities",
];

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function redactText(value: unknown) {
  let text = normalizeText(value);
  const redactions = new Set<string>();
  const replace = (pattern: RegExp, replacement: string, label: string) => {
    text = text.replace(pattern, () => {
      redactions.add(label);
      return replacement;
    });
  };

  replace(SECRET_PATTERN, "[redacted-secret]", "secret");
  replace(PHONE_PATTERN, "[redacted-phone]", "phone");
  replace(ADDRESS_PATTERN, "[redacted-address]", "address");
  replace(EMAIL_PATTERN, "[redacted-email]", "email");

  return { text, redactions: Array.from(redactions) };
}

export function uniqueCleanList(values: unknown, redactions: Set<string>, limit = 8) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const item of list) {
    const redacted = redactText(item);
    redacted.redactions.forEach((label) => redactions.add(label));
    if (!redacted.text || seen.has(redacted.text)) continue;
    seen.add(redacted.text);
    output.push(redacted.text);
  }

  return output.slice(0, limit);
}

/* URL-safe cleaner: links must survive (never run through PII redaction, which
   would mangle a legit profile URL). Drops mailto:/empty, dedupes, caps. */
export function cleanUrlList(values: unknown, limit = 12) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of list) {
    const text = normalizeText(item);
    if (!text || /^mailto:/i.test(text) || seen.has(text)) continue;
    seen.add(text);
    output.push(text.slice(0, 400));
  }
  return output.slice(0, limit);
}

function normalizeCategories(
  categorizedData: Partial<DashboardCategoryMap> | undefined,
  redactions: Set<string>,
): DashboardCategoryMap {
  const source = categorizedData ?? {};
  return CATEGORY_KEYS.reduce((acc, key) => {
    acc[key] = uniqueCleanList(source[key], redactions);
    return acc;
  }, {} as DashboardCategoryMap);
}

function findingConfidence(text: string): OneSafeFinding["confidence"] {
  if (UNSUPPORTED_CLAIM_PATTERN.test(text)) {
    UNSUPPORTED_CLAIM_PATTERN.lastIndex = 0;
    return "not-verified";
  }
  UNSUPPORTED_CLAIM_PATTERN.lastIndex = 0;
  return /https?:\/\/|source|public|profile|official/i.test(text)
    ? "source-backed"
    : "possible";
}

function normalizeFindings(values: unknown, redactions: Set<string>) {
  return uniqueCleanList(values, redactions).slice(0, 6).map((detail, index) => ({
    id: `private-${index + 1}`,
    label: `Signal type ${index + 1}`,
    detail,
    confidence: findingConfidence(detail),
  }));
}

export function normalizeDashboardPayload(params: {
  scanRunId?: string | null;
  mode: "precise" | "limited";
  subject: { name: string; email: string };
  dashboard: Partial<PersonDashboardResponse>;
  auditJobId?: string | null;
  source?: ResultSource;
}): OneDashboardResult {
  const redactions = new Set<string>();
  const summary = redactText(params.dashboard.summary);
  const location = redactText(params.dashboard.locationIntelligence);
  summary.redactions.forEach((label) => redactions.add(label));
  location.redactions.forEach((label) => redactions.add(label));

  const categories = normalizeCategories(
    params.dashboard.categorizedData,
    redactions,
  );
  const privateDataEstimation = normalizeFindings(
    params.dashboard.privateDataEstimation,
    redactions,
  );

  const warnings = [
    "Unsupported breach, dark-web, voter, legal, and wealth-style claims are shown as unverified.",
    "One stores sanitized dashboard results by default.",
  ];

  if (params.mode === "limited") {
    warnings.push("Location was limited, so the result may miss coordinate-backed context.");
  }

  return {
    scanRunId: params.scanRunId ?? null,
    mode: params.mode,
    source: params.source ?? "person_intelligence",
    subject: params.subject,
    entityId: normalizeText(params.dashboard.entityId) || null,
    summary: summary.text || "One found a quiet public footprint. More source-backed detail may appear after the deeper audit finishes.",
    categories,
    privateDataEstimation,
    locationIntelligence: location.text || null,
    auditJobId: params.auditJobId ?? null,
    redactions: Array.from(redactions).sort(),
    warnings,
    rich: null,
  };
}

export function hasUnsafeRawContactData(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return PHONE_PATTERN.test(text) || SECRET_PATTERN.test(text);
}
