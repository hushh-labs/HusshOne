/* Client for the standalone Hushh Deep Research API (Vertex-backed).
   Mirrors src/lib/ria/client.ts: env base URL + Bearer token, AbortController
   timeout, retry with backoff, {statusCode} error convention. */

const DEFAULT_BASE_URL = "https://deep-research-api-bmrh3cdxwa-el.a.run.app";
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type ResearchDepth = "max" | "fast";

export interface ResearchPollResult {
  status: string; // in_progress | completed | failed
  report: string | null;
  citations: unknown[];
  progress: string | null;
  error: string | null;
}

function baseUrl() {
  return (process.env.DEEP_RESEARCH_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function apiToken() {
  return process.env.DEEP_RESEARCH_API_TOKEN?.trim();
}

function timeoutMs() {
  const value = Number.parseInt(process.env.DEEP_RESEARCH_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 5_000), 120_000) : 60_000;
}

function retryCount() {
  const value = Number.parseInt(process.env.DEEP_RESEARCH_RETRIES || "", 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 4) : 2;
}

function retryDelayMs(attempt: number, status: number | null) {
  const base = 450;
  const quotaMultiplier = status === 429 ? 2 : 1;
  return base * quotaMultiplier * attempt + Math.floor(Math.random() * 125);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  if ("upstreamStatus" in error && typeof error.upstreamStatus === "number") return error.upstreamStatus;
  return null;
}

function shouldRetry(error: unknown) {
  const status = errorStatus(error);
  return status !== null && RETRYABLE_UPSTREAM_STATUSES.has(status);
}

async function callJsonOnce<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = apiToken();
  if (!token) {
    throw Object.assign(new Error("Deep Research API token is not configured"), { statusCode: 503 });
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
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(
        JSON.stringify({ event: "one.deep_research.upstream_error", path, status: response.status, baseUrl: baseUrl() }),
      );
      const message =
        (payload as { error?: { message?: string } })?.error?.message || "Deep Research is temporarily unavailable";
      throw Object.assign(new Error(message), {
        statusCode: 502,
        upstreamStatus: response.status,
        payload,
      });
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error("Deep Research request timed out"), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const retries = retryCount();
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await callJsonOnce<T>(path, options);
    } catch (error) {
      if (!shouldRetry(error) || attempt > retries) throw error;
      const delayMs = retryDelayMs(attempt, errorStatus(error));
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw Object.assign(new Error("Deep Research is temporarily unavailable"), { statusCode: 502 });
}

const MOCK_REPORT = [
  "# Personal Intelligence Dossier (mock)",
  "",
  "## Executive Summary",
  "This is a local mock report. Set `ONE_ENABLE_MOCK_RESEARCH=false` and configure `DEEP_RESEARCH_API_TOKEN` to call the live Deep Research API.",
  "",
  "## Professional",
  "- Example role at Example Co (2024–present).",
  "",
  "## Open-source footprint",
  "- GitHub: example-handle",
  "",
  "## Sources",
  "1. https://example.com/profile",
].join("\n");

/** Start a background Deep Research job. Returns the jobId to poll. */
export async function startResearch(question: string, depth: ResearchDepth): Promise<{ jobId: string }> {
  if (process.env.ONE_ENABLE_MOCK_RESEARCH === "true") {
    return { jobId: "mock-research-job" };
  }
  const data = await callJson<{ jobId?: string; id?: string }>("/v1/research", {
    method: "POST",
    body: JSON.stringify({ question, depth }),
  });
  const jobId = data.jobId || data.id;
  if (!jobId) {
    throw Object.assign(new Error("Deep Research did not return a job id"), { statusCode: 502 });
  }
  return { jobId };
}

/** Poll a Deep Research job for its current status / final report. */
export async function pollResearch(jobId: string): Promise<ResearchPollResult> {
  if (process.env.ONE_ENABLE_MOCK_RESEARCH === "true") {
    return { status: "completed", report: MOCK_REPORT, citations: [], progress: null, error: null };
  }
  const data = await callJson<{
    status?: string;
    report?: string | null;
    citations?: unknown[];
    progress?: string | null;
    error?: string | null;
  }>(`/v1/research/${encodeURIComponent(jobId)}`, { method: "GET" });
  return {
    status: String(data.status || "in_progress").toLowerCase(),
    report: data.report ?? null,
    citations: Array.isArray(data.citations) ? data.citations : [],
    progress: data.progress ?? null,
    error: data.error ?? null,
  };
}

export interface SynthIdentity {
  name: string;
  email: string;
  phone?: string;
  location?: string;
}

/** Synthesis runs Claude server-side; allow longer than the poll/start timeout. */
function synthTimeoutMs() {
  const value = Number.parseInt(process.env.DEEP_RESEARCH_SYNTH_TIMEOUT_MS || "", 10);
  // Phase-2 now emits a much larger 22-section markdown report → allow more headroom
  // before the fail-safe (raw phase-1) kicks in.
  return Number.isFinite(value) ? Math.min(Math.max(value, 30_000), 300_000) : 270_000;
}

/**
 * Phase 2: refine a raw phase-1 dossier into the focused, disambiguated, confidence-
 * ranked FINAL report (Claude Opus on Vertex, executed server-side by the DR API).
 */
export async function synthesizeReport(
  rawReport: string,
  identity: SynthIdentity,
  citations: unknown[] = [],
): Promise<string> {
  if (process.env.ONE_ENABLE_MOCK_RESEARCH === "true") {
    return [
      "This is the subject — High confidence — mock synthesis (set ONE_ENABLE_MOCK_RESEARCH=false to call real Opus on Vertex).",
      "",
      rawReport,
    ].join("\n");
  }
  const token = apiToken();
  if (!token) {
    throw Object.assign(new Error("Deep Research API token is not configured"), { statusCode: 503 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), synthTimeoutMs());
  try {
    const response = await fetch(`${baseUrl()}/v1/synthesize`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ report: rawReport, identity, citations }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn(
        JSON.stringify({ event: "one.deep_research.synth_upstream_error", status: response.status, baseUrl: baseUrl() }),
      );
      const message = (payload as { error?: { message?: string } })?.error?.message || "Synthesis failed";
      throw Object.assign(new Error(message), { statusCode: 502, upstreamStatus: response.status });
    }
    const report = (payload as { report?: string }).report;
    if (!report || !report.trim()) {
      throw Object.assign(new Error("Synthesis returned an empty report"), { statusCode: 502 });
    }
    return report;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw Object.assign(new Error("Synthesis request timed out"), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
