import { describe, expect, it } from "vitest";
import {
  DatedPositionEvent,
  TickSample,
  buildRealizedRecord,
  feeReceipts,
  liquidityAt,
  liquidityTimeline,
  ponsPerWeth,
  sigmaFromTickSamples,
} from "./lpRealized";

/**
 * THE POSITION'S COMPLETE EVENT HISTORY, swept from this chain 2026-10-01 and
 * pinned here wei-precise.
 *
 * Eleven events, the whole life of tokenId 1109566: four Increases, five
 * Collects, two Decreases. This is not a synthetic fixture — it is the actual
 * financial record, and it is the ground truth every assertion below rests on.
 *
 * The liquidity deltas sum to EXACTLY ZERO, which is how this file came to
 * exist: the position was fully withdrawn on 2026-09-27, four days before the
 * pre-registered verdict it was built to inform.
 */
const EVENTS: DatedPositionEvent[] = [
  { block: 59046910, tsMs: 1789007348000, kind: "increase", amount0: 43000000000000000n, amount1: 189856453018988063611n, liquidityDelta: 13730574270183102919n },
  { block: 60070559, tsMs: 1789110740000, kind: "increase", amount0: 19000000000000000n, amount1: 67854758894026289806n, liquidityDelta: 5443819844832993567n },
  { block: 60630656, tsMs: 1789167805000, kind: "collect", amount0: 1367340943009270n, amount1: 5855779037723660784n, liquidityDelta: 0n },
  { block: 66527317, tsMs: 1789764960000, kind: "collect", amount0: 2926302071638665n, amount1: 11632329911972367478n, liquidityDelta: 0n },
  { block: 66527788, tsMs: 1789765008000, kind: "increase", amount0: 5000000000000000n, amount1: 20480939223882760367n, liquidityDelta: 1534987224755938629n },
  { block: 72528034, tsMs: 1790369581000, kind: "collect", amount0: 1667110878282820n, amount1: 7230714893276841874n, liquidityDelta: 0n },
  { block: 72528872, tsMs: 1790369665000, kind: "increase", amount0: 2036146326185422n, amount1: 13117430358426770197n, liquidityDelta: 806067319847736971n },
  { block: 74266275, tsMs: 1790545079000, kind: "decrease", amount0: 19193974927524981n, amount1: 210249608058700546721n, liquidityDelta: -10757724329809886043n },
  { block: 74266275, tsMs: 1790545079000, kind: "collect", amount0: 19437529701804793n, amount1: 211474854809685236429n, liquidityDelta: 0n },
  { block: 74269617, tsMs: 1790545416000, kind: "decrease", amount0: 19136061073903264n, amount1: 210517939735427280560n, liquidityDelta: -10757724329809886043n },
  { block: 74269617, tsMs: 1790545416000, kind: "collect", amount0: 19136062014165171n, amount1: 210518616940462363841n, liquidityDelta: 0n },
];

/** A tick series spanning the life, matching the measured 81117..84774 band. */
function tickSeries(): TickSample[] {
  const out: TickSample[] = [];
  const open = 59046910;
  const close = 74269617;
  const steps = 148;
  for (let i = 0; i < steps; i++) {
    const block = Math.round(open + ((close - open) * i) / (steps - 1));
    // Drift 82713 -> 84350 with alternating noise, inside the measured band.
    const base = 82713 + ((84350 - 82713) * i) / (steps - 1);
    out.push({ block, tick: Math.round(base + (i % 2 ? 180 : -180)) });
  }
  return out;
}

const BPS = 10.4;

describe("liquidityTimeline — the closure proof", () => {
  it("nets to exactly zero across the position's life", () => {
    const tl = liquidityTimeline(EVENTS);
    expect(tl[tl.length - 1].liquidity).toBe(0n);
  });

  it("reproduces the known intermediate liquidity values", () => {
    const tl = liquidityTimeline(EVENTS);
    // The pre-compound L the trading session recorded independently.
    expect(liquidityAt(tl, 66527317)).toBe(19174394115016096486n);
    // The L every P0 fixture was taken at.
    expect(liquidityAt(tl, 72528034)).toBe(20709381339772035115n);
    // Peak, after the final top-up.
    expect(liquidityAt(tl, 74266274)).toBe(21515448659619772086n);
    // Half withdrawn, then none.
    expect(liquidityAt(tl, 74266275)).toBe(10757724329809886043n);
    expect(liquidityAt(tl, 74269617)).toBe(0n);
  });

  it("withdraws in two equal halves", () => {
    const decs = EVENTS.filter((e) => e.kind === "decrease");
    expect(decs).toHaveLength(2);
    expect(decs[0].liquidityDelta).toBe(decs[1].liquidityDelta);
  });
});

