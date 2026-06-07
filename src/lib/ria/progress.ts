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

/** Estimated typical run used only to pace the UI; the real result governs completion.
   Tuned to the real Shadow p50 (~3.5 min) so the bar advances across the whole
   wait instead of freezing at ~92% after 95s. */
export const SHADOW_ESTIMATED_MS = 210_000;

export function shadowPhaseIndex(elapsedMs: number) {
  const frac = Math.min(0.999, Math.max(0, elapsedMs) / SHADOW_ESTIMATED_MS);
  return Math.min(SHADOW_PHASES.length - 1, Math.floor(frac * SHADOW_PHASES.length));
}

/** Source categories Shadow checks — drives the live "what's being scanned" feed.
   Mirrors the canvas chips in CanvasField. */
export const SCAN_SOURCE_SEQUENCE = [
  "LinkedIn",
  "GitHub",
  "Google & the open web",
  "news & media",
  "public records",
  "X / social",
  "company & team pages",
  "publications & mentions",
] as const;

/** Curated "currently checking" label cycled over the estimated run. Honest about
   the source CATEGORIES being checked; superseded by real per-source events once
   the upstream streams (see docs/RIA_SHADOW_STREAMING_SPEC.md). */
export function scanningSourceAt(elapsedMs: number) {
  const step = 13_000; // advance ~every 13s
  const i = Math.floor(Math.max(0, elapsedMs) / step) % SCAN_SOURCE_SEQUENCE.length;
  return SCAN_SOURCE_SEQUENCE[i];
}
