export function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeName(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function initialsForName(name: string) {
  const initials = normalizeName(name)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return initials || "O";
}

/* ── LinkedIn pivot (Phase-0 primary identity anchor) ──────────────────────
   Shared by the client (Send One gate) and the server (/api/one/research
   sanitize). No React/Next deps so both can import it. */

/** Canonicalize a user-pasted LinkedIn personal-profile URL.
 *  Accepts with/without protocol, any linkedin.com host (www., in., uk., …),
 *  a `/in/<handle>` path, and trailing slash / query / hash. Returns the
 *  canonical `https://www.linkedin.com/in/<handle>` or "" when it isn't a
 *  valid LinkedIn personal profile. */
export function normalizeLinkedInUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  // exact linkedin.com or any subdomain of it (www., in., uk., …)
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return "";
  // personal profile path only: /in/<handle>
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
  if (!match) return "";
  const handle = match[1].replace(/\/+$/, "");
  if (!handle) return "";
  return `https://www.linkedin.com/in/${handle}`;
}

/** True when `value` is a recognizable LinkedIn personal-profile URL. */
export function isLinkedInUrl(value: unknown): boolean {
  return !!normalizeLinkedInUrl(value);
}

/** Extract the (decoded) vanity handle from a LinkedIn profile URL, or "". */
export function linkedinHandleFromUrl(value: unknown): string {
  const normalized = normalizeLinkedInUrl(value);
  if (!normalized) return "";
  const handle = normalized.slice("https://www.linkedin.com/in/".length);
  try {
    return decodeURIComponent(handle);
  } catch {
    return handle;
  }
}

const INSTAGRAM_RESERVED_SEGMENTS = new Set([
  "about",
  "accounts",
  "api",
  "challenge",
  "developer",
  "direct",
  "explore",
  "oauth",
  "p",
  "reel",
  "reels",
  "stories",
  "tv",
]);

/** Canonicalize a user-pasted Instagram profile URL.
 *  Accepts instagram.com/www.instagram.com/m.instagram.com direct profile paths only.
 *  Rejects posts, reels, stories, explore, login, and app-internal routes. */
export function normalizeInstagramUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com" && host !== "m.instagram.com") return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  const username = parts[0].trim();
  if (!username || INSTAGRAM_RESERVED_SEGMENTS.has(username.toLowerCase())) return "";
  if (!/^[a-z0-9._]{1,30}$/i.test(username)) return "";
  if (username.startsWith(".") || username.endsWith(".") || username.includes("..")) return "";
  return `https://www.instagram.com/${username.toLowerCase()}/`;
}

export function isInstagramUrl(value: unknown): boolean {
  return !!normalizeInstagramUrl(value);
}

export function instagramHandleFromUrl(value: unknown): string {
  const normalized = normalizeInstagramUrl(value);
  if (!normalized) return "";
  return new URL(normalized).pathname.split("/").filter(Boolean)[0] || "";
}

const THREADS_RESERVED_SEGMENTS = new Set([
  "about",
  "activity",
  "api",
  "challenge",
  "developer",
  "explore",
  "feed",
  "help",
  "login",
  "oauth",
  "post",
  "privacy",
  "search",
  "settings",
  "signup",
  "terms",
]);

/** Canonicalize a user-pasted Threads profile URL.
 *  Accepts threads.com/www.threads.com direct `@username` profile paths only.
 *  Rejects posts, login, search, internal routes, and non-profile paths. */
export function normalizeThreadsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProto);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  if (host !== "threads.com" && host !== "www.threads.com" && host !== "threads.net" && host !== "www.threads.net") return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  const segment = parts[0].trim();
  if (!segment.startsWith("@")) return "";
  const username = segment.slice(1);
  if (!username || THREADS_RESERVED_SEGMENTS.has(username.toLowerCase())) return "";
  if (!/^[a-z0-9._]{1,30}$/i.test(username)) return "";
  if (username.startsWith(".") || username.endsWith(".") || username.includes("..")) return "";
  return `https://www.threads.com/@${username.toLowerCase()}`;
}

export function isThreadsUrl(value: unknown): boolean {
  return !!normalizeThreadsUrl(value);
}

export function threadsHandleFromUrl(value: unknown): string {
  const normalized = normalizeThreadsUrl(value);
  if (!normalized) return "";
  return (new URL(normalized).pathname.split("/").filter(Boolean)[0] || "").replace(/^@/, "");
}
