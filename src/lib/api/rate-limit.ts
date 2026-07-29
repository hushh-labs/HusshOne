/* Best-effort, in-memory, per-IP rate limiter shared by the public (key-free) same-origin routes that
   power the /localfinder panel: GET /api/localfinder (summary) and GET /api/localfinder/rows (paging).
   Both draw from ONE window per client IP so paging can't be used to sidestep the search budget.

   It is intentionally simple and per-Cloud-Run-instance (no Redis): a sliding count of request
   timestamps per IP. Casual-abuse defense for a shared DB, not a hard guarantee. The map is bounded so a
   burst of unique IPs can't grow it without limit. */

const globalForRate = globalThis as unknown as { __ipRateHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (globalForRate.__ipRateHits ??= new Map());

/** Best-effort client IP from the proxy headers.
 *
 *  IMPORTANT: use the RIGHTMOST X-Forwarded-For entry, never the leftmost. This service runs on Cloud Run
 *  reached directly (no external HTTP LB), and Google's front end APPENDS the real caller IP as the LAST
 *  entry — anything to its left is client-supplied and therefore spoofable. Keying on `[0]` let an attacker
 *  rotate a fake first hop (`X-Forwarded-For: <random>`) to land in a fresh bucket on every request and
 *  slip the limiter entirely. The appended last hop is the only value the platform vouches for.
 *  (If this ever moves behind a GCLB, the trusted client IP becomes the second-from-last entry instead.) */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Returns true when `ip` is over budget in the trailing window. Records this hit. Uses Date.now()
 *  (route runtime, not a workflow script). Defaults: 30 requests / 60s. */
export function rateLimited(ip: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5_000) {
    // bound memory: drop the oldest-touched entries
    for (const key of hits.keys()) {
      if (hits.size <= 2_500) break;
      hits.delete(key);
    }
  }
  return recent.length > limit;
}
