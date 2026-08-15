import { describe, expect, it } from "vitest";
import { etfFlowsMetric } from "./evaluators";
import { AggregateMarketData } from "@/types/market";

type Etf = NonNullable<AggregateMarketData["etfFlows"]>;

const summary = (over: Partial<Etf> = {}): Etf =>
  ({
    netFlowUsd: 300e6,
    netFlow5dUsd: 900e6,
    typicalAbsFlowUsd: 200e6,
    latestDate: "2026-08-14",
    isStale: false,
    ageDays: 0,
    ...over,
  }) as Etf;

/*
 * THE ONE VALIDATED MODULE. As of 2026-08-15 this is the only signal that
 * clears the Wilson gate AND survives FDR across the candidate family, so it
 * is the single reading allowed to move a decision — which makes a second,
 * drifting implementation of it the most expensive duplication available.
 * Extracting it from the aggregate-only evaluator is what lets the dossier
 * and the dashboard reach the same answer.
 */
describe("etfFlowsMetric", () => {
  it("judges flow against the complex's OWN typical day, not a fixed dollar bar", () => {
    // +$300M against a $200M typical day is 1.5x — comfortably directional.
    expect(etfFlowsMetric(summary(), 0)?.verdict).toBe("bullish");
    // The same +$300M against a $1B typical day is an ordinary session.
    expect(etfFlowsMetric(summary({ typicalAbsFlowUsd: 1e9 }), 0)?.verdict).toBe("neutral");
  });

  it("reads sustained outflows as bearish", () => {
    const m = etfFlowsMetric(summary({ netFlowUsd: -300e6, netFlow5dUsd: -800e6 }), 0);
    expect(m?.verdict).toBe("bearish");
  });

  /*
   * One session is noisy. When the latest print fights the 5-day trend the
   * module still calls the day, but says so — an unflagged reversal reads as
   * conviction it does not have.
   */
  it("flags a single day that contradicts its own 5-day trend", () => {
    const m = etfFlowsMetric(summary({ netFlowUsd: 300e6, netFlow5dUsd: -800e6 }), 0);
    expect(m?.verdict).toBe("bullish");
    expect(m?.conflicts.join(" ")).toContain("counter to the 5-day trend");
  });

  it("discounts a stale print rather than hiding it", () => {
    const fresh = etfFlowsMetric(summary(), 0)!;
    const stale = etfFlowsMetric(summary({ isStale: true, ageDays: 3 }), 0)!;
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.conflicts.join(" ")).toContain("days old");
  });

  /*
   * `asOf` is a parameter precisely so the two callers can stamp differently
   * — the aggregate has an update clock, a dossier request has the moment it
   * was served. Reading it from a blob is what made this aggregate-only.
   */
  it("stamps with the caller's clock", () => {
    expect(etfFlowsMetric(summary(), 1_700_000_000_000)?.asOf).toBe(1_700_000_000_000);
  });

  it("returns null for an asset with no ETF complex rather than a neutral vote", () => {
    // Everything except BTC and ETH. A neutral reading would be a claim.
    expect(etfFlowsMetric(null, 0)).toBeNull();
  });
});
