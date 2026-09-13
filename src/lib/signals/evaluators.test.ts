import { describe, it, expect } from "vitest";
import { fundingBandVerdict, bookImbalanceVerdict, evaluateAll, SignalContext } from "./evaluators";
import { AggregateMarketData, SpotPerpVolume, TechnicalRead, ThesisDirection } from "@/types/market";

describe("fundingBandVerdict", () => {
  it("hand-computed: deep in the crowded-longs band -> bearish (fade the crowd)", () => {
    expect(fundingBandVerdict(0.2)).toBe("bearish");
  });

  it("hand-computed: deep in the extreme-shorts band -> bullish (fade the crowd)", () => {
    expect(fundingBandVerdict(-0.2)).toBe("bullish");
  });

  /*
   * These two asserted the opposite until 9.0.0, which is how the sign flip
   * survived: the suite pinned "fade at the extreme, trend in the middle" as
   * intended behaviour, on one axis.
   */
  it("hand-computed: mild positive (Longs Paying band) -> bearish, same as the extreme", () => {
    expect(fundingBandVerdict(0.08)).toBe("bearish");
  });

  it("hand-computed: mild negative (Shorts Paying band) -> bullish, same as the extreme", () => {
    expect(fundingBandVerdict(-0.08)).toBe("bullish");
  });

  /*
   * THE PROPERTY, not another point sample. The defect was not a wrong value at
   * 0.08 — it was a mapping that reversed direction as magnitude grew, so the
   * guard has to be monotonicity itself. Point tests cannot express that: the
   * old code passed six of them.
   */
  it("is monotone in magnitude — no sign reverses as funding gets more extreme", () => {
    const positive = [0.041, 0.05, 0.08, 0.149, 0.15, 0.2, 0.5, 5];
    const negative = positive.map((p) => -p);
    for (const p of positive) expect(fundingBandVerdict(p), `+${p}`).toBe("bearish");
    for (const p of negative) expect(fundingBandVerdict(p), `${p}`).toBe("bullish");
  });

  it("crosses the old flip point (0.15) without changing sign", () => {
    // 0.149 and 0.151 used to be bullish and bearish respectively.
    expect(fundingBandVerdict(0.149)).toBe(fundingBandVerdict(0.151));
  });

  it("hand-computed: inside the neutral band -> neutral", () => {
    expect(fundingBandVerdict(0.0)).toBe("neutral");
  });

  it("boundary: exactly at the neutral/bullish edge (0.04) reads neutral (band is inclusive on the neutral side)", () => {
    expect(fundingBandVerdict(0.04)).toBe("neutral");
  });
});

describe("bookImbalanceVerdict", () => {
  it("hand-computed: +10% imbalance (past the +5 threshold) -> bullish", () => {
    expect(bookImbalanceVerdict(10)).toBe("bullish");
  });

  it("hand-computed: -10% imbalance (past the -5 threshold) -> bearish", () => {
    expect(bookImbalanceVerdict(-10)).toBe("bearish");
  });

  it("hand-computed: +2% imbalance (inside the band) -> neutral", () => {
    expect(bookImbalanceVerdict(2)).toBe("neutral");
  });

  it("boundary: exactly +5% is NOT past threshold (strictly greater-than) -> neutral", () => {
    expect(bookImbalanceVerdict(5)).toBe("neutral");
  });

  it("returns neutral when no book data is available", () => {
    expect(bookImbalanceVerdict(null)).toBe("neutral");
  });
});

/**
 * THE DURABILITY READ LIVES ON THE PRICE ROW NOW.
 *
 * `evaluateSpotPerpVolume` used to set its verdict to `ctx.technicals
 * .direction` when spot was participating. That put a demoted (role "state")
 * read into the edge composite at weight 0.05 under a volume label, and did
 * it imperfectly: the price row reports neutral below trend strength 20,
 * this gate did not, so on 417 of 2896 replayed days the wrapper published a
 * direction Price Action had declined to call.
 *
 * Every evaluator below drives the real `evaluateAll`, not a re-implementation
 * — a test that restated the rule would pass against the borrowed direction
 * too. Only the two rows under test have their inputs populated; every other
 * evaluator returns null on missing data and drops out.
 */
