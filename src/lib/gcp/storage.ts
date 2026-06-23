/* Media-cache bucket: persist scraped image BYTES at analysis time (when the signed, expiring social CDN
   URL is still alive) so the preference synthesis can read the real images later via Vertex `fileData`
   (gs:// URI) — long after the original URL dies. ADC-authed (Cloud Run runtime SA), same metadata-token
   pattern as src/lib/gcp/auth.ts. Fully defensive: any failure → null (the asset just won't be shown as an
   image to synthesis). Object name = media/<assetHash>.<ext>; assetHash is sha256(sourceUrl), so identical
   images across users dedupe to one object. */
import { adcAccessToken } from "./auth";

const DEFAULT_BUCKET = "hushone-media-cache";

function extensionFor(mimeType: string): string {
  if (/png/i.test(mimeType)) return "png";
  if (/webp/i.test(mimeType)) return "webp";
  if (/gif/i.test(mimeType)) return "gif";
  return "jpg";
}

export function mediaCacheBucket(): string {
  return (process.env.MEDIA_CACHE_BUCKET || DEFAULT_BUCKET).trim();
}

/** Upload image bytes to the media-cache bucket. Returns { fileUri: "gs://…", mimeType } or null. */
export async function uploadMediaCache(
  assetHash: string,
  base64: string,
  mimeType: string,
): Promise<{ fileUri: string; mimeType: string } | null> {
  const bucket = mediaCacheBucket();
  if (!bucket || !assetHash || !base64) return null;
  const token = await adcAccessToken();
  if (!token) return null;
  const safeMime = mimeType && mimeType.startsWith("image/") ? mimeType : "image/jpeg";
  const object = `media/${assetHash}.${extensionFor(safeMime)}`;
  try {
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(object)}`,
      {
        method: "POST",
        headers: { "Content-Type": safeMime, Authorization: `Bearer ${token}` },
        body: Buffer.from(base64, "base64"),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) return null;
    return { fileUri: `gs://${bucket}/${object}`, mimeType: safeMime };
  } catch {
    return null;
  }
}
