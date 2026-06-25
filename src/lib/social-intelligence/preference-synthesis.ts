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
import crypto from "node:crypto";
import { adcAccessToken, vertexConfig, vertexGenerateContentUrl } from "@/lib/gcp/auth";
import {
  PREFERENCE_QUESTIONS,
  QUESTION_REGISTRY_VERSION,
  type PreferenceQuestionDefinition,
  type PreferenceQuestionSectionId,
} from "./preference-profile";
import { buildPreferenceSummary } from "./preference-presentation";
import type { ArchiveContentRecord } from "@/lib/db/scan-store";

// Re-export the client-safe presentation helpers so existing import sites keep working.
export { prettyPlatform, prettyPlatformList } from "./preference-presentation";

export const DEFAULT_SYNTH_MODEL = "gemini-2.5-pro";
const FETCH_TIMEOUT_MS = 150_000;

// Manual salt for data-shape changes that the auto-derived PREFERENCE_SYNTHESIS_VERSION hash (below)
// can't see in the prompt/schema/sections/model/questions — e.g. the collage builder shape or the
// RenderablePreferenceProfile fields, OR the numeric context budgets just below (they aren't in the
// hash). Bump this string when you change those so existing users auto-refresh. Pure copy changes need
// NO bump (the headline is computed at render time).
// rev "2": widened per-section context budgets (40→150 snippets etc.) so deeper archives actually feed
// the model — "data accha → preference strong".
// rev "3": LinkedIn career spine now feeds synthesis as professionalContext (grounds professional/
// mental-model inferences) — force a recompute so existing users pick it up.
// rev "4": engagement+self-declared weighted snippet selection, word-boundary keyword routing,
// evidence-grounded confidence cap, wider aggregation caps (learnings from the 40-agent Sundar run).
// rev "5": LinkedIn posts (activity feed) now flow into the archive as a feed platform → synthesis sees
// LinkedIn content as evidence for professionals who push there, not just IG/X/Threads.
// rev "6": MULTIMODAL synthesis — each section now SEES the real images (Vertex fileData) + 2 agents/section
// merged by consensus + always-answer. The biggest quality lever yet (the model reads the photos, not just
// text tokens). Forces a full recompute.
// rev "7": DEEP PIXEL extraction + redesigned 6 sections (brand_look/food_drink/travel_places/social_vibe/
// lifestyle_daily/mindset_values; Romance removed). Per-image now yields clothing brand+colour+type,
// eyewear, footwear, objects, table/background items, surroundings, pose, expression, people count, event,
// place + FACE/WEB Vision signals — all routed into the new sections. Forces a full recompute.
// rev "8": de-noised lifestyle cards (stopword + word-count cleanup; places no longer pull noisy
// webEntities/bestGuessLabels; foods no longer pull tableItems) + 4 agents/section (was 2). Forces recompute
// so existing users get the cleaner cards from their existing media (no re-scrape needed).
// rev "9": stopword top-up — strip literal null/placeholder tokens, planet-scale "places" (Earth/World),
// and generic containers (water bottle / monitor) that still leaked into the cards.
const PREFERENCE_DATA_SHAPE_REV = "9";

// Per-section multimodal: how many real images each section agent is shown (Vertex fileData parts), and how
// many independent agents read each section (their answers are merged by consensus — more agents = stronger
// consensus + higher confidence). v5.1: scaled UP to 4 agents/section (6×4 = 24 parallel reads/recompute) +
// 14 images/agent — deliberately compute-heavy for quality (cost is not the constraint here). Env-tunable.
const MAX_SECTION_IMAGES = Number(process.env.PREFERENCE_SECTION_IMAGES) || 14;
const AGENTS_PER_SECTION = Number(process.env.PREFERENCE_AGENTS_PER_SECTION) || 4;

// Context budgets — generous on purpose. We route PER SECTION, each call sees a focused slice, and the
// model (Gemini 2.5 Pro) has a large context window — so the real lever on preference quality is how
// many of the archived posts actually reach each section's call. 150 text snippets/section means a 512
// rolling archive is genuinely used, not throttled to a thin sample. (Validated against the recompute
// worker's 300s budget: 6 parallel section calls + up to 2 re-passes on unknowns still fit.)
const MAX_TEXT_SNIPPETS = 150; // per section
const TEXT_SNIPPET_CHARS = 500;
const TOP_AGG = 80; // frequency-ranked values per media signal — the discriminating brand/place is often in the tail
const REPRESENTATIVE_ASSETS = 60; // assetHashes surfaced per section for media citations

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

/* ── Section evidence routing (v5) ───────────────────────────────────────────────────────────────
   For each of the 6 preference sections we declare: which media-signal keys matter (read from each
   analysis's vision/semantic, incl. the v5 deep pixel fields — clothing/eyewear/footwear/objects/
   surroundings/place/expression/pose/faces), and which text keywords help pre-filter snippets. Some
   fields are nested objects/arrays-of-objects (clothing, eyewear, footwear, faces, behavioralRead) →
   they carry a `transform` so readSignalFromAnalysis flattens them to citable strings. */

