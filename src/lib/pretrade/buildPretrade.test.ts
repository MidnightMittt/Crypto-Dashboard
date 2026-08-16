import { describe, expect, it } from "vitest";
import {
  BuildInputs,
  Field,
  Measured,
  SCHEMA_VERSION,
  buildPretrade,
} from "./buildPretrade";
import { PositioningPoint } from "@/lib/history/positioningHistory";

const NOW = Date.UTC(2026, 7, 16);

const position = (over: Partial<PositioningPoint> = {}): PositioningPoint => ({
  date: "2026-08-14",
  symbol: "APLD",
  origin: "live",
  netGexUsdPer1Pct: 11_975_320,
  gammaSign: "positive",
  shortRatioPct: 55.2,
  putCallOiRatio: 0.94,
  putCallVolumeRatio: 0.47,
  atmIvPct: 81.7,
  atmIvDaysToExpiry: 5,
  typicalDailyMovePct: 9.2,
  ...over,
});

const inputs = (over: Partial<BuildInputs> = {}): BuildInputs => ({
  symbols: ["APLD"],
  now: NOW,
  overnight: {
    generatedAt: NOW,
    rows: [
      {
        symbol: "APLD", lastClose: 31.2, asOf: "2026-08-14", window: 120,
        observations: 120, overnightGrossBp: 40, overnightNetBp: 33.6,
        tStat: 1.1, significantAfterFdr: false,
      },
      {
        symbol: "APLD", lastClose: 31.2, asOf: "2026-08-14", window: 250,
        observations: 250, overnightGrossBp: 38, overnightNetBp: 31.6,
        tStat: 1.4, significantAfterFdr: false,
      },
    ],
  },
  positioningLatest: { generatedAt: NOW, points: [position()] },
  earnings: { generatedAt: NOW, entries: [{ symbol: "APLD", date: "2026-10-08" }] },
  measuredRoundTripBp: new Map(),
  dataQuality: new Map([["APLD", { adjustments: 0, undeclared: 0 }]]),
  ...over,
});

/** Narrowing helper: a field that should have a value. */
const measured = <T,>(f: Field<T>): Measured<T> => {
  expect(f.value).not.toBeNull();
  return f as Measured<T>;
};

describe("buildPretrade — the envelope contract", () => {
  it("stamps a schema version and a generation time", () => {
    const r = buildPretrade(inputs());
    expect(r.schema_version).toBe(SCHEMA_VERSION);
    expect(r.generated_at).toBe(new Date(NOW).toISOString());
  });

  /*
   * The failure this exists to prevent: two ATR figures disagreed for an hour
   * because one used a simple mean and the other Wilder smoothing, and
   * neither declared which. `method` settles that in seconds.
   */
  it("carries unit, as_of, source and method on every value it serves", () => {
    const s = buildPretrade(inputs()).symbols[0];
    const atr = measured(s.volatility.typical_daily_move_pct);
    expect(atr.unit).toBe("pct");
    expect(atr.as_of).toBe("2026-08-14");
    expect(atr.source).toBe("yahoo_daily_bars");
    expect(atr.method).toBe("wilder_atr_14_over_close");

    const px = measured(s.price.last);
    expect(px.value).toBe(31.2);
    expect(px.method).toContain("adjusted");
  });

  /* Short VOLUME is flow; short INTEREST is a standing stock. Never conflated. */
  it("names the short-volume metric precisely enough to prevent conflation", () => {
    const s = buildPretrade(inputs()).symbols[0];
    const sv = measured(s.positioning.short_sale_volume_share_pct);
    expect(sv.method).toContain("NOT_short_interest");
  });

  it("serves every requested symbol from one call", () => {
    const r = buildPretrade(
      inputs({
        symbols: ["APLD", "WULF"],
        positioningLatest: {
          generatedAt: NOW,
          points: [position(), position({ symbol: "WULF" })],
        },
      })
    );
    expect(r.symbols.map((s) => s.symbol)).toEqual(["APLD", "WULF"]);
  });

  it("reports a symbol it knows nothing about instead of inventing one", () => {
    const r = buildPretrade(inputs({ symbols: ["APLD", "NOPE"] }));
    expect(r.unknown_symbols).toEqual(["NOPE"]);
    expect(r.symbols).toHaveLength(1);
  });
});

