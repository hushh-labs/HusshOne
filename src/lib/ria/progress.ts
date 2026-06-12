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
   Tuned to the real Deep Research distribution (Phase-1 fast realistically ~14–20 min,
   long tail higher) so the eased bar advances across the whole wait instead of pegging at
   ~92% after a few min. The honest signal remains the mm:ss elapsed shown alongside. */
export const SHADOW_ESTIMATED_MS = 1_080_000;

/** A ScanRun that has been "running" longer than this is unrecoverable: it is well past
   the 900s hard wall (Cloud Run + maxDuration) PLUS a generous recovery grace, and beyond
   the client's own 30-min recovery poll. At that point the upstream Deep Research job is
   dead/abandoned and the row will never finalize on its own. Read paths auto-fail such rows
   (self-heal) and the client refuses to resume their progress screen — without this a row
   can sit "running" for hours and the client re-seeds the elapsed timer from createdAt on
   every login, producing the eternal "composing your report" screen (observed: 1358:09 / 92%). */
export const STALE_RUNNING_MS = 60 * 60 * 1000; // 60 min

/** True when a scan is "running" but older than the staleness ceiling → treat as failed. */
export function isStaleRunning(
  status: string | null | undefined,
  createdAtMs: number,
  now: number = Date.now(),
): boolean {
  return status === "running" && Number.isFinite(createdAtMs) && createdAtMs > 0 && now - createdAtMs > STALE_RUNNING_MS;
}

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

/* ── One-voiced live progress ──────────────────────────────────────────────
   The Deep Research backend streams a real progress/thought summary (dr.progress).
   To keep the wait interactive AND on-brand, we present it as One DOING the work
   ("One is reading LinkedIn…") rather than a raw model log. The mapping is curated
   + deterministic: we detect the strongest signal in the real text and phrase it as
   One; when there's no signal yet we fall back to the current phase line. */

/** Phase lines phrased as One acting — index-aligned with SHADOW_PHASES. */
export const ONE_PHASE_LINES = [
  "One is searching the public web",
  "One is reading what it finds",
  "One is sharpening the search",
  "One is cross-checking with expert models",
  "One is resolving conflicts",
  "One is composing your report",
] as const;

/** Pull a clean, non-platform domain out of raw progress text, if present. */
function domainFrom(raw: string): string | null {
  const m =
    raw.match(/https?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i) ||
    raw.match(/\b(?:www\.)?([a-z0-9-]+\.(?:com|org|net|io|ai|co|edu|gov|dev|in|me))\b/i);
  if (!m) return null;
  const d = m[1].toLowerCase().replace(/^www\./, "");
  if (/google|gstatic|schema\.org|w3\.org|example\.com|vertexaisearch/.test(d)) return null;
  return d;
}

/** Map the strongest signal in a raw progress string to a One-voiced action (no ellipsis). */
function oneActionFrom(raw: string): string | null {
  const s = raw.toLowerCase();
  if (/\bcompos|synthes|draft|writing (the |your )?report|final report/.test(s)) return "One is composing your report";
  if (/cross[- ]?check|verif|conflict|disambig|reconcil|corroborat|confidence/.test(s)) return "One is cross-checking sources";
  if (/linkedin/.test(s)) return "One is reading LinkedIn";
  if (/github|gitlab|stack ?overflow|repositor|\brepo\b|open[- ]?source|\bnpm\b|pypi|kaggle/.test(s)) return "One is reading code & projects";
  if (/news|newspaper|article|press|\bmedia\b|interview/.test(s)) return "One is reading news & media";
  if (/government|public record|registr|gazette|\bcourt\b/.test(s)) return "One is checking public records";
  if (/twitter|\bx\.com\b|instagram|facebook|reddit|\bsocial\b/.test(s)) return "One is checking social profiles";
  const d = domainFrom(raw);
  if (d) return `One is reading ${d}`;
  if (/search|discover|querie|query|grounding|browsing|looking|gathering/.test(s)) return "One is searching the public web";
  if (/read|analy|extract|review|examin/.test(s)) return "One is reading what it finds";
  return null;
}

/** Turn the real DR progress (or, if absent, the current phase) into a One-voiced
   sentence with a trailing ellipsis, e.g. "One is reading LinkedIn…". */
export function oneVoiceProgress(raw: string | null | undefined, phaseIndex: number): string {
  const action = raw ? oneActionFrom(raw) : null;
  if (action) return `${action}…`;
  const idx = Math.min(Math.max(0, phaseIndex), ONE_PHASE_LINES.length - 1);
  return `${ONE_PHASE_LINES[idx]}…`;
}

/** One-voiced fallback when no live label is available (e.g. during recovery polling):
   cycles the source categories as One checking them, e.g. "One is checking GitHub…". */
export function oneVoiceScanningAt(elapsedMs: number): string {
  return `One is checking ${scanningSourceAt(elapsedMs)}…`;
}
