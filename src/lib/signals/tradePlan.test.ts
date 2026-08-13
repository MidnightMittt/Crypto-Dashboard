import { describe, expect, it } from "vitest";
import { buildTradePlanOutcome, PlanConstraints, TradePlanInputs } from "./tradePlan";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";

function zone(kind: "support" | "resistance", priceLow: number, priceHigh: number): SupportResistanceZone {
  return {
    priceLow,
    priceHigh,
    kind,
    strength: 70,
    reactionCount: 3,
    confluence: [],
    status: "inactive",
    mostRecentTouchBarsAgo: 10,
    source: "swing-cluster",
    timeframe: "1D",
  };
}

/**
 * Price 100, ATR 3%. Long pullback into support 92–96: worst fill 96, stop
 * beyond the zone at 92 − 0.25×3 = 91.25, so risk = 4.75 → 4.95% of entry.
 * Primary target at the resistance zone's near edge — ≥ 8/96 ≈ 8.3% away.
 * These hand-derived distances are what the constraint thresholds below are
 * chosen around.
 */
function inputs(overrides: Partial<TradePlanInputs> = {}): TradePlanInputs {
  return {
    direction: "long",
    anchorPrice: 100,
    atrPct: 3,
    zones: [zone("support", 92, 96), zone("resistance", 104, 108)],
    quality: { confidence: 70, agreement: 70, historicalWinRatePct: 55, historicalWinRateN: 40 },
    ...overrides,
  };
}

const constraints = (over: Partial<PlanConstraints> = {}): PlanConstraints => ({
  cellKey: "long:normal-vol",
  n: 59,
  evLowerPct: 1,
  winnersMaeP50Pct: 2.2,
  winnersMaeP80Pct: 3,
  winnersMfeP75Pct: 20,
  ...over,
});

describe("excursion/EV constraints (redesign §10)", () => {
  it("builds identically to the pre-constraint engine when no constraints are supplied", () => {
    const out = buildTradePlanOutcome(inputs());
    expect(out.plan).not.toBeNull();
    expect(out.plan!.expectedDrawdownPct).toBeNull();
    expect(out.plan!.evLowerPct).toBeNull();
  });

  it("refuses a side+regime whose replayed record is EV-negative at the Wilson lower bound, before any geometry", () => {
    // No zones at all — normally a "no-structure" refusal — but the EV gate
    // fires FIRST because no arrangement of levels can rescue the bucket.
    const out = buildTradePlanOutcome(inputs({ zones: [], constraints: constraints({ evLowerPct: -0.65 }) }));
    expect(out.refusal).toBe("negative-expectancy");
  });

  it("refuses a stop inside the drawdown 80% of winners endured", () => {
    // Risk distance is 4.95% of entry (hand-derived above); a p80 winners'
    // MAE of 6% means winning trades routinely drew down past this stop.
    const out = buildTradePlanOutcome(inputs({ constraints: constraints({ winnersMaeP80Pct: 6 }) }));
    expect(out.refusal).toBe("stop-tighter-than-winners-drawdown");
  });

  it("refuses a primary target beyond where 75% of winners ever reached", () => {
    // Target sits ≥ 8.3% away; winners' p75 MFE of 5% says the strategy does
    // not produce that excursion.
    const out = buildTradePlanOutcome(inputs({ constraints: constraints({ winnersMfeP75Pct: 5 }) }));
    expect(out.refusal).toBe("target-beyond-winners-reach");
  });

  it("annotates (never moves) a stretch target beyond winners' reach, and stamps the measured fields", () => {
    const out = buildTradePlanOutcome(inputs({ constraints: constraints() }));
    expect(out.plan).not.toBeNull();
    const plan = out.plan!;
    expect(plan.expectedDrawdownPct).toBe(2.2);
    expect(plan.evLowerPct).toBe(1);
    const t2DistancePct = (Math.abs(plan.target2Price - plan.entryRef) / plan.entryRef) * 100;
    if (t2DistancePct > 20) {
      expect(plan.target2Basis).toContain("beyond the excursion");
    } else {
      expect(plan.target2Basis).not.toContain("beyond the excursion");
    }
  });

  it("treats missing individual fields as no constraint, never as zero", () => {
    // A thin cell publishes EV but no excursion quantiles — the plan must
    // build rather than compare against a fabricated 0% floor.
    const out = buildTradePlanOutcome(
      inputs({
        constraints: constraints({ winnersMaeP50Pct: null, winnersMaeP80Pct: null, winnersMfeP75Pct: null }),
      })
    );
    expect(out.plan).not.toBeNull();
    expect(out.plan!.expectedDrawdownPct).toBeNull();
  });
});
