import { describe, expect, it } from "vitest";
import {
  MIN_SERIES_N,
  PositioningPoint,
  appendPoints,
  isChartable,
  prunePoints,
  seriesOf,
} from "./positioningHistory";

const point = (over: Partial<PositioningPoint> = {}): PositioningPoint => ({
  date: "2026-08-14",
  symbol: "IREN",
  origin: "live",
  netGexUsdPer1Pct: -1_250_000,
  gammaSign: "negative",
  shortRatioPct: 48.7,
  putCallOiRatio: 0.82,
  putCallVolumeRatio: 0.61,
  atmIvPct: 96.4,
  atmIvDaysToExpiry: 4,
  typicalDailyMovePct: 9.2,
  chainOi: 412_800,
  analystCount: 9,
  analystMeanTargetUsd: 21.4,
  socialBullishPctOfTagged: 78,
  socialTaggedCount: 23,
  socialSpanHours: 6.1,
  ...over,
});

/** A FINRA-only row: short volume observed, options never existed. */
const backfilled = (date: string, symbol = "IREN"): PositioningPoint =>
  point({
    date,
    symbol,
    origin: "backfill",
    netGexUsdPer1Pct: null,
    gammaSign: null,
    putCallOiRatio: null,
    putCallVolumeRatio: null,
    atmIvPct: null,
    atmIvDaysToExpiry: null,
    typicalDailyMovePct: null,
    chainOi: null,
    analystCount: null,
    analystMeanTargetUsd: null,
    socialBullishPctOfTagged: null,
    socialTaggedCount: null,
    socialSpanHours: null,
  });

/**
 * WHAT IS STORED, AND THE ONE FIELD DELIBERATELY ABSENT.
 *
 * The justification for this file is that its fields cannot be reconstructed:
 * CBOE, Nasdaq and StockTwits all serve "now" with no date parameter and no
 * archive, so a series exists only if written down as it happens.
 */
describe("the recorded field set", () => {
  /*
   * Every share needs its denominator IN THE ROW. This is the same rule the
   * type already applies to atmIvPct and atmIvDaysToExpiry, and it is not
   * academic: CLSK on 2026-08-18 read "90% bullish" on a 30-message sample,
   * but only 10 of those 30 self-tagged a direction. The headline is 9 votes
   * out of 10, not 27 out of 30. Without socialTaggedCount the row would
   * record the stronger-sounding of those two claims and lose the true one.
   */
  it("stores every ratio next to the count it was computed over", () => {
    const p = point();
    for (const [share, denominator] of [
      ["putCallOiRatio", "chainOi"],
      ["analystMeanTargetUsd", "analystCount"],
      ["socialBullishPctOfTagged", "socialTaggedCount"],
      ["atmIvPct", "atmIvDaysToExpiry"],
    ] as const) {
      expect(p[share], `${share} must exist`).not.toBeUndefined();
      expect(p[denominator], `${share} without ${denominator} is uninterpretable`).not.toBeUndefined();
    }
  });

  /*
   * Insider activity was requested for this row and refused. SEC Form 4 is a
   * permanent dated archive, so any past 90-day net is recomputable from
   * EDGAR forever — storing it adds no unique information, and a stored
   * snapshot would silently diverge from the archive whenever a filing is
   * amended or filed late. If this assertion ever fails, the field was added
   * without that argument being answered.
   */
  it("does not store anything recoverable from a dated public archive", () => {
    const keys = Object.keys(point());
    const recomputable = keys.filter((k) => /insider|form4|filing|earningsDate/i.test(k));
    expect(recomputable, "EDGAR is the record for these, not this file").toEqual([]);
  });
});

describe("appendPoints", () => {
  it("is idempotent per symbol and date, so a re-run cannot stuff the series", () => {
    const once = appendPoints([], [point(), point()]);
    expect(once).toHaveLength(1);
    const again = appendPoints(once, [point({ shortRatioPct: 51.1 })]);
    expect(again).toHaveLength(1);
    expect(again[0].shortRatioPct).toBe(51.1);
  });

  it("keeps different symbols on the same date apart", () => {
    expect(appendPoints([], [point(), point({ symbol: "WULF" })])).toHaveLength(2);
  });

  /*
   * THE RULE THAT MATTERS. Backfill supplies short volume only. If it were
   * allowed to overwrite a live row, running the backfill after a week of
   * recording would silently DELETE every gamma observation collected so far
   * — replacing rich rows with sparse ones and leaving no trace.
   */
  it("never lets a backfill overwrite a live row", () => {
    const live = appendPoints([], [point()]);
    const after = appendPoints(live, [backfilled("2026-08-14")]);
    expect(after).toHaveLength(1);
    expect(after[0].origin).toBe("live");
    expect(after[0].netGexUsdPer1Pct).toBe(-1_250_000);
  });

  it("lets a live row upgrade a backfilled one, whichever arrives first", () => {
    const seeded = appendPoints([], [backfilled("2026-08-14")]);
    const after = appendPoints(seeded, [point()]);
    expect(after[0].origin).toBe("live");
    expect(after[0].atmIvPct).toBe(96.4);
  });

  it("returns rows in date order", () => {
    const out = appendPoints([], [point({ date: "2026-08-14" }), point({ date: "2026-08-12" })]);
    expect(out.map((p) => p.date)).toEqual(["2026-08-12", "2026-08-14"]);
  });
});

