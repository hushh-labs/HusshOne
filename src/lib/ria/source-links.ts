import type { OneSourceCard } from "./types";

/**
 * Cleans the Shadow report's raw source URLs into professional, personalized
 * cards. Gemini grounding citations arrive as opaque
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/<token>` URLs — we
 * resolve those server-side (SSRF-guarded) to the real destination, then label
 * + categorize them. Anything we can't resolve is folded into a count so the
 * UI can say "Verified across N public web sources" instead of showing junk.
 */

const GROUNDING_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_PREFIX = "/grounding-api-redirect/";
const RESOLVE_TIMEOUT_MS = 2500;
const MAX_RESOLVE = 16; // bound the parallel fan-out
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h

const resolveCache = new Map<string, { url: string | null; at: number }>();

export function isGroundingRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === GROUNDING_HOST && u.pathname.startsWith(GROUNDING_PREFIX);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Drop query + hash so we never display/leak params (e.g. an email in a tracking param). */
function stripParams(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Resolve a grounding-redirect to its real destination. SSRF guard: we ONLY
 * initiate requests to the known vertex grounding host (verified by
 * isGroundingRedirect); the result is used for display only, never re-fetched.
 * Non-grounding URLs pass through unchanged.
 */
export async function resolveGroundingUrl(url: string): Promise<string | null> {
  if (!isGroundingRedirect(url)) return url;

  const cached = resolveCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.url;

  let finalUrl: string | null = null;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HushhOne/1.0; +https://one.hushh.ai)" },
    });
    if (res.url && !isGroundingRedirect(res.url)) {
      finalUrl = stripParams(res.url);
    }
  } catch {
    finalUrl = null; // timeout / network / expired token → unresolved
  }

  resolveCache.set(url, { url: finalUrl, at: Date.now() });
  return finalUrl;
}

function firstName(name: string): string {
  return (name || "").trim().split(/\s+/)[0] || "";
}

/** Map a clean URL → a personalized, professional source card (Hushh voice). */
export function categorizeSource(url: string, subjectName: string): OneSourceCard {
  const domain = hostOf(url);
  const first = firstName(subjectName);
  const favicon = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null;

  let category = "Public web";
  let label = domain || url;

  if (domain === "github.com") {
    category = "Code";
    label = first ? `${first}'s GitHub` : "GitHub";
  } else if (domain === "linkedin.com") {
    category = "Professional";
    label = first ? `${first} on LinkedIn` : "LinkedIn";
  } else if (domain === "x.com" || domain === "twitter.com") {
    category = "Social";
    label = first ? `${first} on X` : "X";
  } else if (domain === "play.google.com" || domain === "apps.apple.com") {
    category = "App";
    label = "App listing";
  } else if (/\.edu$|\.ac\.in$|\.edu\.in$|aitpune|university|college|institute/.test(domain)) {
    category = "Education";
    label = domain;
  } else if (/news|times|express|reuters|bloomberg|forbes|techcrunch|yourstory|hindu|medium\.com|dev\.to/.test(domain)) {
    category = "News & media";
    label = domain;
  } else if (/devfolio|lu\.ma|luma|theorg|behance|dribbble|notion\.site|substack/.test(domain)) {
    category = "Professional";
    label = domain;
  }

  return { url, domain, label, category, favicon };
}

/**
 * Resolve + categorize + dedupe a list of raw source URLs into display cards.
 * Returns named cards plus a count of public-web sources that couldn't be
 * individually named (for the "Verified across N public web sources" line).
 */
export async function buildSourceCards(
  urls: string[],
  subjectName: string,
): Promise<{ cards: OneSourceCard[]; verifiedWebCount: number }> {
  const unique = Array.from(new Set((urls || []).filter((u): u is string => typeof u === "string" && !!u.trim())));
  const head = unique.slice(0, MAX_RESOLVE);
  const overflow = Math.max(0, unique.length - head.length);

  const resolved = await Promise.all(
    head.map((u) => (isGroundingRedirect(u) ? resolveGroundingUrl(u) : Promise.resolve(u))),
  );

  const byDomain = new Map<string, OneSourceCard>();
  let verifiedWebCount = overflow;

  for (const r of resolved) {
    if (!r) {
      verifiedWebCount += 1; // unresolved grounding citation → verified but unnamed
      continue;
    }
    const card = categorizeSource(stripParams(r), subjectName);
    if (!card.domain) {
      verifiedWebCount += 1;
      continue;
    }
    if (!byDomain.has(card.domain)) byDomain.set(card.domain, card);
  }

  return { cards: Array.from(byDomain.values()), verifiedWebCount };
}
