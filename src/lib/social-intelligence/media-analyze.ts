/* GCP multimodal media analysis for the v3 preference layer. For each visible social media asset:
   (1) Cloud Vision images:annotate — ONE multi-feature call (OCR, labels, logos, landmarks, objects,
       dominant colors, safe-search), and (2) Vertex Gemini generateContent with a forced JSON schema
       for the semantic read (style / brand / food / travel / aesthetic / activity + confidence).
   All auth is ADC (no keys). Pure builders/parsers are exported for unit tests; the orchestrator is
   fully defensive — a failed asset never throws, it returns a failed/skipped result. No facial
   recognition; only public/visible media; safe-search gates unsafe content out of synthesis. */
import { adcAccessToken, vertexConfig, vertexGenerateContentUrl } from "@/lib/gcp/auth";

export const MEDIA_ANALYSIS_VERSION = "2026-06-18.media-v3";
export const DEFAULT_MEDIA_MODEL = "gemini-2.5-flash";

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const FETCH_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // skip absurdly large assets to bound cost/latency

const VISION_FEATURES = [
  { type: "TEXT_DETECTION", maxResults: 1 },
  { type: "LABEL_DETECTION", maxResults: 15 },
  { type: "LOGO_DETECTION", maxResults: 8 },
  { type: "LANDMARK_DETECTION", maxResults: 5 },
  { type: "OBJECT_LOCALIZATION", maxResults: 12 },
  { type: "IMAGE_PROPERTIES" },
  { type: "SAFE_SEARCH_DETECTION" },
] as const;

/** Forced JSON schema for the Gemini semantic read (Vertex controlled generation). */
export const PREFERENCE_MEDIA_SCHEMA = {
  type: "object",
  properties: {
    scene: { type: "string" },
    activity: { type: "string" },
    clothingStyle: { type: "array", items: { type: "string" } },
    brands: { type: "array", items: { type: "string" } },
    devices: { type: "array", items: { type: "string" } },
    foodDrink: { type: "array", items: { type: "string" } },
    travelPlaceType: { type: "string" },
    colorAesthetic: { type: "array", items: { type: "string" } },
    mood: { type: "string" },
    languageInImage: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    notes: { type: "string" },
  },
  required: ["confidence"],
} as const;

const GEMINI_INSTRUCTION = `You are extracting PREFERENCE signals from ONE public social image for a user who consented to a self-audit. Describe ONLY what is visibly present. Infer brand/device/style/food/travel/aesthetic preferences cautiously and set confidence accordingly (low if unsure). Do NOT identify or describe specific people, do NOT guess identity, religion, health, politics, or sensitive traits. If the image shows none of these signals, return empty arrays and confidence "low". Output must match the provided JSON schema exactly.`;

export interface VisionFacts {
  ocrText: string | null;
  labels: Array<{ description: string; score: number }>;
  logos: string[];
  landmarks: string[];
  objects: string[];
  dominantColors: Array<{ rgb: string; score: number; fraction: number }>;
  safeSearch: Record<string, string>;
}

export interface PreferenceMediaSemantic {
  scene?: string;
  activity?: string;
  clothingStyle?: string[];
  brands?: string[];
  devices?: string[];
  foodDrink?: string[];
  travelPlaceType?: string;
  colorAesthetic?: string[];
  mood?: string;
  languageInImage?: string;
  confidence: "low" | "medium" | "high";
  notes?: string;
}

export interface MediaAnalysisResult {
  status: "completed" | "failed" | "skipped";
  version: string;
  model: string | null;
  mediaType: string;
  videoState?: "thumbnail_only";
  safe: boolean;
  vision?: VisionFacts;
  semantic?: PreferenceMediaSemantic;
  error?: string;
}

/** True when Vision/Vertex can authenticate (running on GCP with ADC, or an explicit Vision key). */
export function mediaAnalysisConfigured(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT);
}

/* ── Pure builders / parsers (unit-tested) ──────────────────────────────────────────────────── */

export function buildVisionRequestBody(imageBase64: string) {
  return { requests: [{ image: { content: imageBase64 }, features: VISION_FEATURES }] };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rgbString(color: Record<string, unknown>): string {
  return `rgb(${Math.round(num(color.red))}, ${Math.round(num(color.green))}, ${Math.round(num(color.blue))})`;
}

export function parseVisionResponse(json: unknown): VisionFacts {
  const response = (json as { responses?: unknown[] })?.responses?.[0];
  const r = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];

  const fullText = (r.fullTextAnnotation as { text?: unknown } | undefined)?.text;
  const firstTextAnnotation = arr(r.textAnnotations)[0]?.description;
  const ocrRaw = typeof fullText === "string" ? fullText : typeof firstTextAnnotation === "string" ? firstTextAnnotation : null;
  const ocrText = ocrRaw ? ocrRaw.replace(/\s+/g, " ").trim().slice(0, 1200) || null : null;

  const labels = arr(r.labelAnnotations)
    .map((l) => ({ description: String(l.description ?? "").trim(), score: num(l.score) }))
    .filter((l) => l.description)
    .slice(0, 15);
  const logos = arr(r.logoAnnotations).map((l) => String(l.description ?? "").trim()).filter(Boolean).slice(0, 8);
  const landmarks = arr(r.landmarkAnnotations).map((l) => String(l.description ?? "").trim()).filter(Boolean).slice(0, 5);
  const objects = arr(r.localizedObjectAnnotations).map((o) => String(o.name ?? "").trim()).filter(Boolean).slice(0, 12);

  const colorsRaw = arr((r.imagePropertiesAnnotation as { dominantColors?: { colors?: unknown } } | undefined)?.dominantColors?.colors);
  const dominantColors = colorsRaw
    .map((c) => ({
      rgb: rgbString((c.color as Record<string, unknown>) ?? {}),
      score: num(c.score),
      fraction: num(c.pixelFraction),
    }))
    .slice(0, 6);

  const ss = (r.safeSearchAnnotation && typeof r.safeSearchAnnotation === "object" ? r.safeSearchAnnotation : {}) as Record<string, unknown>;
  const safeSearch: Record<string, string> = {};
  for (const key of ["adult", "spoof", "medical", "violence", "racy"]) {
    if (typeof ss[key] === "string") safeSearch[key] = ss[key] as string;
  }

  return { ocrText, labels, logos, landmarks, objects, dominantColors, safeSearch };
}