describe("spot-vs-perp volume qualifies price action instead of copying it", () => {
  const LEVERAGE_LED = { spotVolumeUsd: 1e8, perpVolumeUsd: 5e9, spotToPerpRatio: 0.02 };
  const SPOT_LED = { spotVolumeUsd: 3e9, perpVolumeUsd: 1e10, spotToPerpRatio: 0.3 };

  const technicalRead = (direction: ThesisDirection, strength: number): TechnicalRead => ({
    direction,
    strength,
    summary: "",
    rsi: 50,
    macdHistogram: 0,
    emaAlignment: "mixed",
    adx: 30, // above 20, so the ADX conflict does not fire and cannot be mistaken for ours
    atrPct: 1,
    volumeRatio: 1,
    vwapPosition: "above",
    trendStructure: "sideways",
    bollingerBandwidthPct: null,
    bollingerPosition: null,
    stochasticK: null,
    obvTrend: null,
    supertrendDirection: null,
    parabolicSarDirection: null,
    ichimokuPosition: null,
    fibonacciNearestLevel: null,
    rsiDivergence: null,
    macdDivergence: null,
  });

  function rows(spv: SpotPerpVolume | null, t: TechnicalRead | null) {
    const data = {
      updatedAt: 0,
      spotPerpVolume: spv,
      // Everything else the other sixteen evaluators read, set to the value
      // that makes them return null and drop out. Two exceptions: funding has
      // no bail-out branch at all, so it needs real scalars and emits a
      // neutral row that the id filter below discards.
      exchanges: [],
      weightedFundingRatePct: 0,
      basisPct: null,
      coinbasePremiumPct: null,
      deribitOptions: null,
      etfFlows: null,
      exchangeFlow: null,
      liquidations: null,
      longShortRatio: null,
      oiChange: null,
      orderFlow: null,
      spotCvd: null,
      squeezeRisk: null,
    } as unknown as AggregateMarketData;
    const ctx = {
      technicals: t,
      stablecoins: null,
      fearGreed: null,
      sectorBreadth: null,
      macroLiquidity: null,
      hyperliquidConfirm: null,
      priceChange24hPct: 0,
      now: 0,
    } as SignalContext;
    const all = evaluateAll(data, ctx);
    return {
      spv: all.find((m) => m.id === "spotPerpVolume") ?? null,
      technicals: all.find((m) => m.id === "technicals") ?? null,
    };
  }

  it("stays neutral whichever way price action points, spot-led or not", () => {
    // The old rule was `spotLed && pa !== "neutral" -> pa`, so SPOT_LED with a
    // strong bullish price read is exactly the input that used to produce a
    // bullish vote here.
    for (const direction of ["bullish", "bearish", "neutral"] as ThesisDirection[]) {
      for (const mix of [SPOT_LED, LEVERAGE_LED]) {
        const r = rows(mix, technicalRead(direction, 90));
        expect(r.spv).not.toBeNull();
        expect(r.spv!.verdict).toBe("neutral");
      }
    }
  });

  it("raises the leverage-led warning on the Price Action row", () => {
    const r = rows(LEVERAGE_LED, technicalRead("bullish", 90));
    expect(r.technicals!.conflicts.some((c) => /rests on leverage/.test(c))).toBe(true);
    // 2% of perp turnover, read off the fixture rather than retyped.
    expect(r.technicals!.conflicts.some((c) => c.includes("only 2%"))).toBe(true);
  });

  it("says nothing on the Price Action row when spot is participating", () => {
    // Spot-led is the ABSENCE of a warning, not evidence for the direction.
    // If this ever starts pushing a confirming line, the qualifier has turned
    // back into a vote.
    const r = rows(SPOT_LED, technicalRead("bullish", 90));
    expect(r.technicals!.conflicts).toEqual([]);
  });

  it("still warns when Price Action itself has no direction to qualify", () => {
    // Strength 10 -> the price row reads neutral. The move is still leveraged,
    // and that was true on the 417 days the old wrapper used to overrule.
    const r = rows(LEVERAGE_LED, technicalRead("bullish", 10));
    expect(r.technicals!.verdict).toBe("neutral");
    expect(r.technicals!.conflicts.some((c) => /rests on leverage/.test(c))).toBe(true);
    expect(r.spv!.verdict).toBe("neutral");
  });
});
