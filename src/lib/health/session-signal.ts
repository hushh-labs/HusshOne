/* The scraper-session signal that comes from REAL traffic.

   Each scraper VM holds a logged-in browser session. That session is a credential: it expires on the
   platform's schedule (logout, checkpoint, 2FA, IP-based rate limiting), silently, whether or not anyone
   is watching — and recovering it needs a HUMAN at a VNC browser, not a restart.

   Synthetic polling is a poor detector for that: it is expensive (each probe drives a live browser
   inspection), it mostly reports liveness (which never changes — the VMs are non-preemptible and stay up
   for months), and a "VM reachable" verdict says nothing about whether the next real scrape will succeed.

   So the authoritative signal is emitted here, from the outcome of actual scrapes. When a real scrape comes
   back reporting that the session could not read the page, we log a structured event. Cloud Logging turns
   that into a metric and alerts on it. Every alert is therefore real, user-affecting, and actionable —
   there is no synthetic traffic and no false positive class.

   Paired with the slow readiness sweep in @/lib/health/checks, which exists only to catch decay during
   idle periods when no real scrape has run to produce this signal. */

/** Access states that mean the VM's session could not read the target — as opposed to states that describe
 *  the TARGET (private, not-found, pending follow approval), which are normal outcomes and never alert. */
const SESSION_FAULT_STATES = new Set(["login_required", "checkpoint_required", "rate_limited", "blocked"]);

/** Faults only a human can clear: someone must open the VM browser and complete login / 2FA / CAPTCHA. */
const NEEDS_HUMAN_STATES = new Set(["login_required", "checkpoint_required"]);

/** Which producer observed the fault. Both feed one alert — what matters is that a human is needed, not
 *  which code path noticed. `real_scrape` is the primary signal; `readiness_probe` only covers idle periods
 *  where no real scrape has run recently enough to surface the problem. */
export type SessionSignalSource = "real_scrape" | "readiness_probe";

export interface ScraperSessionSignal {
  platform: string;
  accessState: string | null | undefined;
  publicId?: string | null;
  scanRunId?: string | null;
}

/**
 * Emit `one.scraper.session_blocked` when a real scrape reveals an unusable VM session.
 *
 * No-op for healthy scrapes and for target-side outcomes (private / not_found / pending), so this stays
 * silent in normal operation and fires only when a user actually hit a wall.
 *
 * @returns true if a fault was reported (exposed for tests and callers that want to react).
 */
export function reportScraperSession({ platform, accessState, publicId, scanRunId }: ScraperSessionSignal): boolean {
  if (!accessState || !SESSION_FAULT_STATES.has(accessState)) return false;

  const needsHuman = NEEDS_HUMAN_STATES.has(accessState);
  emit({
    platform,
    accessState,
    needsHuman,
    source: "real_scrape",
    publicId: publicId ?? null,
    scanRunId: scanRunId ?? null,
  });
  return true;
}

/**
 * Emit the same fault from the slow readiness sweep, for the idle case: nobody has scanned recently, so no
 * real scrape exists to reveal that the session has quietly expired. Fires only on `requiresHumanLogin` —
 * never on unreachability or slowness, which are not actionable and were the old alert's false-alarm source.
 */
export function reportScraperReadiness({ platform, requiresHumanLogin }: { platform: string; requiresHumanLogin: boolean }): boolean {
  if (!requiresHumanLogin) return false;
  emit({ platform, accessState: "login_required", needsHuman: true, source: "readiness_probe", publicId: null, scanRunId: null });
  return true;
}

function emit(fields: {
  platform: string;
  accessState: string;
  needsHuman: boolean;
  source: SessionSignalSource;
  publicId: string | null;
  scanRunId: string | null;
}): void {
  // needsHuman true → a human must log the VM browser back in; false → transient (rate limit / block),
  // self-clears after the VM's cooldown. The alert keys on needsHuman, so transients stay silent.
  console[fields.needsHuman ? "error" : "warn"](
    JSON.stringify({ event: "one.scraper.session_blocked", severity: fields.needsHuman ? "ERROR" : "WARNING", ...fields }),
  );
}