export type MediaSignalTransform = "clothing" | "eyewear" | "footwear" | "facesCount" | "objectField";

export interface SectionEvidenceSpec {
  /** Media-signal sources pulled from each completed analysis. `path` is vision|semantic; `key` is the
   *  field; `array` says whether the value is a string[] (collected) or a scalar string; `transform`
   *  (optional) flattens a nested object/array-of-objects to citable strings; `objectKey` names the
   *  inner field for transform "objectField" (e.g. behavioralRead.sociability). */
  mediaSignals: Array<{ label: string; path: "vision" | "semantic"; key: string; array: boolean; transform?: MediaSignalTransform; objectKey?: string }>;
  /** Lowercase keyword fragments used to bias text-snippet selection toward this section. */
  textKeywords: string[];
  /** When true this section never receives media signals (text/self-declared only). Unused in v5. */
  textOnly?: boolean;
}

export const SECTION_EVIDENCE: Record<PreferenceQuestionSectionId, SectionEvidenceSpec> = {
  brand_look: {
    mediaSignals: [
      { label: "brands", path: "semantic", key: "brands", array: true },
      { label: "clothing", path: "semantic", key: "clothing", array: false, transform: "clothing" },
      { label: "eyewear", path: "semantic", key: "eyewear", array: false, transform: "eyewear" },
      { label: "footwear", path: "semantic", key: "footwear", array: false, transform: "footwear" },
      { label: "accessories", path: "semantic", key: "accessories", array: true },
      { label: "logos", path: "vision", key: "logos", array: true },
      { label: "dominantColors", path: "vision", key: "dominantColors", array: true },
      { label: "colorAesthetic", path: "semantic", key: "colorAesthetic", array: true },
      { label: "clothingStyle", path: "semantic", key: "clothingStyle", array: true },
      { label: "devices", path: "semantic", key: "devices", array: true },
    ],
    textKeywords: [
      "brand", "style", "outfit", "wear", "fashion", "color", "colour", "aesthetic", "logo", "luxury",
      "minimal", "sneaker", "shoes", "glasses", "watch", "streetwear", "wardrobe", "palette",
    ],
  },
  food_drink: {
    mediaSignals: [
      { label: "foodDrink", path: "semantic", key: "foodDrink", array: true },
      { label: "cuisineCategory", path: "semantic", key: "cuisineCategory", array: false },
      { label: "venueType", path: "semantic", key: "venueType", array: false },
      { label: "tableItems", path: "semantic", key: "tableItems", array: true },
    ],
    textKeywords: [
      "food", "eat", "dinner", "lunch", "brunch", "cafe", "coffee", "restaurant", "menu", "dish",
      "cook", "recipe", "drink", "cocktail", "wine", "street food", "chai", "dining", "meal",
    ],
  },
  travel_places: {
    // v5.1: dropped vision.webEntities + bestGuessLabels here — reverse-image labels are noisy for PLACE
    // ("Businessperson", "Presentation"). Places come from the model's explicit placeGuess/destination +
    // detected landmarks, which are far more reliable.
    mediaSignals: [
      { label: "travelPlaceType", path: "semantic", key: "travelPlaceType", array: false },
      { label: "destinationName", path: "semantic", key: "destinationName", array: false },
      { label: "placeGuess", path: "semantic", key: "placeGuess", array: false },
      { label: "landmarksSeen", path: "semantic", key: "landmarksSeen", array: true },
      { label: "landmarks", path: "vision", key: "landmarks", array: true },
      { label: "scene", path: "semantic", key: "scene", array: false },
    ],
    textKeywords: [
      "travel", "trip", "flight", "hotel", "beach", "mountain", "city", "trek", "vacation", "holiday",
      "wander", "resort", "stay", "destination", "explore", "abroad", "outdoor",
    ],
  },
  social_vibe: {
    mediaSignals: [
      { label: "people", path: "vision", key: "faces", array: false, transform: "facesCount" },
      { label: "socialSetting", path: "semantic", key: "socialSetting", array: false },
      { label: "eventType", path: "semantic", key: "eventType", array: false },
      { label: "expression", path: "semantic", key: "expression", array: false },
      { label: "pose", path: "semantic", key: "pose", array: false },
      { label: "sociability", path: "semantic", key: "behavioralRead", array: false, transform: "objectField", objectKey: "sociability" },
    ],
    textKeywords: [
      "party", "friends", "group", "solo", "alone", "gathering", "event", "celebration", "squad",
      "crowd", "smile", "vibe", "hangout", "introvert", "extrovert", "people",
    ],
  },
  lifestyle_daily: {
    mediaSignals: [
      { label: "timeOfDay", path: "semantic", key: "timeOfDay", array: false },
      { label: "surroundings", path: "semantic", key: "surroundings", array: false },
      { label: "objects", path: "semantic", key: "objects", array: true },
      { label: "tableItems", path: "semantic", key: "tableItems", array: true },
      { label: "backgroundItems", path: "semantic", key: "backgroundItems", array: true },
      { label: "activity", path: "semantic", key: "activity", array: false },
      { label: "pixelNotes", path: "semantic", key: "pixelNotes", array: false },
    ],
    textKeywords: [
      "morning", "night", "home", "office", "desk", "room", "setup", "daily", "routine", "workspace",
      "gym", "outdoor", "indoor", "lifestyle", "weekend",
    ],
  },
  mindset_values: {
    mediaSignals: [
      { label: "musicOrEntertainment", path: "semantic", key: "musicOrEntertainment", array: true },
      { label: "ocrText", path: "vision", key: "ocrText", array: false },
      { label: "activity", path: "semantic", key: "activity", array: false },
      { label: "pixelNotes", path: "semantic", key: "pixelNotes", array: false },
      { label: "webEntities", path: "vision", key: "webEntities", array: true },
    ],
    textKeywords: [
      "music", "song", "playlist", "genre", "review", "research", "decision", "buy", "purchase",
      "freedom", "respect", "creative", "build", "ship", "founder", "money", "think", "book", "learn",
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
  /** Section-relevant text snippets (relevance-scored to budget); selfDeclared flags first-person posts. */
  textSnippets: Array<{ id: string; platform: string; type: string; text: string; selfDeclared: boolean }>;
  /** This section's media signals with frequency counts. Empty for text-only (sensitive) sections. */
  mediaSignals: SectionMediaSignal[];
  /** Representative assetHashes so answers can cite mediaEvidenceIds. Empty for text-only sections. */
  mediaAssetHashes: string[];
  /** The actual images (gs:// fileUri + mimeType) shown to the section agents via Vertex fileData, labeled
   *  by assetHash so answers can cite them. Subset of mediaAssetHashes that have a persisted cacheUri. */
  mediaImages: Array<{ assetHash: string; fileUri: string; mimeType: string }>;
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

/** Flatten a v5 nested media field (object / array-of-objects) into citable strings. */
function transformSignal(transform: MediaSignalTransform, value: unknown, objectKey?: string): string[] {
  if (transform === "clothing") {
    // value: Array<{ type?, color?, brand? }> → e.g. "navy blazer (Zara)", "white sneakers".
    if (!Array.isArray(value)) return [];
    return value
      .map((raw) => {
        const o = asRecord(raw);
        const label = [normText(o.color), normText(o.type)].filter(Boolean).join(" ");
        const brand = normText(o.brand);
        const out = brand ? (label ? `${label} (${brand})` : brand) : label;
        return out.trim();
      })
      .filter(Boolean)
      .slice(0, 8);
  }
  if (transform === "eyewear") {
    // value: { present?, color?, style? } → only when glasses are present.
    const o = asRecord(value);
    if (o.present === false) return [];
    const detail = [normText(o.color), normText(o.style)].filter(Boolean).join(" ");
    if (o.present === true || detail) return [detail ? `glasses: ${detail}` : "glasses"];
    return [];
  }
  if (transform === "footwear") {
    const o = asRecord(value);
    const label = [normText(o.color), normText(o.type)].filter(Boolean).join(" ");
    const model = normText(o.model);
    const out = model ? (label ? `${label} (${model})` : model) : label;
    return out.trim() ? [out.trim()] : [];
  }
  if (transform === "facesCount") {
    // value: { count, ... } → "solo" / "2 people" / "3 people" — feeds solo-vs-group.
    const o = asRecord(value);
    const count = typeof o.count === "number" && Number.isFinite(o.count) ? Math.round(o.count) : 0;
    if (count <= 0) return [];
    return [count === 1 ? "solo (1 person)" : `${count} people`];
  }
  if (transform === "objectField") {
    // value: { [objectKey]: scalar } → the inner scalar (e.g. behavioralRead.sociability).
    const o = asRecord(value);
    const scalar = normText(objectKey ? o[objectKey] : undefined);
    return scalar ? [scalar] : [];
  }
  return [];
}

/** Pull a single media-signal's raw values from one completed analysis, per its spec. */
function readSignalFromAnalysis(
  analysis: Record<string, unknown>,
  spec: SectionEvidenceSpec["mediaSignals"][number],
): string[] {
  const bag = asRecord(analysis[spec.path]);
  const value = bag[spec.key];
  if (spec.transform) return transformSignal(spec.transform, value, spec.objectKey);
  if (spec.array) return strArray(value);
  const scalar = normText(value);
  return scalar ? [scalar] : [];
}

/** First-person framing — a post stating "I/my/we…" is a stronger preference signal than ambient text. */
const SELF_DECLARED_RE = /\b(i|i'm|i am|my|me|mine|we|we're|we are|our)\b/i;

/** Parse a metric string like "1,234" / "1.2K" / "3M" into a number (best-effort, 0 on failure). */
function parseMetricNum(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const m = raw.trim().replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const suf = (m[2] || "").toUpperCase();
  if (suf === "K") n *= 1e3;
  else if (suf === "M") n *= 1e6;
  else if (suf === "B") n *= 1e9;
  return n;
}

/** Normalized engagement weight (~0-1, log-scaled) from a content item's metrics, so a viral/high-signal
 *  post outranks low-engagement filler without swamping keyword relevance. */
export function engagementScore(metrics: unknown): number {
  if (!metrics || typeof metrics !== "object") return 0;
  let max = 0;
  for (const v of Object.values(metrics as Record<string, unknown>)) max = Math.max(max, parseMetricNum(v));
  if (max <= 0) return 0;
  return Math.min(1, Math.log10(max + 1) / 6); // ~1e6 → 1.0
}

/** Build a TARGETED evidence slice for one section: relevance-scored text snippets (keyword + engagement
 *  + self-declaration + recency) + that section's media signals with frequency counts + asset hashes. */
export function buildSectionContext(
  sectionId: PreferenceQuestionSectionId,
  contentItems: ArchiveContentRecord[],
  mediaAnalyses: MediaAnalysisRecord[],
): SectionContext {
  const spec = SECTION_EVIDENCE[sectionId];
  const platforms = [...new Set(contentItems.map((c) => c.platform))].sort();

  // ── Text snippets: SCORE every item by section-keyword relevance (word-boundary, so "date" no longer
  // matches "update"/"candidate"), engagement (already-captured metrics), self-declaration, and recency,
  // then take the top budget. This surfaces the highest-signal posts (a viral post, a first-person
  // declaration) rather than just the newest — the lever that made the deep run answer well.
  const withText = contentItems.filter((c) => c.text && (c.text as string).trim());
  const keywordRes = spec.textKeywords.map(
    (kw) => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  );
  const scoreItem = (c: ArchiveContentRecord, idx: number): number => {
    const text = c.text as string;
    const kwHits = keywordRes.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
    const declared = SELF_DECLARED_RE.test(text) ? 1 : 0;
    const eng = engagementScore(c.metrics);
    const recency = withText.length > 1 ? 1 - idx / withText.length : 1; // input is newest-first
    return kwHits * 3 + declared * 2 + eng * 1.5 + recency * 0.5;
  };
  const ordered = withText
    .map((c, idx) => ({ c, s: scoreItem(c, idx) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_TEXT_SNIPPETS)
    .map((x) => x.c);
  const textSnippets = ordered.map((c) => ({
    id: c.itemId,
    platform: c.platform,
    type: c.itemType,
    text: normText(c.text).slice(0, TEXT_SNIPPET_CHARS),
    selfDeclared: SELF_DECLARED_RE.test(c.text as string),
  }));

  // ── Media signals + representative asset hashes (skipped entirely for sensitive/text-only sections).
  const signalBuckets = new Map<string, string[]>();
  for (const s of spec.mediaSignals) signalBuckets.set(s.label, []);
  const assetHashes: string[] = [];
  const mediaImages: SectionContext["mediaImages"] = [];
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
      // Collect the REAL image (gs:// cacheUri) for the top section-relevant assets so the agent can SEE it.
      const cacheUri = normText(analysis.cacheUri);
      if (contributed && cacheUri && record.assetHash && mediaImages.length < MAX_SECTION_IMAGES) {
        if (!mediaImages.some((m) => m.assetHash === record.assetHash)) {
          mediaImages.push({ assetHash: record.assetHash, fileUri: cacheUri, mimeType: normText(analysis.cacheMime) || "image/jpeg" });
        }
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
    mediaImages,
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
const SYNTH_INSTRUCTION = `You are One's preference analyst. The user consented to a self-audit of their OWN public social presence. You are given a FOCUSED evidence slice for ONE section: this section's text snippets, aggregated media signals (frequency counts), AND — attached to this message — the ACTUAL IMAGES from their posts (each labeled with an [img:<assetHash>] tag in the IMAGES list below, in attachment order). LOOK AT THE IMAGES CAREFULLY — they are your richest evidence (colors, outfits, settings, places, food, objects, how the person shows up). Answer EVERY question in this section.

How to reason:
- READ THE ATTACHED IMAGES, not just the text tokens. Derive concrete signal from what you actually see (e.g. the colors they wear/post, the kinds of places, the social settings, the aesthetics) and infer with calibrated confidence.
- The aggregated mediaSignals already carry DEEP per-image reads — clothing (colour/type/brand), eyewear, footwear, accessories, objects, table & background items, surroundings, pose, expression, people count, event type, and place/landmark guesses. Use them together with the images to answer concretely (e.g. "wears mostly black/grey, sneakers, no logos" or "usually outdoors, in group settings, morning posts").
- ALWAYS give a best-effort answer for EVERY non-sensitive question — never "no signal". If the direct signal is thin, make your best inference from the closest adjacent evidence (their professional context, the overall vibe of the images, recurring themes) and mark it status "inferred" with low confidence. Use "answered" when self-declared or the evidence (incl. images) is strong and unambiguous; "inferred" otherwise.
- Cite your evidence: snippet ids in evidenceIds, and the image tags you used in mediaEvidenceIds (use the bare assetHash from [img:<assetHash>]). Citing the specific images you read is what earns medium/high confidence — do it. Do NOT contradict what the evidence shows.
- Put a short justification in \`why\`.

Hard rules (never violate):
- SENSITIVE questions (partner/romance/attraction/red-flags/love-language): NEVER state as fact and NEVER infer from photos or scenes. Use "needs_confirmation" or "unknown" unless the user themselves self-declared it in their own text (then source "self_declared"). The "always answer" rule does NOT apply to sensitive questions.
- Do NOT infer protected/sensitive traits (health, religion, politics, sexuality) and never identify other people in media.

Output MUST match the JSON schema exactly (an "answers" array, one object per question in this section).`;

/* Auto-derived synthesis version. It is a hash of everything that shapes the STORED intelligence:
   the prompt, the response schema, the per-section evidence routing, the model, the question registry,
   and the manual data-shape salt. Any change to those flips the version automatically — so we can never
   forget to "bump" it, and every existing user's stored profile is treated as stale on the next visit
   (the /preferences read path enqueues an in-place recompute; the worker re-stamps THIS same version, so
   the loop converges after one pass). Pure presentation/copy is NOT in this hash — the headline is
   computed at render time, so copy tweaks ship instantly without a recompute. Defined here (after its
   dependencies) to avoid a temporal-dead-zone crash at module load. The `env` model override is
   intentionally excluded — flipping PREFERENCE_SYNTH_MODEL is an ops lever, not a code change. */
export const PREFERENCE_SYNTHESIS_VERSION = `v3.1-${crypto
  .createHash("sha256")
  .update(
    JSON.stringify({
      instr: SYNTH_INSTRUCTION,
      schema: PREFERENCE_SYNTH_SCHEMA,
      sections: SECTION_EVIDENCE,
      model: DEFAULT_SYNTH_MODEL,
      questions: QUESTION_REGISTRY_VERSION,
      rev: PREFERENCE_DATA_SHAPE_REV,
    }),
  )
  .digest("hex")
  .slice(0, 12)}`;

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
  opts: { agentIndex?: number } = {},
) {
  const images = context.mediaImages ?? [];
  const imagesNote = images.length
    ? `\n\nIMAGES (attached below, in this order — these are the user's real post images; cite the ones you read by their bare assetHash):\n${images
        .map((m, i) => `${i + 1}. [img:${m.assetHash}]`)
        .join("\n")}`
    : "";
  const text = `${SYNTH_INSTRUCTION}\n\nSECTION: ${context.sectionId}\n\nQUESTIONS (answer all ${questions.length}):\n${questionsBlock(
    questions,
  )}\n\nEVIDENCE:\n\`\`\`json\n${sectionEvidenceJson(context, professionalContext)}\n\`\`\`${imagesNote}`;
  // Multimodal: the text part first, then one fileData part per real image (Vertex reads gs:// directly).
  const parts: Array<Record<string, unknown>> = [{ text }];
  for (const m of images) parts.push({ fileData: { fileUri: m.fileUri, mimeType: m.mimeType } });
  // Two agents read each section; vary temperature so the reads are genuinely independent (then merged).
  const temperature = 0.35 + (opts.agentIndex ?? 0) * 0.25;
  return {
    model,
    body: {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PREFERENCE_SYNTH_SCHEMA,
        temperature,
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
  let confidence: SynthConfidence = a.confidence === "high" || a.confidence === "medium" ? a.confidence : "low";
  const source: SynthSource = VALID_SOURCE.has(a.source as SynthSource) ? (a.source as SynthSource) : "not_available";
  let answer = typeof a.answer === "string" && a.answer.trim() ? a.answer.trim() : null;
  const evidenceIds = strArray(a.evidenceIds).slice(0, 16);
  const mediaEvidenceIds = strArray(a.mediaEvidenceIds).slice(0, 16);
  const why = typeof a.why === "string" && a.why.trim() ? a.why.trim() : null;

  // Per-agent evidence floor: a claim citing ZERO evidence (no snippet, no image) can't be confident — a
  // pure ungrounded guess is "low". The HIGH cap (needs ≥2 distinct citations) is applied later on the UNION
  // of the 2 agents' citations in mergeAnswerPair, so two agents each reading 1 image can together reach high.
  const evCount = new Set([...evidenceIds, ...mediaEvidenceIds]).size;
  if (evCount === 0) confidence = "low";

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

const CONF_ORDER: Record<SynthConfidence, number> = { low: 0, medium: 1, high: 2 };

/** Merge two independent agent reads of the SAME answer into one, by consensus. The final confidence is
 *  shaped by agreement + the UNION of citations: both agents committed (answered/inferred) + ≥1 citation →
 *  at least medium; HIGH requires ≥2 distinct citations across the two reads; an ungrounded lone guess
 *  stays low. Sensitive answers (already downgraded per-agent) are never amplified past medium. */
export function mergeAnswerPair(a: SynthesizedAnswer, b: SynthesizedAnswer): SynthesizedAnswer {
  const committed = (x: SynthesizedAnswer) => x.status === "answered" || x.status === "inferred";
  const evidenceIds = [...new Set([...a.evidenceIds, ...b.evidenceIds])].slice(0, 16);
  const mediaEvidenceIds = [...new Set([...a.mediaEvidenceIds, ...b.mediaEvidenceIds])].slice(0, 16);
  const evCount = new Set([...evidenceIds, ...mediaEvidenceIds]).size;
  const rank = (x: SynthesizedAnswer) =>
    (committed(x) ? 2 : x.status === "needs_confirmation" ? 1 : 0) * 100 + new Set([...x.evidenceIds, ...x.mediaEvidenceIds]).size;
  const primary = rank(a) >= rank(b) ? a : b;
  const bothCommitted = committed(a) && committed(b);

  let confidence: SynthConfidence = CONF_ORDER[a.confidence] >= CONF_ORDER[b.confidence] ? a.confidence : b.confidence;
  if (bothCommitted && evCount >= 1 && confidence === "low") confidence = "medium"; // consensus + grounded
  if (confidence === "high" && evCount < 2) confidence = "medium"; // high needs ≥2 distinct citations (union)
  if (evCount === 0 && !bothCommitted) confidence = "low"; // ungrounded lone guess
  if (primary.status === "needs_confirmation" && confidence === "high") confidence = "medium"; // never amplify sensitive

  return { ...primary, confidence, evidenceIds, mediaEvidenceIds };
}

/** Merge two agents' full section answer-sets, question by question. */
export function mergeSectionAnswers(
  a: SynthesizedAnswer[],
  b: SynthesizedAnswer[],
  questions: PreferenceQuestionDefinition[],
): SynthesizedAnswer[] {
  const am = new Map(a.map((x) => [x.questionId, x]));
  const bm = new Map(b.map((x) => [x.questionId, x]));
  return questions.map((q) => {
    const x = am.get(q.id);
    const y = bm.get(q.id);
    if (x && y) return mergeAnswerPair(x, y);
    return x ?? y ?? mapOneAnswer({}, q);
  });
}

/** Synthesize ONE section: build its targeted context (text + REAL images), run AGENTS_PER_SECTION
 *  independent multimodal Vertex reads in parallel, and merge them by consensus. Returns null only if
 *  EVERY agent failed (Vertex unavailable) so the caller can fall back to honest unknowns / the fast pass. */
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
  const reads = await Promise.all(
    Array.from({ length: AGENTS_PER_SECTION }, async (_agent, agentIndex) => {
      const { body } = buildSectionSynthesisRequest(model, context, questions, professionalContext, { agentIndex });
      const json = await callVertex(model, body);
      return json ? parseSectionAnswers(json, questions) : null;
    }),
  );
  const ok = reads.filter((r): r is SynthesizedAnswer[] => r !== null);
  if (!ok.length) return null;
  // Merge ALL successful agent reads by consensus (pairwise fold) — works for any agent count. More agents
  // → citations accumulate in the union → stronger, better-grounded answers (HIGH still needs ≥2 distinct).
  return ok.reduce((acc, cur) => mergeSectionAnswers(acc, cur, questions));
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

/** One visual tile in the preference collage — a real post image linking back to its post. */
export interface CollageItem {
  evidenceId: string;
  imageUrl: string | null;
  postUrl: string | null;
  caption: string | null;
  reason: string;
  platform: string;
  signals: string[];
}

function collageImageUrl(media: unknown): string | null {
  const m = media && typeof media === "object" && !Array.isArray(media) ? (media as { primaryUrl?: unknown; urls?: unknown }) : null;
  if (!m) return null;
  if (typeof m.primaryUrl === "string" && /^https?:\/\//i.test(m.primaryUrl)) return m.primaryUrl;
  const urls = Array.isArray(m.urls) ? m.urls : [];
  const first = urls.find((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
  return first ?? null;
}

/** Build a visual collage of the user's real post images (newest-first, deduped) to show under the
 *  preference layer. Pure — reads ArchiveContentRecord.media; safe on missing/expired media. */
export function buildPreferenceCollage(contentItems: ArchiveContentRecord[], limit = 24): CollageItem[] {
  const out: CollageItem[] = [];
  const seen = new Set<string>();
  for (const item of contentItems) {
    const imageUrl = collageImageUrl(item.media);
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    out.push({
      evidenceId: item.itemId,
      imageUrl,
      postUrl: item.itemUrl || null,
      caption: item.text ? item.text.replace(/\s+/g, " ").trim().slice(0, 140) || null : null,
      reason: "",
      platform: item.platform,
      signals: [],
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Lifestyle facts (v5) ─────────────────────────────────────────────────────────────────────────
   Beyond the 6 taste sections, aggregate the deep per-image pixel reads into FACTUAL frequency cards —
   "where you are / what you wear / what you eat / who-with vibe" — surfaced as their own dashboard band.
   Pure + empty-safe; reuses rankByFrequency. */

export interface LifestyleFact {
  value: string;
  count: number;
}

export interface LifestyleFacts {
  sampleSize: number; // completed media analyses considered
  topBrands: LifestyleFact[];
  topColours: LifestyleFact[];
  eyewear: { present: number; absent: number; topStyles: LifestyleFact[] };
  footwear: LifestyleFact[];
  foods: LifestyleFact[];
  places: LifestyleFact[];
  soloVsSocial: { solo: number; group: number };
  timeOfDay: LifestyleFact[];
  surroundings: LifestyleFact[];
  events: { events: number; casual: number; topTypes: LifestyleFact[] };
}

// v5.1: generic visual-noise tokens that Vision labels / web-detection / loose model reads emit but which
// are NOT useful preference facts. Filtered out of every lifestyle card (exact, lowercased match).
const GENERIC_FACT_STOPWORDS = new Set([
  "person", "people", "man", "woman", "men", "women", "human", "adult", "boy", "girl", "businessperson",
  "white collar worker", "white-collar worker", "employee", "spokesperson", "crowd", "audience",
  "photograph", "photography", "photo", "picture", "image", "selfie", "portrait", "snapshot", "screenshot",
  "presentation", "document", "text", "font", "line", "paper", "poster", "banner", "slide", "slideshow",
  "product", "material property", "brand", "logo", "advertising", "advertisement", "job", "gesture",
  "community", "organization", "company", "business", "management", "design", "graphics", "graphic",
  "illustration", "art", "technology", "electronics", "gadget", "device", "object", "thing", "stock photography",
  "event", "ceremony", "meeting", "room", "wall", "floor", "table", "smile", "happy", "fun",
  // v5.2: literal null/placeholder tokens + planet-scale "places" + generic containers the model emits.
  "null", "none", "n/a", "na", "nil", "unknown", "undefined", "not visible", "not applicable", "not specified",
  "earth", "world", "planet", "globe", "map", "water bottle", "water bottles", "bottle", "computer monitor",
  "computer monitors", "monitor", "screen", "indoor", "outdoor", "background", "foreground",
]);

/** Clean a list of raw fact strings for a lifestyle card: trim, drop empties / pure-numbers / overly long
 *  or wordy descriptions (e.g. "Digital Graphic With Map Elements") / generic visual-noise stopwords. */
function cleanFactValues(values: string[], maxWords = 4): string[] {
  return values
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter((v) => v.length > 0 && v.length <= 40)
    .filter((v) => v.split(" ").length <= maxWords)
    .filter((v) => !/^[\d.,%]+$/.test(v))
    .filter((v) => !GENERIC_FACT_STOPWORDS.has(v.toLowerCase()));
}

/** Aggregate the deep per-image reads across all completed media analyses into factual lifestyle cards.
 *  Pure — reads the same MediaAnalysisRecord[] synthesis uses; every field is empty-safe. v5.1: cleaned via
 *  cleanFactValues + tighter sources (places: no reverse-image labels; foods: no generic table items). */
export function aggregateLifestyleFacts(mediaAnalyses: MediaAnalysisRecord[]): LifestyleFacts {
  const brands: string[] = [];
  const colours: string[] = [];
  const eyewearStyles: string[] = [];
  const footwear: string[] = [];
  const foods: string[] = [];
  const places: string[] = [];
  const timeOfDay: string[] = [];
  const surroundings: string[] = [];
  const eventTypes: string[] = [];
  let eyewearPresent = 0;
  let eyewearAbsent = 0;
  let solo = 0;
  let group = 0;
  let events = 0;
  let casual = 0;
  let sampleSize = 0;

  const CASUAL_EVENTS = new Set(["casual", "other"]);
  const GROUP_SETTINGS = new Set(["couple", "small_group", "large_gathering"]);

  for (const record of mediaAnalyses) {
    const analysis = asRecord(record.analysis);
    if (analysis.status !== "completed") continue;
    sampleSize += 1;
    const semantic = asRecord(analysis.semantic);
    const vision = asRecord(analysis.vision);
    const clothing = Array.isArray(semantic.clothing) ? semantic.clothing.map((c) => asRecord(c)) : [];

    // Brands: declared brands + per-garment brand + detected logos.
    for (const b of strArray(semantic.brands)) brands.push(b);
    for (const c of clothing) if (normText(c.brand)) brands.push(normText(c.brand));
    for (const l of strArray(vision.logos)) brands.push(l);

    // Colours: aesthetic palette + per-garment colour.
    for (const c of strArray(semantic.colorAesthetic)) colours.push(c);
    for (const c of clothing) if (normText(c.color)) colours.push(normText(c.color));

    // Eyewear present/absent + style.
    const eyewear = asRecord(semantic.eyewear);
    if (eyewear.present === true) {
      eyewearPresent += 1;
      const detail = [normText(eyewear.color), normText(eyewear.style)].filter(Boolean).join(" ");
      if (detail) eyewearStyles.push(detail);
    } else if (eyewear.present === false) {
      eyewearAbsent += 1;
    }

    // Footwear.
    const fw = asRecord(semantic.footwear);
    const fwLabel = [normText(fw.color), normText(fw.type)].filter(Boolean).join(" ");
    const fwModel = normText(fw.model);
    const fwOut = fwModel ? (fwLabel ? `${fwLabel} (${fwModel})` : fwModel) : fwLabel;
    if (fwOut) footwear.push(fwOut);

    // Food: actual food/drink + cuisine only (tableItems is too noisy — "water bottle", "small plant").
    for (const f of strArray(semantic.foodDrink)) foods.push(f);
    if (normText(semantic.cuisineCategory)) foods.push(normText(semantic.cuisineCategory));

    // Places: the model's explicit place + detected landmarks only (NOT reverse-image web labels, which
    // surface "Businessperson"/"Presentation"). cleanFactValues then strips any remaining noise.
    if (normText(semantic.placeGuess)) places.push(normText(semantic.placeGuess));
    if (normText(semantic.destinationName)) places.push(normText(semantic.destinationName));
    for (const l of strArray(semantic.landmarksSeen)) places.push(l);
    for (const l of strArray(vision.landmarks)) places.push(l);

    // Time of day + surroundings.
    if (normText(semantic.timeOfDay)) timeOfDay.push(normText(semantic.timeOfDay));
    if (normText(semantic.surroundings)) surroundings.push(normText(semantic.surroundings));
    if (normText(semantic.venueType)) surroundings.push(normText(semantic.venueType));

    // Solo vs social: isGroup → socialSetting → face count, first signal wins.
    const faceCount = (() => {
      const f = asRecord(vision.faces);
      return typeof f.count === "number" && Number.isFinite(f.count) ? Math.round(f.count) : null;
    })();
    const setting = normText(semantic.socialSetting);
    if (semantic.isGroup === true || GROUP_SETTINGS.has(setting) || (faceCount !== null && faceCount > 1)) group += 1;
    else if (semantic.isGroup === false || setting === "solo" || faceCount === 1) solo += 1;

    // Events.
    const eventType = normText(semantic.eventType);
    if (eventType) {
      eventTypes.push(eventType);
      if (CASUAL_EVENTS.has(eventType)) casual += 1;
      else events += 1;
    }
  }

  return {
    sampleSize,
    topBrands: rankByFrequency(cleanFactValues(brands), 8),
    topColours: rankByFrequency(cleanFactValues(colours, 3), 8),
    eyewear: { present: eyewearPresent, absent: eyewearAbsent, topStyles: rankByFrequency(cleanFactValues(eyewearStyles), 5) },
    footwear: rankByFrequency(cleanFactValues(footwear), 6),
    foods: rankByFrequency(cleanFactValues(foods), 8),
    places: rankByFrequency(cleanFactValues(places), 8),
    soloVsSocial: { solo, group },
    timeOfDay: rankByFrequency(cleanFactValues(timeOfDay), 4),
    surroundings: rankByFrequency(cleanFactValues(surroundings), 6),
    events: { events, casual, topTypes: rankByFrequency(cleanFactValues(eventTypes), 5) },
  };
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
  collage: CollageItem[];
  questionAnswers: Array<Record<string, unknown>>;
  questionCoverage: { total: number; answered: number; inferred: number; needsConfirmation: number; unknown: number; blockedByAccess: number };
  sectionSummaries: Array<{ sectionId: string; title: string; summary: string; answeredCount: number; totalCount: number; confidence: "low" | "medium" | "high" }>;
  archiveDepth: ArchiveDepthLike | null;
  /** v5: factual lifestyle aggregation (top brands/colours/places/foods/…) for the dashboard cards. */
  lifestyle?: LifestyleFacts | null;
}

export function toRenderablePreferenceProfile(
  result: PreferenceSynthesisResult,
  depth: ArchiveDepthLike | null,
  opts: { generatedAt: string; preferenceStatus: "partial" | "completed"; collage?: CollageItem[]; lifestyle?: LifestyleFacts | null },
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
    summary: buildPreferenceSummary({ answeredTotal, total: result.answers.length, platforms: result.context.platforms }),
    generatedAt: opts.generatedAt,
    updatedFrom: {
      platforms: result.context.platforms,
      indexedItems: result.context.contentItems,
      mediaAssets: result.context.mediaAnalyzed,
      externalLinks: 0,
      ocrSignals: 0,
    },
    topSignals: [],
    collage: opts.collage ?? [],
    questionAnswers,
    questionCoverage,
    sectionSummaries,
    archiveDepth: depth,
    lifestyle: opts.lifestyle ?? null,
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
