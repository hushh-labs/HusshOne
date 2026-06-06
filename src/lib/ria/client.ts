import type {
  DashboardCategoryMap,
  OneSubjectInput,
  PersonAuditStatus,
  PersonDashboardResponse,
} from "./types";

const DEFAULT_BASE_URL = "https://hushh-ria-intelligence-api-53407187172.us-central1.run.app";
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function baseUrl() {
  return (process.env.RIA_INTELLIGENCE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function timeoutMs() {
  const value = Number.parseInt(process.env.ONE_RIA_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 5_000), 600_000) : 180_000;
}

function retryCount() {
  const value = Number.parseInt(process.env.ONE_RIA_RETRIES || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 4) : 2;
}

function retryDelayMs(attempt: number, status: number | null) {
  const configured = Number.parseInt(process.env.ONE_RIA_RETRY_BASE_DELAY_MS || "", 10);
  const base = Number.isFinite(configured) ? Math.min(Math.max(configured, 0), 5_000) : 450;
  const quotaMultiplier = status === 429 ? 2 : 1;
  return base * quotaMultiplier * attempt + Math.floor(Math.random() * 125);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function fetchJsonOnce<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = process.env.PERSON_INTELLIGENCE_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error("Personal intelligence API key is not configured"), { statusCode: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs());

  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "one.personal_intelligence.upstream_error",
          path,
          status: response.status,
          baseUrl: baseUrl(),
        }),
      );
      throw Object.assign(new Error("Personal intelligence is temporarily unavailable"), {
        statusCode: response.status === 202 ? 202 : 502,
        upstreamStatus: response.status,
        payload,
      });
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(
        JSON.stringify({
          event: "one.personal_intelligence.timeout",
          path,
          timeoutMs: timeoutMs(),
          baseUrl: baseUrl(),
        }),
      );
      throw Object.assign(new Error("Personal intelligence timed out"), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const retries = retryCount();

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fetchJsonOnce<T>(path, options);
    } catch (error) {
      if (!shouldRetry(error) || attempt > retries) {
        throw error;
      }

      const status = errorStatus(error);
      const delayMs = retryDelayMs(attempt, status);
      console.warn(
        JSON.stringify({
          event: "one.personal_intelligence.retry",
          path,
          status,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          baseUrl: baseUrl(),
        }),
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw Object.assign(new Error("Personal intelligence is temporarily unavailable"), { statusCode: 502 });
}

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

function mockDashboard(input: OneSubjectInput): PersonDashboardResponse {
  return {
    entityId: input.name,
    summary: `${input.name} has a public footprint across education, professional, and open web signals. This local mock keeps private contact details hidden while the real RIA key is not configured.`,
    categorizedData: {
      newsAndMedia: ["No source-backed media signal in local mock mode."],
      socials: ["LinkedIn-style public profile signal possible", "GitHub-style technical footprint possible"],
      education: ["Education source category ready for source-backed matches"],
      government: ["No confirmed government or legal record shown"],
      otherFootprints: ["Public web and portfolio-style pages"],
      connectedIdentities: ["Connected identity signals require source-backed review"],
    },
    privateDataEstimation: [
      "Professional platforms may hold profile and career records.",
      "Consumer data brokers may hold address or phone records; direct contact details are redacted.",
    ],
    locationIntelligence:
      input.latitude && input.longitude
        ? `Coordinate-backed local context is available near ${input.latitude.toFixed(3)}, ${input.longitude.toFixed(3)}.`
        : "Zip-code-only location context is limited.",
  };
}

function compactText(value: unknown, depth = 0): string {
  if (depth > 3 || value == null) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => compactText(item, depth + 1)).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "summary",
      "report",
      "markdown",
      "footprint",
      "intelligence",
      "analysis",
      "text",
      "content",
      "details",
      "result",
      "data",
    ];
    for (const key of preferredKeys) {
      const text = compactText(record[key], depth + 1);
      if (text) return text;
    }
    return Object.values(record)
      .slice(0, 12)
      .map((item) => compactText(item, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function sentenceSnippets(text: string) {
  const matches = text.match(/[^.!?]+[.!?]?/g) || [text];
  return matches.map((item) => truncateText(item.trim(), 220)).filter(Boolean).slice(0, 5);
}

function sourceLabels(value: unknown) {
  if (!value || typeof value !== "object" || !("sources" in value)) return [];
  const sources = (value as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];

  return sources
    .map((source) => {
      if (typeof source === "string") return source;
      if (!source || typeof source !== "object") return "";
      const record = source as Record<string, unknown>;
      return compactText(record.url || record.link || record.title || record.name);
    })
    .filter(Boolean)
    .slice(0, 5);
}

function dashboardFromFootprint(input: OneSubjectInput, payload: unknown): PersonDashboardResponse {
  const text = truncateText(compactText(payload), 1_400);
  const snippets = sentenceSnippets(text);
  const categories = emptyCategories();
  categories.otherFootprints = snippets.length
    ? snippets
    : ["One received a partial public-footprint response while the dashboard endpoint was unavailable."];
  categories.connectedIdentities = sourceLabels(payload);

  return {
    entityId: input.name,
    summary:
      snippets[0] ||
      "One found a partial public footprint while the dashboard endpoint was unavailable.",
    categorizedData: categories,
    privateDataEstimation: [],
    locationIntelligence:
      typeof input.latitude === "number" && typeof input.longitude === "number"
        ? `Coordinate-backed context was requested near ${input.latitude.toFixed(3)}, ${input.longitude.toFixed(3)}.`
        : "Limited location context was used.",
  };
}

export function buildAuditPendingDashboard(input: OneSubjectInput, audit: PersonAuditStatus): PersonDashboardResponse {
  const categories = emptyCategories();
  categories.otherFootprints = [
    `Deeper audit started across ${audit.totalShards || "multiple"} public-source shards.`,
  ];

  return {
    entityId: input.name,
    summary: "One started the deeper audit. Dashboard signals are still warming up, so only verified results will appear when sources respond.",
    categorizedData: categories,
    privateDataEstimation: [],
    locationIntelligence:
      typeof input.latitude === "number" && typeof input.longitude === "number"
        ? `Coordinate-backed context was requested near ${input.latitude.toFixed(3)}, ${input.longitude.toFixed(3)}.`
      : "Limited location context was used.",
  };
}

export function buildTemporaryDashboard(input: OneSubjectInput): PersonDashboardResponse {
  const categories = emptyCategories();
  categories.otherFootprints = [
    "Personal intelligence is queued for another pass.",
  ];

  return {
    entityId: input.name,
    summary: "One saved the request. Public-source intelligence is temporarily warming back up, so only verified signals will appear when the layer responds.",
    categorizedData: categories,
    privateDataEstimation: [],
    locationIntelligence:
      typeof input.latitude === "number" && typeof input.longitude === "number"
        ? `Coordinate-backed context was requested near ${input.latitude.toFixed(3)}, ${input.longitude.toFixed(3)}.`
        : "Limited location context was used.",
  };
}

export async function fetchDashboardIntelligence(input: OneSubjectInput) {
  if (process.env.ONE_ENABLE_MOCK_RIA === "true") {
    return mockDashboard(input);
  }

  if (typeof input.latitude === "number" && typeof input.longitude === "number") {
    const body = JSON.stringify({
      name: input.name,
      email: input.email,
      latitude: input.latitude,
      longitude: input.longitude,
      consentAttestation: true,
      purpose: "self_audit",
    });

    try {
      return await fetchJson<PersonDashboardResponse>("/v1/person-intelligence/dashboard", {
        method: "POST",
        body,
      });
    } catch (dashboardError) {
      console.warn(
        JSON.stringify({
          event: "one.personal_intelligence.dashboard_fallback",
          path: "/v1/person-intelligence/dashboard",
          fallbackPath: "/v1/person-intelligence/footprint",
          status: errorStatus(dashboardError),
          baseUrl: baseUrl(),
        }),
      );

      try {
        const footprint = await fetchJson<unknown>("/v1/person-intelligence/footprint", {
          method: "POST",
          body,
        });
        return dashboardFromFootprint(input, footprint);
      } catch (fallbackError) {
        console.warn(
          JSON.stringify({
            event: "one.personal_intelligence.fallback_failed",
            path: "/v1/person-intelligence/footprint",
            status: errorStatus(fallbackError),
            baseUrl: baseUrl(),
          }),
        );
        throw dashboardError;
      }
    }
  }

  if (input.zipCode) {
    const osint = await fetchJson<{ intelligence?: { summary?: string; sections?: unknown[] } | string }>(
      "/v1/intelligence/osint-profile",
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          email: input.email,
          zipCode: input.zipCode,
        }),
      },
    );
    const summary =
      typeof osint.intelligence === "string"
        ? osint.intelligence
        : osint.intelligence?.summary;
    return {
      entityId: input.name,
      summary: summary || "One found a limited public-footprint result.",
      categorizedData: {
        newsAndMedia: [],
        socials: [],
        education: [],
        government: [],
        otherFootprints: [summary || "Limited OSINT profile returned."],
        connectedIdentities: [],
      },
      privateDataEstimation: [],
      locationIntelligence: "Limited mode used zip code instead of browser coordinates.",
    } satisfies PersonDashboardResponse;
  }

  throw Object.assign(new Error("Location or zip code is required"), { statusCode: 400 });
}

export async function startAudit(input: OneSubjectInput): Promise<PersonAuditStatus | null> {
  if (process.env.ONE_ENABLE_MOCK_RIA === "true") {
    return {
      jobId: "mock-audit-job",
      status: "running",
      totalShards: 12,
      completedShards: 2,
      failedShards: 0,
      reportAvailable: false,
      errors: [],
    };
  }

  if (typeof input.latitude !== "number" || typeof input.longitude !== "number") {
    return null;
  }

  return fetchJson<PersonAuditStatus>("/v1/person-intelligence/audits", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      latitude: input.latitude,
      longitude: input.longitude,
      consentAttestation: true,
      purpose: "self_audit",
    }),
  });
}

export async function fetchAuditReport(jobId: string) {
  return fetchJson<unknown>(`/v1/person-intelligence/audits/${encodeURIComponent(jobId)}/report`, {
    method: "GET",
  });
}
