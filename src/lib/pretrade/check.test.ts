import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_CAP,
  MAX_BETA_EXPOSURE,
  PretradeInputs,
  SURVIVAL_FLOOR,
  runPretradeChecks,
} from "./check";

/** A trade that clears everything, so each test can break exactly one thing. */
const clean = (over: Partial<PretradeInputs> = {}): PretradeInputs => ({
  symbol: "RIOT",
  shares: 10,
  entry: 20,
  stop: 18,
  holdSessions: 20,
  accountValue: 1000,
  existingPositions: [],
  beta: 1.2,
  stopSurvival: { survival: 0.85, independentN: 14 },
  earnings: { date: null, status: "none" },
  cost: { roundTripBp: 8.7, edgeBp: 29.3 },
  priceAgeSessions: 0,
  today: "2026-08-21",
  livePrice: null,
  buyingPowerUsd: null,
  nowMs: Date.UTC(2026, 7, 21, 19, 0, 0),
  ...over,
});

const check = (r: ReturnType<typeof runPretradeChecks>, name: string) =>
  r.checks.find((c) => c.name === name)!;

describe("runPretradeChecks", () => {
  it("passes a trade that clears every check", () => {
    const r = runPretradeChecks(clean());
    expect(r.verdict).toBe("pass");
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });

  /*
   * THE CENTRAL RULE. Missing data is a third state, never green. "No stop
   * grid for this name" and "the stop survives comfortably" are opposite
   * facts and must not reduce to the same verdict.
   */
  it("returns incomplete, not pass, when a check cannot be evaluated", () => {
    const r = runPretradeChecks(clean({ stopSurvival: null }));
    expect(r.verdict).toBe("incomplete");
    expect(check(r, "stop_survival").status).toBe("unknown");
    expect(check(r, "stop_survival").detail).toContain("Unmeasured is not the same as safe");
    expect(r.summary).toContain("not a pass");
  });

  it("blocks rather than reporting incomplete when something both fails and is unknown", () => {
    const r = runPretradeChecks(clean({ stopSurvival: null, priceAgeSessions: 4 }));
    expect(r.verdict).toBe("block");
  });

  /* The measured case from 2026-08-20: 20% stop, 56% survival, 70% floor. */
  it("fails a stop that sits inside the name's normal range", () => {
    const r = runPretradeChecks(
      clean({ entry: 20, stop: 16, stopSurvival: { survival: 0.56, independentN: 12 } })
    );
    expect(r.verdict).toBe("block");
    const c = check(r, "stop_survival");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("20.0% stop survives 56%");
    expect(c.data!.floor).toBe(SURVIVAL_FLOOR);
    // The sample size travels with the claim, per the contract.
    expect(c.data!.independent_n).toBe(12);
  });

  /*
   * Notional is the wrong axis. $95.58 at beta 4.57 is $437 market-equivalent,
   * which is what actually moves the account.
   */
  it("measures exposure in market-equivalent terms, not notional", () => {
    // The historical case, hand-computed: $95.58 notional x beta 4.57 =
    // $436.80 market-equivalent, on the $211.67 account it was sized against
    // = 206%. Notional alone reads 45% and looks unremarkable, which is the
    // whole reason this check exists.
    const r = runPretradeChecks(
      clean({ shares: 10, entry: 9.558, beta: 4.57, accountValue: 211.67, stop: 8 })
    );
    const c = check(r, "beta_exposure");
    expect(c.status).toBe("fail");
    expect(c.data!.added_market_equivalent).toBeCloseTo(436.8, 0);
    expect(Number(c.data!.ratio_of_account)).toBeCloseTo(2.06, 1);
    expect(c.data!.ceiling).toBe(MAX_BETA_EXPOSURE);
    // Notional would have read 45% of the account and cleared every cap.
    expect((10 * 9.558) / 211.67).toBeLessThan(0.5);
  });

  /*
   * A held position with no measured beta contributes ZERO, so the reported
   * figure understates the book. Saying so is the difference between a number
   * and a misleading number.
   */
  it("warns that unmeasured betas make the exposure figure a floor", () => {
    const r = runPretradeChecks(
      clean({
        existingPositions: [
          // CIFR 5sh x $17 at beta 4.5 -> 382.50 market-equivalent.
          { symbol: "CIFR", instrument: "equity", capitalUsd: 85, marketEquivalentUsd: 382.5 },
          { symbol: "MYSTERY", instrument: "equity", capitalUsd: 100, marketEquivalentUsd: null },
        ],
      })
    );
    const c = check(r, "beta_exposure");
    expect(c.data!.positions_without_beta).toBe(1);
    expect(c.detail).toContain("the true figure is HIGHER");
  });

  /*
   * The real held book: an option leg's EXPOSURE is its delta-equivalent x
   * beta, while its CAPITAL is only the premium. The two checks must read
   * different numbers from the same leg — counting premium in beta_exposure
   * was the 140x understatement /api/portfolio already fixed.
   */
  it("counts an option leg's delta-equivalent in exposure and its premium in deployment", () => {
    const r = runPretradeChecks(
      clean({
        accountValue: 437,
        existingPositions: [
          // 1 BTDR call: $125 premium capital, ~$823 delta-equiv x beta 2.6 = 2,140.
          { symbol: "BTDR", instrument: "option", capitalUsd: 125, marketEquivalentUsd: 2140 },
        ],
      })
    );
    const beta = check(r, "beta_exposure");
    // 2,140 held + (10 x 20 x 1.2 = 240) added = 2,380 on a 437 account: breach.
    expect(beta.status).toBe("fail");
    expect(beta.data!.book_market_equivalent).toBeCloseTo(2380, 0);
    const cap = check(r, "deployment_cap");
    // Deployment counts the premium, not the delta notional: 125 + 200 = 325.
    expect(cap.data!.deployed).toBeCloseTo(325, 0);
  });

  it("refuses to assume a beta of 1 for an unmeasured candidate", () => {
    const r = runPretradeChecks(clean({ beta: null }));
    expect(check(r, "beta_exposure").status).toBe("unknown");
    expect(check(r, "beta_exposure").detail).toContain("would understate a high-beta name");
  });

  /*
   * The cap is a FRACTION. A dollar cap derived at $211.67 was still in use at
   * $338 because nobody rescaled it.
   */
  it("scales the deployment cap with the account", () => {
    const small = runPretradeChecks(clean({ shares: 40, entry: 20, accountValue: 1000 }));
    expect(check(small, "deployment_cap").status).toBe("fail");
    const large = runPretradeChecks(clean({ shares: 40, entry: 20, accountValue: 5000 }));
    expect(check(large, "deployment_cap").status).toBe("pass");
    expect(check(large, "deployment_cap").data!.cap).toBe(DEPLOYMENT_CAP);
  });

  it("blocks a report inside the hold and clears one beyond it", () => {
    const inside = runPretradeChecks(
      clean({ earnings: { date: "2026-08-27", status: "confirmed" }, holdSessions: 20 })
    );
    expect(check(inside, "earnings_window").status).toBe("fail");
    expect(check(inside, "earnings_window").detail).toContain("not tradeable through a stop");

    const beyond = runPretradeChecks(
      clean({ earnings: { date: "2026-11-20", status: "confirmed" }, holdSessions: 5 })
    );
    expect(check(beyond, "earnings_window").status).toBe("pass");
  });

  /* A failed lookup clears nothing — the three-state contract, enforced here. */
  it("treats a failed earnings lookup as unknown rather than as no earnings", () => {
    const r = runPretradeChecks(clean({ earnings: { date: null, status: "lookup_failed" } }));
    expect(check(r, "earnings_window").status).toBe("unknown");
    expect(r.verdict).toBe("incomplete");
  });

  /* CORZ: a 133bp exit spread against a 29.3bp edge is a losing trade. */
  it("fails when measured cost exceeds the edge", () => {
    const r = runPretradeChecks(clean({ cost: { roundTripBp: 133, edgeBp: 29.3 } }));
    const c = check(r, "round_trip_cost");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("losing trade before it starts");
    expect(Number(c.data!.net_bp)).toBeLessThan(0);
  });

  it("will not substitute a modelled spread for a measured one", () => {
    const r = runPretradeChecks(clean({ cost: null }));
    expect(check(r, "round_trip_cost").status).toBe("unknown");
    expect(check(r, "round_trip_cost").detail).toContain("114-177bp");
  });

  it("rejects a stop that is not below entry", () => {
    expect(check(runPretradeChecks(clean({ stop: 22 })), "price_band").status).toBe("fail");
    expect(check(runPretradeChecks(clean({ shares: 0 })), "price_band").status).toBe("fail");
  });

  /* Everything above is derived from the price, so staleness poisons all of it. */
  it("fails on a stale price and says the whole check inherits it", () => {
    const r = runPretradeChecks(clean({ priceAgeSessions: 4 }));
    const c = check(r, "data_freshness");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("as stale as the price");
  });

  /* A blocked trade must be arguable: every check carries figures to argue with. */
  it("gives every check a detail sentence and data to re-derive it", () => {
    const r = runPretradeChecks(clean({ stop: 16, stopSurvival: { survival: 0.5, independentN: 9 } }));
    for (const c of r.checks) {
      expect(c.detail.length, `${c.name} needs a reason`).toBeGreaterThan(20);
      expect(c.data, `${c.name} needs its numbers`).toBeDefined();
    }
    expect(r.summary).toContain("override only against the specific figure");
  });
});

