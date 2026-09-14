import { describe, expect, it } from "vitest";
import {
  HORIZON_SESSIONS,
  MAX_SPREAD_PCT_OF_MID,
  MIN_OPEN_INTEREST,
  buildContractScreen,
  directionSkewPp,
  type ChainContract,
  type ScreenInput,
  type SymbolInput,
} from "./contractScreen";
import type { Bar } from "./types";
import type { EquityExecutionSnapshot } from "../dossier/equityExpectations";

/**
 * What these tests are actually defending.
 *
 * The screen's one claim is that its ORDER means something, because the column
 * it sorts on is the only one with a forward record. Three ways that claim can
 * quietly become false, all pinned below: an unvalidated column leaking into
 * the sort; a contract being ranked on a probability describing a window it
 * does not live through; and a row that cannot be bought, or cannot be priced,
 * appearing above one that can. The fourth is a bucket tie resolving by chain
 * enumeration order, which is an arbitrary list wearing a ranked table's
 * clothes.
 */

const TODAY = "2026-09-11";
const FAR_EXPIRY = "2026-10-16";

/**
 * Flat bars with a constant 2-point range on a 100 close, so ATR is exactly 2
 * and every distance in the assertions below is arithmetic a reader can check
 * by hand rather than a number produced by the code under test.
 */
function flatBars(n = 60, close = 100, halfRange = 1): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: Date.UTC(2026, 0, 1) + i * 86_400_000,
    open: close,
    high: close + halfRange,
    low: close - halfRange,
    close,
    volume: 1_000_000,
  }));
}

function snapshot(): EquityExecutionSnapshot {
  const cell = (distanceAtrMax: number, reachRatePct: number, attempts: number) => ({
    source: "zone" as const,
    distanceAtrMax,
    touchesMin: 0,
    kind: "all" as const,
    attempts,
    reached: Math.round((attempts * reachRatePct) / 100),
    reachRatePct,
    medianSessionsToReach: 3,
  });
  return {
    generatedAt: 1_760_000_000_000,
    method: {
      engine: "test",
      lookbackYears: 1,
      maxHoldSessions: 10,
      costBpsRoundTrip: 0,
      barsPerYear: 252,
    },
    coverage: {
      symbols: 1,
      firstDate: "2025-09-11",
      lastDate: TODAY,
      sessionsEvaluated: 252,
      plansPrinted: 0,
      reachRatePct: 0,
      trades: 0,
    },
    cells: {},
    reach: [cell(0.5, 87.8, 4000), cell(1, 70.7, 3800), cell(2, 48.7, 3600), cell(3, 25.5, 3400)],
    caveats: [],
  };
}

function chain(over: Partial<ChainContract> = {}): ChainContract {
  return {
    symbol: "AAA",
    expiry: FAR_EXPIRY,
    kind: "call",
    strike: 100,
    bid: 0.95,
    ask: 1.05,
    openInterest: 500,
    volume: 100,
    ivPct: 40,
    delta: 0.45,
    ...over,
  };
}

function symbol(over: Partial<SymbolInput> = {}): SymbolInput {
  return {
    symbol: "AAA",
    spot: 100,
    bars: flatBars(),
    contracts: [chain()],
    ...over,
  };
}

function run(symbols: SymbolInput[], budgetUsd = 500): ReturnType<typeof buildContractScreen> {
  const input: ScreenInput = { symbols, budgetUsd, snapshot: snapshot(), today: TODAY };
  return buildContractScreen(input);
}

describe("directionSkewPp", () => {
  it("splits the measured up-minus-down gap, because the pooled rate sits between the two", () => {
    // 2.0 ATR measured +2.3pp drift-controlled; half of it lands on each side.
    expect(directionSkewPp(2, "call")).toBe(1.2);
    expect(directionSkewPp(2, "put")).toBe(-1.2);
  });

  it("interpolates between measured distances and holds the ends rather than extrapolating", () => {
    expect(directionSkewPp(2.5, "call")).toBe(1.4); // between 2.3 and 3.2
    expect(directionSkewPp(0.1, "call")).toBe(0.1); // held at the 0.5 value
    expect(directionSkewPp(9, "call")).toBe(1.3); // held at the 5.0 value
  });

  it("has no answer at zero or negative distance", () => {
    expect(directionSkewPp(0, "call")).toBeNull();
    expect(directionSkewPp(-1, "call")).toBeNull();
  });
});

