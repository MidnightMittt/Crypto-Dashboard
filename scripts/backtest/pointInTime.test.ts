import { describe, it, expect } from "vitest";
import { replayAsset, RawAssetData, MarketWideData, DayRecord } from "./run";

/**
 * The look-ahead test.
 *
 * Reading the replay code and satisfying yourself that every series is
 * filtered to `t < evaluationDay` is necessary but not sufficient — it's
 * exactly the kind of invariant that holds until someone adds a new input
 * six months from now and forgets. This asserts it mechanically instead:
 *
 *   Replay the same history twice, once with 30 extra days of future
 *   appended to EVERY input series. Every field a decision could legally
 *   depend on must come out byte-identical for the days both runs share.
 *
 * If any input leaks future information — a percentile ranked against bars
 * that hadn't printed, a regime classified with hindsight, a support zone
 * drawn from a swing that hadn't happened — the two runs diverge and this
 * fails. That is the whole point: the test cannot pass for the wrong
 * reason, because the only way to pass is genuinely not to look forward.
 *
 * Forward returns and resolved trades are deliberately EXCLUDED from the
 * comparison. Those are labels, not inputs; they are supposed to depend on
 * the future, and asserting they match would be asserting the opposite of
 * what this file is for.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START = Date.parse("2023-01-01T00:00:00Z");

/**
 * Deterministic LCG rather than Math.random — a leakage test that only
 * fails on some seeds is worse than no test at all.
 */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}

/** A plausible random-walk history: enough real variation for swings, divergences and regime shifts to actually occur. */
function buildData(days: number): { asset: RawAssetData; market: MarketWideData } {
  const rng = makeRng(42);
  const futuresKlines = [];
  const spotKlines = [];
  let price = 30_000;

  for (let h = 0; h < days * 24; h++) {
    const t = START + h * HOUR_MS;
    const drift = Math.sin(h / 300) * 40;
    price = Math.max(1_000, price + drift + (rng() - 0.5) * 220);
    const high = price * (1 + rng() * 0.006);
    const low = price * (1 - rng() * 0.006);
    futuresKlines.push({ t, open: price, high, low, close: price, volumeUsd: 5e8 + rng() * 2e8 });
    spotKlines.push({ t, close: price * (1 - 0.0004), volumeUsd: 3e8 + rng() * 1e8 });
  }

  const fundingRate = [];
  for (let i = 0; i < days * 3; i++) {
    fundingRate.push({ t: START + i * 8 * HOUR_MS, fundingRatePct: (rng() - 0.4) * 0.02 });
  }

  const oiHistory = [];
  const longShortHistory = [];
  const etfFlows = [];
  for (let d = 0; d < days; d++) {
    const t = START + d * DAY_MS;
    oiHistory.push({ t, oiUsd: 8e9 + rng() * 3e9 });
    longShortHistory.push({ t, ratio: 0.8 + rng() * 0.8 });
    etfFlows.push({ t, netFlowUsd: (rng() - 0.5) * 4e8 });
  }

  const series = (scale: number, offset: number) =>
    Array.from({ length: days }, (_, d) => ({ t: START + d * DAY_MS, value: offset + rng() * scale }));

  return {
    asset: { asset: "BTC", futuresKlines, spotKlines, fundingRate, oiHistory, longShortHistory, etfFlows },
    market: {
      fearGreed: Array.from({ length: days }, (_, d) => ({ t: START + d * DAY_MS, value: Math.floor(rng() * 100) })),
      stablecoins: Array.from({ length: days }, (_, d) => ({ t: START + d * DAY_MS, totalUsd: 1.3e11 + d * 5e7 })),
      nfci: series(0.4, -0.5),
      t10y2y: series(1.2, -0.4),
      rrp: series(400, 1_800),
      tga: series(200_000, 600_000),
      effr: series(0.5, 5),
    },
  };
}

