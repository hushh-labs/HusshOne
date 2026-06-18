/* Phase-D: Vertex preference synthesis. Reads the FULL indexed archive (SocialContentItem) + the
   media analyses (SocialMediaAsset) and asks a Vertex LLM (Gemini 3.1 Pro by default, env-switchable)
   to answer the 30 preference questions with evidence, confidence, source, and honest unknowns.
   All inference goes THROUGH Vertex (no direct Gemini API). Sensitive questions (Partner & Romance)
   can never be force-answered — the guardrail is enforced in code, not trusted to the model.
   Pure builders/parsers are exported for unit tests; the network call is fully defensive. */
import { adcAccessToken, vertexConfig, vertexGenerateContentUrl } from "@/lib/gcp/auth";
import { PREFERENCE_QUESTIONS, type PreferenceQuestionDefinition } from "./preference-profile";
import type { ArchiveContentRecord } from "@/lib/db/scan-store";

export const PREFERENCE_SYNTHESIS_VERSION = "2026-06-18.synthesis-v3";
export const DEFAULT_SYNTH_MODEL = "gemini-3.1-pro";
const FETCH_TIMEOUT_MS = 60_000;

// Context budgets — keep the synthesis prompt bounded (Vertex has generous limits, but a tight,
// aggregated context is faster, cheaper, and higher-signal than dumping 1024 raw posts).
const MAX_TEXT_SNIPPETS = 60;
const TEXT_SNIPPET_CHARS = 240;
const TOP_AGG = 16;

export type SynthAnswerStatus = "answered" | "inferred" | "needs_confirmation" | "unknown";
export type SynthConfidence = "low" | "medium" | "high";
export type SynthSource = "self_declared" | "observed" | "inferred" | "aggregate" | "not_available";

export interface SynthesizedAnswer {
  questionId: string;
  sectionId: string;
  prompt: string;
  status: SynthAnswerStatus;
  answer: string | null;
  confidence: SynthConfidence;
  source: SynthSource;
  evidenceIds: string[];
  mediaEvidenceIds: string[];
  why: string | null;
  needsUserConfirmation: boolean;
}

export interface MediaAnalysisRecord {
  platform: string;
  assetHash: string;
  sourceUrl: string;
  analysis: unknown; // the MediaAnalysisResult JSON persisted on SocialMediaAsset.analysis
}

export interface SynthesisContext {
  platforms: string[];
  contentItemCount: number;
  mediaAnalyzedCount: number;
  textSnippets: Array<{ id: string; platform: string; type: string; text: string }>;
  mediaSignals: {
    brands: string[];
    logos: string[];
    devices: string[];
    foodDrink: string[];
    travelPlaceTypes: string[];
    clothingStyles: string[];
    colorAesthetic: string[];
    scenes: string[];
    activities: string[];
    ocrSnippets: string[];
  };
}

export interface PreferenceSynthesisResult {
  version: string;
  model: string;
  answers: SynthesizedAnswer[];
  context: { platforms: string[]; contentItems: number; mediaAnalyzed: number };
}

/* ── Pure aggregation (unit-tested) ─────────────────────────────────────────────────────────── */