describe("seriesOf — coverage is per field, not per row", () => {
  /*
   * A row count beside a gamma chart would be a lie of composition: this
   * symbol has 40 rows and 3 gamma readings, because FINRA reaches back
   * years and CBOE reaches back to whenever recording started.
   */
  const history = [
    ...Array.from({ length: 37 }, (_, i) => backfilled(`2026-06-${String(i + 1).padStart(2, "0")}`)),
    point({ date: "2026-08-12" }),
    point({ date: "2026-08-13" }),
    point({ date: "2026-08-14" }),
  ];

  it("counts each field separately", () => {
    const s = seriesOf(history, "IREN");
    expect(s.points).toHaveLength(40);
    const shortVol = s.coverage.find((c) => c.field === "shortRatioPct")!;
    const gamma = s.coverage.find((c) => c.field === "netGexUsdPer1Pct")!;
    expect(shortVol.observed).toBe(40);
    expect(gamma.observed).toBe(3);
  });

  it("dates each field's own first and last observation", () => {
    const s = seriesOf(history, "IREN");
    const gamma = s.coverage.find((c) => c.field === "netGexUsdPer1Pct")!;
    expect(gamma.firstDate).toBe("2026-08-12");
    expect(gamma.lastDate).toBe("2026-08-14");
    const shortVol = s.coverage.find((c) => c.field === "shortRatioPct")!;
    expect(shortVol.firstDate).toBe("2026-06-01");
  });

  it("reports zero observations rather than pretending, when a field is never seen", () => {
    const s = seriesOf([backfilled("2026-06-01")], "IREN");
    const gamma = s.coverage.find((c) => c.field === "netGexUsdPer1Pct")!;
    expect(gamma.observed).toBe(0);
    expect(gamma.firstDate).toBeNull();
  });

  it("ignores other symbols entirely", () => {
    const s = seriesOf([point(), point({ symbol: "WULF" })], "IREN");
    expect(s.points).toHaveLength(1);
  });

  /*
   * The gate that stops a three-point gamma series being drawn as a trend.
   * Short volume clears it on the same data that gamma fails it, which is the
   * whole point of tracking coverage per field.
   */
  it("charts only the fields with enough observations", () => {
    const s = seriesOf(history, "IREN");
    expect(isChartable(s, "shortRatioPct")).toBe(true);
    expect(isChartable(s, "netGexUsdPer1Pct")).toBe(false);
    expect(MIN_SERIES_N).toBe(30);
  });
});

describe("prunePoints", () => {
  it("caps PER SYMBOL so a well-covered name cannot evict the others", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => backfilled(`2026-07-${String(i + 1).padStart(2, "0")}`, "IREN")),
      ...Array.from({ length: 3 }, (_, i) => backfilled(`2026-07-${String(i + 1).padStart(2, "0")}`, "WULF")),
    ];
    const out = prunePoints(rows, 5);
    expect(out.filter((p) => p.symbol === "IREN")).toHaveLength(5);
    expect(out.filter((p) => p.symbol === "WULF")).toHaveLength(3);
  });

  it("drops the oldest rows first", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      backfilled(`2026-07-0${i + 1}`)
    );
    const out = prunePoints(rows, 2);
    expect(out.map((p) => p.date)).toEqual(["2026-07-05", "2026-07-06"]);
  });

  it("leaves a series under the cap untouched", () => {
    const rows = Array.from({ length: 4 }, (_, i) => backfilled(`2026-07-0${i + 1}`));
    expect(prunePoints(rows, 100)).toHaveLength(4);
  });
});

/**
 * A row from an older schema, or one that simply omitted a field, arrives as
 * `undefined` rather than `null`. Counting it as an observation would
 * overstate coverage — the single error this module exists to prevent.
 */
describe("seriesOf — undefined is not an observation", () => {
  it("does not count a missing field as observed", () => {
    const legacy = { ...point(), netGexUsdPer1Pct: undefined } as unknown as PositioningPoint;
    const s = seriesOf([legacy], "IREN");
    const gamma = s.coverage.find((c) => c.field === "netGexUsdPer1Pct")!;
    expect(gamma.observed).toBe(0);
    expect(gamma.firstDate).toBeNull();
  });
});