describe("buildPretrade — null carries a reason, never a default", () => {
  /*
   * THE FIELD THAT DECIDES A TRADE. Falling back to the modelled spread would
   * be indistinguishable from a measurement and wrong by up to two orders of
   * magnitude on these names, so it stays null until the book is observed.
   */
  it("refuses net_edge while the round trip is only modelled", () => {
    const s = buildPretrade(inputs()).symbols[0];
    expect(s.net_edge.value).toBeNull();
    expect((s.net_edge as { reason: string }).reason).toBe("no_spread_history");
    expect(s.execution.entry_window.value).toBeNull();
    expect(s.execution.exit_window.value).toBeNull();
  });

  it("computes net_edge once a MEASURED cost exists", () => {
    const r = buildPretrade(
      inputs({ measuredRoundTripBp: new Map([["APLD", { bp: 6.4, reason: null }]]) })
    );
    const ne = measured(r.symbols[0].net_edge);
    // Longest window wins the headline: 250 sessions, net 31.6bp, less 6.4bp.
    expect(ne.value).toBeCloseTo(31.6 - 6.4, 10);
    expect(ne.unit).toBe("bp");
    expect(ne.method).toContain("measured_round_trip");
  });

  it("says why tradability and filings are absent rather than omitting them", () => {
    const s = buildPretrade(inputs()).symbols[0];
    expect((s.tradability.status as { reason: string }).reason).toBe("no_venue_status_feed");
    expect((s.catalysts.filings_since_prior_close as { reason: string }).reason).toBe(
      "edgar_intraday_feed_not_wired"
    );
  });

  it("reports insufficient history rather than a zero", () => {
    const r = buildPretrade(
      inputs({
        overnight: { generatedAt: NOW, rows: [] },
        positioningLatest: {
          generatedAt: NOW,
          points: [position({ typicalDailyMovePct: null })],
        },
      })
    );
    const s = r.symbols[0];
    expect(s.overnight.legs).toBeNull();
    expect(s.overnight.reason).toBe("insufficient_history");
    expect((s.volatility.typical_daily_move_pct as { reason: string }).reason).toBe(
      "insufficient_history"
    );
  });
});

describe("buildPretrade — earnings is three-state", () => {
  it("confirms a date inside the window", () => {
    const r = buildPretrade(
      inputs({ earnings: { generatedAt: NOW, entries: [{ symbol: "APLD", date: "2026-08-17" }] } })
    );
    expect(r.symbols[0].catalysts.earnings_status).toBe("confirmed_date");
  });

  it("confirms clear only with a date to point at", () => {
    const s = buildPretrade(inputs()).symbols[0];
    expect(s.catalysts.earnings_status).toBe("confirmed_none");
    expect(measured(s.catalysts.earnings_detail).value).toBe("2026-10-08");
  });

  /*
   * An uncovered symbol is UNKNOWN, never clear. A boolean here would say
   * "safe to hold overnight" on the strength of never having looked.
   */
  it("calls an uncovered symbol lookup_failed, and carries the reason", () => {
    const r = buildPretrade(
      inputs({ earnings: { generatedAt: NOW, entries: [{ symbol: "OTHER", date: "2026-10-08" }] } })
    );
    const s = r.symbols[0];
    expect(s.catalysts.earnings_status).toBe("lookup_failed");
    expect((s.catalysts.earnings_detail as { reason: string }).reason).toBe("symbol_not_covered");
  });

  it("surfaces calendar staleness as a reason with its age", () => {
    const r = buildPretrade(
      inputs({
        earnings: {
          generatedAt: NOW - 30 * 86_400_000,
          entries: [{ symbol: "APLD", date: "2026-10-08" }],
        },
      })
    );
    const detail = r.symbols[0].catalysts.earnings_detail as {
      reason: string;
      detail: Record<string, number>;
    };
    expect(detail.reason).toBe("calendar_stale");
    expect(detail.detail.calendar_age_days).toBe(30);
  });
});

describe("buildPretrade — no verdicts, and data quality is never silent", () => {
  /*
   * An unvalidated score sharing a payload with a measured edge invites the
   * first overriding the second. This asserts the absence structurally rather
   * than trusting review to notice one being added.
   */
  it("emits no score, rating or directional language anywhere", () => {
    const json = JSON.stringify(buildPretrade(inputs())).toLowerCase();
    for (const banned of ["confidence", "opportunity", "rating", "stars", "verdict", "\"buy\"", "\"sell\"", "bullish", "bearish"]) {
      expect(json).not.toContain(banned);
    }
  });

  it("exposes corporate-action interventions per symbol", () => {
    const r = buildPretrade(
      inputs({ dataQuality: new Map([["APLD", { adjustments: 2, undeclared: 1 }]]) })
    );
    expect(r.symbols[0].data_quality).toEqual({
      corporate_action_adjustments: 2,
      undeclared_steps: 1,
    });
  });

  it("stays compact enough for a token budget", () => {
    const bytes = JSON.stringify(buildPretrade(inputs())).length;
    expect(bytes).toBeLessThan(2048);
  });
});
