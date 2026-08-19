import { describe, expect, it } from "vitest";
import { PositioningPoint } from "./positioningHistory";
import { MIN_BASELINE_SESSIONS, baselineGap, baselinesFor } from "./positioningBaseline";

const day = (n: number): string => `2026-0${1 + Math.floor(n / 28)}-${String((n % 28) + 1).padStart(2, "0")}`;

const point = (over: Partial<PositioningPoint>): PositioningPoint => ({
  date: "2026-03-01",
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

/** 40 prior sessions of short volume, ramping 20%..59%. Gamma only on the last. */
function history(): { points: PositioningPoint[]; latest: PositioningPoint } {
  const points = Array.from({ length: 40 }, (_, i) =>
    point({ date: day(i), shortRatioPct: 20 + i })
  );
  const latest = point({ date: day(40), shortRatioPct: 58, netGexUsdPer1Pct: 12_000_000 });
  return { points: [...points, latest], latest };
}

describe("baselinesFor", () => {
  /*
   * 40 priors spanning 20..59. Today is 58, which is BELOW 38 of them and
   * TIES one — 58 is itself in the prior range. Mid-rank splits the tie:
   * (38 + 0.5) / 40 = 0.9625 -> 96. Counting the tie as "below" would give
   * 97.5 and counting it as "above" 95; the split is the convention the
   * shared estimator enforces everywhere.
   */
  it("places today in its own trailing distribution", () => {
    const { points, latest } = history();
    const b = baselinesFor(points, latest).shortRatioPct!;
    expect(b.sessions).toBe(40);
    expect(b.percentile).toBe(96);
    expect(b.typical).toBeCloseTo(39.5, 10);
    expect(b.since).toBe(day(0));
  });

  /*
   * TODAY IS NOT IN ITS OWN DISTRIBUTION. Including it drags every reading
   * toward the middle and makes a true extreme unreachable — with n priors, a
   * record high would cap at n/(n+1) rather than 100.
   */
  it("excludes today from the sessions it is ranked against", () => {
    const { points, latest } = history();
    const b = baselinesFor(points, latest).shortRatioPct!;
    expect(b.sessions).toBe(points.length - 1);
    const record = { ...latest, shortRatioPct: 999 };
    expect(baselinesFor([...points, record], record).shortRatioPct!.percentile).toBe(100);
  });

  /*
   * COVERAGE IS PER FIELD, and this is the case that forced it. A backfilled
   * row carries short volume and nulls for everything else, so a symbol can
   * hold hundreds of short-volume sessions and one session of gamma. Counting
   * rows would claim a gamma baseline that does not exist.
   */
  it("refuses a field whose own observations are thin, on a symbol rich in another", () => {
    const { points, latest } = history();
    const out = baselinesFor(points, latest);
    expect(out.shortRatioPct).toBeDefined();
    expect(out.netGexUsdPer1Pct).toBeUndefined();
  });

  it("refuses everything below the minimum rather than reporting a thin percentile", () => {
    const few = Array.from({ length: MIN_BASELINE_SESSIONS - 1 }, (_, i) =>
      point({ date: day(i), shortRatioPct: 30 + i })
    );
    const latest = point({ date: day(50), shortRatioPct: 40 });
    expect(baselinesFor([...few, latest], latest).shortRatioPct).toBeUndefined();
  });

  it("never mixes one symbol's history into another's baseline", () => {
    const mine = Array.from({ length: 40 }, (_, i) => point({ date: day(i), shortRatioPct: 20 + i }));
    const theirs = Array.from({ length: 40 }, (_, i) =>
      point({ date: day(i), symbol: "IREN", shortRatioPct: 90 })
    );
    const latest = point({ date: day(40), shortRatioPct: 58 });
    const b = baselinesFor([...mine, ...theirs, latest], latest).shortRatioPct!;
    expect(b.sessions).toBe(40);
    expect(b.typical).toBeCloseTo(39.5, 10);
  });
});

describe("baselineGap", () => {
  /*
   * The count is what separates "two sessions away" from "never coming". A
   * bare "insufficient_history" would leave a caller unable to tell whether
   * to wait or to stop asking.
   */
  it("names how many sessions exist and how many are needed", () => {
    const { points } = history();
    const gap = baselineGap(points, "APLD", "netGexUsdPer1Pct");
    expect(gap.reason).toBe("baseline_needs_more_sessions");
    expect(gap.sessions_observed).toBe(1);
    expect(gap.sessions_required).toBe(MIN_BASELINE_SESSIONS);
  });
});
