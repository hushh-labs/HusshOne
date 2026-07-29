/* Cost guardrails for Local Discovery — the money side of the reliability story. Nothing on the paid path
   (Google Places, geocoding, grounded web) may run without clearing these gates:

     • a hard DAILY budget cap (env, safe default) enforced against a running spend ledger,
     • a PER-REQUEST paid-call cap so a single search can never fan out unbounded,
     • spend recording + threshold alerts (50/80/100%) written to the structured log.

   Scope note (Phase 1): the ledger lives on `globalThis`, so it is per-instance and resets on cold start.
   That is deliberately conservative — a cap that only counts one instance's spend under-counts fleet spend,
   so the per-instance cap is set well below the intended fleet ceiling. Phase 2 backs this with a shared
   store (directories DB row or Memorystore) for a true cross-instance ledger. There is intentionally NO
   background job here — per the pivot rule, no uncapped background API work is permitted. */

/** Per-call cost estimates (USD). Sourced from the hotel-scraper Places pricing (config.mjs) plus rough
 *  estimates for the other providers. Used to pre-check the budget before a paid call. */
export const PROVIDER_COST_USD: Readonly<Record<string, number>> = {
  // Google Places (New) — Text Search billed at the highest SKU in the field mask (~Pro).
  google_places_search: 0.035,
  // Place Details fetched with an IDs-only mask (photo resource names) is free; keep a tiny nonzero
  // guard so it still counts against the per-request call cap.
  google_places_details: 0,
  // Place Photo media — view-time only, never on the search path. Listed for the view route's tracker.
  google_places_photo: 0.007,
  // Forward/reverse geocoding (postal → coords / coords → locality).
  geocoding: 0.005,
  // Vertex Gemini grounded-web enrichment (rough per-call estimate).
  grounded_web: 0.01,
};

export interface SpendConfig {
  /** Hard daily ceiling (USD) for ALL Local Discovery paid calls on this instance. */
  dailyBudgetUsd: number;
  /** Max paid provider calls a single /search request may make (across all adapters). */
  perRequestPaidCallCap: number;
  /** Alert fractions of the daily budget; each fires at most once per UTC day. */
  alertThresholds: number[];
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Read the live config from env each call so ops can retune without a redeploy of this module's callers. */
export function getSpendConfig(): SpendConfig {
  return {
    // Conservative per-instance default; raise via env once paid APIs are provisioned + observed.
    dailyBudgetUsd: numEnv("LOCAL_DISCOVERY_DAILY_BUDGET_USD", 25),
    perRequestPaidCallCap: Math.max(0, Math.floor(numEnv("LOCAL_DISCOVERY_MAX_PAID_CALLS_PER_REQUEST", 6))),
    alertThresholds: [0.5, 0.8, 1.0],
  };
}

interface DayLedger {
  day: string; // YYYY-MM-DD (UTC)
  totalUsd: number;
  calls: number;
  byProvider: Record<string, { usd: number; calls: number }>;
  alertsFired: number[]; // thresholds already logged today
}

interface SpendGlobal {
  ledger: DayLedger | null;
}

const g = globalThis as typeof globalThis & { __oneLdSpend?: SpendGlobal };
function store(): SpendGlobal {
  if (!g.__oneLdSpend) g.__oneLdSpend = { ledger: null };
  return g.__oneLdSpend;
}

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Return today's ledger, rolling over (and resetting alerts) at UTC midnight. */
function currentLedger(now = Date.now()): DayLedger {
  const s = store();
  const day = utcDay(now);
  if (!s.ledger || s.ledger.day !== day) {
    s.ledger = { day, totalUsd: 0, calls: 0, byProvider: {}, alertsFired: [] };
  }
  return s.ledger;
}

export function estimateCost(provider: string, calls = 1): number {
  const unit = PROVIDER_COST_USD[provider] ?? 0;
  return unit * Math.max(0, calls);
}

export function spentTodayUsd(): number {
  return currentLedger().totalUsd;
}

export function remainingBudgetUsd(): number {
  const { dailyBudgetUsd } = getSpendConfig();
  return Math.max(0, dailyBudgetUsd - currentLedger().totalUsd);
}

/** True when there is budget headroom for an estimated spend (the daily-cap gate). */
export function canAfford(estimatedUsd: number): boolean {
  return remainingBudgetUsd() >= estimatedUsd;
}

/** Record a completed paid call and fire budget alerts as thresholds are crossed. */
export function recordSpend(provider: string, usd: number, calls = 1): void {
  const led = currentLedger();
  led.totalUsd += Math.max(0, usd);
  led.calls += Math.max(0, calls);
  const p = (led.byProvider[provider] ??= { usd: 0, calls: 0 });
  p.usd += Math.max(0, usd);
  p.calls += Math.max(0, calls);

  const { dailyBudgetUsd, alertThresholds } = getSpendConfig();
  if (dailyBudgetUsd <= 0) return;
  const frac = led.totalUsd / dailyBudgetUsd;
  for (const t of alertThresholds) {
    if (frac >= t && !led.alertsFired.includes(t)) {
      led.alertsFired.push(t);
      // Structured line for Cloud Logging alerting.
      console.warn(
        `one.local-discovery.spend alert=${Math.round(t * 100)}% ` +
          `spent=$${led.totalUsd.toFixed(3)} budget=$${dailyBudgetUsd} day=${led.day}`,
      );
    }
  }
}

/** Snapshot of today's spend for the /search response + observability. */
export function spendSnapshot(): {
  day: string;
  totalUsd: number;
  calls: number;
  budgetUsd: number;
  remainingUsd: number;
  byProvider: Record<string, { usd: number; calls: number }>;
} {
  const led = currentLedger();
  const { dailyBudgetUsd } = getSpendConfig();
  return {
    day: led.day,
    totalUsd: Number(led.totalUsd.toFixed(4)),
    calls: led.calls,
    budgetUsd: dailyBudgetUsd,
    remainingUsd: Number(Math.max(0, dailyBudgetUsd - led.totalUsd).toFixed(4)),
    byProvider: led.byProvider,
  };
}

/** Per-request spend gate. One instance is created per /search; it enforces the per-request paid-call cap
 *  AND consults the shared daily ledger, so an adapter asks it (not the ledger) before every paid call. */
export class RequestBudget {
  private paidCalls = 0;
  private readonly cap: number;

  constructor(cap = getSpendConfig().perRequestPaidCallCap) {
    this.cap = cap;
  }

  /** Whether a paid call estimated at `estimatedUsd` may proceed (per-request cap AND daily budget). */
  canSpend(estimatedUsd: number): boolean {
    if (this.paidCalls >= this.cap) return false;
    return canAfford(estimatedUsd);
  }

  /** How many paid calls remain for this request. */
  get remainingCalls(): number {
    return Math.max(0, this.cap - this.paidCalls);
  }

  /** Record an actually-made paid call against both this request and the daily ledger. */
  spend(provider: string, usd: number, calls = 1): void {
    this.paidCalls += calls;
    recordSpend(provider, usd, calls);
  }
}

/** TEST-ONLY: clear the in-memory ledger so suites start from zero spend. */
export function __resetSpendLedgerForTests(): void {
  store().ledger = null;
}
