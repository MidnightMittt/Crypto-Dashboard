import { describe, expect, it } from "vitest";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { SymbolPanel } from "@/lib/research/barsPanel";
import { AssetFactsInputs, buildAssetFacts, quantile, RET_WINDOW_SESSIONS } from "./buildAssetFacts";

const NOW = Date.UTC(2026, 7, 20, 12);
const DAY = 86_400_000;

/** n sessions ending 2026-08-19, ISO dates. Weekends don't matter to the math. */
const sessions = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 7, 19) - (n - 1 - i) * DAY).toISOString().slice(0, 10));

const panelOf = (closes: number[], interpolated: number[] = []): SymbolPanel => ({
  bars: closes.map((c) => [c, c + 1, c - 1, c, 1000]),
  interpolated,
});

const inputs = (over: Partial<AssetFactsInputs> = {}): AssetFactsInputs => ({
  symbol: "TEST",
  sessions: sessions(60),
  panel: panelOf(Array.from({ length: 60 }, () => 100)),
  positioning: null,
  earnings: { kind: "unreachable" },
  calendarEntries: [],
  now: NOW,
  ...over,
});

describe("quantile", () => {
  /*
   * Type-7 by hand on [1,2,3,4]: p50 sits at pos 1.5 -> 2 + 0.5x(3-2) = 2.5;
   * p25 at pos 0.75 -> 1 + 0.75x1 = 1.75. Endpoints are the data's own min/max.
   */
  it("matches the hand computation on a four-point sample", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
  });

  it("returns null on an empty sample rather than a fabricated number", () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("buildAssetFacts", () => {
  /*
   * A flat series has exactly one distinct 20-session return: 0%. Every
   * percentile is 0 and n counts the overlapping windows: 60 - 20 = 40,
   * of which floor(40/20) = 2 are independent.
   */
  it("computes return percentiles with the honest overlapping/independent split", () => {
    const f = buildAssetFacts(inputs());
    expect(f.ret_20d_pct).toBe(0);
    expect(f.ret_pctile_20d.p05).toBe(0);
    expect(f.ret_pctile_20d.p95).toBe(0);
    expect(f.ret_pctile_20d.n).toBe(60 - RET_WINDOW_SESSIONS);
    expect(f.ret_pctile_20d.independent_n).toBe(2);
  });

  /* 100 -> 90 over the last 20 sessions is a -10% return, and it must be the p05 tail of a flat history. */
  it("places a real drawdown against the name's own distribution", () => {
    const closes = [...Array.from({ length: 40 }, () => 100), ...Array.from({ length: 20 }, (_, i) => 100 - (i + 1) * 0.5)];
    const f = buildAssetFacts(inputs({ panel: panelOf(closes) }));
    expect(f.ret_20d_pct).toBeCloseTo(-10, 1);
    expect(f.ret_pctile_20d.p05).toBeLessThan(-8);
    // Half the 40 windows straddle the decline, so the median is the seam
    // between the shallowest negative (-0.5%) and the flat era's zeros.
    expect(f.ret_pctile_20d.p50).toBeCloseTo(-0.25, 2);
    expect(f.ret_pctile_20d.p95).toBe(0);
  });

  /*
   * TWO CLOCKS. `asof` is compute time; `price_asof` is the price's own
   * session. And when the newest row is an interpolated fill, the price walks
   * BACK to the last real print — a filled close quoted as "price" would be a
   * fabricated observation wearing a date.
   */
  it("keeps asof and price_asof separate, and price never comes from a fill", () => {
    const s = sessions(60);
    const f = buildAssetFacts(inputs({ sessions: s, panel: panelOf(Array.from({ length: 60 }, () => 100), [59]) }));
    expect(f.asof).toBe(new Date(NOW).toISOString());
    expect(f.price_asof).toBe(s[58]);
    expect(f.price).toBe(100);
  });

  it("passes positioning through with each group's own instant, null where unobserved", () => {
    const pos = {
      date: "2026-08-19",
      symbol: "TEST",
      origin: "live",
      sourceAsOf: { options: "2026-08-19T21:03:26Z", shortVolume: "2026-08-18" },
      netGexUsdPer1Pct: 1_000_000,
      gammaSign: "positive",
      shortRatioPct: null, // unobserved, and it must SURVIVE as null — never 0
      putCallOiRatio: 0.6,
      putCallVolumeRatio: 0.3,
      atmIvPct: 45.5,
      atmIvDaysToExpiry: 8,
      typicalDailyMovePct: null,
      chainOi: 819_240,
      analystCount: null,
      analystMeanTargetUsd: null,
      socialBullishPctOfTagged: null,
      socialTaggedCount: null,
      socialSpanHours: null,
    } as PositioningPoint;
    const f = buildAssetFacts(inputs({ positioning: pos }));
    expect(f.short_ratio_pct).toBeNull();
    expect(f.net_gex_usd_per_1pct).toBe(1_000_000);
    expect(f.options_asof).toBe("2026-08-19T21:03:26Z");
    expect(f.short_volume_asof).toBe("2026-08-18");
    expect(f.positioning_session).toBe("2026-08-19");
  });

  it("reports every positioning field null when no row exists at all", () => {
    const f = buildAssetFacts(inputs({ positioning: null }));
    for (const k of ["short_ratio_pct", "net_gex_usd_per_1pct", "atm_iv_pct", "options_asof", "chain_oi"] as const) {
      expect(f[k], k).toBeNull();
    }
  });

  /*
   * THE THREE STATES, each with its opposite trading consequence:
   * a live "no date" clears an event veto; an unreachable provider does not.
   */
  it("distinguishes confirmed / none / lookup_failed", () => {
    const live = buildAssetFacts(inputs({ earnings: { kind: "live", nextEarningsDate: "2026-11-20" } }));
    expect(live.earnings_status).toBe("confirmed");
    expect(live.earnings_date).toBe("2026-11-20");
    expect(live.earnings_source).toBe("nasdaq-live");

    const none = buildAssetFacts(inputs({ earnings: { kind: "live", nextEarningsDate: null } }));
    expect(none.earnings_status).toBe("none");
    expect(none.earnings_date).toBeNull();

    const failed = buildAssetFacts(inputs({ earnings: { kind: "unreachable" } }));
    expect(failed.earnings_status).toBe("lookup_failed");
    expect(failed.earnings_source).toBeNull();
  });

  it("falls back to the committed calendar only for a CONFIRMED future date", () => {
    const confirmed = buildAssetFacts(
      inputs({ earnings: { kind: "unreachable" }, calendarEntries: [{ symbol: "TEST", date: "2026-09-01" }] })
    );
    expect(confirmed.earnings_status).toBe("confirmed");
    expect(confirmed.earnings_source).toBe("committed-calendar");

    // A PAST calendar entry confirms nothing about the next report, and the
    // calendar's silence is not "none" — it records only positive findings.
    const stale = buildAssetFacts(
      inputs({ earnings: { kind: "unreachable" }, calendarEntries: [{ symbol: "TEST", date: "2026-08-01" }] })
    );
    expect(stale.earnings_status).toBe("lookup_failed");
  });

  it("emits the trend line and ATR from the same formulas the dossier uses", () => {
    const f = buildAssetFacts(inputs());
    // Flat closes at 100 with a constant 2-wide range: ATR = 2, trail = 100 - 3.
    expect(f.atr_usd).toBeCloseTo(2, 5);
    expect(f.trail_stop_usd).toBeCloseTo(97, 5);
    expect(f.trend_intact).toBe(true);
  });

  it("returns nulls, not zeros, when the panel is too thin to measure", () => {
    const f = buildAssetFacts(inputs({ sessions: sessions(5), panel: panelOf([100, 100, 100, 100, 100]) }));
    expect(f.ret_20d_pct).toBeNull();
    expect(f.ret_pctile_20d.p50).toBeNull();
    expect(f.ret_pctile_20d.n).toBe(0);
    expect(f.atr_usd).toBeNull();
    expect(f.narrowest_viable_stop_pct_5d).toBeNull();
  });
});
