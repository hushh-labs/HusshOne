/* Phase-D: Vertex preference synthesis. Reads the FULL indexed archive (SocialContentItem) + the
   media analyses (SocialMediaAsset) and asks a Vertex LLM (Gemini 2.5 Pro by default, env-switchable)
   to answer the 30 preference questions with evidence, confidence, source, and calibrated inference.

   v3.1 — PER-SECTION synthesis. Instead of one conservative one-shot over a generic evidence blob
   (which answered only ~6/30 in prod), we route each of the 6 sections to its own Vertex call with a
   TARGETED evidence slice (section-relevant text snippets + the media signals that matter for that
   section, with frequency counts and representative asset hashes). The 6 section calls run in PARALLEL
   and are merged into 30 answers. The prompt is reframed to infer with calibrated confidence wherever
   a reasonable pattern exists, reserving "unknown" for genuinely zero-signal questions.

   All inference goes THROUGH Vertex (no direct Gemini API). Sensitive questions (Partner & Romance)
   can never be force-answered — the guardrail is enforced in code, not trusted to the model.
   Pure builders/parsers are exported for unit tests; the network calls are fully defensive. */
import { adcAccessToken, vertexConfig, vertexGenerateContentUrl } from "@/lib/gcp/auth";
import {
  PREFERENCE_QUESTIONS,
  type PreferenceQuestionDefinition,
  type PreferenceQuestionSectionId,
} from "./preference-profile";
import type { ArchiveContentRecord } from "@/lib/db/scan-store";

export const PREFERENCE_SYNTHESIS_VERSION = "2026-06-18.synthesis-v3.1-persection";
export const DEFAULT_SYNTH_MODEL = "gemini-2.5-pro";
const FETCH_TIMEOUT_MS = 150_000;

// Context budgets — kept bounded but generous. Because we now route PER SECTION, each call sees a
// focused slice, so we can afford a deeper per-section text budget and more aggregated signals than
// the old single-shot prompt allowed.
const MAX_TEXT_SNIPPETS = 40; // per section
const TEXT_SNIPPET_CHARS = 500;
const TOP_AGG = 28;
const REPRESENTATIVE_ASSETS = 24; // assetHashes surfaced per section for media citations

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

export interface PreferenceSynthesisResult {
  version: string;
  model: string;
  answers: SynthesizedAnswer[];
  context: { platforms: string[]; contentItems: number; mediaAnalyzed: number };
}

/* ── Section evidence routing ───────────────────────────────────────────────────────────────────
   For each section we declare: which media-signal keys matter (read from each analysis's
   vision/semantic, including the NEW optional semantic fields another agent is adding), and which
   text keywords help pre-filter the most relevant snippets. partner_romance is TEXT ONLY (sensitive):
   it gets no media signals so we never feed a face/scene to a romance inference. */

export interface SectionEvidenceSpec {
  /** Media-signal sources pulled from each completed analysis. `path` is vision|semantic; `key` is
   *  the field; `array` says whether the value is a string[] (collected) or a scalar string. */
  mediaSignals: Array<{ label: string; path: "vision" | "semantic"; key: string; array: boolean }>;
  /** Lowercase keyword fragments used to bias text-snippet selection toward this section. */
  textKeywords: string[];
  /** When true this section never receives media signals (sensitive — text/self-declared only). */
  textOnly?: boolean;
}

