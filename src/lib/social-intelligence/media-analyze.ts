/* GCP multimodal media analysis for the v3 preference layer. For each visible social media asset:
   (1) Cloud Vision images:annotate — ONE multi-feature call (OCR, labels, logos, landmarks, objects,
       dominant colors, safe-search), and (2) Vertex Gemini generateContent with a forced JSON schema
       for the semantic read (style / brand / food / travel / aesthetic / activity + confidence).
   All auth is ADC (no keys). Pure builders/parsers are exported for unit tests; the orchestrator is
   fully defensive — a failed asset never throws, it returns a failed/skipped result. No facial
   recognition; only public/visible media; safe-search gates unsafe content out of synthesis. */
import { adcAccessToken, vertexConfig, vertexGenerateContentUrl } from "@/lib/gcp/auth";
import { uploadMediaCache } from "@/lib/gcp/storage";

// v5 (pixel): much deeper per-image read — added FACE/WEB/DOCUMENT_TEXT Vision features + a far richer
// Gemini schema (clothing brand+colour+type, eyewear, footwear, objects, pose, expression, people count,
// event, place, time-of-day, surroundings). Bumping this string is what part B's requeue keys off.
export const MEDIA_ANALYSIS_VERSION = "2026-06-24.media-v5-pixel";
export const DEFAULT_MEDIA_MODEL = "gemini-2.5-flash";

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const FETCH_TIMEOUT_MS = 25_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // skip absurdly large assets to bound cost/latency

const VISION_FEATURES = [
  { type: "TEXT_DETECTION", maxResults: 1 },
  { type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }, // dense signage/menus (shares fullTextAnnotation)
  { type: "LABEL_DETECTION", maxResults: 15 },
  { type: "LOGO_DETECTION", maxResults: 8 },
  { type: "LANDMARK_DETECTION", maxResults: 5 },
  { type: "OBJECT_LOCALIZATION", maxResults: 15 },
  { type: "FACE_DETECTION", maxResults: 15 }, // count + smile/headwear likelihoods ONLY — never identity
  { type: "WEB_DETECTION", maxResults: 10 }, // reverse-image: web entities + best-guess label (place/context)
  { type: "IMAGE_PROPERTIES" },
  { type: "SAFE_SEARCH_DETECTION" },
] as const;

export const EVENT_TYPES = [
  "party",
  "conference",
  "wedding",
  "work",
  "outdoor",
  "dining",
  "concert",
  "sports",
  "travel",
  "casual",
  "other",
] as const;

/** Forced JSON schema for the Gemini semantic read (Vertex controlled generation). v5 adds the deep
 *  "pixel" fields: clothing (type+colour+brand), eyewear, footwear, objects, table/background items,
 *  surroundings, pose, expression, people count, event, place. All ADDITIVE — the original 16 keys are
 *  kept so previously-stored rows still parse. */
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
    cuisineCategory: { type: "string" },
    venueType: { type: "string" },
    destinationName: { type: "string" },
    socialSetting: { type: "string", enum: ["solo", "couple", "small_group", "large_gathering"] },
    timeOfDay: { type: "string", enum: ["morning", "afternoon", "evening", "night"] },
    musicOrEntertainment: { type: "array", items: { type: "string" } },
    // ── v5 deep pixel read ───────────────────────────────────────────────────────────────────
    clothing: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string" }, color: { type: "string" }, brand: { type: "string" } },
      },
    },
    eyewear: {
      type: "object",
      properties: { present: { type: "boolean" }, color: { type: "string" }, style: { type: "string" } },
    },
    footwear: {
      type: "object",
      properties: { type: { type: "string" }, color: { type: "string" }, model: { type: "string" } },
    },
    accessories: { type: "array", items: { type: "string" } },
    objects: { type: "array", items: { type: "string" } },
    tableItems: { type: "array", items: { type: "string" } },
    backgroundItems: { type: "array", items: { type: "string" } },
    surroundings: { type: "string" },
    pose: { type: "string" },
    expression: { type: "string" },
    peopleCount: { type: "integer" },
    isGroup: { type: "boolean" },
    eventType: { type: "string", enum: [...EVENT_TYPES] },
    placeGuess: { type: "string" },
    landmarksSeen: { type: "array", items: { type: "string" } },
    pixelNotes: { type: "string" },
    // Soft, low-confidence sociability read (solo-vs-group + pose) — NOT a clinical personality label.
    behavioralRead: {
      type: "object",
      properties: { sociability: { type: "string" }, confidence: { type: "string", enum: ["low", "medium", "high"] } },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    notes: { type: "string" },
  },
  required: ["confidence"],
} as const;