describe("feeReceipts — principal must not be counted as fee", () => {
  const receipts = feeReceipts(EVENTS);

  it("treats an unpaired Collect as pure fee", () => {
    const r = receipts.find((x) => x.block === 66527317)!;
    expect(r.principalRemoved).toBe(false);
    expect(r.fee1).toBe(11632329911972367478n);
  });

  /*
   * THE LOAD-BEARING ONE. The closing Collect returned 211.47 PONS of which
   * 210.25 was principal. Reading it as fee would overstate that receipt by
   * ~170x and the life's fees by ~8x.
   */
  it("subtracts same-block Decrease principal from a paired Collect", () => {
    const r = receipts.find((x) => x.block === 74266275)!;
    expect(r.principalRemoved).toBe(true);
    expect(r.fee1).toBe(211474854809685236429n - 210249608058700546721n);
    expect(Number(r.fee1) / 1e18).toBeCloseTo(1.2252, 3);
    // The naive read, for contrast — what this test exists to prevent.
    expect(Number(211474854809685236429n) / 1e18).toBeCloseTo(211.47, 1);
  });

  it("totals the life's realized fees to the swept values", () => {
    const f0 = receipts.reduce((a, r) => a + r.fee0, 0n);
    const f1 = receipts.reduce((a, r) => a + r.fee1, 0n);
    expect(Number(f0) / 1e18).toBeCloseTo(0.006204309607472474, 12);
    expect(Number(f1) / 1e18).toBeCloseTo(25.944747798993, 6);
  });
});

describe("buildRealizedRecord", () => {
  const rec = buildRealizedRecord(EVENTS, tickSeries(), BPS)!;

  it("reports the position as CLOSED, with the date", () => {
    expect(rec.isClosed).toBe(true);
    expect(rec.finalLiquidity).toBe(0n);
    expect(rec.closedIso).toBe("2026-09-27T21:43:36.000Z");
    expect(rec.openedIso).toBe("2026-09-10T02:29:08.000Z");
    expect(rec.lifeDays).toBeCloseTo(17.8, 1);
  });

  it("reports exact token flows", () => {
    expect(rec.deposited.weth).toBeCloseTo(0.069036146326185419, 12);
    expect(rec.deposited.pons).toBeCloseTo(291.309581495324, 6);
    expect(rec.withdrawn.weth).toBeCloseTo(0.044534345608900718, 12);
    expect(rec.withdrawn.pons).toBeCloseTo(446.712295593120, 6);
  });

  it("finds the position was in range for its entire life", () => {
    expect(rec.inRangeFraction).toBe(1);
  });

  /*
   * The verdict's two answers. LVR coverage is the theoretical benchmark the
   * register gates on (PASS >= 1.5x); vsHodl is what actually happened.
   */
  it("clears the LVR coverage gate over the whole life", () => {
    expect(rec.lifeCoverage).not.toBeNull();
    expect(rec.lifeCoverage!).toBeGreaterThan(1.5);
  });

  it("reports LP against simply holding the tokens", () => {
    expect(rec.vsHodlPct).not.toBeNull();
    // Fees more than offset the divergence loss from PONS falling.
    expect(rec.vsHodlPct!).toBeGreaterThan(0);
    expect(rec.vsHodlPct!).toBeCloseTo(7.0, 0);
  });

  /* Five Collects → five realized intervals, each carrying its sample size. */
  it("produces one interval per fee receipt, each with its tick sample count", () => {
    expect(rec.intervals).toHaveLength(5);
    for (const iv of rec.intervals) {
      expect(iv.fee1Wei).toBeGreaterThanOrEqual(0n);
      expect(iv.tickSamples).toBeGreaterThanOrEqual(0);
    }
  });

  it("shows the fee rate DECAYING across the position's life", () => {
    // The measured finding: 3.15 -> 1.68 -> 1.03 -> 0.60 PONS/day.
    const perDay = rec.intervals
      .filter((i) => i.days > 0.5)
      .map((i) => Number(i.fee1Wei) / 1e18 / i.days);
    expect(perDay.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < perDay.length; i++) {
      expect(perDay[i], `interval ${i} should earn less per day than ${i - 1}`).toBeLessThan(perDay[i - 1]);
    }
  });

  it("refuses sigma rather than guessing when an interval has too few ticks", () => {
    const sparse = buildRealizedRecord(EVENTS, [{ block: 60000000, tick: 83000 }], BPS)!;
    expect(sparse.intervals.every((i) => i.sigmaDaily === null)).toBe(true);
    expect(sparse.intervals.every((i) => i.coverage === null)).toBe(true);
  });

  it("returns null on no events rather than an empty record", () => {
    expect(buildRealizedRecord([], tickSeries(), BPS)).toBeNull();
  });
});

describe("unit helpers", () => {
  it("converts a tick to PONS per WETH", () => {
    expect(ponsPerWeth(0)).toBe(1);
    expect(ponsPerWeth(84350)).toBeCloseTo(4603.5, 0);
  });

  it("refuses sigma below three samples", () => {
    expect(sigmaFromTickSamples([{ block: 1, tick: 2 }], BPS)).toBeNull();
    expect(sigmaFromTickSamples([], BPS)).toBeNull();
  });
});
