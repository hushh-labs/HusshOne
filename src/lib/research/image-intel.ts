/* Background image-intelligence pipeline: reverse-image search the subject's verified
   LinkedIn profile photo via Google Cloud Vision WEB_DETECTION, then hand the matching
   pages/entities to Deep Research to identify same-person matches and extra footprint.
   Runs AFTER Phase-1, the same way the deep batches do. Degrades gracefully when not
   configured (no API key / no photo) so it can never break the dossier. */
import type { OneSubjectInput } from "@/lib/ria/types";

const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const FETCH_TIMEOUT_MS = 20_000;

/* Configured when we can authenticate to Vision: either an explicit API key, or we're
   running on GCP (GOOGLE_CLOUD_PROJECT is set on Cloud Run) where we use the service
   account's Application Default Credentials via the metadata server — no new secret. */
export function visionConfigured(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_CLOUD_PROJECT);
}

/** Fetch a short-lived ADC access token from the Cloud Run metadata server. Null off-GCP. */
async function adcAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch {
    return null;
  }
}

/** Resolve how to call Vision: an API key (?key=) if set, else an ADC bearer token. */
async function visionRequest(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (key) return { url: `${VISION_URL}?key=${encodeURIComponent(key)}`, headers: {} };
  const token = await adcAccessToken();
  if (token) return { url: VISION_URL, headers: { Authorization: `Bearer ${token}` } };
  return null;
}

export interface WebDetection {
  bestGuessLabels: string[];
  webEntities: string[];
  pages: { url: string; title: string }[];
  fullMatchingImages: string[];
  visuallySimilarCount: number;
}

function strList(arr: unknown, pick: (o: Record<string, unknown>) => string, max: number): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const v = pick(item as Record<string, unknown>).trim();
    if (v) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** Cloud Vision WEB_DETECTION on a photo URL. Returns null if unauthenticated or on any error. */
export async function runWebDetection(imageUri: string): Promise<WebDetection | null> {
  if (!imageUri) return null;
  const auth = await visionRequest();
  if (!auth) return null;
  try {
    const res = await fetch(auth.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify({
        requests: [{ image: { source: { imageUri } }, features: [{ type: "WEB_DETECTION", maxResults: 15 }] }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { responses?: Array<{ webDetection?: Record<string, unknown> }> };
    const wd = json.responses?.[0]?.webDetection;
    if (!wd) return null;
    const pagesRaw = Array.isArray(wd.pagesWithMatchingImages) ? wd.pagesWithMatchingImages : [];
    const pages = pagesRaw
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
      .map((p) => ({ url: typeof p.url === "string" ? p.url : "", title: typeof p.pageTitle === "string" ? p.pageTitle : "" }))
      .filter((p) => p.url)
      .slice(0, 15);
    return {
      bestGuessLabels: strList(wd.bestGuessLabels, (o) => String(o.label ?? ""), 3),
      webEntities: strList(wd.webEntities, (o) => String(o.description ?? ""), 12),
      pages,
      fullMatchingImages: strList(wd.fullMatchingImages, (o) => String(o.url ?? ""), 10),
      visuallySimilarCount: Array.isArray(wd.visuallySimilarImages) ? wd.visuallySimilarImages.length : 0,
    };
  } catch {
    return null;
  }
}

export function hasSignal(wd: WebDetection): boolean {
  return wd.pages.length > 0 || wd.webEntities.length > 0 || wd.fullMatchingImages.length > 0 || wd.bestGuessLabels.length > 0;
}

/** The preliminary "Image intelligence" markdown from the raw Vision result (shown immediately). */
export function renderWebDetection(wd: WebDetection): string {
  const lines: string[] = ["## Image intelligence", "", "_Reverse image search on the verified LinkedIn profile photo (Google Cloud Vision)._", ""];
  if (wd.bestGuessLabels.length) lines.push(`**Best-guess description:** ${wd.bestGuessLabels.join(", ")}`, "");
  if (wd.webEntities.length) lines.push(`**Related web entities:** ${wd.webEntities.join(" · ")}`, "");
  if (wd.pages.length) {
    lines.push("**Pages where this photo appears:**", "");
    for (const p of wd.pages) lines.push(`- ${p.title || p.url} — ${p.url}`);
    lines.push("");
  }
  if (wd.visuallySimilarCount) lines.push(`**Visually similar images found:** ${wd.visuallySimilarCount}`, "");
  return lines.join("\n").trim();
}

/** Deep-Research synthesis prompt: verify same-person matches + extract extra footprint. */
export function buildImageBatchQuestion(subject: OneSubjectInput, wd: WebDetection): string {
  const today = new Date().toISOString().slice(0, 10);
  const pageList = wd.pages.map((p) => `- ${p.title || "(page)"} — ${p.url}`).join("\n") || "- (none)";
  const entities = wd.webEntities.join(", ") || "(none)";
  return `CONSENT-BASED PUBLIC INTELLIGENCE — IMAGE FOOTPRINT PASS. Today is ${today}.
The subject consented to a self-audit of their OWN public footprint. Identity is ALREADY CONFIRMED — this is ${subject.name} (${subject.email}). Do NOT re-confirm identity.

A reverse image search on the subject's verified LinkedIn profile photo returned these signals:
Best-guess: ${wd.bestGuessLabels.join(", ") || "(none)"}
Web entities: ${entities}
Pages where the photo (or a close match) appears:
${pageList}

TASK — using lawful public sources, briefly investigate these pages/entities and DELIVER one markdown section:
## Image-based footprint
- Which of the above are clearly the SAME person (the subject) vs. coincidental look-alikes — say so explicitly with the URL.
- Any ADDITIONAL public profiles/accounts/aliases or notable mentions this reverse-image trail reveals that aren't already obvious.
- A one-line takeaway on how discoverable the subject is by their photo.

RULES: run roughly 6–10 targeted checks then STOP. Lawful public sources only; never expose private/sensitive data; label uncertain matches "possible/weak"; back claims with the source URL. Strictly about THIS person.`;
}
