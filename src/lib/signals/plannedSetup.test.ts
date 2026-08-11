import { describe, expect, it } from "vitest";
import {
  buildPlannedSetups,
  readPlannedSetups,
  favouredDirection,
  PlannedSetupInputs,
  APPROACH_ATR,
} from "./plannedSetup";
import { SupportResistanceZone, ZoneTimeframe } from "@/lib/technicals/marketStructure";

function zone(
  kind: "support" | "resistance",
  priceLow: number,
  priceHigh: number,
  timeframe: ZoneTimeframe = "1D"
): SupportResistanceZone {
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
    timeframe,
  };
}

/** Price 100, ATR 3. Support 92-96 below, resistance 104-108 above — both reachable. */
const ZONES = [zone("support", 92, 96), zone("resistance", 104, 108)];

function inputs(overrides: Partial<PlannedSetupInputs> = {}): PlannedSetupInputs {
  return {
    t: 1000,
    closePrice: 100,
    atrPct: 3,
    zones: ZONES,
    dailyDirection: "bullish",
    fourHourDirection: "bullish",
    quality: { confidence: 70, agreement: 70, historicalWinRatePct: 55, historicalWinRateN: 40 },
    ...overrides,
  };
}

describe("favouredDirection", () => {
  it("favours a side only when both swing timeframes agree", () => {
    expect(favouredDirection("bullish", "bullish").direction).toBe("long");
    expect(favouredDirection("bearish", "bearish").direction).toBe("short");
  });

  it("favours NEITHER side when the timeframes conflict", () => {
    // This is the range case. Calling one primary here would invent a
    // directional read the evidence doesn't contain.
    const result = favouredDirection("bullish", "bearish");
    expect(result.direction).toBeNull();
    expect(result.rationale).toContain("conflict");
  });

  it("lets the daily set the lean when 4H is neutral or absent", () => {
    expect(favouredDirection("bearish", "neutral").direction).toBe("short");
    expect(favouredDirection("bearish", null).direction).toBe("short");
    expect(favouredDirection("bearish", null).rationale).toContain("no 4H read");
  });

  it("favours nothing when the daily itself has no direction", () => {
    expect(favouredDirection("neutral", "bullish").direction).toBeNull();
    expect(favouredDirection(null, "bullish").direction).toBeNull();
  });
});

describe("buildPlannedSetups", () => {
  it("produces BOTH sides regardless of any directional opinion", () => {
    // The whole point: a setup is a statement about structure, so it exists
    // even when the engine has no view. Neutral daily, neutral 4H, and both
    // levels are still real.
    const frozen = buildPlannedSetups(inputs({ dailyDirection: "neutral", fourHourDirection: "neutral" }))!;

    expect(frozen.long).not.toBeNull();
    expect(frozen.short).not.toBeNull();
    expect(frozen.favoured).toBeNull();
  });

  it("anchors the long at support and the short at resistance", () => {
    const frozen = buildPlannedSetups(inputs())!;

    expect(frozen.long!.entryLow).toBe(92);
    expect(frozen.long!.entryHigh).toBe(96);
    expect(frozen.long!.stopPrice).toBeCloseTo(91.25, 5); // below the retested zone
    expect(frozen.long!.target1Price).toBeGreaterThan(100);

    expect(frozen.short!.entryLow).toBe(104);
    expect(frozen.short!.entryHigh).toBe(108);
    expect(frozen.short!.stopPrice).toBeCloseTo(108.75, 5); // above the retested zone
    expect(frozen.short!.target1Price).toBeLessThan(100);
  });

  it("measures reward:risk from the WORST fill in the zone, so the ratio is a floor", () => {
    // Entry zone 92-96. A long pays at most 96, so that is what risk and
    // reward are measured from — quoting the midpoint would inflate the
    // ratio purely by choosing where inside its own zone to stand.
    const long = buildPlannedSetups(inputs())!.long!;
    expect(long.entryRef).toBe(96);
    const expected = Math.abs(long.target1Price - long.entryRef) / Math.abs(long.entryRef - long.stopPrice);
    expect(long.riskRewardRatio).toBeCloseTo(expected, 5);

    // A short sells at worst at the BOTTOM of its zone.
    const short = buildPlannedSetups(inputs())!.short!;
    expect(short.entryRef).toBe(104);
  });

  it("returns null for a side structure cannot support, rather than inventing one", () => {
    // Support only, no resistance above: there is no honest short here.
    const frozen = buildPlannedSetups(inputs({ zones: [zone("support", 92, 96)] }))!;
    expect(frozen.long).not.toBeNull();
    expect(frozen.short).toBeNull();
  });

  it("returns null entirely when there is no ATR to size anything", () => {
    expect(buildPlannedSetups(inputs({ atrPct: null }))).toBeNull();
  });

  it("names the timeframe a level came from, including multi-timeframe confirmation", () => {
    const frozen = buildPlannedSetups(inputs({ zones: [zone("support", 92, 96, "both"), zone("resistance", 104, 108)] }))!;
    expect(frozen.long!.entryBasis).toContain("daily + 4H");
  });
});