describe("buildContractScreen — the row", () => {
  it("prices the breakeven off the mid and expresses it in the symbol's own ATR", () => {
    const { rows } = run([symbol()]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.mid).toBe(1);
    expect(r.costUsd).toBe(100);
    expect(r.breakeven).toBe(101); // strike 100 + premium 1.00
    expect(r.breakevenMovePct).toBe(1);
    expect(r.breakevenAtr).toBe(0.5); // 1 point against a 2-point ATR
    expect(r.reachPct).toBe(87.8);
    expect(r.reachBucketAtr).toBe(0.5);
    expect(r.contractsAffordable).toBe(5); // $500 budget, $100 a contract
    expect(r.sessionsToExpiry).toBeGreaterThanOrEqual(HORIZON_SESSIONS);
  });

  it("signs a put's breakeven move downward, the direction that pays", () => {
    const { rows } = run([symbol({ contracts: [chain({ kind: "put", strike: 100, delta: -0.45 })] })]);
    expect(rows[0].breakeven).toBe(99);
    expect(rows[0].breakevenMovePct).toBe(-1);
    expect(rows[0].breakevenAtr).toBe(0.5);
    expect(rows[0].directionSkewPp).toBeLessThan(0);
  });

  it("flags a catalyst only when it falls inside the contract's life", () => {
    const seen = { eventsKnownThrough: "2026-12-31" };
    const before = run([symbol({ eventDate: "2026-09-30", ...seen })]).rows[0];
    const after = run([symbol({ eventDate: "2026-11-04", ...seen })]).rows[0];
    expect(before.eventBeforeExpiry).toBe(true);
    expect(after.eventDate).toBe("2026-11-04");
    expect(after.eventBeforeExpiry).toBe(false);
  });

  /*
   * The committed calendar sweeps through 2026-10-09 while the affordability
   * artifact carries expiries out to 2027-01-15, so this is the common case
   * and not an edge case. A `false` here would claim a clean window nobody
   * checked, and a clean catalyst column reads as permission to hold.
   */
  it("refuses to answer when the calendar stopped looking before expiry", () => {
    const short = run([symbol({ eventDate: null, eventsKnownThrough: "2026-09-20" })]).rows[0];
    expect(short.eventBeforeExpiry).toBeNull();
    expect(short.eventsKnownThrough).toBe("2026-09-20");

    // No coverage declared at all is the same refusal, not a false.
    expect(run([symbol({ eventDate: null })]).rows[0].eventBeforeExpiry).toBeNull();
  });

  it("still answers true past the sweep horizon, because a found event is a fact", () => {
    /*
     * Asymmetric on purpose. An absence is only a fact inside the window that
     * was searched; a hit is a hit however short the search was.
     */
    const r = run([symbol({ eventDate: "2026-09-30", eventsKnownThrough: "2026-09-20" })]).rows[0];
    expect(r.eventBeforeExpiry).toBe(true);
  });

  it("asks the symbol's own bars in the direction that pays", () => {
    /*
     * Bars whose highs run far above the close and whose lows barely dip: the
     * +1% breakeven is inside every session's range and the -1% one is inside
     * none. A direction-blind implementation — using the up-side estimator for
     * both legs — returns the same number twice and quotes a put the
     * probability of the move it loses on.
     */
    const upOnly = flatBars(60).map((b) => ({ ...b, high: b.close + 3, low: b.close - 0.5 }));
    const call = run([
      symbol({ bars: upOnly, contracts: [chain({ kind: "call", strike: 100, delta: 0.45 })] }),
    ]).rows[0];
    const put = run([
      symbol({ bars: upOnly, contracts: [chain({ kind: "put", strike: 100, delta: -0.45 })] }),
    ]).rows[0];

    expect(call.breakeven).toBe(101);
    expect(put.breakeven).toBe(99);
    expect(call.symbolReachPct).toBe(100);
    expect(put.symbolReachPct).toBe(0);
    // Overlapping windows, so the honest sample size is well under the count.
    expect(call.symbolReachIndependentN!).toBeGreaterThan(0);
    expect(call.symbolReachIndependentN!).toBeLessThan(call.symbolReachN!);
  });

  it("separates rows the bucket table cannot", () => {
    /*
     * The reason this column exists. Two names whose breakevens land in the
     * same distance bucket carry an identical reach_pct, so the order between
     * them is the cost tiebreak and nothing else.
     *
     * These two are built as mirror images — one rises then falls, the other
     * falls then rises, in steps of the same size. Every true range is
     * therefore identical, so both carry the same ATR and land in the same
     * bucket by construction, while their paths differ completely.
     */
    const zigzag = (up: boolean): Bar[] =>
      Array.from({ length: 60 }, (_, i) => {
        const leg = i < 30 ? i : 59 - i;
        const close = up ? 100 + leg * 0.5 : 100 - leg * 0.5;
        return {
          t: Date.UTC(2026, 0, 1) + i * 86_400_000,
          open: close,
          high: close + 1,
          low: close - 1,
          close,
          volume: 1_000_000,
        };
      });

    const rows = run([
      symbol({ symbol: "AAA", bars: zigzag(true) }),
      symbol({ symbol: "BBB", bars: zigzag(false) }),
    ]).rows;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.reachPct)).size).toBe(1);
    expect(new Set(rows.map((r) => r.symbolReachPct)).size).toBe(2);
  });
});

