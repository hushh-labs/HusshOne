const RESERVED_SEGMENTS = new Set([
  "about",
  "account",
  "api",
  "compose",
  "developer",
  "explore",
  "hashtag",
  "help",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "logout",
  "messages",
  "notifications",
  "oauth",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
]);

const ACCEPTED_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export const DEFAULT_PROFILE_URL = "https://x.com/sundarpichai";

export function normalizeTwitterProfileUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    return "";
  }

  if (!ACCEPTED_HOSTS.has(url.hostname.toLowerCase())) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";

  const handle = decodeURIComponent(parts[0] || "").replace(/^@/, "").trim();
  if (!handle || RESERVED_SEGMENTS.has(handle.toLowerCase())) return "";
  if (!/^[a-z0-9_]{1,15}$/i.test(handle)) return "";
  return `https://x.com/${handle.toLowerCase()}`;
}

export function twitterUsernameFromUrl(value) {
  const normalized = normalizeTwitterProfileUrl(value);
  if (!normalized) return "";
  return new URL(normalized).pathname.split("/").filter(Boolean)[0] || "";
}

export function usernameToUrl(username) {
  const raw = String(username || "").trim();
  const normalized = normalizeTwitterProfileUrl(raw);
  if (normalized) return normalized;
  const handle = raw.replace(/^@/, "");
  if (!handle) return "";
  return normalizeTwitterProfileUrl(`https://x.com/${handle}`);
}

export function parseProfileArg(argv = process.argv.slice(2)) {
  const explicitUrl = readFlag(argv, "--url") || process.env.TWITTER_PROFILE_URL;
  const explicitUsername = readFlag(argv, "--username") || process.env.TWITTER_USERNAME;
  const positional = argv.find((arg) => !arg.startsWith("--"));
  const candidate = explicitUrl || explicitUsername || positional || DEFAULT_PROFILE_URL;
  const url = usernameToUrl(candidate);
  const username = twitterUsernameFromUrl(url);
  if (!url || !username) {
    throw new Error(`Expected a Twitter/X profile URL or username, got: ${candidate}`);
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