function topByFrequency(values: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    // re-surface a representative original casing
    .map(([key]) => values.find((v) => v.trim().toLowerCase() === key)?.trim() ?? key);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

/** Aggregate the archive + media analyses into a compact, high-signal synthesis context. */
export function buildSynthesisContext(contentItems: ArchiveContentRecord[], mediaAnalyses: MediaAnalysisRecord[]): SynthesisContext {
  const platforms = [...new Set(contentItems.map((c) => c.platform))].sort();

  const textSnippets = contentItems
    .filter((c) => c.text && c.text.trim())
    .slice(0, MAX_TEXT_SNIPPETS)
    .map((c) => ({ id: c.itemId, platform: c.platform, type: c.itemType, text: (c.text as string).replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET_CHARS) }));

  const brands: string[] = [];
  const logos: string[] = [];
  const devices: string[] = [];
  const foodDrink: string[] = [];
  const travelPlaceTypes: string[] = [];
  const clothingStyles: string[] = [];
  const colorAesthetic: string[] = [];
  const scenes: string[] = [];
  const activities: string[] = [];
  const ocrSnippets: string[] = [];
  let mediaAnalyzedCount = 0;

  for (const record of mediaAnalyses) {
    const analysis = asRecord(record.analysis);
    if (analysis.status !== "completed") continue;
    mediaAnalyzedCount += 1;
    const vision = asRecord(analysis.vision);
    const semantic = asRecord(analysis.semantic);
    logos.push(...strArray(vision.logos));
    if (typeof vision.ocrText === "string" && vision.ocrText.trim()) ocrSnippets.push(vision.ocrText.trim().slice(0, 120));
    brands.push(...strArray(semantic.brands));
    devices.push(...strArray(semantic.devices));
    foodDrink.push(...strArray(semantic.foodDrink));
    if (typeof semantic.travelPlaceType === "string" && semantic.travelPlaceType.trim()) travelPlaceTypes.push(semantic.travelPlaceType.trim());
    clothingStyles.push(...strArray(semantic.clothingStyle));
    colorAesthetic.push(...strArray(semantic.colorAesthetic));
    if (typeof semantic.scene === "string" && semantic.scene.trim()) scenes.push(semantic.scene.trim());
    if (typeof semantic.activity === "string" && semantic.activity.trim()) activities.push(semantic.activity.trim());
  }

  return {
    platforms,
    contentItemCount: contentItems.length,
    mediaAnalyzedCount,
    textSnippets,
    mediaSignals: {
      brands: topByFrequency(brands, TOP_AGG),
      logos: topByFrequency(logos, TOP_AGG),
      devices: topByFrequency(devices, TOP_AGG),
      foodDrink: topByFrequency(foodDrink, TOP_AGG),
      travelPlaceTypes: topByFrequency(travelPlaceTypes, TOP_AGG),
      clothingStyles: topByFrequency(clothingStyles, TOP_AGG),
      colorAesthetic: topByFrequency(colorAesthetic, TOP_AGG),
      scenes: topByFrequency(scenes, TOP_AGG),
      activities: topByFrequency(activities, TOP_AGG),
      ocrSnippets: ocrSnippets.slice(0, TOP_AGG),
    },
  };
}

/* ── Vertex request / response (pure builder + parser) ──────────────────────────────────────── */

export const PREFERENCE_SYNTH_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questionId: { type: "string" },
          status: { type: "string", enum: ["answered", "inferred", "needs_confirmation", "unknown"] },
          answer: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          source: { type: "string", enum: ["self_declared", "observed", "inferred", "aggregate", "not_available"] },
          evidenceIds: { type: "array", items: { type: "string" } },
          mediaEvidenceIds: { type: "array", items: { type: "string" } },
          why: { type: "string" },
        },
        required: ["questionId", "status", "confidence"],
      },
    },
  },
  required: ["answers"],
} as const;

function questionsBlock(questions: PreferenceQuestionDefinition[]): string {
  return questions
    .map((q) => `- ${q.id} [${q.sectionId}${q.sensitive ? ", SENSITIVE" : ""}]: ${q.prompt}`)
    .join("\n");
}

const SYNTH_INSTRUCTION = `You are One's preference analyst. The user consented to a self-audit of their own public social presence. Answer EACH of the 30 preference questions using ONLY the provided evidence (text snippets + aggregated media signals). Rules:
- Ground every answer in the evidence; cite the snippet ids you used in evidenceIds.
- Prefer "unknown" over guessing. If the signal is weak/ambiguous, use status "needs_confirmation" or "unknown" with confidence "low".
- SENSITIVE questions (partner/romance/attraction/etc.): NEVER state as fact. Use "needs_confirmation" or "unknown" unless the user themselves self-declared it in the text (source "self_declared").
- Do NOT infer protected/sensitive traits (health, religion, politics, sexuality) and never identify other people.
- 30/30 must be present; showing a question as "unknown" is correct when evidence is missing — do not fabricate.
Output MUST match the JSON schema exactly (an "answers" array).`;

export function buildSynthesisRequest(model: string, context: SynthesisContext, questions: PreferenceQuestionDefinition[], professionalContext?: string) {
  const contextJson = JSON.stringify(
    {
      platforms: context.platforms,
      counts: { contentItems: context.contentItemCount, mediaAnalyzed: context.mediaAnalyzedCount },
      mediaSignals: context.mediaSignals,
      textSnippets: context.textSnippets,
      professionalContext: professionalContext ?? null,
    },
    null,
    2,
  );
  const text = `${SYNTH_INSTRUCTION}\n\nQUESTIONS:\n${questionsBlock(questions)}\n\nEVIDENCE:\n\`\`\`json\n${contextJson}\n\`\`\``;
  return {
    model,
    body: {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PREFERENCE_SYNTH_SCHEMA,
        temperature: 0.3,
        maxOutputTokens: 8192,
      },
    },
  };
}