describe("buildContractScreen — the order", () => {
  it("ranks by the validated probability, nearest breakeven first", () => {
    const near = symbol({ symbol: "NEAR", contracts: [chain({ symbol: "NEAR", strike: 100 })] });
    // Breakeven 104 on a 100 spot is 2.0 ATR out — a real bucket, a worse rate.
    const far = symbol({ symbol: "FAR", contracts: [chain({ symbol: "FAR", strike: 103 })] });
    const { rows } = run([far, near]);
    expect(rows.map((r) => r.symbol)).toEqual(["NEAR", "FAR"]);
    expect(rows[0].reachPct).toBeGreaterThan(rows[1].reachPct);
    expect(rows[1].breakevenAtr).toBe(2);
  });

  it("breaks a bucket tie by distance rather than by chain enumeration order", () => {
    // Breakevens 0.45 and 0.40 ATR out — different distances, same bucket, so
    // the ranking statistic is identical and the order would otherwise be
    // whatever the chain happened to enumerate.
    const dear = chain({ symbol: "DEAR", strike: 100, bid: 0.85, ask: 0.95 });
    const cheap = chain({ symbol: "CHEAP", strike: 100, bid: 0.75, ask: 0.85 });
    const { rows } = run([
      symbol({ symbol: "DEAR", contracts: [dear] }),
      symbol({ symbol: "CHEAP", contracts: [cheap] }),
    ]);
    expect(rows[0].reachPct).toBe(rows[1].reachPct);
    expect(rows.map((r) => r.symbol)).toEqual(["CHEAP", "DEAR"]);
  });

  it("puts the nearer breakeven first when cost disagrees with distance", () => {
    /*
     * The case that caught the original tiebreak. Cheaper contracts sit further
     * out of the money, so inside a bucket cost and distance are negatively
     * correlated — measured at rho -0.268 on a live $195 run, where ordering
     * cheapest-first put a mean 1.50 ATR breakeven in the displayed top half
     * against 1.36 in the bottom. The bucket cannot tell those apart, but the
     * table it comes from is monotone in distance, so the cheap-and-far row
     * being on top was an ordering pointed the wrong way.
     *
     * Both breakevens land in (0.5, 1] and carry the identical 70.7%. The
     * cheaper one is deliberately the further one.
     */
    const nearDear = chain({ symbol: "NEARDEAR", strike: 100, bid: 1.15, ask: 1.25 });
    const farCheap = chain({ symbol: "FARCHEAP", strike: 101, bid: 0.85, ask: 0.95 });
    const { rows } = run([
      symbol({ symbol: "FARCHEAP", contracts: [farCheap] }),
      symbol({ symbol: "NEARDEAR", contracts: [nearDear] }),
    ]);

    expect(rows).toHaveLength(2);
    // Same bucket, so the ranking statistic is silent between them.
    expect(rows[0].reachPct).toBe(rows[1].reachPct);
    // Breakeven = strike + mid: 101.20 (0.60 ATR) against 101.90 (0.95 ATR).
    expect(rows[0].breakevenAtr).toBeCloseTo(0.6, 5);
    expect(rows[1].breakevenAtr).toBeCloseTo(0.95, 5);
    // The nearer row leads despite costing $120 against $90.
    expect(rows.map((r) => r.symbol)).toEqual(["NEARDEAR", "FARCHEAP"]);
    expect(rows[0].costUsd).toBeGreaterThan(rows[1].costUsd);
  });

  it("does not let an unvalidated column reorder the table", () => {
    /*
     * The whole point of the module. IV/RV is under a pre-declared kill line
     * and asymmetry has no forward record; a screen that let either move a row
     * would be making exactly the claim the kill line exists to withhold.
     */
    const loud = symbol({
      symbol: "LOUD",
      contracts: [chain({ symbol: "LOUD", strike: 103, ivPct: 140 })],
      ivRvRatio: 0.31,
    });
    const quiet = symbol({
      symbol: "QUIET",
      contracts: [chain({ symbol: "QUIET", strike: 100, ivPct: 20 })],
      ivRvRatio: 2.9,
    });
    const { rows } = run([loud, quiet]);
    expect(rows.map((r) => r.symbol)).toEqual(["QUIET", "LOUD"]);
    expect(rows[0].ivRvRatio).toBe(2.9);
    expect(rows[1].ivRvRatio).toBe(0.31);
  });

  it("keeps the skew correction beside the rank and out of it", () => {
    const { rows, rankedBy } = run([
      symbol({ symbol: "P", contracts: [chain({ symbol: "P", kind: "put", strike: 100, delta: -0.45 })] }),
      symbol({ symbol: "C", contracts: [chain({ symbol: "C", strike: 100 })] }),
    ]);
    // Identical distance, opposite skew, identical rank statistic.
    expect(rows[0].reachPct).toBe(rows[1].reachPct);
    expect(rows.map((r) => r.directionSkewPp).sort()).toEqual([-0.1, 0.1]);
    expect(rankedBy).toContain("not a composite");
  });
});

