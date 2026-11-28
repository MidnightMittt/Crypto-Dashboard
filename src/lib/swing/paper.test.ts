import { describe, it, expect } from "vitest";
import { stepPaperPosition, unrealisedPnl, remainingRisk } from "./paper";
import { sizePosition, checkRiskConstraints, applyScaleOut, correlationGroup } from "./risk";
import { opportunityId, detectTrigger, derivePreEntryState, describeTransition } from "./lifecycle";
import { PaperPosition, DEFAULT_RISK_CONFIG, RiskConfig, SwingTarget } from "./types";
import { SupportResistanceZone } from "../technicals/marketStructure";
import { Candle } from "../technicals/indicators";

const T0 = Date.parse("2024-01-01T00:00:00Z");
const DAY = 86_400_000;
const bar = (o: number, h: number, l: number, c: number, i = 0): Candle => ({
  t: T0 + i * DAY, open: o, high: h, low: l, close: c, volumeUsd: 1_000,
});

/** No fees or slippage, so arithmetic in the assertions is exact. */
const CLEAN: RiskConfig = { ...DEFAULT_RISK_CONFIG, feeRate: 0, slippageRate: 0 };

const targets: SwingTarget[] = [
  { price: 110, basis: "TP1", rMultiple: 1, closeFraction: 0.4 },
  { price: 120, basis: "TP2", rMultiple: 2, closeFraction: 0.35 },
  { price: 130, basis: "TP3", rMultiple: 3, closeFraction: 0.25 },
];

function longPosition(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "p1", opportunityId: "BTC:long:100-102", asset: "BTC", direction: "long",
    state: "ACTIVE", openedAt: T0, closedAt: null,
    entryPrice: 100, quantity: 10, remainingQuantity: 10, stopPrice: 90,
    targets, fills: [], realisedPnl: 0,
    thesis: { reasons: [], familyCount: 3, htfAligned: true, trendDirection: "up", entryBasis: "", stopBasis: "" },
    ...over,
  };
}

describe("paper execution — the conservative rules", () => {
  it("AMBIGUOUS BAR GOES TO THE STOP, not the target", () => {
    // This bar's range contains TP1 (110) AND the stop (90). The bar cannot
    // say which came first, so the stop is assumed.
    const r = stepPaperPosition({ position: longPosition(), bar: bar(100, 115, 88, 95), config: CLEAN });
    expect(r.position.state).toBe("COMPLETED");
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].reason).toBe("stop");
    expect(r.fills[0].note).toContain("conservative");
    expect(r.position.realisedPnl).toBe(-100); // 10 units × (90-100)
  });

  it("A GAP THROUGH THE STOP FILLS AT THE OPEN, not the stop price", () => {
    // Opened at 80 with a stop at 90 — there was never a chance to transact
    // at 90. Filling there would manufacture liquidity and understate the loss.
    const r = stepPaperPosition({ position: longPosition(), bar: bar(80, 82, 78, 79), config: CLEAN });
    expect(r.fills[0].price).toBe(80);
    expect(r.fills[0].note).toContain("GAPPED");
    expect(r.position.realisedPnl).toBe(-200); // 10 × (80-100), worse than the -100 a stop fill implies
  });

  it("scales out at each target by fraction of the ORIGINAL quantity", () => {
    let p = longPosition();
    // TP1 only
    let r = stepPaperPosition({ position: p, bar: bar(100, 112, 99, 111), config: CLEAN });
    expect(r.position.state).toBe("PARTIALLY_EXITED");
    expect(r.position.remainingQuantity).toBeCloseTo(6, 10); // 40% of 10 closed
    expect(r.position.realisedPnl).toBeCloseTo(40, 10);      // 4 × (110-100)

    // TP2 next bar
    r = stepPaperPosition({ position: r.position, bar: bar(111, 121, 110, 120), config: CLEAN });
    expect(r.position.remainingQuantity).toBeCloseTo(2.5, 10); // another 35% of 10
    expect(r.position.realisedPnl).toBeCloseTo(40 + 3.5 * 20, 10);

    // TP3 closes the rest
    r = stepPaperPosition({ position: r.position, bar: bar(120, 131, 119, 130), config: CLEAN });
    expect(r.position.remainingQuantity).toBe(0);
    expect(r.position.state).toBe("COMPLETED");
  });

  it("does not re-fill a target that already filled", () => {
    let r = stepPaperPosition({ position: longPosition(), bar: bar(100, 112, 99, 111), config: CLEAN });
    const after1 = r.position.remainingQuantity;
    // Same level touched again — must not sell another 40%.
    r = stepPaperPosition({ position: r.position, bar: bar(111, 113, 109, 112), config: CLEAN });
    expect(r.position.remainingQuantity).toBe(after1);
    expect(r.fills).toHaveLength(0);
  });

  it("charges fees and slippage adversely on both sides", () => {
    const withCosts: RiskConfig = { ...DEFAULT_RISK_CONFIG, feeRate: 0.001, slippageRate: 0.001 };
    const clean = stepPaperPosition({ position: longPosition(), bar: bar(100, 112, 99, 111), config: CLEAN });
    const costly = stepPaperPosition({ position: longPosition(), bar: bar(100, 112, 99, 111), config: withCosts });
    // A long selling at TP1 fills LOWER with slippage, and pays a fee.
    expect(costly.fills[0].price).toBeLessThan(clean.fills[0].price);
    expect(costly.fills[0].fee).toBeGreaterThan(0);
    expect(costly.position.realisedPnl).toBeLessThan(clean.position.realisedPnl);
  });

  it("mirrors correctly for a short", () => {
    const short = longPosition({
      direction: "short", entryPrice: 100, stopPrice: 110,
      targets: [{ price: 90, basis: "TP1", rMultiple: 1, closeFraction: 1 }],
    });
    const r = stepPaperPosition({ position: short, bar: bar(100, 101, 89, 90), config: CLEAN });
    expect(r.fills[0].reason).toBe("tp1");
    expect(r.position.realisedPnl).toBeCloseTo(100, 10); // 10 × (100-90)
  });

  it("does nothing once completed", () => {
    const done = longPosition({ state: "COMPLETED", remainingQuantity: 0 });
    const r = stepPaperPosition({ position: done, bar: bar(100, 200, 50, 150), config: CLEAN });
    expect(r.fills).toHaveLength(0);
  });

  it("reports unrealised P&L and remaining risk only while open", () => {
    const p = longPosition();
    expect(unrealisedPnl(p, 105)).toBe(50);
    expect(remainingRisk(p)).toBe(100);
    const flat = longPosition({ remainingQuantity: 0 });
    expect(unrealisedPnl(flat, 105)).toBe(0);
    expect(remainingRisk(flat)).toBe(0);
  });
});

