const RESERVED_SEGMENTS = new Set([
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

export const DEFAULT_PROFILE_URL = "https://www.threads.com/@threads";

export function normalizeThreadsProfileUrl(value) {
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
  if (host !== "threads.com" && host !== "www.threads.com" && host !== "threads.net" && host !== "www.threads.net") {
    return "";
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 1) return "";
  const segment = parts[0].trim();
  if (!segment.startsWith("@")) return "";
  const username = segment.slice(1);
  if (!username || RESERVED_SEGMENTS.has(username.toLowerCase())) return "";
  if (!/^[a-z0-9._]{1,30}$/i.test(username)) return "";
  if (username.startsWith(".") || username.endsWith(".") || username.includes("..")) return "";
  return `https://www.threads.com/@${username.toLowerCase()}`;
}

export function threadsUsernameFromUrl(value) {
  const normalized = normalizeThreadsProfileUrl(value);
  if (!normalized) return "";
  const segment = new URL(normalized).pathname.split("/").filter(Boolean)[0] || "";
  return segment.replace(/^@/, "");
}

export function usernameToUrl(username) {
  const raw = String(username || "").trim().replace(/^@/, "");
  if (!raw) return "";
  return normalizeThreadsProfileUrl(`https://www.threads.com/@${raw}`);
}

export function parseProfileArg(argv = process.argv.slice(2)) {
  const explicitUrl = readFlag(argv, "--url") || process.env.THREADS_PROFILE_URL;
  const explicitUsername = readFlag(argv, "--username") || process.env.THREADS_USERNAME;
  const positional = argv.find((arg) => !arg.startsWith("--"));
  const candidate = explicitUrl || explicitUsername || positional || DEFAULT_PROFILE_URL;
  const url = usernameToUrl(candidate);
  const username = threadsUsernameFromUrl(url);
  if (!url || !username) {
    throw new Error(`Expected a Threads profile URL or username, got: ${candidate}`);
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