export const SECTION_EVIDENCE: Record<PreferenceQuestionSectionId, SectionEvidenceSpec> = {
  style_brands_color: {
    mediaSignals: [
      { label: "brands", path: "semantic", key: "brands", array: true },
      { label: "logos", path: "vision", key: "logos", array: true },
      { label: "dominantColors", path: "vision", key: "dominantColors", array: true },
      { label: "colorAesthetic", path: "semantic", key: "colorAesthetic", array: true },
      { label: "clothingStyle", path: "semantic", key: "clothingStyle", array: true },
      { label: "devices", path: "semantic", key: "devices", array: true },
    ],
    textKeywords: [
      "brand", "style", "outfit", "wear", "fashion", "color", "colour", "aesthetic", "logo", "luxury",
      "minimal", "fit check", "sneaker", "streetwear", "wardrobe", "design", "palette",
    ],
  },
  travel_wanderlust: {
    mediaSignals: [
      { label: "travelPlaceType", path: "semantic", key: "travelPlaceType", array: false },
      { label: "destinationName", path: "semantic", key: "destinationName", array: false },
      { label: "landmarks", path: "vision", key: "landmarks", array: true },
      { label: "scene", path: "semantic", key: "scene", array: false },
    ],
    textKeywords: [
      "travel", "trip", "flight", "hotel", "beach", "mountain", "city", "trek", "vacation", "holiday",
      "wander", "itinerary", "resort", "stay", "airbnb", "destination", "explore", "escape", "abroad",
    ],
  },
  food_culinary: {
    mediaSignals: [
      { label: "foodDrink", path: "semantic", key: "foodDrink", array: true },
      { label: "cuisineCategory", path: "semantic", key: "cuisineCategory", array: false },
      { label: "venueType", path: "semantic", key: "venueType", array: false },
      { label: "scene", path: "semantic", key: "scene", array: false },
    ],
    textKeywords: [
      "food", "eat", "dinner", "lunch", "brunch", "cafe", "coffee", "restaurant", "menu", "dish",
      "cook", "recipe", "drink", "cocktail", "wine", "street food", "chai", "dining", "tasty", "meal",
    ],
  },
  partner_romance: {
    // SENSITIVE: text only, never media. We still pre-filter by relationship language, but inference
    // stays gated to self-declaration via the code guardrail in parseSectionAnswers.
    mediaSignals: [],
    textKeywords: [
      "partner", "love", "relationship", "date", "crush", "romantic", "girlfriend", "boyfriend",
      "marriage", "wedding", "couple", "my type", "love language", "red flag", "green flag",
    ],
    textOnly: true,
  },
  deep_likes_dislikes: {
    mediaSignals: [
      { label: "socialSetting", path: "semantic", key: "socialSetting", array: false },
      { label: "activity", path: "semantic", key: "activity", array: false },
      { label: "scene", path: "semantic", key: "scene", array: false },
      { label: "timeOfDay", path: "semantic", key: "timeOfDay", array: false },
    ],
    textKeywords: [
      "love", "hate", "favorite", "favourite", "pet peeve", "annoy", "cringe", "recharge", "alone",
      "friends", "morning", "introvert", "extrovert", "party", "quiet", "weekend", "vibe", "opinion",
    ],
  },
  mental_models: {
    mediaSignals: [
      { label: "musicOrEntertainment", path: "semantic", key: "musicOrEntertainment", array: true },
      { label: "ocrText", path: "vision", key: "ocrText", array: false },
      { label: "activity", path: "semantic", key: "activity", array: false },
    ],
    textKeywords: [
      "music", "song", "playlist", "genre", "review", "research", "decision", "buy", "purchase",
      "freedom", "respect", "creative", "build", "ship", "founder", "friend group", "money", "think",
    ],
  },
};

/* ── Targeted per-section context (unit-tested) ──────────────────────────────────────────────────── */

export interface SectionMediaSignal {
  label: string;
  /** Aggregated, frequency-ranked values for this signal across the section's media. */
  values: Array<{ value: string; count: number }>;
}

export interface SectionContext {
  sectionId: PreferenceQuestionSectionId;
  platforms: string[];
  contentItemCount: number;
  mediaAnalyzedCount: number;
  /** Section-relevant text snippets (keyword-biased, then back-filled to budget). */
  textSnippets: Array<{ id: string; platform: string; type: string; text: string }>;
  /** This section's media signals with frequency counts. Empty for text-only (sensitive) sections. */
  mediaSignals: SectionMediaSignal[];
  /** Representative assetHashes so answers can cite mediaEvidenceIds. Empty for text-only sections. */
  mediaAssetHashes: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

/** Frequency-rank a list of raw strings, returning `{ value, count }` with a representative casing. */
function rankByFrequency(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, { count: number; sample: string }>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { count: 1, sample: value });
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => ({ value: entry.sample, count: entry.count }));
}