describe("risk management", () => {
  it("sizes from the stop distance so risk is constant", () => {
    const cfg = { ...DEFAULT_RISK_CONFIG, accountEquity: 10_000, maxRiskPerTrade: 0.01 };
    const tight = sizePosition(100, 98, "long", cfg)!;   // 2% stop
    const wide = sizePosition(100, 90, "long", cfg)!;    // 10% stop
    expect(tight.riskAmount).toBeCloseTo(100, 6);
    expect(wide.riskAmount).toBeCloseTo(100, 6);          // SAME risk
    expect(tight.quantity).toBeGreaterThan(wide.quantity); // tighter stop ⇒ more size
  });

  it("refuses a malformed plan rather than sizing it", () => {
    expect(sizePosition(100, 105, "long", DEFAULT_RISK_CONFIG)).toBeNull();  // stop above entry on a long
    expect(sizePosition(100, 95, "short", DEFAULT_RISK_CONFIG)).toBeNull();  // stop below entry on a short
  });

  const sizing = sizePosition(100, 90, "long", DEFAULT_RISK_CONFIG)!;
  const base = { asset: "BTC", riskReward: 3, sizing, config: DEFAULT_RISK_CONFIG };

  it("allows a sound trade", () => {
    expect(checkRiskConstraints({ ...base, state: { openPositions: [], realisedToday: 0, realisedThisWeek: 0 } })).toBeNull();
  });

  it("refuses below the minimum risk/reward", () => {
    const r = checkRiskConstraints({ ...base, riskReward: 1.0, state: { openPositions: [], realisedToday: 0, realisedThisWeek: 0 } });
    expect(r).toContain("Risk/reward");
  });

  it("refuses after the daily loss limit", () => {
    const r = checkRiskConstraints({ ...base, state: { openPositions: [], realisedToday: -500, realisedThisWeek: -500 } });
    expect(r).toContain("Daily loss limit");
  });

  it("refuses past the correlated-position cap", () => {
    // Deliberately TINY remaining size, so total open risk stays well under
    // the portfolio cap and the CORRELATION rule is what actually fires.
    // The first version used full-size positions and tripped the portfolio
    // limit first — the checks are ordered by severity, so the test was
    // exercising a different rule than it named.
    const open = [
      longPosition({ asset: "ETH", remainingQuantity: 0.5 }),
      longPosition({ asset: "SOL", remainingQuantity: 0.5 }),
    ];
    const r = checkRiskConstraints({ ...base, state: { openPositions: open, realisedToday: 0, realisedThisWeek: 0 } });
    expect(r).toContain("crypto-major");
  });

  it("counts open risk on REMAINING quantity, not original", () => {
    // A position scaled down to a tenth carries a tenth of the risk. Counting
    // it at full size would lock out trades the book can afford.
    const scaled = longPosition({ asset: "ETH", remainingQuantity: 1, state: "PARTIALLY_EXITED" });
    const r = checkRiskConstraints({ ...base, state: { openPositions: [scaled], realisedToday: 0, realisedThisWeek: 0 } });
    expect(r).toBeNull();
  });

  it("renormalises scale-out when only two targets exist", () => {
    const two = applyScaleOut([{ price: 1, basis: "a", rMultiple: 1 }, { price: 2, basis: "b", rMultiple: 2 }], DEFAULT_RISK_CONFIG);
    const total = two.reduce((s, t) => s + t.closeFraction, 0);
    expect(total).toBeCloseTo(1, 10); // the position still fully exits
  });

  it("groups crypto majors together", () => {
    expect(correlationGroup("BTC")).toBe(correlationGroup("ETH"));
    expect(correlationGroup("AAPL")).not.toBe(correlationGroup("BTC"));
  });
});

