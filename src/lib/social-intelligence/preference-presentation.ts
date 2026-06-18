/* Client-safe presentation helpers for the preference layer.
 *
 * IMPORTANT: keep this module free of server-only imports (no `node:crypto`, no Vertex/DB code). It is
 * imported by the client component `OneExperience.tsx` AS WELL AS server code, so the headline copy lives
 * in exactly one place and any tweak ships instantly to every user at render time — no re-synthesis, no
 * version bump. (preference-synthesis.ts / preference-profile.ts pull in `node:crypto`; importing those
 * into the client bundle would break the build — that's why these pure helpers live on their own.) */

/** Human-readable single platform name ("x" → "X", "instagram" → "Instagram"). */
export function prettyPlatform(platform: string): string {
  const s = (platform ?? "").trim();
  if (!s) return s;
  if (s.toLowerCase() === "x") return "X";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Instagram, Threads and X" — warm, human-readable platform list (not a scrape dump). */
export function prettyPlatformList(platforms: string[]): string {
  const names = [...new Set((platforms ?? []).map(prettyPlatform).filter(Boolean))];
  if (!names.length) return "your socials";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The preference-layer headline. Pure function of coverage + platforms, so it is computed at RENDER
 *  time (client) and also stored on the profile (for email / API consumers) from the same source. */
export function buildPreferenceSummary(input: { answeredTotal: number; total: number; platforms: string[] }): string {
  return `One has a read on ${input.answeredTotal} of ${input.total} sides of your taste — drawn from how you show up across ${prettyPlatformList(input.platforms)}.`;
}