/** Parse the model JSON into typed answers, fill missing questions with honest unknowns, and ENFORCE
 *  the sensitive-question guardrail regardless of what the model returned. */
export function parseSynthesisResponse(json: unknown, questions: PreferenceQuestionDefinition[]): SynthesizedAnswer[] {
  let raw: Record<string, unknown>[] = [];
  try {
    const text = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text === "string") {
      const parsed = JSON.parse(text) as { answers?: unknown };
      if (Array.isArray(parsed.answers)) raw = parsed.answers.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object");
    }
  } catch {
    raw = [];
  }
  const byId = new Map(raw.map((a) => [String(a.questionId ?? ""), a]));

  const validStatus = new Set<SynthAnswerStatus>(["answered", "inferred", "needs_confirmation", "unknown"]);
  const validSource = new Set<SynthSource>(["self_declared", "observed", "inferred", "aggregate", "not_available"]);

  return questions.map((q) => {
    const a = byId.get(q.id) ?? {};
    let status: SynthAnswerStatus = validStatus.has(a.status as SynthAnswerStatus) ? (a.status as SynthAnswerStatus) : "unknown";
    const confidence: SynthConfidence = a.confidence === "high" || a.confidence === "medium" ? a.confidence : "low";
    const source: SynthSource = validSource.has(a.source as SynthSource) ? (a.source as SynthSource) : "not_available";
    const answer = typeof a.answer === "string" && a.answer.trim() ? a.answer.trim() : null;
    const evidenceIds = strArray(a.evidenceIds).slice(0, 12);
    const mediaEvidenceIds = strArray(a.mediaEvidenceIds).slice(0, 12);
    const why = typeof a.why === "string" && a.why.trim() ? a.why.trim() : null;

    // Guardrail: a sensitive question may never be asserted ("answered"/"inferred") unless the user
    // self-declared it. Otherwise it is downgraded to needs_confirmation (or unknown if no answer).
    if (q.sensitive && (status === "answered" || status === "inferred") && source !== "self_declared") {
      status = answer ? "needs_confirmation" : "unknown";
    }
    const needsUserConfirmation = Boolean(status === "needs_confirmation" || (q.sensitive && status !== "unknown"));

    return {
      questionId: q.id,
      sectionId: q.sectionId,
      prompt: q.prompt,
      status,
      answer: status === "unknown" ? null : answer,
      confidence,
      source,
      evidenceIds,
      mediaEvidenceIds,
      why,
      needsUserConfirmation,
    };
  });
}

/* ── Vertex call (defensive) ────────────────────────────────────────────────────────────────── */

export function synthesisConfigured(): boolean {
  return Boolean(process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT);
}