function normText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Pull a single media-signal's raw values from one completed analysis, per its spec. */
function readSignalFromAnalysis(
  analysis: Record<string, unknown>,
  spec: SectionEvidenceSpec["mediaSignals"][number],
): string[] {
  const bag = asRecord(analysis[spec.path]);
  const value = bag[spec.key];
  if (spec.array) return strArray(value);
  const scalar = normText(value);
  return scalar ? [scalar] : [];
}

/** Build a TARGETED evidence slice for one section: keyword-biased text snippets (back-filled to
 *  budget) + that section's media signals with frequency counts + representative assetHashes. */
export function buildSectionContext(
  sectionId: PreferenceQuestionSectionId,
  contentItems: ArchiveContentRecord[],
  mediaAnalyses: MediaAnalysisRecord[],
): SectionContext {
  const spec = SECTION_EVIDENCE[sectionId];
  const platforms = [...new Set(contentItems.map((c) => c.platform))].sort();

  // ── Text snippets: prefer items whose text matches this section's keywords, then back-fill with
  // other items up to the budget so a section is never starved when keyword hits are sparse.
  const withText = contentItems.filter((c) => c.text && (c.text as string).trim());
  const keywords = spec.textKeywords;
  const matches: ArchiveContentRecord[] = [];
  const rest: ArchiveContentRecord[] = [];
  for (const item of withText) {
    const lower = (item.text as string).toLowerCase();
    (keywords.some((kw) => lower.includes(kw)) ? matches : rest).push(item);
  }
  const ordered = [...matches, ...rest].slice(0, MAX_TEXT_SNIPPETS);
  const textSnippets = ordered.map((c) => ({
    id: c.itemId,
    platform: c.platform,
    type: c.itemType,
    text: normText(c.text).slice(0, TEXT_SNIPPET_CHARS),
  }));

  // ── Media signals + representative asset hashes (skipped entirely for sensitive/text-only sections).
  const signalBuckets = new Map<string, string[]>();
  for (const s of spec.mediaSignals) signalBuckets.set(s.label, []);
  const assetHashes: string[] = [];
  let mediaAnalyzedCount = 0;

  if (!spec.textOnly) {
    for (const record of mediaAnalyses) {
      const analysis = asRecord(record.analysis);
      if (analysis.status !== "completed") continue;
      mediaAnalyzedCount += 1;
      let contributed = false;
      for (const s of spec.mediaSignals) {
        const values = readSignalFromAnalysis(analysis, s);
        if (values.length) {
          const bucket = signalBuckets.get(s.label);
          if (bucket) {
            for (const v of values) bucket.push(s.key === "ocrText" ? v.slice(0, 160) : v);
          }
          contributed = true;
        }
      }
      if (contributed && record.assetHash && assetHashes.length < REPRESENTATIVE_ASSETS) {
        if (!assetHashes.includes(record.assetHash)) assetHashes.push(record.assetHash);
      }
    }
  } else {
    // Still report how much media exists overall (for context counts) without exposing it.
    for (const record of mediaAnalyses) {
      if (asRecord(record.analysis).status === "completed") mediaAnalyzedCount += 1;
    }
  }

  const mediaSignals: SectionMediaSignal[] = spec.mediaSignals
    .map((s) => ({ label: s.label, values: rankByFrequency(signalBuckets.get(s.label) ?? [], TOP_AGG) }))
    .filter((s) => s.values.length > 0);

  return {
    sectionId,
    platforms,
    contentItemCount: contentItems.length,
    mediaAnalyzedCount,
    textSnippets,
    mediaSignals,
    mediaAssetHashes: assetHashes,
  };
}

