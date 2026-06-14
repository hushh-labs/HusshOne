export const DEFAULT_PROFILE_URL = "https://www.linkedin.com/in/ankit-kumar-886428288/";

export function normalizeLinkedInProfileUrl(value) {
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
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return "";
  const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
  if (!match) return "";
  return `https://www.linkedin.com/in/${match[1]}/`;
}

export function profileIdFromUrl(value) {
  const normalized = normalizeLinkedInProfileUrl(value);
  if (!normalized) return "";
  const url = new URL(normalized);
  const id = url.pathname.match(/^\/in\/([^/]+)\/?$/i)?.[1] || "";
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function profileIdToUrl(profileId) {
  const id = String(profileId || "").trim().replace(/^\/+|\/+$/g, "");
  if (!id) return "";
  if (/linkedin\.com/i.test(id)) return normalizeLinkedInProfileUrl(id);
  return `https://www.linkedin.com/in/${encodeURIComponent(id)}/`;
}

export function parseProfileArg(argv = process.argv.slice(2)) {
  const explicitUrl = readFlag(argv, "--url") || process.env.LINKEDIN_PROFILE_URL;
  const explicitId = readFlag(argv, "--id") || process.env.LINKEDIN_PROFILE_ID;
  const positional = argv.find((arg) => !arg.startsWith("--"));
  const candidate = explicitUrl || explicitId || positional || DEFAULT_PROFILE_URL;
  const url = profileIdToUrl(candidate);
  const id = profileIdFromUrl(url);
  if (!url || !id) {
    throw new Error(`Expected a LinkedIn personal profile URL or id, got: ${candidate}`);
  }
  return { id, url };
}

export function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : "";
}