async function callVertex(model: string, body: unknown): Promise<unknown | null> {
  const config = vertexConfig();
  if (!config) return null;
  const token = await adcAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(vertexGenerateContentUrl(config, model), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface SynthesizeInput {
  contentItems: ArchiveContentRecord[];
  mediaAnalyses: MediaAnalysisRecord[];
  professionalContext?: string;
  model?: string;
  questions?: PreferenceQuestionDefinition[];
}

/* ── Render mapping: turn the v3 synthesis into the shape the dashboard's PreferenceIntelligence
   component already renders (question answers + coverage + section summaries), plus archive depth.
   This lets v3 reuse the entire polished v2 UI with no component rewrite. ──────────────────────── */

const CONFIDENCE_SCORE: Record<SynthConfidence, number> = { low: 0.35, medium: 0.65, high: 0.9 };

export interface ArchiveDepthLike {
  perPlatform: Record<string, { items: number; mediaTotal: number; mediaAnalyzed: number; mediaPending: number; mediaFailed: number }>;
  totals: { items: number; mediaTotal: number; mediaAnalyzed: number; mediaPending: number };
}

/** A subset-compatible UserPreferenceProfile the dashboard can render, carrying the v3 answers,
 *  coverage, section summaries, and the live archive depth. Stored as JSON; the client reads it as
 *  `preferenceProfile`. */
export interface RenderablePreferenceProfile {
  version: string;
  synthesisModel: string;
  preferenceStatus: "partial" | "completed";
  summary: string;
  generatedAt: string;
  updatedFrom: { platforms: string[]; indexedItems: number; mediaAssets: number; externalLinks: number; ocrSignals: number };
  topSignals: never[];
  collage: never[];
  questionAnswers: Array<Record<string, unknown>>;
  questionCoverage: { total: number; answered: number; inferred: number; needsConfirmation: number; unknown: number; blockedByAccess: number };
  sectionSummaries: Array<{ sectionId: string; title: string; summary: string; answeredCount: number; totalCount: number; confidence: "low" | "medium" | "high" }>;
  archiveDepth: ArchiveDepthLike | null;
}

export function toRenderablePreferenceProfile(
  result: PreferenceSynthesisResult,
  depth: ArchiveDepthLike | null,
  opts: { generatedAt: string; preferenceStatus: "partial" | "completed" },
): RenderablePreferenceProfile {
  const byId = new Map(PREFERENCE_QUESTIONS.map((q) => [q.id, q]));
  const questionAnswers = result.answers.map((a) => {
    const q = byId.get(a.questionId);
    return {
      questionId: a.questionId,
      sectionId: a.sectionId,
      sectionTitle: q?.sectionTitle ?? a.sectionId,
      category: q?.category ?? "unknowns",
      prompt: a.prompt,
      status: a.status,
      answer: a.answer,
      confidence: { score: CONFIDENCE_SCORE[a.confidence], level: a.confidence, rationale: a.why ?? "" },
      sourceMode: a.source,
      evidenceIds: a.evidenceIds,
      mediaEvidenceIds: a.mediaEvidenceIds,
      needsUserConfirmation: a.needsUserConfirmation,
      updatedFrom: a.mediaEvidenceIds.length ? "media_pass" : "fast_text_pass",
      ...(a.status === "unknown" ? { unknownReason: a.needsUserConfirmation ? "unsafe_to_infer" : "no_evidence" } : {}),
    };
  });
  const count = (pred: (a: SynthesizedAnswer) => boolean) => result.answers.filter(pred).length;
  const questionCoverage = {
    total: result.answers.length,
    answered: count((a) => a.status === "answered"),
    inferred: count((a) => a.status === "inferred"),
    needsConfirmation: count((a) => a.status === "needs_confirmation"),
    unknown: count((a) => a.status === "unknown"),
    blockedByAccess: 0,
  };
  const sectionIds = [...new Set(result.answers.map((a) => a.sectionId))];
  const sectionSummaries = sectionIds.map((sectionId) => {
    const xs = result.answers.filter((a) => a.sectionId === sectionId);
    const answered = xs.filter((a) => a.status === "answered" || a.status === "inferred").length;
    return {
      sectionId,
      title: byId.get(xs[0]?.questionId ?? "")?.sectionTitle ?? sectionId,
      summary: "",
      answeredCount: answered,
      totalCount: xs.length,
      confidence: (answered > xs.length / 2 ? "medium" : "low") as "low" | "medium" | "high",
    };
  });
  const answeredTotal = questionCoverage.answered + questionCoverage.inferred;
  return {
    version: result.version,
    synthesisModel: result.model,
    preferenceStatus: opts.preferenceStatus,
    summary: `One answered ${answeredTotal}/${result.answers.length} preference questions from ${result.context.contentItems} posts and ${result.context.mediaAnalyzed} analyzed media across ${result.context.platforms.join(", ") || "your socials"}.`,
    generatedAt: opts.generatedAt,
    updatedFrom: {
      platforms: result.context.platforms,
      indexedItems: result.context.contentItems,
      mediaAssets: result.context.mediaAnalyzed,
      externalLinks: 0,
      ocrSignals: 0,
    },
    topSignals: [],
    collage: [],
    questionAnswers,
    questionCoverage,
    sectionSummaries,
    archiveDepth: depth,
  };
}

/** Run the full synthesis. Returns null if Vertex is unavailable/failed (caller keeps the fast pass). */
export async function synthesizePreferences(input: SynthesizeInput): Promise<PreferenceSynthesisResult | null> {
  const model = input.model || process.env.PREFERENCE_SYNTH_MODEL || DEFAULT_SYNTH_MODEL;
  const questions = input.questions ?? PREFERENCE_QUESTIONS;
  const context = buildSynthesisContext(input.contentItems, input.mediaAnalyses);
  const { body } = buildSynthesisRequest(model, context, questions, input.professionalContext);
  const json = await callVertex(model, body);
  if (!json) return null;
  const answers = parseSynthesisResponse(json, questions);
  return {
    version: PREFERENCE_SYNTHESIS_VERSION,
    model,
    answers,
    context: { platforms: context.platforms, contentItems: context.contentItemCount, mediaAnalyzed: context.mediaAnalyzedCount },
  };
}
