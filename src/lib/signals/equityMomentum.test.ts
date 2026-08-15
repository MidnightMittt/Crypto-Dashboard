import { describe, expect, it } from "vitest";
import { Bar } from "@/lib/research/types";
import {
  CrossSection,
  loadCrossSection,
  loadMomentumRecord,
  readEquityMomentum,
} from "./equityMomentum";

const DAY = 86_400_000;
const AS_OF = Date.parse("2026-08-13T00:00:00Z");

/**
 * A 20-name panel with momentum 20% down to 1% in one-point steps. Decile
 * size is floor(20 × 0.1) = 2, so the cuts are exactly:
 *
 *   topCut    = members[1].mom  = 0.19
 *   bottomCut = members[18].mom = 0.02
 *
 * Every expectation below is worked out against those two numbers.
 */
function panel(overrides: Partial<CrossSection> = {}): CrossSection {
  const members = Array.from({ length: 20 }, (_, j) => ({
    symbol: `P${j}`,
    mom: (20 - j) / 100,
  }));
  return {
    generatedAt: AS_OF,
    asOf: AS_OF,
    instruments: members.length,
    lookbackSessions: 252,
    skipSessions: 21,
    decileSize: 2,
    topCut: members[1].mom,
    bottomCut: members[18].mom,
    breadthPct: 0.742,
    members,
    ...overrides,
  };
}

/**
 * 300 daily bars ending exactly at the panel's as-of date, flat at 1.0
 * except for the one bar that sets the trailing return. With i = 299, the
 * window the module reads is close[47] → close[278].
 */
function bars(mom: number, count = 300, lastT = AS_OF): Bar[] {
  const out: Bar[] = [];
  for (let k = 0; k < count; k++) {
    const close = k === count - 22 ? 1 + mom : 1;
    out.push({
      t: lastT - (count - 1 - k) * DAY,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
    });
  }
  return out;
}

const equity = (mom: number, cs = panel(), extra: Partial<Parameters<typeof readEquityMomentum>[0]> = {}) =>
  readEquityMomentum({
    symbol: "TEST",
    assetClass: "equity",
    bars: bars(mom),
    now: AS_OF,
    crossSection: cs,
    ...extra,
  });