describe("buildContractScreen — the rejections", () => {
  const reasonOf = (contracts: ChainContract[], budget = 500) =>
    run([symbol({ contracts })], budget).rejected.map((r) => r.reason);

  it("names an unpriceable market rather than dropping it", () => {
    expect(reasonOf([chain({ bid: null })])).toEqual(["no_two_sided_market"]);
    expect(reasonOf([chain({ bid: 2, ask: 1 })])).toEqual(["no_two_sided_market"]);
  });

  it("refuses a mid nobody trades at, with the width in the sentence", () => {
    const { rejected } = run([symbol({ contracts: [chain({ bid: 0.6, ask: 1.4 })] })]);
    expect(rejected[0].reason).toBe("spread_too_wide");
    expect(rejected[0].detail).toContain("80%");
    expect(rejected[0].detail).toContain(`${MAX_SPREAD_PCT_OF_MID}%`);
  });

  it("refuses thin open interest on the exit, not the entry", () => {
    const { rejected } = run([symbol({ contracts: [chain({ openInterest: MIN_OPEN_INTEREST - 1 })] })]);
    expect(rejected[0].reason).toBe("thin_open_interest");
    expect(rejected[0].detail).toContain("getting out is");
  });

  it("names the cost that put a contract out of budget", () => {
    const { rows, rejected } = run([symbol({ contracts: [chain({ bid: 15, ask: 15.4 })] })], 195);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toBe("unaffordable");
    expect(rejected[0].detail).toBe("One contract costs $1520 against a $195 budget.");
  });

  it("refuses to lend a ten-session probability to a five-session contract", () => {
    const { rejected } = run([symbol({ contracts: [chain({ expiry: "2026-09-18" })] })]);
    expect(rejected[0].reason).toBe("expiry_shorter_than_horizon");
    expect(rejected[0].detail).toContain(`calibrated over ${HORIZON_SESSIONS}`);
  });

  it("refuses a distance the calibrated table has no cell for", () => {
    // Breakeven 141 on a 100 spot with a 2-point ATR is 20.5 ATR out.
    const { rows, rejected } = run([symbol({ contracts: [chain({ strike: 140 })] })]);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toBe("beyond_reach_table");
    expect(rejected[0].detail).toContain("20.5 ATR");
  });

  it("refuses a quote below intrinsic instead of sorting it to the top", () => {
    /*
     * A 90-strike call at $9.00 against a $100 spot is a point under intrinsic
     * — a stale mid on a delayed chain, not an opportunity. Its breakeven sits
     * behind spot, so it would borrow the nearest bucket's high rate and rank
     * first: the screen's best row being its worst quote.
     *
     * A correctly-priced contract cannot reach this branch at any depth, since
     * strike + premium >= spot whenever premium >= intrinsic. The test exists
     * because that is not obvious from the condition alone.
     */
    const { rows, rejected } = run([symbol({ contracts: [chain({ strike: 90, bid: 8.9, ask: 9.1 })] })], 5000);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toBe("breakeven_behind_spot");
    expect(rejected[0].detail).toContain("below intrinsic value");

    // The same contract quoted at or above intrinsic is an ordinary row.
    const fair = run([symbol({ contracts: [chain({ strike: 90, bid: 10.9, ask: 11.1 })] })], 5000);
    expect(fair.rows).toHaveLength(1);
    expect(fair.rows[0].breakeven).toBe(101);
  });

  it("refuses a symbol with too few bars for an ATR, in ATR's own words", () => {
    const { rows, rejected } = run([symbol({ bars: flatBars(5) })]);
    expect(rows).toHaveLength(0);
    expect(rejected[0].reason).toBe("no_atr");
  });

  it("accounts for every rejected row in the reason tally", () => {
    const screen = run([
      symbol({
        contracts: [
          chain({ bid: null }),
          chain({ strike: 101, bid: 0.6, ask: 1.4 }),
          chain({ strike: 102, openInterest: 1 }),
          chain({ strike: 103 }), // survives
        ],
      }),
    ]);
    const total = Object.values(screen.rejectedByReason).reduce((a, b) => a + b, 0);
    expect(total).toBe(screen.rejected.length);
    expect(total).toBe(3);
    expect(screen.rows).toHaveLength(1);
    // A short list has to be explainable: every dropped row is named.
    expect(screen.rejected.every((r) => r.detail.length > 0)).toBe(true);
  });
});

