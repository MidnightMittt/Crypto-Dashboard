import { describe, expect, it } from "vitest";
import { OptionOrderInputs, runOptionOrderChecks } from "./optionOrder";

/**
 * Hand-computed on the account's real numbers throughout: $437.04 account,
 * $100 hard floor, 4 concurrent positions -> $84.01 per-position budget;
 * the candidate is the real MARA 2026-09-18 $12 call quoted at 0.86.
 */
const NOW = Date.UTC(2026, 7, 22, 14, 0, 0);

const clean = (over: Partial<OptionOrderInputs> = {}): OptionOrderInputs => ({
  symbol: "MARA",
  order: {
    leg: {
      strike: 12,
      expiry: "2026-09-18",
      right: "call",
      multiplier: 100,
      multiplier_source: "default_us_equity_option_100",
      delta: 0.4,
    },
    premium: 0.86,
    contracts: 1,
  },
  accountValue: 437.04,
  buyingPowerUsd: 137.14,
  budget: { hardFloorUsd: 100, concurrentPositions: 4 },
  minBreakevenReachPct: null,
  spot: { value: 11.5, source: "stored_close" },
  breakeven: {
    // (12 + 0.86 - 11.50) / 11.50 = 11.83% rise required.
    movePct: 11.83,
    reach: { reachPct: 56.1, n: 1180, independentN: 62, horizonSessions: 19 },
  },
  beta: 2.6,
  existingPositions: [],
  earnings: { date: null, status: "none" },
  sessionsToExpiry: 19,
  livePrice: null,
  priceAgeSessions: 0,
  nowMs: NOW,
  ...over,
});

const check = (r: ReturnType<typeof runOptionOrderChecks>, name: string) =>
  r.checks.find((c) => c.name === name)!;

describe("runOptionOrderChecks — the defined-risk order audit", () => {
  it("fails max loss over budget by its exact overage — $86 against $84.26", () => {
    // (437.04 - 100) / 4 = 84.26. Part 0's own $84.01 was computed on the
    // earlier $436.04 snapshot — the budget moves with the account, which
    // is the point of taking it as an input instead of a constant.
    const r = runOptionOrderChecks(clean());
    const c = check(r, "max_loss_vs_budget");
    expect(c.status).toBe("fail");
    expect(c.data!.max_loss_usd).toBe(86);
    expect(c.data!.budget_usd).toBe(84.26);
    expect(c.detail).toContain("$1.74");
    expect(r.verdict).toBe("block");
  });

  it("passes a premium that fits, and says the premium cannot be gapped through", () => {
    const r = runOptionOrderChecks(clean({ order: { ...clean().order, premium: 0.8 } }));
    const c = check(r, "max_loss_vs_budget");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("cannot be gapped through");
  });

  it("returns unknown, not a verdict, when no risk policy is declared", () => {
    const r = runOptionOrderChecks(clean({ budget: null }));
    const c = check(r, "max_loss_vs_budget");
    expect(c.status).toBe("unknown");
    expect(c.detail).toContain("supply hard_floor_usd and concurrent_positions");
  });

  it("reports the measured breakeven reach with n and horizon, unjudged without a declared floor", () => {
    const r = runOptionOrderChecks(clean());
    const c = check(r, "breakeven_reach");
    expect(c.status).toBe("unknown");
    expect(c.detail).toContain("11.8% rise");
    expect(c.detail).toContain("56.1%");
    expect(c.detail).toContain("independent_n=62");
    expect(c.detail).toContain("only you know");
    expect(c.data!.horizon_sessions).toBe(19);
  });

  it("judges breakeven reach against the caller's own floor when declared", () => {
    const passes = runOptionOrderChecks(clean({ minBreakevenReachPct: 50 }));
    expect(check(passes, "breakeven_reach").status).toBe("pass");
    const fails = runOptionOrderChecks(clean({ minBreakevenReachPct: 60 }));
    expect(check(fails, "breakeven_reach").status).toBe("fail");
    expect(check(fails, "breakeven_reach").detail).toContain("Misses your declared 60.0% floor");
  });

  it("passes by construction when spot already sits beyond breakeven", () => {
    const r = runOptionOrderChecks(
      clean({ spot: { value: 13.5, source: "stored_close" }, breakeven: { movePct: -4.7, reach: null } })
    );
    const c = check(r, "breakeven_reach");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("answered by construction");
  });

  it("counts the order at delta-equivalent x beta in exposure and at its premium in deployment", () => {
    const r = runOptionOrderChecks(
      clean({
        existingPositions: [
          { symbol: "BTDR", instrument: "option", capitalUsd: 125, marketEquivalentUsd: 2140 },
        ],
      })
    );
    const beta = check(r, "beta_exposure");
    // Added: 1 x 0.4 x 100 x 11.50 x 2.6 = 1,196; book 2,140 + 1,196 = 3,336.
    expect(beta.data!.added_market_equivalent).toBeCloseTo(1196, 0);
    expect(beta.data!.book_market_equivalent).toBeCloseTo(3336, 0);
    expect(beta.status).toBe("fail");
    const cap = check(r, "deployment_cap");
    // 125 held premium + 86 debit = 211 of 437.04 = 48% — under the 70% cap.
    expect(cap.data!.deployed).toBeCloseTo(211, 0);
    expect(cap.status).toBe("pass");
  });

  it("names the caller as the delta's source — the site cannot verify it", () => {
    const r = runOptionOrderChecks(clean());
    expect(check(r, "beta_exposure").detail).toContain("as posted by the caller");
  });

  it("fits the debit inside buying power and names the exercise-capital cliff", () => {
    const r = runOptionOrderChecks(clean());
    const c = check(r, "reachability");
    expect(c.status).toBe("pass");
    expect(c.data!.debit_usd).toBe(86);
    // Exercising the $12 call needs $1,200 the account does not have.
    expect(c.data!.exercise_capital_usd).toBe(1200);
    expect(c.detail).toContain("EXERCISING would need $1200.00");
  });

  it("fails an unaffordable debit", () => {
    const r = runOptionOrderChecks(clean({ order: { ...clean().order, premium: 1.86, contracts: 1 }, buyingPowerUsd: 100 }));
    const c = check(r, "reachability");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("cannot be placed");
  });

  it("treats earnings inside the tenor as named context, never a veto — the premium is the floor", () => {
    const r = runOptionOrderChecks(clean({ earnings: { date: "2026-09-10", status: "confirmed" } }));
    const c = check(r, "earnings_window");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("INSIDE this contract's tenor");
    expect(c.detail).toContain("a gap cannot go through it");
    expect(c.detail).toContain("named rather than measured");
  });

  it("still treats a failed earnings lookup as unknown — a failed lookup clears nothing", () => {
    const r = runOptionOrderChecks(clean({ earnings: { date: null, status: "lookup_failed" } }));
    expect(check(r, "earnings_window").status).toBe("unknown");
  });

  it("uses the shared freshness semantics — a live underlying price is dated and named", () => {
    const r = runOptionOrderChecks(
      clean({ livePrice: { value: 11.52, asOfMs: NOW - 30_000, source: "broker_mid" }, priceAgeSessions: 1 })
    );
    const c = check(r, "data_freshness");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain('"broker_mid"');
    expect(c.detail).toContain("30s old");
  });
});
