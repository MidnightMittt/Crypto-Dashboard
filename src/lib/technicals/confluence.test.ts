import { describe, it, expect } from "vitest";
import { assessConfluence, maTrendContext, computeMovingAverages } from "./confluence";
import { SupportResistanceZone } from "./marketStructure";
import { fibFromLastLeg } from "./fibonacci";
import { Candle } from "./indicators";
import { sma, ema, closes } from "./indicators";

const DAY = 86_400_000;
const T0 = Date.parse("2024-01-01T00:00:00Z");

/** Flat-ish series around `base`, so ATR is small and "near the zone" is tight. */
function flat(n: number, base = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: T0 + i * DAY, open: base, high: base + 1, low: base - 1, close: base, volumeUsd: 1_000,
  }));
}

/** Steady uptrend — every average below price and rising. */
function uptrend(n: number, from = 50, to = 150): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = from + ((to - from) * i) / (n - 1);
    return { t: T0 + i * DAY, open: p, high: p + 1, low: p - 1, close: p, volumeUsd: 1_000 };
  });
}

function zone(p: Partial<SupportResistanceZone> = {}): SupportResistanceZone {
  return {
    priceLow: 99, priceHigh: 101, kind: "support", strength: 50, reactionCount: 3,
    confluence: [], status: "testing", mostRecentTouchBarsAgo: 4,
    source: "swing-cluster", timeframe: "1D", ...p,
  };
}

describe("sma", () => {
  it("averages the last `period` values and differs from the EMA on a trend", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 5)).toBeNull();
    // On a rising series the EMA leads the SMA — if these were equal, one of
    // them would be mis-implemented.
    const c = closes(uptrend(260));
    const s = sma(c, 200)!, e = ema(c, 200)!;
    expect(e).toBeGreaterThan(s);
  });
});

describe("maTrendContext", () => {
  it("collapses six averages into ONE direction rather than six confirmations", () => {
    const ctx = maTrendContext(uptrend(260));
    expect(ctx.direction).toBe("up");
    expect(ctx.above).toBe(ctx.available); // price above all of them
    expect(ctx.longSlopePct).toBeGreaterThan(0);
  });

  it("reports unknown rather than guessing when there is too little history", () => {
    expect(maTrendContext(flat(5)).direction).toBe("unknown");
  });

  it("flags a pullback only when price has actually come back to the fast EMA", () => {
    const trend = uptrend(260);

    // A STEADY CLIMB IS NOT A PULLBACK. On a linear advance the EMA lags by
    // ~half its period, leaving price persistently >1 ATR above it. The first
    // version of this test asserted `true` here, which was wrong about the
    // market, not about the code: price marching away from its average is the
    // opposite of pulling back toward it.
    expect(maTrendContext(trend).pullbackInTrend).toBe(false);
    expect(maTrendContext(trend).extensionAtr!).toBeGreaterThan(1);

    // Now let price retrace toward the average while the trend stays intact.
    const last = trend[trend.length - 1].close;
    const dip = [last - 1.5, last - 2.5, last - 3.2, last - 3.4].map((p, i) => ({
      t: T0 + (260 + i) * DAY, open: p, high: p + 1, low: p - 1, close: p, volumeUsd: 1_000,
    }));
    const pulled = maTrendContext([...trend, ...dip]);
    expect(pulled.direction).toBe("up");          // trend intact
    expect(pulled.pullbackInTrend).toBe(true);    // but price is back at the EMA

    // A spike far above is trending and emphatically not a pullback.
    const spiked = [...trend, { t: T0 + 300 * DAY, open: 400, high: 410, low: 395, close: 405, volumeUsd: 1_000 }];
    expect(maTrendContext(spiked).pullbackInTrend).toBe(false);
  });
});

describe("assessConfluence — the anti-double-counting contract", () => {
  const candles = flat(60);

  it("counts a family AT MOST ONCE even when several members qualify", () => {
    // BOTH a weekly and a monthly zone overlap. That is one kind of
    // agreement, not two.
    const higher = [
      zone({ timeframe: "1W", priceLow: 98, priceHigh: 102 }),
      zone({ timeframe: "1M", priceLow: 97, priceHigh: 103 }),
    ];
    const a = assessConfluence({ zone: zone(), candles, higherZones: higher });
    expect(a.factors.filter((f) => f.family === "higher-timeframe")).toHaveLength(1);
  });

  it("counts ONE moving-average factor even when several averages sit in the zone", () => {
    // Flat series ⇒ every average lands at ~100, inside the 99-101 zone.
    const mas = computeMovingAverages(flat(260, 100));
    const a = assessConfluence({ zone: zone(), candles: flat(260, 100), mas });
    expect(a.factors.filter((f) => f.family === "moving-average")).toHaveLength(1);
    // and it names the most significant one that qualifies
    expect(a.factors.find((f) => f.family === "moving-average")!.detail).toContain("200");
  });

  it("never returns more factors than there are families", () => {
    const mas = computeMovingAverages(flat(260, 100));
    const a = assessConfluence({
      zone: zone({ status: "reclaiming" }),
      candles: flat(260, 100),
      higherZones: [zone({ timeframe: "1M", priceLow: 98, priceHigh: 102 })],
      mas,
    });
    expect(a.factors.length).toBeLessThanOrEqual(5);
    expect(new Set(a.factors.map((f) => f.family)).size).toBe(a.factors.length);
  });
});