describe("readPlannedSetups — price only moves status, never levels", () => {
  const frozen = buildPlannedSetups(inputs())!;

  it("is byte-identical across many reads at the same price", () => {
    const first = readPlannedSetups(frozen, 100);
    for (let i = 0; i < 200; i++) {
      expect(readPlannedSetups(frozen, 100)).toEqual(first);
    }
  });

  it("keeps every level fixed as price moves — the whole point of the split", () => {
    const at100 = readPlannedSetups(frozen, 100)!;
    const at97 = readPlannedSetups(frozen, 97)!;
    const at94 = readPlannedSetups(frozen, 94)!;

    for (const view of [at97, at94]) {
      const long = view.setups.find((s) => s.direction === "long")!;
      const reference = at100.setups.find((s) => s.direction === "long")!;
      expect(long.plan).toEqual(reference.plan);
    }
  });

  it("walks waiting -> approaching -> at-entry as price closes in", () => {
    // ATR 3, APPROACH_ATR 0.75 => approaching within 2.25 of the zone edge (96).
    expect(readPlannedSetups(frozen, 100)!.setups.find((s) => s.direction === "long")!.status).toBe("waiting");
    expect(readPlannedSetups(frozen, 97.5)!.setups.find((s) => s.direction === "long")!.status).toBe("approaching");
    expect(readPlannedSetups(frozen, 94)!.setups.find((s) => s.direction === "long")!.status).toBe("at-entry");
  });

  it("marks a setup invalidated once price breaks the level it was built on", () => {
    const long = readPlannedSetups(frozen, 90)!.setups.find((s) => s.direction === "long")!;
    expect(long.status).toBe("invalidated");
    expect(long.trigger).toContain("no longer holds");
  });

  it("states the move required in plain English, leaving price formatting to the UI", () => {
    const long = readPlannedSetups(frozen, 100)!.setups.find((s) => s.direction === "long")!;
    // 100 -> 96 is a 4% fall to the top of the entry zone.
    expect(long.trigger).toContain("fall 4.0%");
    expect(long.triggerPrice).toBe(96);
    // The sentence must not embed a raw number — that produced "1855.75"
    // rendering beside "$1,856" in the same block.
    expect(long.trigger).not.toMatch(/\d{2,}\.\d{2}/);
  });

  it("explains itself when the favoured side has no tradeable level", () => {
    // Both timeframes bearish, but no resistance in pullback range: showing
    // a lone LONG under a "both bearish" rationale reads like a bug unless
    // the gap is named.
    const frozenNoShort = buildPlannedSetups(
      inputs({ zones: [zone("support", 92, 96)], dailyDirection: "bearish", fourHourDirection: "bearish" })
    )!;
    expect(frozenNoShort.short).toBeNull();
    expect(frozenNoShort.rationale).toContain("No short entry is in range");
  });

  it("leads with the favoured side, then with whichever is closest", () => {
    const favouringShort = buildPlannedSetups(inputs({ dailyDirection: "bearish", fourHourDirection: "bearish" }))!;
    expect(readPlannedSetups(favouringShort, 100)!.setups[0].direction).toBe("short");

    // With no favoured side, proximity decides: 97 is nearer the long zone.
    const noFavourite = buildPlannedSetups(inputs({ dailyDirection: "neutral", fourHourDirection: "neutral" }))!;
    expect(readPlannedSetups(noFavourite, 97)!.setups[0].direction).toBe("long");
  });

  it("marks primary only when a side is genuinely favoured", () => {
    const conflicted = buildPlannedSetups(inputs({ dailyDirection: "bullish", fourHourDirection: "bearish" }))!;
    expect(readPlannedSetups(conflicted, 100)!.setups.every((s) => !s.primary)).toBe(true);
  });

  it("returns null rather than an empty shell when nothing is planned", () => {
    expect(readPlannedSetups(null, 100)).toBeNull();
  });
});