const GEMINI_INSTRUCTION = `You are extracting PREFERENCE signals from ONE public social image for a user who consented to a self-audit. Read the image like a careful analyst: note EVERYTHING visibly present and fill as many schema fields as the image truly supports. Describe ONLY what is visibly present; never guess — leave a field empty/omit it when not clearly evident, and set confidence accordingly (low if unsure).

Capture, when visible:
- clothing: an entry per visible garment with its type (e.g. "t-shirt", "blazer", "kurta"), color, and brand (only if a logo/text makes the brand clear).
- eyewear: present true/false, plus color and style (e.g. "black wayfarer", "round metal") when worn.
- footwear: type/color and model (e.g. "white sneakers", "Air Jordan 1") when visible.
- accessories (watch, bag, cap, jewellery), objects in frame, tableItems (what's on the table/plate), backgroundItems (what's behind the subject), and surroundings (a short phrase: "home living room", "rooftop cafe", "mountain trail", "conference hall").
- pose (e.g. "candid walking", "seated at desk", "group selfie") and expression (e.g. "smiling", "relaxed", "neutral").
- peopleCount (integer, how many people are visible) and isGroup (true if more than one person).
- eventType (one of the schema enum values) when the scene is clearly an event.
- placeGuess (a city/venue/region ONLY if strongly evident from signage, landmarks, or unmistakable scenery) and landmarksSeen.
- timeOfDay, cuisineCategory, venueType, colorAesthetic, devices, foodDrink, musicOrEntertainment, scene, activity, mood, languageInImage — as before.
- behavioralRead: a SOFT sociability read (e.g. "appears social / outgoing" vs "appears reserved") inferred only from solo-vs-group and pose; ALWAYS set its confidence to "low". This is a gentle behavioural hint, never a clinical or definitive personality label.
- pixelNotes: a short free-text line capturing any other concrete visible detail worth remembering.

STRICT GUARDRAILS — never violate: Do NOT identify or name any specific person. Do NOT infer or describe skin tone, race, ethnicity, religion, health, disability, politics, or sexuality — leave anything touching these blank. These are about the user's own visible scene and self-presentation only.

If the image shows none of these signals, return empty arrays and confidence "low". Output must match the provided JSON schema exactly.`;

export interface VisionFacts {
  ocrText: string | null;
  labels: Array<{ description: string; score: number }>;
  logos: string[];
  landmarks: string[];
  objects: string[];
  dominantColors: Array<{ rgb: string; score: number; fraction: number }>;
  safeSearch: Record<string, string>;
  /** v5: face COUNT + smile/headwear likelihood tallies only — never boxes, landmarks, or identity. */
  faces?: { count: number; joyLikely: number; headwearLikely: number };
  /** v5: reverse-image context (web entities, best-guess labels, page titles). No page URLs (privacy). */
  webEntities?: string[];
  bestGuessLabels?: string[];
  webPageTitles?: string[];
}

export interface MediaClothingItem {
  type?: string;
  color?: string;
  brand?: string;
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
  cuisineCategory?: string;
  venueType?: string;
  destinationName?: string;
  socialSetting?: string;
  timeOfDay?: string;
  musicOrEntertainment?: string[];
  // ── v5 deep pixel read ───────────────────────────────────────────────────────────────────────
  clothing?: MediaClothingItem[];
  eyewear?: { present?: boolean; color?: string; style?: string };
  footwear?: { type?: string; color?: string; model?: string };
  accessories?: string[];
  objects?: string[];
  tableItems?: string[];
  backgroundItems?: string[];
  surroundings?: string;
  pose?: string;
  expression?: string;
  peopleCount?: number;
  isGroup?: boolean;
  eventType?: string;
  placeGuess?: string;
  landmarksSeen?: string[];
  pixelNotes?: string;
  behavioralRead?: { sociability?: string; confidence: "low" | "medium" | "high" };
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
  /** gs:// URI of the persisted image bytes (set when safe + uploaded) so synthesis can read the REAL
   *  image via Vertex fileData after the social CDN URL expires. Plus its mimeType. */
  cacheUri?: string | null;
  cacheMime?: string | null;
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

  // v5: FACE_DETECTION → count + smile/headwear tallies ONLY. No bounding boxes, landmarks, or identity.
  const faceAnnotations = arr(r.faceAnnotations);
  const likely = new Set(["LIKELY", "VERY_LIKELY"]);
  const faces = {
    count: faceAnnotations.length,
    joyLikely: faceAnnotations.filter((f) => likely.has(String(f.joyLikelihood ?? ""))).length,
    headwearLikely: faceAnnotations.filter((f) => likely.has(String(f.headwearLikelihood ?? ""))).length,
  };

