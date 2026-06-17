/* Intelligence-layer version.
   BUMP this whenever the intelligence changes — Phase-1 prompt, Phase-2
   synthesis, social preference intelligence, or progressive dashboard layer
   behavior. Every completed scan is stamped with this value; on load, a
   recovered scan whose stamp !== this is treated as stale and the user is routed
   back to the social/profile intake screen to re-run on the new intelligence.
   See .claude/skills/intelligence-release. */
export const INTELLIGENCE_VERSION = "2026-06-17-social-preference-progressive";