describe("lifecycle", () => {
  const zone = (o: Partial<SupportResistanceZone> = {}): SupportResistanceZone => ({
    priceLow: 100, priceHigh: 102, kind: "support", strength: 50, reactionCount: 3,
    confluence: [], status: "testing", mostRecentTouchBarsAgo: 3,
    source: "swing-cluster", timeframe: "1D", ...o,
  });

  it("gives a setup a STABLE id across small zone drift", () => {
    const a = opportunityId("BTC", "long", zone({ priceLow: 60000, priceHigh: 60500 }));
    const b = opportunityId("BTC", "long", zone({ priceLow: 60001, priceHigh: 60499 }));
    expect(a).toBe(b); // one dollar of drift must NOT mint a new opportunity
  });

  it("distinguishes different assets, directions and levels", () => {
    expect(opportunityId("BTC", "long", zone())).not.toBe(opportunityId("ETH", "long", zone()));
    expect(opportunityId("BTC", "long", zone())).not.toBe(opportunityId("BTC", "short", zone()));
  });

  it("CONFLUENCE CANNOT SATISFY A TRIGGER — only price action can", () => {
    // A zone with every confluence tag in existence, but price nowhere near it.
    const loaded = zone({ confluence: ["swing-cluster", "volume-poc", "value-area-edge", "multi-timeframe"], strength: 100 });
    const candles = [bar(200, 201, 199, 200, 0), bar(200, 201, 199, 200, 1), bar(200, 201, 199, 200, 2)];
    expect(detectTrigger({ direction: "long", zone: loaded, candles }).satisfied).toBe(false);
  });

  it("fires a long rejection trigger only when the bar closes back above the zone", () => {
    const base = [bar(105, 106, 104, 105, 0), bar(105, 106, 104, 105, 1)];
    // Wicked into the zone and closed above it.
    const good = detectTrigger({ direction: "long", zone: zone(), candles: [...base, bar(104, 105, 99, 104, 2)] });
    expect(good.satisfied).toBe(true);
    // Wicked in and closed INSIDE it — not a rejection.
    const bad = detectTrigger({ direction: "long", zone: zone(), candles: [...base, bar(104, 105, 99, 101, 2)] });
    expect(bad.satisfied).toBe(false);
  });

  it("derives pre-entry states from geometry", () => {
    const candles = Array.from({ length: 30 }, (_, i) => bar(100, 102, 98, 100, i));
    const t = { kind: "rejection" as const, description: "", price: null, satisfied: false };
    const common = { entryLow: 99, entryHigh: 101, stopPrice: 95, direction: "long" as const, candles };
    expect(derivePreEntryState({ ...common, price: 100, trigger: t })).toBe("WAITING_CONFIRMATION");
    expect(derivePreEntryState({ ...common, price: 100, trigger: { ...t, satisfied: true } })).toBe("ENTRY_CONFIRMED");
    expect(derivePreEntryState({ ...common, price: 94, trigger: t })).toBe("INVALIDATED");
    expect(derivePreEntryState({ ...common, price: 140, trigger: t })).toBe("WATCHING");
  });

  it("returns null for an unchanged state so alerts are tied to TRANSITIONS", () => {
    expect(describeTransition("WATCHING", "WATCHING", "BTC", "long")).toBeNull();
    expect(describeTransition("WATCHING", "APPROACHING", "BTC", "long")).toContain("approaching");
  });
});
