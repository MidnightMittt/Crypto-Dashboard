import { describe, expect, it } from "vitest";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { SymbolPanel } from "@/lib/research/barsPanel";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { AssetFactsInputs, buildAssetFacts, quantile, RET_WINDOW_SESSIONS } from "./buildAssetFacts";

const NOW = Date.UTC(2026, 7, 20, 12);
const DAY = 86_400_000;

/** A completed sweep covering TEST — the only state in which absence means "none". */
const swept = (over: Partial<EarningsCalendar> = {}): EarningsCalendar => ({
  generatedAt: NOW,
  entries: [],
  sweep: { throughDate: "2026-09-17", universe: ["TEST", "OTHER"] },
  ...over,
});

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
  calendar: swept(),
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
   * THE THREE STATES, each with its opposite trading consequence. `none` is
   * the hard one: it is earned only by a COMPLETED sweep that still covers
   * today and had this symbol in scope, because the sweep visits every day in
   * its window — so absence is then a finding rather than a gap.
   */
  it("distinguishes confirmed / none / lookup_failed", () => {
    const confirmed = buildAssetFacts(
      inputs({ calendar: swept({ entries: [{ symbol: "TEST", date: "2026-09-01" }] }) })
    );
    expect(confirmed.earnings_status).toBe("confirmed");
    expect(confirmed.earnings_date).toBe("2026-09-01");
    expect(confirmed.earnings_source).toBe("committed-calendar");

    // Swept, in scope, no entry -> genuinely no earnings in the window.
    const none = buildAssetFacts(inputs({ calendar: swept() }));
    expect(none.earnings_status).toBe("none");
    expect(none.earnings_date).toBeNull();

    // No sweep block at all: an older calendar cannot support the claim.
    const noSweep = buildAssetFacts(inputs({ calendar: { generatedAt: NOW, entries: [] } }));
    expect(noSweep.earnings_status).toBe("lookup_failed");
    expect(noSweep.earnings_source).toBeNull();
  });

  it("refuses to call it 'none' for a symbol the sweep never covered", () => {
    const f = buildAssetFacts(
      inputs({ calendar: swept({ sweep: { throughDate: "2026-09-17", universe: ["OTHER"] } }) })
    );
    expect(f.earnings_status).toBe("lookup_failed");
  });

  /*
   * A window that closed before today proves nothing about what is ahead —
   * the exact failure a stale committed file would otherwise cause, silently
   * clearing an event veto on a name about to report.
   */
  it("refuses to call it 'none' when the swept window has already expired", () => {
    const f = buildAssetFacts(
      inputs({ calendar: swept({ sweep: { throughDate: "2026-08-19", universe: ["TEST"] } }) })
    );
    expect(f.earnings_status).toBe("lookup_failed");
  });

  /* A PAST entry confirms nothing about the NEXT report. */
  it("ignores an entry that has already happened", () => {
    const f = buildAssetFacts(
      inputs({ calendar: swept({ entries: [{ symbol: "TEST", date: "2026-08-01" }] }) })
    );
    expect(f.earnings_status).toBe("none");
    expect(f.earnings_date).toBeNull();
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
    // Not a bare null: thin history is DISCRIMINATED from "no width survives".
    expect(f.narrowest_viable_stop_5d.width_pct).toBeNull();
    expect(f.narrowest_viable_stop_5d.verdict).toBe("insufficient_history");
  });
});

describe("price staleness on the facts object", () => {
  /*
   * The P0 this closes: the panel's newest session is 60 sessions back from
   * "now", so the price must be labelled stale even though it is a perfectly
   * real close that was correct on the day it was taken.
   */
  it("marks a price stale when the panel has fallen behind", () => {
    const f = buildAssetFacts(inputs({ now: Date.UTC(2026, 7, 27, 20, 30) }));
    expect(f.price).not.toBeNull();
    expect(f.price_stale).toBe(true);
    expect(f.price_age_sessions).toBeGreaterThan(0);
    expect(f.price_stale_reason).toContain("Do not size or trigger from it");
    expect(f.latest_completed_session).toBe("2026-08-27");
  });

  /* Mid-session, yesterday's close is current and must not be flagged. */
  it("does not flag the latest close mid-session", () => {
    // Panel ends 2026-08-19; 2026-08-20 15:00 ET is before that day's close.
    const f = buildAssetFacts(inputs({ now: Date.UTC(2026, 7, 20, 15, 0) }));
    expect(f.price_stale).toBe(false);
    expect(f.price_age_sessions).toBe(0);
    expect(f.price_stale_reason).toBeNull();
  });
});

describe("implied vol", () => {
  const pos = (over: Partial<PositioningPoint> = {}) =>
    ({
      date: "2026-08-20",
      symbol: "TEST",
      origin: "live",
      sourceAsOf: { options: "2026-08-20T21:00:00Z" },
      netGexUsdPer1Pct: null,
      gammaSign: null,
      shortRatioPct: null,
      putCallOiRatio: null,
      putCallVolumeRatio: null,
      atmIvPct: 130,
      atmIvDaysToExpiry: 1,
      ivConstantMaturityPct: 78,
      typicalDailyMovePct: null,
      chainOi: null,
      analystCount: null,
      analystMeanTargetUsd: null,
      socialBullishPctOfTagged: null,
      socialTaggedCount: null,
      socialSpanHours: null,
      ...over,
    }) as PositioningPoint;

  const series = (n: number) => Array.from({ length: n }, (_, i) => 20 + (60 * i) / (n - 1));

  /*
   * The front-week figure and the rankable one are DIFFERENT fields and must
   * both survive: 130% at 1 DTE is pin risk, 78% at constant maturity is the
   * number a percentile can be built on.
   */
  it("carries the constant-maturity reading beside the front-expiry one", () => {
    const f = buildAssetFacts(inputs({ positioning: pos(), ivHistory: series(40) }));
    expect(f.atm_iv_pct).toBe(130);
    expect(f.atm_iv_days_to_expiry).toBe(1);
    expect(f.iv_constant_maturity_pct).toBe(78);
    expect(f.iv_constant_maturity_days).toBeGreaterThan(1);
  });

  it("ranks it and says which side of the trade it argues for", () => {
    const f = buildAssetFacts(inputs({ positioning: pos(), ivHistory: series(40) }));
    expect(f.iv_percentile).toBeGreaterThan(80);
    expect(f.iv_percentile_n).toBe(40);
    expect(f.iv_percentile_reason).toBeNull();
    expect(f.iv_sentence).toContain("favours selling premium");
  });

  /* A thin series must produce a REASON, never a number. */
  it("withholds the percentile while the series is accruing", () => {
    const f = buildAssetFacts(inputs({ positioning: pos(), ivHistory: series(5) }));
    expect(f.iv_percentile).toBeNull();
    expect(f.iv_sentence).toBeNull();
    expect(f.iv_percentile_reason).toContain("sessions");
    // The reading itself still ships — it is the RANK that is unsupported.
    expect(f.iv_constant_maturity_pct).toBe(78);
  });

  it("says so when the session recorded no constant-maturity vol at all", () => {
    const f = buildAssetFacts(inputs({ positioning: pos({ ivConstantMaturityPct: null }), ivHistory: series(40) }));
    expect(f.iv_constant_maturity_pct).toBeNull();
    expect(f.iv_percentile).toBeNull();
    expect(f.iv_percentile_reason).toContain("no constant-maturity implied vol recorded");
  });
});