describe("readEquityMomentum — placement in the panel", () => {
  it("ranks a name above the top cut into the long decile", () => {
    const r = equity(0.25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("long-decile");
    // Every one of the 20 members sits below +25%.
    expect(r.read.percentile).toBeCloseTo(100, 10);
    expect(r.read.momentumPct).toBeCloseTo(25, 8);
  });

  /*
   * Placement is by RANK, so these fixtures sit strictly between panel
   * members rather than exactly on a boundary. Testing float-exact equality
   * at a cut would be testing arithmetic noise, not the rule.
   */
  it("admits the last name that still ranks inside the decile", () => {
    // Above P0 (+20%)? No. Above P1 (+19%)? Yes. Rank 2 of 21, decile is 2.
    const r = equity(0.195);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("long-decile");
    // 19 of 20 members sit below +19.5%.
    expect(r.read.percentile).toBeCloseTo(95, 10);
  });

  it("excludes the first name that ranks outside it", () => {
    // Two members (+20%, +19%) rank above, so this is 3rd of 21.
    const r = equity(0.185);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("middle");
  });

  it("ranks a name near the bottom into the short decile", () => {
    // Only P19 (+1%) ranks below, so this is 2nd from the bottom.
    const r = equity(0.015);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("short-decile");
    expect(r.read.percentile).toBeCloseTo(5, 10);
  });

  it("leaves the middle eight deciles unclaimed", () => {
    const r = equity(0.1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("middle");
    expect(r.read.percentile).toBeCloseTo(50, 10);
    expect(r.read.applies).toBe(false);
    expect(r.read.record).toBeNull();
  });

  it("names the peers in the same decile so concentration is visible", () => {
    const r = equity(0.25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.peers).toEqual(["P0", "P1"]);
  });
});

describe("readEquityMomentum — when the record applies", () => {
  it("applies in broad strength and carries the measured numbers", () => {
    const r = equity(0.25);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.regime).toBe("broad-strength");
    expect(r.read.applies).toBe(true);
    expect(r.read.record).not.toBeNull();
    expect(r.read.record!.n).toBeGreaterThan(0);
    expect(r.read.record!.lowerBoundPct).toBeGreaterThan(50);
  });

  /*
   * The declared complement. This is the "when not to take the trade"
   * result, and it must actually withhold the forecast rather than soften
   * the wording around it.
   */
  it("withholds the forecast in broad weakness", () => {
    const r = equity(0.25, panel({ breadthPct: 0.42 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.regime).toBe("broad-weakness");
    expect(r.read.applies).toBe(false);
    expect(r.read.record).toBeNull();
    expect(r.read.detail).toContain("49.2%");
  });

  it("makes no standalone short claim for the bottom decile", () => {
    const r = equity(0.015);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.applies).toBe(false);
    expect(r.read.record).toBeNull();
    expect(r.read.detail).toContain("no standalone short record");
  });

  it("reports an unknown regime rather than assuming one when breadth is missing", () => {
    const r = equity(0.25, panel({ breadthPct: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.regime).toBe("unknown");
    expect(r.read.applies).toBe(false);
  });
});

describe("readEquityMomentum — staleness", () => {
  it("keeps the ranking but drops the regime once breadth is over ten days old", () => {
    const r = equity(0.25, panel(), { now: AS_OF + 12 * DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.leg).toBe("long-decile");
    expect(r.read.regime).toBe("unknown");
    expect(r.read.breadthPct).toBeNull();
    expect(r.read.applies).toBe(false);
    expect(r.read.caveats.some((c) => c.includes("stale"))).toBe(true);
  });

  it("refuses entirely once the decile boundaries are over forty-five days old", () => {
    const r = equity(0.25, panel(), { now: AS_OF + 50 * DAY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockedBy).toBe("no-provider");
    expect(r.reason).toContain("50 days ago");
  });
});

describe("readEquityMomentum — refusals", () => {
  it("does not rank a crypto asset inside an equity panel", () => {
    const r = readEquityMomentum({
      symbol: "BTC",
      assetClass: "crypto",
      bars: bars(0.25),
      now: AS_OF,
      crossSection: panel(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockedBy).toBe("not-applicable");
  });

  it("refuses a name without the full twelve-month-plus-skip window", () => {
    const r = readEquityMomentum({
      symbol: "NEW",
      assetClass: "equity",
      bars: bars(0.25, 200),
      now: AS_OF,
      crossSection: panel(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.blockedBy).toBe("insufficient-history");
  });

  /*
   * ALIGNMENT. A ticker with fresher bars than the panel must still be read
   * at the panel's date, or it is placed in a distribution measured over a
   * different window. Here the extra 10 sessions are flat, so a correctly
   * aligned read gets the same +25% as the aligned fixture; a read that used
   * the ticker's own last bar would shift the window and miss the move.
   */
  it("reads the ticker at the panel's date, not the ticker's own last bar", () => {
    const fresher = bars(0.25, 310, AS_OF + 10 * DAY);
    const r = readEquityMomentum({
      symbol: "TEST",
      assetClass: "equity",
      bars: fresher,
      now: AS_OF,
      crossSection: panel(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.read.asOf).toBe(AS_OF);
    expect(r.read.momentumPct).toBeCloseTo(0, 8);
  });
});

/**
 * TRIPWIRES ON THE SHIPPED ARTIFACTS.
 *
 * The module above is correct in the abstract; these assert that what is
 * actually committed still supports the claim the page makes. If a re-run of
 * the lab ever retires the long-only signal, this fails loudly instead of
 * the site quietly continuing to cite a record that no longer holds.
 */
describe("the shipped artifacts still support the claim", () => {
  it("the gated long-only hypothesis still earns Edge", () => {
    const gated = loadMomentumRecord("momentum-12-1-long-only-broad-up");
    expect(gated).not.toBeNull();
    expect(gated!.earnsEdge).toBe(true);
    expect(gated!.lowerBound).not.toBeNull();
    expect(gated!.lowerBound!).toBeGreaterThan(0.52);
  });

  it("the long leg is measured separately from the spread, and differs from it", () => {
    const spread = loadMomentumRecord("momentum-12-1");
    const longOnly = loadMomentumRecord("momentum-12-1-long-only");
    expect(spread).not.toBeNull();
    expect(longOnly).not.toBeNull();
    expect(longOnly!.meanSpread).not.toBeCloseTo(spread!.meanSpread, 4);
  });

  it("the down-regime complement is on the record and does not earn Edge", () => {
    const down = loadMomentumRecord("momentum-12-1-long-only-broad-down");
    expect(down).not.toBeNull();
    expect(down!.earnsEdge).toBe(false);
  });

  it("the committed cross-section is internally consistent", () => {
    const cs = loadCrossSection();
    expect(cs.members.length).toBe(cs.instruments);
    expect(cs.decileSize).toBe(Math.max(1, Math.floor(cs.members.length * 0.1)));
    expect(cs.topCut).toBe(cs.members[cs.decileSize - 1].mom);
    expect(cs.bottomCut).toBe(cs.members[cs.members.length - cs.decileSize].mom);
    // Sorted descending, which every cut and percentile above depends on.
    for (let i = 1; i < cs.members.length; i++) {
      expect(cs.members[i].mom).toBeLessThanOrEqual(cs.members[i - 1].mom);
    }
  });
});
