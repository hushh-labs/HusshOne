import { afterEach, describe, expect, it, vi } from "vitest";
import { reportScraperSession, reportScraperReadiness } from "./session-signal";

/* The alerting contract for scraper sessions. These assertions are what keep the alert honest: it must fire
   on states that mean "the VM session is unusable" and stay silent on states that merely describe the
   TARGET account — the latter are normal scrape outcomes and paging on them would recreate the false-alarm
   problem this signal exists to replace. */

function captured(fn: () => void): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const grab = (line: unknown) => {
    out.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  const err = vi.spyOn(console, "error").mockImplementation(grab);
  const warn = vi.spyOn(console, "warn").mockImplementation(grab);
  try {
    fn();
  } finally {
    err.mockRestore();
    warn.mockRestore();
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("reportScraperSession", () => {
  it("logged-out session → ERROR, needsHuman (someone must log the VM browser back in)", () => {
    let reported = false;
    const logs = captured(() => {
      reported = reportScraperSession({ platform: "instagram", accessState: "login_required", publicId: "acme", scanRunId: "scan-1" });
    });
    expect(reported).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "one.scraper.session_blocked",
      severity: "ERROR",
      platform: "instagram",
      accessState: "login_required",
      needsHuman: true,
      publicId: "acme",
      scanRunId: "scan-1",
    });
  });

  it("checkpoint (2FA/CAPTCHA) also needs a human", () => {
    const logs = captured(() => reportScraperSession({ platform: "x", accessState: "checkpoint_required" }));
    expect(logs[0]).toMatchObject({ severity: "ERROR", needsHuman: true, platform: "x" });
  });

  it("rate limit / block → WARNING, self-clearing, must not page", () => {
    const logs = captured(() => {
      reportScraperSession({ platform: "threads", accessState: "rate_limited" });
      reportScraperSession({ platform: "linkedin", accessState: "blocked" });
    });
    expect(logs.map((l) => l.severity)).toEqual(["WARNING", "WARNING"]);
    expect(logs.every((l) => l.needsHuman === false)).toBe(true);
  });

  it("silent for healthy scrapes and for target-side outcomes", () => {
    const targetStates = ["public_visible", "approved_visible", "private_not_following", "follow_requested", "pending_approval", "not_found"];
    let reported: boolean[] = [];
    const logs = captured(() => {
      reported = targetStates.map((accessState) => reportScraperSession({ platform: "instagram", accessState }));
    });
    expect(logs).toHaveLength(0);
    expect(reported.every((r) => r === false)).toBe(true);
  });

  it("silent when the scraper reported no access state at all", () => {
    const logs = captured(() => {
      expect(reportScraperSession({ platform: "instagram", accessState: null })).toBe(false);
      expect(reportScraperSession({ platform: "instagram", accessState: undefined })).toBe(false);
      expect(reportScraperSession({ platform: "instagram", accessState: "" })).toBe(false);
    });
    expect(logs).toHaveLength(0);
  });

  it("tags the producer so real user impact is distinguishable from the idle canary", () => {
    const logs = captured(() => reportScraperSession({ platform: "instagram", accessState: "login_required" }));
    expect(logs[0].source).toBe("real_scrape");
  });
});

describe("reportScraperReadiness (idle canary)", () => {
  it("fires only on requiresHumanLogin — the one actionable readiness outcome", () => {
    const logs = captured(() => {
      expect(reportScraperReadiness({ platform: "instagram", requiresHumanLogin: true })).toBe(true);
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "one.scraper.session_blocked",
      severity: "ERROR",
      platform: "instagram",
      needsHuman: true,
      source: "readiness_probe",
    });
  });

  it("stays silent when the session is fine (this is what killed the old 10-minute false alarm)", () => {
    const logs = captured(() => {
      expect(reportScraperReadiness({ platform: "instagram", requiresHumanLogin: false })).toBe(false);
    });
    expect(logs).toHaveLength(0);
  });
});
