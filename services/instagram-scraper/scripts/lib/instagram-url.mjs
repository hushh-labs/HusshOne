const RESERVED_SEGMENTS = new Set([
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

export const DEFAULT_PROFILE_URL = "https://www.instagram.com/ankit_ya_i_am/";

export function normalizeInstagramProfileUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    return "";
  }
  const host = url.hostname.toLowerCase();
  if (host !== "instagram.com" && host !== "www.instagram.com" && host !== "m.instagram.com") return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  const username = parts[0].trim();
  if (!username || RESERVED_SEGMENTS.has(username.toLowerCase())) return "";
  if (!/^[a-z0-9._]{1,30}$/i.test(username)) return "";
  if (username.startsWith(".") || username.endsWith(".") || username.includes("..")) return "";
  return `https://www.instagram.com/${username.toLowerCase()}/`;
}

export function instagramUsernameFromUrl(value) {
  const normalized = normalizeInstagramProfileUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  return url.pathname.split("/").filter(Boolean)[0] || "";
}

export function usernameToUrl(username) {
  const raw = String(username || "").trim().replace(/^@/, "");
  if (!raw) return "";
  return normalizeInstagramProfileUrl(`https://www.instagram.com/${raw}/`);
}

export function parseProfileArg(argv = process.argv.slice(2)) {
  const explicitUrl = readFlag(argv, "--url") || process.env.INSTAGRAM_PROFILE_URL;
  const explicitUsername = readFlag(argv, "--username") || process.env.INSTAGRAM_USERNAME;
  const positional = argv.find((arg) => !arg.startsWith("--"));
  const candidate = explicitUrl || explicitUsername || positional || DEFAULT_PROFILE_URL;
  const url = usernameToUrl(candidate);
  const username = instagramUsernameFromUrl(url);
  if (!url || !username) {
    throw new Error(`Expected an Instagram profile URL or username, got: ${candidate}`);
  }
  return { username, url };
}

export function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : "";
}
