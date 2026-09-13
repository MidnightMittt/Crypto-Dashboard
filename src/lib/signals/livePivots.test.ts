import { describe, it, expect } from "vitest";
import { livePivotProvenance, livePivotsFor } from "./livePivots";
import { buildMarketBias } from "./marketBias";
import { NEUTRAL_PIVOTS } from "./scorePivots";
import { ENGINE_VERSION } from "./engineVersion";
import { MetricVerdict, Verdict } from "./types";

/**
 * THE WIRING TEST, AND WHY IT IS A TEST RATHER THAN A BROWSER CHECK.
 *
 * The calibrated path is aggregator.ts -> buildMarketBias, and it needs live
 * funding/OI/basis from 21 exchanges. In a sandbox none of them resolve, every
 * metric is absent, and `buildMarketBias` correctly returns null — so loading
 * the crypto page proves nothing about whether the pivots arrive. This drives
 * the same composition with metrics supplied directly, using the REAL shipped
 * artifact through the REAL accessor, so the thing being checked is the wiring
 * and not a hand-built fixture of it.
 */

const metric = (id: string, verdict: Verdict, confidence = 80): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence,
  confidenceBasis: "",
  explanation: "test",
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
});

/*
 * The positioning roster reading its ORDINARY state: crowded leveraged longs,
 * which in crypto perpetuals is simply what most days look like. Under 8.0.0
 * this produced the permanent bearish pull the 9.1.0 entry describes.
 */
const ordinaryPositioning = [
  metric("funding", "bearish"),
  metric("openInterest", "bearish"),
  metric("squeezeRisk", "bearish"),
  metric("basis", "bearish"),
];

describe("livePivotsFor", () => {
  it("hands the crypto assets their measured positioning pivot", () => {
    for (const asset of ["BTC", "ETH"]) {
      const p = livePivotsFor(asset);
      expect(p.categories.positioning, `${asset}`).toBeDefined();
      expect(p.categories.positioning!.pivot).toBeLessThan(44);
    }
  });

  it("leaves an uncalibrated symbol on the hard 50", () => {
    // Equities and the search surface. Same accessor, no correction.
    expect(livePivotsFor("AAPL")).toBe(NEUTRAL_PIVOTS);
    expect(livePivotsFor("MARKET")).toBe(NEUTRAL_PIVOTS);
  });

  it("publishes provenance matching the running engine", () => {
    const p = livePivotProvenance();
    expect(p.engineVersion).toBe(ENGINE_VERSION);
    expect(p.through).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the calibration reaching buildMarketBias", () => {
  const build = (asset: string, pivots: ReturnType<typeof livePivotsFor>) =>
    buildMarketBias({
      asset,
      metrics: ordinaryPositioning,
      technicals: null,
      squeezeScore: null,
      previous: null,
      now: 0,
      pivots,
    } as never);

  it("recentres positioning, and the composite follows it", () => {
    const uncalibrated = build("BTC", NEUTRAL_PIVOTS)!;
    const calibrated = build("BTC", livePivotsFor("BTC"))!;

    const rawCat = uncalibrated.categories.find((c) => c.category === "positioning")!;
    const fixedCat = calibrated.categories.find((c) => c.category === "positioning")!;

    // A category's OWN rawScore is untouched — the evidence balance behind it
    // is preserved and still published alongside the corrected number.
    expect(fixedCat.rawScore).toBe(rawCat.rawScore);
    expect(fixedCat.score).toBe(rawCat.score! - livePivotsFor("BTC").categories.positioning!.pivot + 50);
  });

  /**
   * WHAT ACTUALLY SHIPS, PINNED: the composite gets NO pivot of its own.
   *
   * Its residual offset falls below PIVOT_MIN_OFFSET once positioning is
   * corrected, so `composite` is null in the artifact and the composite moves
   * only because it is rebuilt from already-recentred categories. Hence its
   * `rawScore` is NOT invariant across the two arms — "raw" here means before
   * the composite's own pivot, not before its inputs' — and `score` equals
   * `rawScore`, because there is no second correction on top.
   */
  it("corrects the composite indirectly, never directly", () => {
    expect(livePivotsFor("BTC").composite).toBeNull();
    const calibrated = build("BTC", livePivotsFor("BTC"))!;
    const uncalibrated = build("BTC", NEUTRAL_PIVOTS)!;
    expect(calibrated.score).toBe(calibrated.rawScore);
    expect(calibrated.rawScore).toBeGreaterThan(uncalibrated.rawScore);
  });

  /**
   * THE CORRECTION MUST NOT DEFANG THE VERDICT.
   *
   * This fixture is the positioning roster unanimously bearish at full weight
   * — not an ordinary day, an extreme one — and it must still read bearish
   * after recentring. The claim that the correction stops the engine calling
   * ORDINARY days bearish is a distributional one (61.9% -> 25.7% of 2,896
   * replayed days, see the 9.1.0 entry); a synthetic fixture cannot establish
   * it and is not asked to here.
   */
  it("still calls a genuinely extreme positioning day bearish", () => {
    expect(build("BTC", NEUTRAL_PIVOTS)!.verdict).toBe("bearish");
    expect(build("BTC", livePivotsFor("BTC"))!.verdict).toBe("bearish");
  });

  it("leaves an uncalibrated asset scoring exactly as it did before 9.1.0", () => {
    const equity = build("AAPL", livePivotsFor("AAPL"))!;
    expect(equity.score).toBe(equity.rawScore);
  });
});
