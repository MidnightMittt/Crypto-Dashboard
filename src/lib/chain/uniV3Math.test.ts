import { describe, expect, it } from "vitest";
import {
  feeRatePerDay,
  feesOwedRaw,
  lvrCoverage,
  mod256,
  pctThroughRange,
  ponsUsd,
  positionAmounts,
  sqrtPriceAtTick,
} from "./uniV3Math";

/**
 * The fixtures the trading session chain-verified. Stated in the build order
 * as ground truth: "if your card disagrees, your card is wrong until proven
 * otherwise." The RPC does not retain historical state, so these cannot be
 * replayed by re-reading the blocks — they are pinned here as the facts the
 * math must reproduce.
 */
const L = 20709381339772035115n; // constant across fixtures a and b
const FIX = {
  a: { block: 66695771, tick: 82555, ts: 1789781924, ethUsd: 2607.15, wethFee: 0.000047, ponsFee: 0.1921, usd: 0.25 },
  b: { block: 67363811, tick: 84344, ts: 1789849208, ethUsd: 2634.8, wethFee: 0.000281, ponsFee: 1.4687, usd: 1.58 },
  d: { block: 67572824, tick: 83829, poolLiquidity: 280537354388678082751802n, share: 0.0074 },
};

describe("mod256", () => {
  it("wraps a subtraction underflow to the EVM's unsigned result", () => {
    // 0 - 1 in uint256 is 2^256 - 1, not -1. The fee formula depends on this.
    expect(mod256(0n - 1n)).toBe(2n ** 256n - 1n);
    expect(mod256(2n ** 256n)).toBe(0n);
    expect(mod256(5n)).toBe(5n);
  });
});

describe("feesOwedRaw — the accumulator arithmetic", () => {
  /*
   * A synthetic case built so the wrap is load-bearing: global has ticked past
   * 2^256 and wrapped, so a plain subtraction of the outside values would go
   * negative and a float would lose the answer. In range (tick between lower
   * and upper), both outsides are "below/above" as read, inside_now = global -
   * lower - upper, and owed = (inside_now - insideLast) * L / 2^128.
   */
  it("computes owed fees across a 2^256 wrap without going negative", () => {
    const global = 10n; // already wrapped past 2^256 to a small value
    const lowerOutside = 3n;
    const upperOutside = 2n;
    const insideLast = mod256(global - lowerOutside - upperOutside); // == inside_now → owed 0
    const owed = feesOwedRaw({
      currentTick: 100,
      tickLower: 0,
      tickUpper: 200,
      global,
      lowerOutside,
      upperOutside,
      insideLast,
      liquidity: 1n << 128n,
    });
    expect(owed).toBe(0n);
  });

  it("scales by L and un-scales the Q128 fixed point", () => {
    // inside grew by exactly 2^128 per unit liquidity since last touch → owed = L.
    const global = 5n * (1n << 128n);
    const owed = feesOwedRaw({
      currentTick: 50,
      tickLower: 0,
      tickUpper: 100,
      global,
      lowerOutside: 0n,
      upperOutside: 0n,
      insideLast: 4n * (1n << 128n), // inside_now - insideLast = 1 * 2^128
      liquidity: L,
    });
    expect(owed).toBe(L);
  });

  it("takes the below-branch complement when the tick is under the lower bound", () => {
    // currentTick < tickLower flips 'below' to global - outside; a distinct
    // path from the in-range case, so it gets its own assertion.
    const global = 1000n << 128n;
    const inRange = feesOwedRaw({
      currentTick: 50, tickLower: 0, tickUpper: 100,
      global, lowerOutside: 10n << 128n, upperOutside: 20n << 128n,
      insideLast: 0n, liquidity: 1n << 128n,
    });
    const belowRange = feesOwedRaw({
      currentTick: -5, tickLower: 0, tickUpper: 100,
      global, lowerOutside: 10n << 128n, upperOutside: 20n << 128n,
      insideLast: 0n, liquidity: 1n << 128n,
    });
    expect(inRange).not.toBe(belowRange);
  });
});

