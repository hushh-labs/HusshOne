/* Intelligence-layer version.
   BUMP this whenever the intelligence changes — the Phase-1 prompt
   (src/lib/research/dossier.ts) or the Phase-2 synthesis (the external
   hushh-deep-research-api service). Every completed scan is stamped with this
   value; on load, a recovered scan whose stamp !== this is treated as stale and
   the user is routed back to the "Send One" screen to re-run on the new
   intelligence (so an improved layer always reaches users — they can't be stuck
   on a cached old report). See .claude/skills/intelligence-release. */
export const INTELLIGENCE_VERSION = "2026-06-09";