describe("assessConfluence — what does and does not qualify", () => {
  const candles = flat(260, 100);

  it("does NOT count a moving average that is far from the zone", () => {
    const mas = computeMovingAverages(candles); // all ≈100
    const far = zone({ priceLow: 300, priceHigh: 302 });
    const a = assessConfluence({ zone: far, candles, mas });
    expect(a.factors.some((f) => f.family === "moving-average")).toBe(false);
  });

  it("does NOT count structure for a volume-profile zone with no touches", () => {
    const a = assessConfluence({ zone: zone({ reactionCount: 0, source: "volume-poc" }), candles });
    expect(a.factors.some((f) => f.family === "structure")).toBe(false);
  });

  it("counts price-action for a REACTION, not for mere proximity", () => {
    expect(assessConfluence({ zone: zone({ status: "testing" }), candles })
      .factors.some((f) => f.family === "price-action")).toBe(false);
    expect(assessConfluence({ zone: zone({ status: "rejecting" }), candles })
      .factors.some((f) => f.family === "price-action")).toBe(true);
    expect(assessConfluence({ zone: zone({ status: "reclaiming" }), candles })
      .factors.some((f) => f.family === "price-action")).toBe(true);
  });

  it("does NOT count a higher-timeframe zone of the OPPOSITE kind", () => {
    const higher = [zone({ timeframe: "1M", kind: "resistance", priceLow: 99, priceHigh: 101 })];
    const a = assessConfluence({ zone: zone({ kind: "support" }), candles, higherZones: higher });
    expect(a.factors.some((f) => f.family === "higher-timeframe")).toBe(false);
  });

  it("MISSING DATA MUST NOT MANUFACTURE CONFLUENCE", () => {
    // No MAs, no fib, no higher zones, no reaction — a bare zone is weak, and
    // absence of evidence must not read as evidence.
    const a = assessConfluence({ zone: zone({ reactionCount: 0, status: "inactive" }), candles: flat(10) });
    expect(a.familyCount).toBe(0);
    expect(a.quality).toBe("none");
  });

  it("grades quality by INDEPENDENT families, not indicator count", () => {
    const mas = computeMovingAverages(candles);
    const strong = assessConfluence({
      zone: zone({ status: "reclaiming", reactionCount: 4 }),
      candles,
      higherZones: [zone({ timeframe: "1M", priceLow: 98, priceHigh: 102 })],
      mas,
    });
    expect(strong.familyCount).toBeGreaterThanOrEqual(4);
    expect(strong.quality).toBe("strong");

    const weak = assessConfluence({ zone: zone({ status: "testing" }), candles });
    expect(weak.quality).toBe("weak");
  });
});

describe("fibFromLastLeg", () => {
  const mk = (pts: number[]): Candle[] =>
    pts.map((p, i) => ({ t: T0 + i * DAY, open: p, high: p + 1.5, low: p - 1.5, close: p, volumeUsd: 1_000 }));

  /**
   * Ends on a CONFIRMED HIGH: low@4=90, rally to high@10=130, then two bars of
   * decline — enough to confirm the high with lookback=2, but not enough bars
   * remaining to confirm a new low. So the most recent completed leg is UP.
   *
   * The earlier version of this fixture ran four more bars and printed a
   * confirmed low after the high, which made the most recent leg a DOWN leg —
   * the code was right and the fixture was wrong.
   */
  function legUp(): Candle[] {
    return mk([100, 98, 95, 92, 90, 95, 102, 110, 118, 125, 130, 128, 126]);
  }

  /** Mirror: ends on a confirmed LOW, so the most recent leg is DOWN. */
  function legDown(): Candle[] {
    return mk([100, 110, 118, 125, 130, 125, 118, 110, 102, 95, 90, 93, 96]);
  }

  it("anchors on CONFIRMED pivots and reports leg direction", () => {
    const leg = fibFromLastLeg(legUp(), 2);
    expect(leg).not.toBeNull();
    expect(leg!.direction).toBe("up");
    expect(leg!.anchorHigh).toBeGreaterThan(leg!.anchorLow);
  });

  it("produces 5 retracements and 2 extensions", () => {
    const leg = fibFromLastLeg(legUp(), 2)!;
    expect(leg.levels.filter((l) => l.kind === "retracement")).toHaveLength(5);
    expect(leg.levels.filter((l) => l.kind === "extension")).toHaveLength(2);
    expect(leg.levels.map((l) => l.ratio)).toContain(1.618);
  });

  it("places up-leg extensions ABOVE the swing high", () => {
    const leg = fibFromLastLeg(legUp(), 2)!;
    for (const e of leg.levels.filter((l) => l.kind === "extension")) {
      expect(e.price).toBeGreaterThan(leg.anchorHigh);
    }
  });

  it("places retracements INSIDE the leg", () => {
    const leg = fibFromLastLeg(legUp(), 2)!;
    for (const r of leg.levels.filter((l) => l.kind === "retracement")) {
      expect(r.price).toBeGreaterThanOrEqual(leg.anchorLow);
      expect(r.price).toBeLessThanOrEqual(leg.anchorHigh);
    }
  });

  it("mirrors correctly on a DOWN leg — extensions below the low", () => {
    const leg = fibFromLastLeg(legDown(), 2)!;
    expect(leg.direction).toBe("down");
    for (const e of leg.levels.filter((l) => l.kind === "extension")) {
      expect(e.price).toBeLessThan(leg.anchorLow);
    }
  });

  it("returns null rather than inventing anchors when no pivots exist", () => {
    expect(fibFromLastLeg(flat(40), 3)).toBeNull(); // perfectly flat: no strict extremes
    expect(fibFromLastLeg(flat(3), 3)).toBeNull();  // too short
  });
});