describe("buildContractScreen — what travels with the numbers", () => {
  it("states the horizon, the budget and the caveats on the result itself", () => {
    const screen = run([symbol()], 195);
    expect(screen.horizonSessions).toBe(HORIZON_SESSIONS);
    expect(screen.budgetUsd).toBe(195);
    expect(screen.caveats.join(" ")).toContain("UNVALIDATED");
    // The reach rate is about the underlying, not about the contract's P&L.
    expect(screen.caveats.join(" ")).toContain("not the probability the contract is profitable");
  });
});

describe("buildContractScreen — ranking inside the affordable set", () => {
  const excluded = [
    { symbol: "MU", costUsd: 1520, detail: "MU excluded: cheapest qualifying contract $1520 against budget $195." },
    { symbol: "COST", costUsd: 4100, detail: "COST excluded: cheapest qualifying contract $4100 against budget $195." },
    { symbol: "NOOPT", costUsd: null, detail: "NOOPT excluded: no option chain was returned." },
  ];

  const screen = () =>
    buildContractScreen({
      symbols: [symbol()],
      budgetUsd: 195,
      snapshot: snapshot(),
      today: TODAY,
      budgetExcluded: excluded,
    });

  it("carries what the budget removed, with the number, nearest to reachable first", () => {
    const s = screen();
    expect(s.budgetExcluded.map((e) => e.symbol)).toEqual(["MU", "COST", "NOOPT"]);
    expect(s.budgetExcluded[0].detail).toContain("$1520");
  });

  it("says in one sentence how much of the panel the budget removed", () => {
    const note = screen().universeNote;
    expect(note).toContain("1 of 4 names");
    expect(note).toContain("MU at $1520");
  });

  it("does not claim an exclusion when there is none", () => {
    const s = buildContractScreen({
      symbols: [symbol()],
      budgetUsd: 5000,
      snapshot: snapshot(),
      today: TODAY,
    });
    expect(s.budgetExcluded).toEqual([]);
    expect(s.universeNote).toContain("removed none of them");
  });
});