/** Everything above is history; everything below is the actual assertion. */
function truncate(data: RawAssetData, market: MarketWideData, cutoffT: number) {
  const before = <T extends { t: number }>(arr: T[]) => arr.filter((x) => x.t < cutoffT);
  return {
    asset: {
      ...data,
      futuresKlines: before(data.futuresKlines),
      spotKlines: before(data.spotKlines),
      fundingRate: before(data.fundingRate),
      oiHistory: before(data.oiHistory),
      longShortHistory: before(data.longShortHistory),
      etfFlows: before(data.etfFlows),
    },
    market: {
      fearGreed: before(market.fearGreed),
      stablecoins: before(market.stablecoins),
      nfci: before(market.nfci),
      t10y2y: before(market.t10y2y),
      rrp: before(market.rrp),
      tga: before(market.tga),
      effr: before(market.effr),
    },
  };
}

/**
 * Forward-looking BY DESIGN, so excluded from the comparison. Listed
 * explicitly rather than filtered by a name pattern: a future field called
 * something like `nextDayRegime` would silently slip through a
 * `startsWith("forward")` check, and that is precisely the bug this file
 * exists to catch.
 */
const FORWARD_LABEL_FIELDS = new Set<keyof DayRecord>([
  "forwardReturn1h",
  "forwardReturn4h",
  "forwardReturn1d",
  "forwardReturn3d",
  "forwardReturn7d",
  "forwardReturn14d",
  "forwardReturn30d",
  "trade",
]);

function decisionFields(record: DayRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record) as Array<keyof DayRecord>) {
    if (!FORWARD_LABEL_FIELDS.has(key)) out[key] = record[key];
  }
  return out;
}

describe("point-in-time integrity", () => {
  const TOTAL_DAYS = 300;
  const FUTURE_DAYS = 30;

  const { asset, market } = buildData(TOTAL_DAYS);
  const cutoffT = START + (TOTAL_DAYS - FUTURE_DAYS) * DAY_MS;
  const truncated = truncate(asset, market, cutoffT);

  const withFuture = replayAsset(asset, market);
  const withoutFuture = replayAsset(truncated.asset, truncated.market);

  it("produces a usable sample to compare (guards against a vacuous pass)", () => {
    // A test that compares zero records passes trivially. Assert there is
    // real overlap, and that the replay actually generated entry plans and
    // resolved trades on this synthetic history.
    expect(withoutFuture.length).toBeGreaterThan(100);
    expect(withFuture.length).toBeGreaterThan(withoutFuture.length);
    expect(withFuture.some((r) => r.action !== null)).toBe(true);
    expect(withFuture.some((r) => r.trade !== null)).toBe(true);
  });

  it("computes every decision field identically with and without 30 days of future data", () => {
    const laterByDate = new Map(withFuture.map((r) => [r.date, r]));
    let compared = 0;

    for (const early of withoutFuture) {
      const later = laterByDate.get(early.date);
      if (!later) continue;
      expect(decisionFields(early)).toEqual(decisionFields(later));
      compared++;
    }

    expect(compared).toBe(withoutFuture.length);
  });

  it("compares the whole decision surface, not a near-empty object", () => {
    // Without this, the assertion above could pass simply because
    // `decisionFields` excluded almost everything. Pin both the breadth of
    // the comparison and the specific fields that matter most.
    const fields = decisionFields(withoutFuture[0]);
    expect(Object.keys(fields).length).toBeGreaterThanOrEqual(20);
    for (const key of [
      "action",
      "agreement4h",
      "biasVerdict",
      "biasConfidence",
      "entryPrice",
      "stopPrice",
      "targetPrice",
      "target2Price",
      "regimeTags",
      "metrics",
      "categories",
    ]) {
      expect(Object.keys(fields)).toContain(key);
    }
  });

  it("never evaluates a day whose forward labels would be incomplete", () => {
    // Discovered BY this test rather than assumed: forward returns match
    // across the truncation boundary too, because `lastEvalIndex` reserves
    // FORWARD_BUFFER_DAYS and so the replay simply declines to evaluate any
    // day it cannot fully label. Worth pinning — it means a shortened data
    // window yields fewer days, never days with silently truncated labels.
    const laterByDate = new Map(withFuture.map((r) => [r.date, r]));
    for (const early of withoutFuture) {
      expect(early.forwardReturn7d).not.toBeNull();
      expect(early.forwardReturn7d).toBe(laterByDate.get(early.date)!.forwardReturn7d);
    }
  });
});