/** Overall analyzed-media count across the archive (status === "completed"), for the result context. */
export function countAnalyzedMedia(mediaAnalyses: MediaAnalysisRecord[]): number {
  let n = 0;
  for (const record of mediaAnalyses) if (asRecord(record.analysis).status === "completed") n += 1;
  return n;
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
        // answer is REQUIRED — the per-section reframe forces the model to commit to its best read.
        required: ["questionId", "status", "answer", "confidence"],
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

/* The reframed instruction: the BIGGEST lever. We replace "prefer unknown over guessing" with
   calibrated inference — answer wherever any reasonable pattern exists, label confidence honestly,
   and reserve "unknown" for genuinely zero-signal questions. The sensitive rule is unchanged and is
   ALSO enforced in code (parseSectionAnswers) regardless of what the model returns. */
const SYNTH_INSTRUCTION = `You are One's preference analyst. The user consented to a self-audit of their OWN public social presence. You are given a FOCUSED evidence slice for ONE section of the preference profile (this section's text snippets + the aggregated media signals relevant to it, with frequency counts). Answer EVERY question in this section.

How to reason:
- Infer with calibrated confidence from the evidence. Use status "inferred" with low or medium confidence whenever a reasonable pattern exists across the posts/media — frequent brands, recurring places, repeated foods, dominant colors, etc. are all valid grounds to infer.
- Use status "answered" with the matching confidence when the user states it directly (self-declared) or the evidence is strong and unambiguous.
- Use "unknown" ONLY when there is genuinely ZERO relevant signal for that question. A weak or partial signal is still an "inferred" answer with low confidence — do not throw it away.
- Always write a concrete \`answer\` string with your best read (the schema requires it). Never leave it blank; if truly nothing is known, set status "unknown" and write a one-line note in \`answer\` saying no signal was found.
- Ground every answer in the evidence and cite the snippet ids you used in evidenceIds and the media asset hashes in mediaEvidenceIds. Do NOT contradict the evidence.
- Put a short justification in \`why\`.

Hard rules (never violate):
- SENSITIVE questions (partner/romance/attraction/red-flags/love-language): NEVER state as fact and NEVER infer from photos or scenes. Use "needs_confirmation" or "unknown" unless the user themselves self-declared it in their own text (then source "self_declared").
- Do NOT infer protected/sensitive traits (health, religion, politics, sexuality) and never identify other people in media.

Output MUST match the JSON schema exactly (an "answers" array, one object per question in this section).`;

/** Render the per-section evidence as compact JSON for the prompt. */
function sectionEvidenceJson(context: SectionContext, professionalContext?: string): string {
  return JSON.stringify(
    {
      section: context.sectionId,
      platforms: context.platforms,
      counts: { contentItems: context.contentItemCount, mediaAnalyzed: context.mediaAnalyzedCount },
      mediaSignals: context.mediaSignals,
      mediaAssetHashes: context.mediaAssetHashes,
      textSnippets: context.textSnippets,
      professionalContext: professionalContext ?? null,
    },
    null,
    2,
  );
}

/** Build the Vertex request for ONE section (its questions + its targeted evidence slice). */
export function buildSectionSynthesisRequest(
  model: string,
  context: SectionContext,
  questions: PreferenceQuestionDefinition[],
  professionalContext?: string,
) {
  const text = `${SYNTH_INSTRUCTION}\n\nSECTION: ${context.sectionId}\n\nQUESTIONS (answer all ${questions.length}):\n${questionsBlock(
    questions,
  )}\n\nEVIDENCE:\n\`\`\`json\n${sectionEvidenceJson(context, professionalContext)}\n\`\`\``;
  return {
    model,
    body: {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PREFERENCE_SYNTH_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 8192,
      },
    },
  };
}

/* Back-compat builder: the old single-shot request over ALL questions. Kept exported (and used by the
   legacy test) so any caller depending on the prior signature still works; the production path now
   uses per-section synthesis. It embeds the same reframed instruction. */
