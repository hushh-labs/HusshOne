import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RequestBudget,
  __resetSpendLedgerForTests,
  canAfford,
  estimateCost,
  getSpendConfig,
  recordSpend,
  remainingBudgetUsd,
  spendSnapshot,
  spentTodayUsd,
} from "./spend";

const ENV_KEYS = ["LOCAL_DISCOVERY_DAILY_BUDGET_USD", "LOCAL_DISCOVERY_MAX_PAID_CALLS_PER_REQUEST"] as const;

describe("local-discovery/spend", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    __resetSpendLedgerForTests();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it("reads config from env with safe defaults", () => {
    expect(getSpendConfig().dailyBudgetUsd).toBe(25);
    expect(getSpendConfig().perRequestPaidCallCap).toBe(6);
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "100";
    process.env.LOCAL_DISCOVERY_MAX_PAID_CALLS_PER_REQUEST = "3";
    expect(getSpendConfig().dailyBudgetUsd).toBe(100);
    expect(getSpendConfig().perRequestPaidCallCap).toBe(3);
  });

  it("ignores invalid/negative env and keeps the default", () => {
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "not-a-number";
    expect(getSpendConfig().dailyBudgetUsd).toBe(25);
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "-5";
    expect(getSpendConfig().dailyBudgetUsd).toBe(25);
  });

  it("estimates cost from the provider table", () => {
    expect(estimateCost("google_places_search", 3)).toBeCloseTo(0.105, 5);
    expect(estimateCost("unknown_provider", 10)).toBe(0);
  });

  it("records spend and tracks remaining budget against the daily cap", () => {
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "1";
    expect(spentTodayUsd()).toBe(0);
    expect(remainingBudgetUsd()).toBe(1);
    recordSpend("google_places_search", 0.035, 1);
    expect(spentTodayUsd()).toBeCloseTo(0.035, 5);
    expect(remainingBudgetUsd()).toBeCloseTo(0.965, 5);
  });

  it("canAfford reflects the remaining daily budget", () => {
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "0.05";
    expect(canAfford(0.035)).toBe(true);
    recordSpend("google_places_search", 0.035);
    expect(canAfford(0.035)).toBe(false);
    expect(canAfford(0.01)).toBe(true);
  });

  it("fires budget alerts once per threshold as spend crosses 50/80/100%", () => {
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordSpend("google_places_search", 0.5); // 50%
    recordSpend("google_places_search", 0.3); // 80%
    recordSpend("google_places_search", 0.3); // 110% -> 100%
    recordSpend("google_places_search", 0.3); // no new threshold
    const alertLines = warn.mock.calls.filter((c) => String(c[0]).includes("spend alert="));
    expect(alertLines).toHaveLength(3);
  });

  describe("RequestBudget", () => {
    it("enforces the per-request paid-call cap independent of daily budget", () => {
      process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "1000";
      const rb = new RequestBudget(2);
      expect(rb.remainingCalls).toBe(2);
      expect(rb.canSpend(0.035)).toBe(true);
      rb.spend("google_places_search", 0.035);
      rb.spend("google_places_search", 0.035);
      expect(rb.remainingCalls).toBe(0);
      expect(rb.canSpend(0.035)).toBe(false); // capped even though budget remains
    });

    it("refuses to spend when the daily budget is exhausted even if call-cap remains", () => {
      process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "0.02";
      const rb = new RequestBudget(10);
      expect(rb.canSpend(0.035)).toBe(false);
    });

    it("its spend counts toward the shared daily ledger", () => {
      process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "5";
      const rb = new RequestBudget(6);
      rb.spend("google_places_search", 0.035);
      expect(spentTodayUsd()).toBeCloseTo(0.035, 5);
    });
  });

  it("exposes a spend snapshot with per-provider breakdown", () => {
    process.env.LOCAL_DISCOVERY_DAILY_BUDGET_USD = "10";
    recordSpend("google_places_search", 0.07, 2);
    recordSpend("geocoding", 0.005, 1);
    const snap = spendSnapshot();
    expect(snap.calls).toBe(3);
    expect(snap.totalUsd).toBeCloseTo(0.075, 5);
    expect(snap.budgetUsd).toBe(10);
    expect(snap.remainingUsd).toBeCloseTo(9.925, 5);
    expect(snap.byProvider.google_places_search).toEqual({ usd: 0.07, calls: 2 });
    expect(snap.byProvider.geocoding).toEqual({ usd: 0.005, calls: 1 });
  });
});
