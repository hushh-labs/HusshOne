/* Shared between the streaming route (heartbeat stage hints) and the client
   wait-state stepper. These phases mirror the Hushh Shadow pipeline order in
   docs/HUSHH_SHADOW_ENSEMBLE_CONTRACT.md. Because Shadow returns atomically,
   per-phase *timing* is an estimate — the phases genuinely run in this order. */

export const SHADOW_PHASES = [
  "Searching the public web",
  "Reading what it finds",
  "Sharpening the search",
  "Cross-checking with four expert models",
  "Resolving conflicts",
  "Composing your report",
] as const;

/** Estimated typical run used only to pace the UI; the real result governs completion. */
export const SHADOW_ESTIMATED_MS = 95_000;

export function shadowPhaseIndex(elapsedMs: number) {
  const frac = Math.min(0.999, Math.max(0, elapsedMs) / SHADOW_ESTIMATED_MS);
  return Math.min(SHADOW_PHASES.length - 1, Math.floor(frac * SHADOW_PHASES.length));
}