export function buildSynthesisRequest(
  model: string,
  context: SectionContext | { textSnippets: SectionContext["textSnippets"]; platforms: string[] },
  questions: PreferenceQuestionDefinition[],
  professionalContext?: string,
) {
  const text = `${SYNTH_INSTRUCTION}\n\nThis is a combined pass over ${questions.length} preference questions (the production path runs these PER SECTION in parallel).\n\nQUESTIONS:\n${questionsBlock(
    questions,
  )}\n\nEVIDENCE:\n\`\`\`json\n${JSON.stringify(
    {
      platforms: context.platforms,
      textSnippets: context.textSnippets,
      professionalContext: professionalContext ?? null,
    },
    null,
    2,
  )}\n\`\`\``;
  return {
    model,
    body: {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PREFERENCE_SYNTH_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 8192,
      },
    },
  };
}

const VALID_STATUS = new Set<SynthAnswerStatus>(["answered", "inferred", "needs_confirmation", "unknown"]);
const VALID_SOURCE = new Set<SynthSource>(["self_declared", "observed", "inferred", "aggregate", "not_available"]);

/** Turn one raw model answer object + its question definition into a typed SynthesizedAnswer, KEEPING
 *  the model's answer text (don't null it on low confidence) and ENFORCING the sensitive guardrail. */
function mapOneAnswer(a: Record<string, unknown>, q: PreferenceQuestionDefinition): SynthesizedAnswer {
  let status: SynthAnswerStatus = VALID_STATUS.has(a.status as SynthAnswerStatus) ? (a.status as SynthAnswerStatus) : "unknown";
  const confidence: SynthConfidence = a.confidence === "high" || a.confidence === "medium" ? a.confidence : "low";
  const source: SynthSource = VALID_SOURCE.has(a.source as SynthSource) ? (a.source as SynthSource) : "not_available";
  let answer = typeof a.answer === "string" && a.answer.trim() ? a.answer.trim() : null;
  const evidenceIds = strArray(a.evidenceIds).slice(0, 16);
  const mediaEvidenceIds = strArray(a.mediaEvidenceIds).slice(0, 16);
  const why = typeof a.why === "string" && a.why.trim() ? a.why.trim() : null;

  // Parse rule: status "unknown" ONLY when there is no answer text. Otherwise keep the model's read
  // even at low confidence (the whole point of the reframe — don't discard weak-but-real signal).
  if (status === "unknown" && answer) status = "inferred";
  if (status !== "unknown" && !answer) status = "unknown";

  // Guardrail: a sensitive question may never be asserted ("answered"/"inferred") unless the user
  // self-declared it. Otherwise it is downgraded to needs_confirmation (or unknown if no answer).
  if (q.sensitive && (status === "answered" || status === "inferred") && source !== "self_declared") {
    status = answer ? "needs_confirmation" : "unknown";
  }
  if (status === "unknown") answer = null;
  const needsUserConfirmation = Boolean(status === "needs_confirmation" || (q.sensitive && status !== "unknown"));

  return {
    questionId: q.id,
    sectionId: q.sectionId,
    prompt: q.prompt,
    status,
    answer,
    confidence,
    source,
    evidenceIds,
    mediaEvidenceIds,
    why,
    needsUserConfirmation,
  };
}

/** Extract the raw `answers` array from a Vertex generateContent response (defensive). */
function extractRawAnswers(json: unknown): Record<string, unknown>[] {
  try {
    const text = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text === "string") {
      const parsed = JSON.parse(text) as { answers?: unknown };
      if (Array.isArray(parsed.answers)) {
        return parsed.answers.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object");
      }
    }
  } catch {
    /* fall through to empty */
  }
  return [];
}

/** Parse a SINGLE section's model response into typed answers for exactly that section's questions,
 *  filling any the model omitted with honest unknowns. */
export function parseSectionAnswers(
  json: unknown,
  questions: PreferenceQuestionDefinition[],
): SynthesizedAnswer[] {
  const byId = new Map(extractRawAnswers(json).map((a) => [String(a.questionId ?? ""), a]));
  return questions.map((q) => mapOneAnswer(byId.get(q.id) ?? {}, q));
}

/** Parse a model JSON into typed answers for the FULL question set (back-compat with the prior
 *  single-shot contract). Fills missing questions with honest unknowns and enforces the guardrail. */
