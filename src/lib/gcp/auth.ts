/* Shared Google Cloud auth for server-side calls (Vision, Vertex Gemini). On Cloud Run we use the
   runtime service account's Application Default Credentials via the metadata server — no API keys,
   no secret files. Mirrors the proven pattern in src/lib/research/image-intel.ts. */

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Short-lived ADC access token from the Cloud Run metadata server. Null off-GCP or on error. */
export async function adcAccessToken(timeoutMs = 5_000): Promise<string | null> {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch {
    return null;
  }
}

export interface VertexConfig {
  project: string;
  location: string;
}

/** Vertex project/region from env. `location: "global"` is allowed (host has no region prefix). */
export function vertexConfig(): VertexConfig | null {
  const project = (process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
  const location = (process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_REGION || "us-central1").trim();
  if (!project) return null;
  return { project, location };
}

/** REST host for a Vertex region. "global" → aiplatform.googleapis.com; else {region}-aiplatform… */
export function vertexHost(location: string): string {
  return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

/** Vertex generateContent endpoint for a Google publisher model. */
export function vertexGenerateContentUrl(config: VertexConfig, model: string): string {
  return `https://${vertexHost(config.location)}/v1/projects/${config.project}/locations/${config.location}/publishers/google/models/${model}:generateContent`;
}