/**
 * The structural problem live_price exists to cure: during every live
 * session the stored close is ≥1 session behind BY CONSTRUCTION, so the
 * auditor failed data_freshness on every trade the caller was actually
 * about to place. The fix is not to relax the check — it is to judge a
 * caller-supplied price, dated and with its source named.
 */
describe("runPretradeChecks — caller-supplied live price", () => {
  const NOW = Date.UTC(2026, 7, 21, 19, 0, 0);
  const at = (secondsBeforeNow: number) => NOW - secondsBeforeNow * 1000;

  it("judges the supplied price during a live session, when the close must be behind", () => {
    // The close is 1 session behind — previously an unconditional fail.
    const r = runPretradeChecks(
      clean({
        priceAgeSessions: 1,
        livePrice: { value: 19.9, asOfMs: at(42), source: "broker_bid" },
      })
    );
    const c = check(r, "data_freshness");
    expect(c.status).toBe("pass");
    expect(c.detail).toContain('"broker_bid"');
    expect(c.detail).toContain("42s old");
    expect(c.data!.price_age_seconds).toBe(42);
    expect(c.data!.source).toBe("broker_bid");
    expect(r.verdict).toBe("pass");
  });

  it("fails a supplied price older than the 15-minute limit", () => {
    const r = runPretradeChecks(
      clean({ livePrice: { value: 19.9, asOfMs: at(1000), source: "broker_bid" } })
    );
    const c = check(r, "data_freshness");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("1000s old");
    expect(c.detail).toContain("stored close with extra steps");
    expect(r.verdict).toBe("block");
  });

  it("fails a price dated in the future rather than calling it fresh", () => {
    const r = runPretradeChecks(
      clean({ livePrice: { value: 19.9, asOfMs: at(-30), source: "broker_bid" } })
    );
    const c = check(r, "data_freshness");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("FUTURE");
  });

  it("reports how far the entry sits from the live price without judging it", () => {
    // Entry 20 against a live 19.9: +0.5%. A limit away from the market is
    // legitimate; a fat-fingered entry should still be visible.
    const r = runPretradeChecks(
      clean({ livePrice: { value: 19.9, asOfMs: at(5), source: "broker_mid" } })
    );
    const c = check(r, "data_freshness");
    expect(c.status).toBe("pass");
    expect(c.data!.entry_vs_live_pct).toBeCloseTo(0.5, 1);
  });

  it("behaves exactly as before when no live price is supplied", () => {
    const r = runPretradeChecks(clean({ priceAgeSessions: 1 }));
    const c = check(r, "data_freshness");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("1 session behind");
    // And the failure now tells the caller the cure.
    expect(c.detail).toContain("live_price");
  });
});


