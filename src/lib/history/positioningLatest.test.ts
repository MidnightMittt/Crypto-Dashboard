import { describe, expect, it } from "vitest";
import { PositioningPoint } from "./positioningHistory";
import { buildLatest } from "./positioningLatest";

const base = (over: Partial<PositioningPoint>): PositioningPoint => ({
  date: "2026-08-14",
  symbol: "APLD",
  origin: "live",
  netGexUsdPer1Pct: null,
  gammaSign: null,
  shortRatioPct: null,
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
  ...over,
});

/** A full live row: every group observed on one date. */
const live = (date: string): PositioningPoint =>
  base({
    date,
    origin: "live",
    netGexUsdPer1Pct: 12_000_000,
    gammaSign: "positive",
    shortRatioPct: 48.2,
    putCallOiRatio: 0.41,
    putCallVolumeRatio: 0.39,
    atmIvPct: 81.7,
    atmIvDaysToExpiry: 5,
    chainOi: 750_615,
    typicalDailyMovePct: 9.2,
    analystCount: 9,
    analystMeanTargetUsd: 72.56,
    socialBullishPctOfTagged: 90,
    socialTaggedCount: 20,
    socialSpanHours: 6.6,
  });

/** A FINRA backfill row: short volume only, everything else null by construction. */
const backfill = (date: string, shortRatioPct = 51.1): PositioningPoint =>
  base({ date, origin: "backfill", shortRatioPct });

describe("buildLatest — the regression this exists to prevent", () => {
  /*
   * THE BUG, PINNED. Backfill reaching past the newest live row used to select
   * a short-volume-only row as "latest" and erase gamma from every symbol:
   * "105 symbols (0 with gamma)". Merging per group keeps each provider's
   * fields alive at their own observation.
   */
  it("keeps options fields when a backfill row is NEWER than the last live row", () => {
    const [row] = buildLatest([live("2026-08-14"), backfill("2026-08-18")]);
    expect(row.netGexUsdPer1Pct).toBe(12_000_000);
    expect(row.gammaSign).toBe("positive");
    expect(row.atmIvPct).toBe(81.7);
    // ...while short volume correctly comes from the newer backfill row.
    expect(row.shortRatioPct).toBe(51.1);
  });

  /*
   * And each group reports the date it was ACTUALLY observed. Stamping gamma
   * with 08-18 would be the provenance lie marketExposure.ts was fixed for.
   */
  it("dates each group by its own observation, not by the row", () => {
    const [row] = buildLatest([live("2026-08-14"), backfill("2026-08-18")]);
    expect(row.observedAt.options).toBe("2026-08-14");
    expect(row.observedAt.shortVolume).toBe("2026-08-18");
    expect(row.observedAt.street).toBe("2026-08-14");
    expect(row.observedAt.social).toBe("2026-08-14");
  });

  /*
   * Fields the type documents as inseparable must come from ONE observation.
   * An ATM IV from one session with a tenor from another is an annualised vol
   * without its own tenor; a bullish share with a count from a different
   * window is the "90% of 30" claim that was really nine votes out of ten.
   */
  it("never splits a group across two observations", () => {
    const older = live("2026-08-10");
    const newer = base({
      date: "2026-08-14",
      origin: "live",
      atmIvPct: 95.5,
      atmIvDaysToExpiry: 2,
      netGexUsdPer1Pct: 5_000_000,
      gammaSign: "positive",
      socialBullishPctOfTagged: 60,
      socialTaggedCount: 11,
      socialSpanHours: 3.3,
    });
    const [row] = buildLatest([older, newer]);
    // The newer options observation wins WHOLE — no 95.5 paired with a 5.
    expect(row.atmIvPct).toBe(95.5);
    expect(row.atmIvDaysToExpiry).toBe(2);
    expect(row.socialBullishPctOfTagged).toBe(60);
    expect(row.socialTaggedCount).toBe(11);
  });
});

describe("buildLatest — precedence and shape", () => {
  it("prefers a live row over a backfill on the SAME date", () => {
    const [row] = buildLatest([backfill("2026-08-14", 99.9), live("2026-08-14")]);
    expect(row.shortRatioPct).toBe(48.2);
    expect(row.observedAt.shortVolume).toBe("2026-08-14");
  });

  /*
   * THE VENDOR'S INSTANT, carried from the row the fields came from.
   *
   * CBOE stamps its chain to the second; the session date is only the bucket
   * that instant falls in. Taking sourceAsOf from the newest row rather than
   * the SOURCE row would re-introduce the mislabelling this whole change is
   * about, just one level up.
   */
  it("carries each group's vendor instant from the row that supplied it", () => {
    const chain = { ...live("2026-08-14"), sourceAsOf: { options: "2026-08-14T20:43:18Z" } };
    const finra = { ...backfill("2026-08-18"), sourceAsOf: { shortVolume: "2026-08-18" } };
    const [row] = buildLatest([chain, finra]);
    expect(row.sourceAsOf.options).toBe("2026-08-14T20:43:18Z");
    expect(row.sourceAsOf.shortVolume).toBe("2026-08-18");
    // ...and the session date is still available, separately.
    expect(row.observedAt.options).toBe("2026-08-14");
  });

  it("omits a vendor instant the vendor never published", () => {
    // Nasdaq and StockTwits serve "now" with no stamp; our clock must not
    // stand in for theirs.
    const [row] = buildLatest([live("2026-08-14")]);
    expect(row.sourceAsOf.street).toBeUndefined();
    expect(row.sourceAsOf.social).toBeUndefined();
  });

  it("omits observedAt for a group never observed", () => {
    const [row] = buildLatest([backfill("2026-08-18")]);
    expect(row.observedAt.shortVolume).toBe("2026-08-18");
    expect(row.observedAt.options).toBeUndefined();
    expect(row.netGexUsdPer1Pct).toBeNull();
  });

  it("keeps symbols separate and sorted", () => {
    const rows = buildLatest([
      { ...live("2026-08-14"), symbol: "WULF" },
      live("2026-08-14"),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["APLD", "WULF"]);
  });
});