  // v5: WEB_DETECTION → reverse-image context. Entities + best-guess labels + page TITLES only (no URLs).
  const web = (r.webDetection && typeof r.webDetection === "object" ? r.webDetection : {}) as Record<string, unknown>;
  const webEntities = arr(web.webEntities)
    .filter((e) => num(e.score) > 0.3)
    .map((e) => String(e.description ?? "").trim())
    .filter(Boolean)
    .slice(0, 10);
  const bestGuessLabels = arr(web.bestGuessLabels).map((l) => String(l.label ?? "").trim()).filter(Boolean).slice(0, 3);
  const webPageTitles = arr(web.pagesWithMatchingImages)
    .map((p) => String(p.pageTitle ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 5);

  return {
    ocrText,
    labels,
    logos,
    landmarks,
    objects,
    dominantColors,
    safeSearch,
    faces,
    ...(webEntities.length ? { webEntities } : {}),
    ...(bestGuessLabels.length ? { bestGuessLabels } : {}),
    ...(webPageTitles.length ? { webPageTitles } : {}),
  };
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
      maxOutputTokens: 2048, // v5: bigger schema (clothing/eyewear/footwear/objects/pixelNotes) needs headroom
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
    const oneOf = (v: unknown, allowed: readonly string[]): string | undefined => {
      const s = str(v);
      return s && allowed.includes(s) ? s : undefined;
    };
    const boolVal = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
    const intVal = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
    const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    // clothing[]: keep only entries that carry at least one of type/color/brand.
    const clothingArr = (v: unknown): MediaClothingItem[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const items = v
        .map((x) => rec(x))
        .map((o) => ({ type: str(o.type), color: str(o.color), brand: str(o.brand) }))
        .filter((o) => o.type || o.color || o.brand)
        .slice(0, 8);
      return items.length ? items : undefined;
    };
    const eyewear = (() => {
      const o = rec(parsed.eyewear);
      const present = boolVal(o.present);
      const color = str(o.color);
      const style = str(o.style);
      if (present === undefined && !color && !style) return undefined;
      return { ...(present !== undefined ? { present } : {}), ...(color ? { color } : {}), ...(style ? { style } : {}) };
    })();
    const footwear = (() => {
      const o = rec(parsed.footwear);
      const type = str(o.type);
      const color = str(o.color);
      const model = str(o.model);
      if (!type && !color && !model) return undefined;
      return { ...(type ? { type } : {}), ...(color ? { color } : {}), ...(model ? { model } : {}) };
    })();
    // behavioralRead: a soft hint — its confidence is ALWAYS forced to "low".
    const behavioralRead = (() => {
      const o = rec(parsed.behavioralRead);
      const sociability = str(o.sociability);
      if (!sociability) return undefined;
      return { sociability, confidence: "low" as const };
    })();
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
      cuisineCategory: str(parsed.cuisineCategory),
      venueType: str(parsed.venueType),
      destinationName: str(parsed.destinationName),
      socialSetting: oneOf(parsed.socialSetting, ["solo", "couple", "small_group", "large_gathering"]),
      timeOfDay: oneOf(parsed.timeOfDay, ["morning", "afternoon", "evening", "night"]),
      musicOrEntertainment: strArr(parsed.musicOrEntertainment),
      // ── v5 deep pixel read ─────────────────────────────────────────────────────────────────────
      clothing: clothingArr(parsed.clothing),
      eyewear,
      footwear,
      accessories: strArr(parsed.accessories),
      objects: strArr(parsed.objects),
      tableItems: strArr(parsed.tableItems),
      backgroundItems: strArr(parsed.backgroundItems),
      surroundings: str(parsed.surroundings),
      pose: str(parsed.pose),
      expression: str(parsed.expression),
      peopleCount: intVal(parsed.peopleCount),
      isGroup: boolVal(parsed.isGroup),
      eventType: oneOf(parsed.eventType, EVENT_TYPES),
      placeGuess: str(parsed.placeGuess),
      landmarksSeen: strArr(parsed.landmarksSeen),
      pixelNotes: str(parsed.pixelNotes),
      behavioralRead,
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
  /** sha256(sourceUrl) — when present + the image is safe, the fetched bytes are uploaded to the media-cache
   *  bucket so synthesis can read the real image later (the CDN URL will have expired). */
  assetHash?: string;
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
  // Persist the image bytes to the media-cache bucket (safe media only) so synthesis can read the REAL image
  // multimodally later — the social CDN URL will have expired by then. Best-effort: failure ⇒ no cacheUri.
  const cache = safe && input.assetHash ? await uploadMediaCache(input.assetHash, bytes.base64, bytes.mimeType) : null;
  return {
    ...base,
    status: "completed",
    safe,
    vision,
    ...(semantic ? { semantic } : {}),
    ...(cache ? { cacheUri: cache.fileUri, cacheMime: cache.mimeType } : {}),
  };
}