/**
 * The size-awareness check — Part 0's constraint made executable. $137 of
 * buying power makes most correct advice untakeable, and an auditor that
 * PASSes an order the account cannot place is advising a different account.
 */
describe("runPretradeChecks — reachability at the caller's size", () => {
  it("does not appear when buying power is not declared", () => {
    const r = runPretradeChecks(clean());
    expect(r.checks.find((c) => c.name === "reachability")).toBeUndefined();
  });

  it("fails an order that costs more than the buying power, naming the reachable size", () => {
    // 10 shares x $20 = $200 against $137.14 — the real account's number.
    const r = runPretradeChecks(clean({ buyingPowerUsd: 137.14 }));
    const c = check(r, "reachability");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("cannot be placed at this size");
    expect(c.data!.max_affordable_shares).toBe(6);
    expect(r.verdict).toBe("block");
  });

  it("passes a reachable order and says what remains", () => {
    const r = runPretradeChecks(clean({ shares: 5, buyingPowerUsd: 137.14 }));
    const c = check(r, "reachability");
    expect(c.status).toBe("pass");
    expect(c.data!.order_cost).toBe(100);
  });

  it("says plainly when not even one share is reachable", () => {
    const r = runPretradeChecks(clean({ entry: 186, stop: 150, buyingPowerUsd: 137.14 }));
    const c = check(r, "reachability");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("advice for a different account");
  });
});