describe("card display math against the chain-verified fixtures", () => {
  it("reproduces fixture a's $0.25 card value from its fees, tick and ETH price", () => {
    const p = ponsUsd(FIX.a.tick, FIX.a.ethUsd);
    expect(p).toBeCloseTo(0.6777, 3);
    const usd = FIX.a.wethFee * FIX.a.ethUsd + FIX.a.ponsFee * p;
    expect(usd).toBeCloseTo(0.25, 2);
  });

  it("reproduces fixture b's $1.58 card value", () => {
    const p = ponsUsd(FIX.b.tick, FIX.b.ethUsd);
    const usd = FIX.b.wethFee * FIX.b.ethUsd + FIX.b.ponsFee * p;
    expect(usd).toBeCloseTo(1.58, 1);
  });

  it("puts PONS at ~$0.50 at the review tick, ~85% through the range", () => {
    expect(ponsUsd(85596, FIX.a.ethUsd)).toBeCloseTo(0.5, 2);
    expect(pctThroughRange(85596, 77640, 87000)).toBeCloseTo(0.85, 2);
  });

  it("holds the sp() identity the amounts formula rests on", () => {
    expect(sqrtPriceAtTick(0)).toBe(1);
    // sp(t)^2 = 1.0001^t
    expect(sqrtPriceAtTick(82555) ** 2).toBeCloseTo(1.0001 ** 82555, 0);
  });

  it("keeps an in-range position split across both tokens, all-one-token past the edges", () => {
    const inRange = positionAmounts(L, 82555, 77640, 87000);
    expect(inRange.amount0).toBeGreaterThan(0);
    expect(inRange.amount1).toBeGreaterThan(0);
    // Above the range: entirely token1 (PONS), no token0 (WETH) left.
    const above = positionAmounts(L, 90000, 77640, 87000);
    expect(above.amount0).toBeCloseTo(0, 9);
    expect(above.amount1).toBeGreaterThan(0);
    // Below the range: entirely token0.
    const below = positionAmounts(L, 70000, 77640, 87000);
    expect(below.amount1).toBeCloseTo(0, 9);
    expect(below.amount0).toBeGreaterThan(0);
  });
});

describe("share of active liquidity — fixture d", () => {
  it("reproduces 0.0074% from our L over pool.liquidity()", () => {
    const share = (Number(L) / Number(FIX.d.poolLiquidity)) * 100;
    expect(share).toBeCloseTo(FIX.d.share, 3);
  });
});

describe("feeRatePerDay — the between-reads deliverable", () => {
  it("reproduces the fixture $1.71/day between a and b", () => {
    const rate = feeRatePerDay(
      { feesUsd: FIX.a.usd, ts: FIX.a.ts * 1000 },
      { feesUsd: FIX.b.usd, ts: FIX.b.ts * 1000 }
    );
    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(1.71, 1);
  });

  it("refuses (null) rather than reporting a negative rate when fees drop — a reset", () => {
    const rate = feeRatePerDay(
      { feesUsd: 1.58, ts: FIX.b.ts * 1000 },
      { feesUsd: 0.01, ts: (FIX.b.ts + 3600) * 1000 } // collect/compound reset
    );
    expect(rate).toBeNull();
  });

  it("refuses on a non-positive time gap", () => {
    expect(feeRatePerDay({ feesUsd: 1, ts: 1000 }, { feesUsd: 2, ts: 1000 })).toBeNull();
  });
});

describe("lvrCoverage", () => {
  it("computes coverage = feeRate / (sigma^2/8 * value) and flags below 1.0", () => {
    // sigma 0.08 daily → LVR fraction 0.0008; on a $660 position → $0.528/day.
    const under = lvrCoverage({ feeRateUsdPerDay: 0.3, dailySigma: 0.08, positionValueUsd: 660 });
    expect(under).not.toBeNull();
    expect(under!.lvrUsdPerDay).toBeCloseTo(0.528, 3);
    expect(under!.coverage).toBeLessThan(1);
    const over = lvrCoverage({ feeRateUsdPerDay: 1.71, dailySigma: 0.08, positionValueUsd: 660 });
    expect(over!.coverage).toBeGreaterThan(1);
  });

  it("returns null when any input is absent rather than implying coverage", () => {
    expect(lvrCoverage({ feeRateUsdPerDay: null, dailySigma: 0.08, positionValueUsd: 660 })).toBeNull();
    expect(lvrCoverage({ feeRateUsdPerDay: 1, dailySigma: null, positionValueUsd: 660 })).toBeNull();
    expect(lvrCoverage({ feeRateUsdPerDay: 1, dailySigma: 0.08, positionValueUsd: null })).toBeNull();
  });
});