/** Safe-search gate: exclude assets flagged LIKELY/VERY_LIKELY for adult, racy, or violence. */
export function isSafeForSynthesis(facts: VisionFacts): boolean {
  const unsafe = new Set(["LIKELY", "VERY_LIKELY"]);
  return !(["adult", "racy", "violence"] as const).some((k) => unsafe.has(facts.safeSearch[k] ?? ""));
}

export function buildGeminiRequestBody(imageBase64: string, mimeType: string, context: string) {
  const text = context ? `${GEMINI_INSTRUCTION}\n\nPost context (may be empty): ${context.slice(0, 600)}` : GEMINI_INSTRUCTION;
  return {
    contents: [
      {
        role: "user",
        parts: [{ text }, { inlineData: { mimeType, data: imageBase64 } }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: PREFERENCE_MEDIA_SCHEMA,
      temperature: 0.2,
      maxOutputTokens: 1024,
    },
  };
}

export function parseGeminiStructured(json: unknown): PreferenceMediaSemantic | null {
  try {
    const text = (json as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : undefined;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const confidence = parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low";
    return {
      scene: str(parsed.scene),
      activity: str(parsed.activity),
      clothingStyle: strArr(parsed.clothingStyle),
      brands: strArr(parsed.brands),
      devices: strArr(parsed.devices),
      foodDrink: strArr(parsed.foodDrink),
      travelPlaceType: str(parsed.travelPlaceType),
      colorAesthetic: strArr(parsed.colorAesthetic),
      mood: str(parsed.mood),
      languageInImage: str(parsed.languageInImage),
      confidence,
      notes: str(parsed.notes),
    };
  } catch {
    return null;
  }
}

/* ── Network calls (defensive) ──────────────────────────────────────────────────────────────── */

async function visionAuth(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (key) return { url: `${VISION_URL}?key=${encodeURIComponent(key)}`, headers: {} };
  const token = await adcAccessToken();
  if (token) return { url: VISION_URL, headers: { Authorization: `Bearer ${token}` } };
  return null;
}

async function fetchImageBytes(sourceUrl: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!mimeType.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { base64: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

async function runVision(imageBase64: string): Promise<VisionFacts | null> {
  const auth = await visionAuth();
  if (!auth) return null;
  try {
    const res = await fetch(auth.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify(buildVisionRequestBody(imageBase64)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseVisionResponse(await res.json());
  } catch {
    return null;
  }
}

async function runGeminiSemantic(imageBase64: string, mimeType: string, context: string, model: string): Promise<PreferenceMediaSemantic | null> {
  const config = vertexConfig();
  if (!config) return null;
  const token = await adcAccessToken();
  if (!token) return null;
  try {
    const res = await fetch(vertexGenerateContentUrl(config, model), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildGeminiRequestBody(imageBase64, mimeType, context)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseGeminiStructured(await res.json());
  } catch {
    return null;
  }
}

export interface AnalyzeMediaInput {
  sourceUrl: string;
  mediaType: string;
  context?: string;
  model?: string;
}

/** Analyze one media asset end-to-end. Never throws — returns a completed/failed/skipped result.
 *  Vision is the deterministic floor; the Gemini semantic read is best-effort on top. */
export async function analyzeMediaAsset(input: AnalyzeMediaInput): Promise<MediaAnalysisResult> {
  const model = input.model || process.env.PREFERENCE_MEDIA_MODEL || DEFAULT_MEDIA_MODEL;
  const base: Omit<MediaAnalysisResult, "status" | "safe"> = {
    version: MEDIA_ANALYSIS_VERSION,
    model,
    mediaType: input.mediaType,
    ...(input.mediaType === "video" ? { videoState: "thumbnail_only" as const } : {}),
  };
  const bytes = await fetchImageBytes(input.sourceUrl);
  if (!bytes) {
    // Expired/cookie-gated CDN or non-image — never bypass access, just mark unavailable.
    return { ...base, status: "skipped", safe: true, error: "media_unavailable" };
  }
  const vision = await runVision(bytes.base64);
  if (!vision) {
    return { ...base, status: "failed", safe: true, error: "vision_failed" };
  }
  const safe = isSafeForSynthesis(vision);
  // Skip the semantic LLM read for unsafe media — keep it out of preference synthesis entirely.
  const semantic = safe ? await runGeminiSemantic(bytes.base64, bytes.mimeType, input.context ?? "", model) : null;
  return { ...base, status: "completed", safe, vision, ...(semantic ? { semantic } : {}) };
}