export function parseSynthesisResponse(json: unknown, questions: PreferenceQuestionDefinition[]): SynthesizedAnswer[] {
  return parseSectionAnswers(json, questions);
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

/** Synthesize ONE section: build its targeted context, make one Vertex call, parse its answers.
 *  Returns null if Vertex is unavailable/failed for this section (caller fills it with unknowns). */
export async function synthesizeSection(
  sectionId: PreferenceQuestionSectionId,
  questions: PreferenceQuestionDefinition[],
  contentItems: ArchiveContentRecord[],
  mediaAnalyses: MediaAnalysisRecord[],
  model: string,
  professionalContext?: string,
): Promise<SynthesizedAnswer[] | null> {
  if (!questions.length) return [];
  const context = buildSectionContext(sectionId, contentItems, mediaAnalyses);
  const { body } = buildSectionSynthesisRequest(model, context, questions, professionalContext);
  const json = await callVertex(model, body);
  if (!json) return null;
  return parseSectionAnswers(json, questions);
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

/** Group a question list by sectionId, preserving the registry's section order. */
function groupBySection(questions: PreferenceQuestionDefinition[]): Array<{ sectionId: PreferenceQuestionSectionId; questions: PreferenceQuestionDefinition[] }> {
  const order: PreferenceQuestionSectionId[] = [];
  const groups = new Map<PreferenceQuestionSectionId, PreferenceQuestionDefinition[]>();
  for (const q of questions) {
    if (!groups.has(q.sectionId)) {
      groups.set(q.sectionId, []);
      order.push(q.sectionId);
    }
    groups.get(q.sectionId)!.push(q);
  }
  return order.map((sectionId) => ({ sectionId, questions: groups.get(sectionId)! }));
}

/** Run the full synthesis via PER-SECTION parallel Vertex calls.
 *  - Groups the requested questions by section and fires one Vertex call per section in parallel.
 *  - Merges the results into answers for exactly the requested questions (in registry order).
 *  - When a `questions` subset is passed, only the sections those questions belong to are run, and
 *    only those answers are returned (used for a re-pass by another agent).
 *  Returns null only if Vertex is entirely unavailable (no section produced any model answer), so the
 *  caller can keep the fast pass. If some sections succeed and others fail, the failed sections'
 *  questions come back as honest unknowns rather than dropping the whole run. */
export async function synthesizePreferences(input: SynthesizeInput): Promise<PreferenceSynthesisResult | null> {
  const model = input.model || process.env.PREFERENCE_SYNTH_MODEL || DEFAULT_SYNTH_MODEL;
  const questions = input.questions ?? PREFERENCE_QUESTIONS;
  const groups = groupBySection(questions);

  const platforms = [...new Set(input.contentItems.map((c) => c.platform))].sort();
  const mediaAnalyzed = countAnalyzedMedia(input.mediaAnalyses);

  const sectionResults = await Promise.all(
    groups.map(async (group) => {
      const answers = await synthesizeSection(
        group.sectionId,
        group.questions,
        input.contentItems,
        input.mediaAnalyses,
        model,
        input.professionalContext,
      );
      return { group, answers };
    }),
  );

  // If EVERY section failed (Vertex unavailable), signal null so the caller keeps the fast pass.
  if (sectionResults.every((r) => r.answers === null)) return null;

  // Merge: succeeded sections use their answers; failed sections fall back to honest unknowns. Then
  // re-order to match the requested question list exactly.
  const merged = new Map<string, SynthesizedAnswer>();
  for (const { group, answers } of sectionResults) {
    const resolved = answers ?? parseSectionAnswers({}, group.questions);
    for (const a of resolved) merged.set(a.questionId, a);
  }
  const answers = questions.map(
    (q) => merged.get(q.id) ?? parseSectionAnswers({}, [q])[0],
  );

  return {
    version: PREFERENCE_SYNTHESIS_VERSION,
    model,
    answers,
    context: { platforms, contentItems: input.contentItems.length, mediaAnalyzed },
  };
}
