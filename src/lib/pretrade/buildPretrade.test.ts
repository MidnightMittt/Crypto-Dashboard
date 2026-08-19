import { describe, expect, it } from "vitest";
import {
  BuildInputs,
  Field,
  Measured,
  SCHEMA_VERSION,
  buildPretrade,
} from "./buildPretrade";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { QuoteResult, VenueQuote, VenueStatus } from "@/lib/dossier/providers/tradierStatus";
import {
  RELEVANT_8K_ITEMS,
  RELEVANT_OTHER_FORMS,
} from "@/lib/dossier/providers/edgarCatalysts";

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
  chainOi: 819_240,
  analystCount: 12,
  analystMeanTargetUsd: 23.58,
  socialBullishPctOfTagged: 90,
  socialTaggedCount: 30,
  socialSpanHours: 7.6,
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
  marketExposure: new Map(),
  catalysts: new Map(),
  venue: null,
  ...over,
});

/**
 * A venue reply shaped like the sandbox's own: an open session, and APLD's
 * real 31.19 / 31.20 book. `quotes` carries one entry per symbol ASKED FOR,
 * so "the venue does not quote this" stays an answer rather than a gap.
 */
const venueOpen = (over: Partial<VenueQuote["book"]> = {}, quoteOver: Partial<QuoteResult> = {}) =>
  ({
    ok: true as const,
    env: "sandbox" as const,
    clock: {
      state: "open",
      nextState: "postmarket",
      nextChangeEt: "16:00",
      nextChangeIso: "2026-08-17T20:00:00.000Z",
      nextChangeReason: null,
      asOf: "2026-08-17T19:50:00.000Z",
    },
    quotes: new Map<string, QuoteResult>([
      [
        "APLD",
        {
          ok: true,
          quote: {
            symbol: "APLD",
            book: { bid: 31.19, ask: 31.2, bid_size: 100, ask_size: 3200, spread_bp: 3.2056, age_seconds: 4, ...over },
            bookAsOf: "2026-08-17T19:49:56.000Z",
          },
          ...quoteOver,
        } as QuoteResult,
      ],
    ]),
  }) satisfies VenueStatus;

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
    const r = buildPretrade(inputs());
    const s = r.symbols[0];
    expect((r.session.status as { reason: string }).reason).toBe("venue_not_queried");
    expect((s.tradability.book as { reason: string }).reason).toBe("venue_not_queried");
    expect((s.catalysts.filings_since_prior_close as { reason: string }).reason).toBe(
      "edgar_not_fetched"
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

describe("buildPretrade — tradability from the venue clock and book", () => {
  /*
   * The session is stated ONCE at the root. It is a market-wide fact, and
   * repeating it inside every symbol both duplicated it twelve times over and
   * implied a per-symbol claim the feed cannot make: the quote payload has no
   * halt flag, so "open" never means "this name is trading".
   */
  it("states the session once, at the root, not inside every symbol", () => {
    const r = buildPretrade(inputs({ symbols: ["APLD", "WULF"], venue: venueOpen() }));
    const status = measured(r.session.status);
    expect(status.value).toBe("open");
    expect(status.source).toBe("tradier_sandbox_clock");

    const ends = measured(r.session.ends_at);
    expect(ends.value).toBe("2026-08-17T20:00:00.000Z");
    expect(ends.method).toBe("next_state_postmarket");

    for (const s of r.symbols) {
      expect(Object.keys(s.tradability)).toEqual(["book"]);
    }
  });

  /*
   * The delay regime rides in the provenance because it is worth an entire
   * execution window: sandbox quotes are fifteen minutes delayed, production
   * quotes are not, and a consumer cannot read the deployment's env var.
   */
  it("names the delay regime in the source of every book it serves", () => {
    const s = buildPretrade(inputs({ venue: venueOpen() })).symbols[0];
    const book = measured(s.tradability.book);
    expect(book.source).toBe("tradier_sandbox_quotes");
    expect(book.value.spread_bp).toBeCloseTo(3.2056, 3);
    expect(book.as_of).toBe("2026-08-17T19:49:56.000Z");
  });

  /*
   * A live snapshot is not the round-trip cost, and the method string has to
   * make that impossible to misread — net_edge stays null until twenty
   * sessions of execution-window medians exist, and a 3.2bp book sitting in
   * the same payload is the obvious thing to substitute.
   */
  it("labels the book so it cannot be mistaken for the measured round trip", () => {
    const s = buildPretrade(inputs({ venue: venueOpen() })).symbols[0];
    expect(measured(s.tradability.book).method).toContain("NOT_session_median");
    expect(s.net_edge.value).toBeNull();
  });

  /*
   * The age travels INSIDE the book so the two can never be separated. A
   * consumer that slices out `book.value` still holds the fact that makes the
   * spread interpretable.
   */
  it("carries the age inside the book, not beside it", () => {
    const s = buildPretrade(inputs({ venue: venueOpen() })).symbols[0];
    expect(measured(s.tradability.book).value.age_seconds).toBe(4);
  });

  /*
   * A symbol the venue does not quote is a different answer from a venue that
   * was never asked, which is different again from one that refused the
   * request. All three are reasons; none is a bare null.
   */
  it("distinguishes not-quoted from not-queried from venue-down", () => {
    const notQuoted = buildPretrade(
      inputs({
        venue: {
          ...venueOpen(),
          quotes: new Map<string, QuoteResult>([
            ["APLD", { ok: false, reason: "not_quoted_by_venue" }],
          ]),
        },
      })
    );
    expect((notQuoted.symbols[0].tradability.book as { reason: string }).reason).toBe(
      "not_quoted_by_venue"
    );
    // The session clock is market-wide, so it survives one symbol's absence.
    expect(measured(notQuoted.session.status).value).toBe("open");

    const down = buildPretrade(
      inputs({ venue: { ok: false, reason: "tradier_http_401", configured: true } })
    );
    expect((down.session.status as { reason: string }).reason).toBe("tradier_http_401");
    expect((down.symbols[0].tradability.book as { reason: string }).reason).toBe(
      "tradier_http_401"
    );

    const unconfigured = buildPretrade(
      inputs({ venue: { ok: false, reason: "tradier_not_configured", configured: false } })
    );
    expect((unconfigured.session.status as { reason: string }).reason).toBe(
      "tradier_not_configured"
    );
  });

  /*
   * Outside a session the venue's next_change is a bare ET time belonging to
   * a later day. Rather than name an instant a holiday could invalidate, the
   * raw time is handed over in the detail.
   */
  it("hands over the raw ET time when the next change is not today", () => {
    const r = buildPretrade(
      inputs({
        venue: {
          ...venueOpen(),
          clock: {
            state: "closed",
            nextState: "premarket",
            nextChangeEt: "07:00",
            nextChangeIso: null,
            nextChangeReason: "next_change_not_on_clock_date",
            asOf: "2026-08-16T21:00:23.000Z",
          },
        },
      })
    );
    const ends = r.session.ends_at as { reason: string; detail: Record<string, string> };
    expect(ends.reason).toBe("next_change_not_on_clock_date");
    expect(ends.detail.next_change_et).toBe("07:00");
    expect(ends.detail.next_state).toBe("premarket");
    expect(measured(r.session.status).value).toBe("closed");
  });
});

describe("buildPretrade — beta before premium", () => {
  const exposure = {
    proxy: "SPY",
    window_sessions: 250,
    observations: 250,
    beta: 4.63,
    alpha_bp: 25.1,
    alpha_t: 1.4,
    alpha_significant_after_fdr: false,
    detectable_alpha_at_t3_bp: 53.6,
    r_squared: 0.44,
    proxy_net_bp: 6.36,
    derivation: "regressed_ols" as const,
  };

  /*
   * THE MIS-ATTRIBUTION THIS BLOCK EXISTS TO PREVENT. A consumer reading
   * APLD's +51.7bp net premium and nothing else would rank it as an edge.
   * Beta 4.63 on a market that itself returned 6.36bp a night accounts for
   * 29bp of it, and the residual is not significant. A ranking on realised
   * premium is a ranking on market exposure.
   */
  it("serves the decomposition beside the premium, not instead of it", () => {
    const s = buildPretrade(inputs({ marketExposure: new Map([["APLD", exposure]]) })).symbols[0];
    const m = measured(s.market_exposure);
    expect(m.value.beta).toBe(4.63);
    expect(m.value.alpha_significant_after_fdr).toBe(false);
    // The premium itself is still there — this adds context, never replaces.
    expect(s.overnight.legs).toHaveLength(2);
  });

  /*
   * The proxy's own return ships with the row so beta x market is computable
   * from one call. Supplied as a FACT rather than as a derived "share
   * explained", which would be an interpretation the payload must not make.
   */
  it("carries the proxy's own premium so the arithmetic needs no second call", () => {
    const m = measured(
      buildPretrade(inputs({ marketExposure: new Map([["APLD", exposure]]) })).symbols[0]
        .market_exposure
    );
    expect(m.value.proxy_net_bp).toBe(6.36);
    expect(m.value.beta * m.value.proxy_net_bp).toBeCloseTo(29.4, 1);
  });

  /*
   * A null alpha from a test that could not have seen one is not evidence of
   * absence, so the detectable floor rides with the row.
   */
  it("states the alpha it could have detected, not only the one it found", () => {
    const m = measured(
      buildPretrade(inputs({ marketExposure: new Map([["APLD", exposure]]) })).symbols[0]
        .market_exposure
    );
    expect(m.value.detectable_alpha_at_t3_bp).toBeGreaterThan(Math.abs(m.value.alpha_bp));
    expect(m.method).toContain("fdr_across_all_alphas");
  });

  it("says a symbol is outside the study rather than omitting the block", () => {
    const s = buildPretrade(inputs()).symbols[0];
    expect((s.market_exposure as { reason: string }).reason).toBe("not_in_overnight_study");
  });
});

describe("buildPretrade — the catalyst filter is declared once", () => {
  /*
   * Which forms qualify is identical for every symbol, so restating it in
   * twelve method strings was ~70 wasted bytes apiece and twelve chances for
   * the stated filter to drift from the applied one. It is now read straight
   * off the module that implements the predicate.
   */
  it("declares the closed form list at the root, from the predicate's own constants", () => {
    const r = buildPretrade(
      inputs({
        catalysts: new Map([
          ["APLD", { ok: true, windowStart: "2026-08-14T20:00:00.000Z", filings: [] }],
        ]),
      })
    );
    expect(r.catalyst_filter.forms_8k_items).toEqual([...RELEVANT_8K_ITEMS]);
    expect(r.catalyst_filter.other_forms).toEqual([...RELEVANT_OTHER_FORMS]);
    expect(r.catalyst_filter.window_start).toBe("2026-08-14T20:00:00.000Z");
  });

  /* No successful fetch means no symbol was measured against any window. */
  it("leaves the window null when every lookup failed", () => {
    const r = buildPretrade(
      inputs({ catalysts: new Map([["APLD", { ok: false, reason: "edgar_http_503" }]]) })
    );
    expect(r.catalyst_filter.window_start).toBeNull();
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

describe("buildPretrade — after-hours filings", () => {
  it("serves filings with the window baked into the method string", () => {
    const r = buildPretrade(
      inputs({
        catalysts: new Map([
          [
            "APLD",
            {
              ok: true,
              windowStart: "2026-08-14T20:00:00.000Z",
              filings: [
                { form: "8-K", items: ["2.02"], filed_at: "2026-08-14T21:05:00.000Z", accession: "acc-1" },
              ],
            },
          ],
        ]),
      })
    );
    const f = measured(r.symbols[0].catalysts.filings_since_prior_close);
    expect(f.value).toHaveLength(1);
    expect(f.value[0].accession).toBe("acc-1");
    expect(f.method).toBe("accepted_after_2026-08-14T20:00:00.000Z");
    expect(f.source).toBe("sec_edgar_submissions");
  });

  /* An empty list from a SUCCESSFUL fetch is a real answer: nothing filed. */
  it("distinguishes confirmed-quiet from could-not-look", () => {
    const quiet = buildPretrade(
      inputs({
        catalysts: new Map([
          ["APLD", { ok: true, windowStart: "2026-08-14T20:00:00.000Z", filings: [] }],
        ]),
      })
    ).symbols[0];
    expect(measured(quiet.catalysts.filings_since_prior_close).value).toEqual([]);

    const failed = buildPretrade(
      inputs({ catalysts: new Map([["APLD", { ok: false, reason: "edgar_http_503" }]]) })
    ).symbols[0];
    expect((failed.catalysts.filings_since_prior_close as { reason: string }).reason).toBe(
      "edgar_http_503"
    );
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

  /*
   * MARGINAL cost per symbol, on the FULLEST symbol this can produce.
   *
   * Two things about this test were wrong before and both are worth stating.
   * It measured a payload of NULLS, where every absent field is a short
   * reason string rather than a whole envelope — so it passed comfortably
   * while the real populated symbol was 2,700 bytes, and asserted nothing at
   * all. And it measured a ONE-SYMBOL response, which charges that symbol for
   * the root's session block and catalyst filter; those are paid once however
   * many symbols are asked for, so counting them per symbol would penalise
   * exactly the de-duplication that made the payload smaller.
   *
   * The budget has moved twice and each move is argued rather than reflexive:
   *
   *   2,048 -> 2,300  method strings like
   *                   "short_volume_over_total_volume_NOT_short_interest",
   *                   which exists because flow and standing interest have
   *                   been conflated before.
   *   2,300 -> 2,400  the 172-byte market_exposure block. It is what stops a
   *                   consumer reading APLD's +51.7bp net premium as an edge
   *                   when beta 4.63 on overnight SPY explains nearly all of
   *                   it. The cheapest 172 bytes in the payload.
   *
   * The rule for the next move: name the block, its byte cost, and the
   * specific misreading it prevents. A budget raised without those three is
   * not a budget.
   */
  it("keeps the MARGINAL cost of a fully populated symbol within budget", () => {
    const full = (symbols: string[]) =>
      inputs({
        symbols,
        venue: venueOpen(),
        marketExposure: new Map(
          symbols.map((s) => [
            s,
            {
              proxy: "SPY", window_sessions: 250, observations: 250, beta: 4.63,
              alpha_bp: 25.1, alpha_t: 1.4, alpha_significant_after_fdr: false,
              detectable_alpha_at_t3_bp: 53.6, r_squared: 0.44, proxy_net_bp: 6.36,
              derivation: "regressed_ols" as const,
            },
          ])
        ),
        positioningLatest: { generatedAt: NOW, points: symbols.map((s) => position({ symbol: s })) },
        overnight: {
          generatedAt: NOW,
          rows: symbols.flatMap((symbol) =>
            [120, 250].map((window) => ({
              symbol, lastClose: 31.2, asOf: "2026-08-14", window,
              observations: window, overnightGrossBp: 40, overnightNetBp: 33.6,
              tStat: 1.1, significantAfterFdr: false,
            }))
          ),
        },
        earnings: {
          generatedAt: NOW,
          entries: symbols.map((s) => ({ symbol: s, date: "2026-10-08" })),
        },
        measuredRoundTripBp: new Map(symbols.map((s) => [s, { bp: 6.4, reason: null }])),
        dataQuality: new Map(symbols.map((s) => [s, { adjustments: 0, undeclared: 0 }])),
        catalysts: new Map(
          symbols.map((s) => [
            s,
            {
              ok: true as const,
              windowStart: "2026-08-14T20:00:00.000Z",
              filings: [
                {
                  form: "8-K", items: ["2.02", "9.01"],
                  filed_at: "2026-08-14T21:05:00.000Z",
                  accession: "0001096906-26-001872",
                },
              ],
            },
          ])
        ),
      });

    const one = buildPretrade(full(["APLD"]));
    // Nothing is measured as absent here, so this is the expensive case.
    expect(one.symbols[0].tradability.book.value).not.toBeNull();
    expect(one.symbols[0].net_edge.value).not.toBeNull();
    expect(one.symbols[0].market_exposure.value).not.toBeNull();
    expect(measured(one.symbols[0].catalysts.filings_since_prior_close).value).toHaveLength(1);

    const marginal =
      JSON.stringify(buildPretrade(full(["APLD", "WULF"]))).length - JSON.stringify(one).length;
    expect(marginal).toBeLessThan(2_400);
  });
});
