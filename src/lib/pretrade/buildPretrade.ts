import {
  EarningsCalendar,
  earningsStatus,
} from "@/lib/markets/earningsVeto";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import {
  CatalystFiling,
  RELEVANT_8K_ITEMS,
  RELEVANT_OTHER_FORMS,
} from "@/lib/dossier/providers/edgarCatalysts";
import { VenueBook, VenueStatus } from "@/lib/dossier/providers/tradierStatus";

/**
 * THE AGENT-FACING PRE-TRADE PAYLOAD.
 *
 * The consumer is a program assembling a decision inside a short execution
 * window, not a browser. Today it fetches a 235KB server-rendered page and
 * regex-scrapes about thirty numbers out of it — an approach that has already
 * failed once, when copy changes silently degraded sixteen validation checks
 * to SKIP and needed three patterns rewritten. HTML is a rendering, not an
 * interface.
 *
 * ── Every value is an envelope, never a bare scalar ───────────────────
 *
 * A number with no provenance cannot be argued with. The concrete case: a
 * stale reference file reported two ATR checks as FAILURES when the page was
 * right and the checker was wrong — it used a simple mean where the app
 * correctly uses Wilder smoothing, and neither side declared its method. An
 * hour to diagnose something `method` would have settled instantly. So every
 * value carries what it is, when it was true, where it came from, and how it
 * was computed.
 *
 * ── Null is an answer; a default is a lie ─────────────────────────────
 *
 * Nothing here substitutes a zero, a default, or a last-known-good silently.
 * A value that cannot be computed comes back null WITH a machine-readable
 * reason, so a consumer can distinguish "measured as absent" from "never
 * measured" — a distinction this codebase has had to repair in three separate
 * places already.
 *
 * ── No verdicts, deliberately ─────────────────────────────────────────
 *
 * No score, no rating, no buy or sell language. Those exist elsewhere on the
 * site, and of the composite's own voters only a minority clear their own
 * bar. An unvalidated score sharing a payload with a measured edge invites
 * the first overriding the second. Facts and provenance only.
 */

/** ISO-8601 instant or date, whichever the source actually knows. */
export type AsOf = string;

/** A value that exists, with everything needed to argue about it. */
export interface Measured<T> {
  value: T;
  unit: string;
  as_of: AsOf;
  source: string;
  /** How it was computed. Absent only where the value is a raw passthrough. */
  method?: string;
}

/** A value that does not exist, and why. Never a default in disguise. */
export interface Unmeasured {
  value: null;
  reason: string;
  /** Extra context the reason alone cannot carry, e.g. sessions_available. */
  detail?: Record<string, number | string>;
}

export type Field<T> = Measured<T> | Unmeasured;

export const unmeasured = (reason: string, detail?: Record<string, number | string>): Unmeasured =>
  detail ? { value: null, reason, detail } : { value: null, reason };

/**
 * Semantic versioning, enforced by convention and stated here so a consumer
 * can pin against it: additive changes bump MINOR, any field removal or
 * change of meaning bumps MAJOR.
 *
 * 2.0 — the venue feed landed, and with it the realisation that
 *       `tradability.status` was in the wrong place. The session state is
 *       MARKET-wide: repeating it inside every symbol duplicated it twelve
 *       times and, worse, implied a per-symbol claim the feed cannot support.
 *       It moved to `session` at the response root, and the declared filing
 *       forms moved to `catalyst_filter` for the same reason. A field moved
 *       out of a symbol is a removal, so this is MAJOR by the rule above even
 *       though `tradability.status` had never carried a value.
 */
export const SCHEMA_VERSION = "2.0";

/**
 * WHAT THE OVERNIGHT PREMIUM ACTUALLY IS, after the market is taken out.
 *
 * The single most consequential number this payload carries, and it was
 * missing. A consumer reading APLD's +51.7bp net premium had no way to know
 * that a beta of 4.63 on overnight SPY accounts for nearly all of it — so a
 * ranking built on realised premium is a ranking on BETA, and the same
 * exposure is available through QQQ at roughly a tenth of the cost per unit.
 *
 * Measured 2026-08-16 across the scanned cohort: 0 of 76 alphas clear
 * Benjamini-Hochberg at q=0.10, on either market proxy, at either window.
 */
export interface MarketExposure {
  /** The market series regressed against. */
  proxy: string;
  window_sessions: number;
  /** Matched nights — both series had to price the same date. */
  observations: number;
  /** Slope on the proxy's overnight return. What the position is actually long. */
  beta: number;
  /** Intercept: return the market does not explain, in bp per night. */
  alpha_bp: number;
  alpha_t: number;
  /** FDR across every alpha in the study, failures included. */
  alpha_significant_after_fdr: boolean;
  /**
   * The smallest alpha this regression could have called significant at t=3.
   * A null alpha from a test that could not have seen it is not evidence of
   * absence, and a consumer must be able to tell the two apart.
   */
  detectable_alpha_at_t3_bp: number;
  /** Share of nightly variance the market explains. */
  r_squared: number;
  /**
   * The proxy's OWN net premium per night, so beta x this is computable
   * without a second call. Supplied as a fact rather than as a derived
   * "share explained", which would be an interpretation.
   */
  proxy_net_bp: number;
}

export interface OvernightLeg {
  window_sessions: number;
  observations: number;
  gross_bp: number;
  net_bp: number;
  t_stat: number;
  /** Whether it survives Benjamini-Hochberg across the whole declared family. */
  significant_after_fdr: boolean;
}

export interface PretradeSymbol {
  symbol: string;
  /**
   * Can this be traded right now, and against what book?
   *
   * Only per-SYMBOL venue facts live here; the session state is market-wide
   * and sits at the response root. The venue's quote feed carries no halt
   * flag, so nothing here emits one and nothing infers one from a thin book:
   * a one-sided book at 03:00 is a book nobody is quoting overnight, and from
   * here that is indistinguishable from a halt.
   *
   * `age_seconds` rides INSIDE the book rather than beside it, so the two can
   * never be separated. It is what keeps the rest honest — a weekend quote
   * returns Friday's one-tick book with nothing marking it stale, and priced
   * as live a 3.2bp spread describes a market that closed two days ago.
   */
  tradability: {
    /** Top of book. ONE snapshot — never the execution-window median. */
    book: Field<VenueBook>;
  };
  price: {
    last: Field<number>;
  };
  volatility: {
    typical_daily_move_pct: Field<number>;
  };
  overnight: {
    legs: OvernightLeg[] | null;
    reason?: string;
  };
  execution: {
    entry_window: Field<Record<string, number>>;
    exit_window: Field<Record<string, number>>;
  };
  /** The field that decides a trade. Null until the spread is MEASURED. */
  net_edge: Field<number>;
  /**
   * The overnight premium decomposed into market exposure and residual.
   * Null with a reason for anything outside the declared study.
   */
  market_exposure: Field<MarketExposure>;
  catalysts: {
    /** Three states, never a boolean. See earningsVeto.ts. */
    earnings_status: "confirmed_date" | "confirmed_none" | "lookup_failed";
    earnings_detail: Field<string>;
    filings_since_prior_close: Field<CatalystFiling[]>;
  };
  positioning: {
    net_dealer_gamma_per_1pct: Field<number>;
    gamma_sign: Field<string>;
    /** Daily short-sale VOLUME share. NOT short interest. */
    short_sale_volume_share_pct: Field<number>;
  };
  /** Corporate-action interventions applied to this symbol's bars. Never silent. */
  data_quality: {
    corporate_action_adjustments: number;
    undeclared_steps: number;
  };
}

export interface PretradeResponse {
  schema_version: string;
  generated_at: AsOf;
  /**
   * The venue session. Market-wide, so stated ONCE — a status repeated inside
   * every symbol would read as a claim about that symbol, which the feed
   * cannot make.
   */
  session: {
    /** open | closed | premarket | postmarket. */
    status: Field<string>;
    /** ISO instant the state next changes. */
    ends_at: Field<string>;
  };
  /**
   * The declared, closed filing filter — identical for every symbol, so
   * declared once rather than restated in twelve method strings. Each
   * symbol's filings field still carries the window instant with its value.
   */
  catalyst_filter: {
    /** Filings count only when accepted strictly after this instant. */
    window_start: string | null;
    /** 8-K items that qualify. A bare 9.01 is exhibits, and does not. */
    forms_8k_items: string[];
    /** Non-8-K forms that qualify; 424B matches as a prefix. */
    other_forms: string[];
  };
  /** Symbols asked for that nothing is known about, so a caller can tell. */
  unknown_symbols: string[];
  symbols: PretradeSymbol[];
}

export interface OvernightRow {
  symbol: string;
  lastClose: number | null;
  asOf: string | null;
  window: number;
  guardRepairs?: number;
  observations: number;
  overnightGrossBp: number;
  overnightNetBp: number;
  tStat: number;
  significantAfterFdr: boolean;
}

export interface BuildInputs {
  symbols: string[];
  now: number;
  overnight: { generatedAt: number; rows: OvernightRow[] };
  positioningLatest: { generatedAt: number; points: PositioningPoint[] };
  earnings: EarningsCalendar | null;
  /**
   * Measured round-trip cost per symbol, in bp, once spreadHistory has
   * enough sessions. Absent for every symbol until then — and the reason is
   * surfaced rather than papered over with the modelled estimate, because a
   * modelled spread presented as a measured one is how a fictional edge gets
   * published.
   */
  measuredRoundTripBp: Map<string, { bp: number | null; reason: string | null }>;
  /** Corporate-action counts per symbol, from the ingest guard. */
  dataQuality: Map<string, { adjustments: number; undeclared: number }>;
  /**
   * Beta/alpha rows from the overnight study, keyed by symbol. Absent for
   * anything the study does not cover, which is a stated reason rather than
   * a silent omission.
   */
  marketExposure: Map<string, MarketExposure>;
  /**
   * After-hours EDGAR filings per symbol, fetched live by the route. Absent
   * from the map means the fetch was not attempted; an entry with ok:false
   * carries the failure so "no filings" and "could not look" stay opposite
   * answers.
   */
  catalysts: Map<
    string,
    | { ok: true; filings: CatalystFiling[]; windowStart: string }
    | { ok: false; reason: string }
  >;
  /**
   * Live venue clock and top of book, fetched once for the whole call. Null
   * when the route did not attempt it at all, which is a different answer
   * from a venue that was asked and refused.
   */
  venue: VenueStatus | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function buildPretrade(input: BuildInputs): PretradeResponse {
  const { symbols, now, overnight, positioningLatest, earnings } = input;
  const overnightBySymbol = new Map<string, OvernightRow[]>();
  for (const r of overnight.rows) {
    overnightBySymbol.set(r.symbol, [...(overnightBySymbol.get(r.symbol) ?? []), r]);
  }
  const positionBySymbol = new Map(positioningLatest.points.map((p) => [p.symbol, p]));

  const unknown: string[] = [];
  const out: PretradeSymbol[] = [];

  /*
   * The session clock is market-wide, so it is resolved once rather than per
   * symbol. `venueSource` names the delay regime in the provenance a consumer
   * reads: sandbox quotes are fifteen minutes delayed and production quotes
   * are not, which is the difference between describing this execution window
   * and describing the previous one.
   */
  const venue = input.venue;
  const venueUnavailable = venue === null ? "venue_not_queried" : venue.ok ? null : venue.reason;
  const venueSource = venue?.ok ? `tradier_${venue.env}_quotes` : "tradier";
  const session: PretradeResponse["session"] = {
    status: venue?.ok
      ? {
          value: venue.clock.state,
          unit: "session_state",
          as_of: venue.clock.asOf,
          source: `tradier_${venue.env}_clock`,
        }
      : unmeasured(venueUnavailable ?? "venue_not_queried"),
    ends_at: !venue?.ok
      ? unmeasured(venueUnavailable ?? "venue_not_queried")
      : venue.clock.nextChangeIso
        ? {
            value: venue.clock.nextChangeIso,
            unit: "iso_instant",
            as_of: venue.clock.asOf,
            source: `tradier_${venue.env}_clock`,
            method: `next_state_${venue.clock.nextState}`,
          }
        : /*
           * The venue reports the next change as a bare ET wall clock with no
           * date. Outside a session that time belongs to a later day this code
           * cannot identify without a holiday calendar, so the raw time is
           * handed over instead of an instant the market might not honour.
           */
          unmeasured(venue.clock.nextChangeReason ?? "next_change_unresolved", {
            next_change_et: venue.clock.nextChangeEt,
            next_state: venue.clock.nextState,
          }),
  };

  for (const symbol of symbols) {
    const legs = overnightBySymbol.get(symbol);
    const pos = positionBySymbol.get(symbol);
    if (!legs && !pos) {
      unknown.push(symbol);
      continue;
    }

    const priceRow = legs?.find((l) => l.lastClose !== null) ?? null;
    const overnightAsOf = priceRow?.asOf ?? null;
    /*
     * Declared back-adjustments PLUS auto-repaired spikes. Counting only the
     * declared ones reported MARA at zero while its two placeholder prints had
     * been silently repaired — an under-report in a field whose entire purpose
     * is that interventions are never silent.
     */
    const declaredDq = input.dataQuality.get(symbol) ?? { adjustments: 0, undeclared: 0 };
    const repairs = legs?.find((l) => l.guardRepairs != null)?.guardRepairs ?? 0;
    const dq = { adjustments: Math.max(declaredDq.adjustments, repairs), undeclared: declaredDq.undeclared };
    const measured = input.measuredRoundTripBp.get(symbol) ?? { bp: null, reason: "no_spread_history" };

    /*
     * net_edge is the net overnight premium MINUS the measured round trip.
     * It stays null while the cost is modelled: substituting the estimate
     * would look identical to a real answer and be wrong by up to two orders
     * of magnitude on these names.
     */
    const best = legs?.slice().sort((a, b) => b.observations - a.observations)[0] ?? null;
    const netEdge: Field<number> =
      measured.bp === null || !best
        ? unmeasured(measured.reason ?? "no_spread_history")
        : {
            value: best.overnightNetBp - measured.bp,
            unit: "bp",
            as_of: overnightAsOf ?? iso(overnight.generatedAt),
            source: "overnight_premium + spread_history",
            method: "mean_overnight_net_bp_minus_measured_round_trip",
          };

    const es = earningsStatus(symbol, earnings, now);

    /*
     * A book is served only when the venue actually quoted a two-sided one.
     * Crossed and one-sided books are refused on the same rules the spread
     * recorder applies, so the live snapshot and the measured median are
     * never drawn from different samples.
     */
    const q = venue?.ok ? venue.quotes.get(symbol) : undefined;
    const quoteReason = venueUnavailable ?? (q ? (q.ok ? null : q.reason) : "venue_not_queried");

    out.push({
      symbol,
      tradability: {
        book: q?.ok
          ? {
              value: q.quote.book,
              unit: "usd_shares_bp_seconds",
              as_of: q.quote.bookAsOf,
              source: venueSource,
              // Named so it can never be mistaken for the round-trip cost:
              // one snapshot of the top of book, not a session median. The
              // as_of and age_seconds both date the STALER side of the book.
              method: "top_of_book_snapshot_spread_over_mid_NOT_session_median",
            }
          : unmeasured(quoteReason ?? "no_quote"),
      },
      price: {
        last:
          priceRow?.lastClose != null && overnightAsOf
            ? {
                value: priceRow.lastClose,
                unit: "usd",
                as_of: overnightAsOf,
                source: "yahoo_daily_bars",
                method: "split_and_dividend_adjusted_close",
              }
            : unmeasured("no_bars_ingested"),
      },
      volatility: {
        typical_daily_move_pct:
          pos?.typicalDailyMovePct != null
            ? {
                value: pos.typicalDailyMovePct,
                unit: "pct",
                as_of: pos.date,
                source: "yahoo_daily_bars",
                method: "wilder_atr_14_over_close",
              }
            : unmeasured("insufficient_history"),
      },
      overnight: legs?.length
        ? {
            legs: legs
              .slice()
              .sort((a, b) => a.window - b.window)
              .map((l) => ({
                window_sessions: l.window,
                observations: l.observations,
                gross_bp: l.overnightGrossBp,
                net_bp: l.overnightNetBp,
                t_stat: l.tStat,
                significant_after_fdr: l.significantAfterFdr,
              })),
          }
        : { legs: null, reason: "insufficient_history" },
      execution: {
        entry_window: unmeasured(measured.reason ?? "no_spread_history"),
        exit_window: unmeasured(measured.reason ?? "no_spread_history"),
      },
      net_edge: netEdge,
      market_exposure: (() => {
        const m = input.marketExposure.get(symbol);
        if (!m) return unmeasured("not_in_overnight_study");
        return {
          value: m,
          unit: "beta_and_bp",
          as_of: overnightAsOf ?? iso(overnight.generatedAt),
          source: "overnight_premium_study",
          method:
            `ols_overnight_on_${m.proxy}_same_nights_both_sides_tick_net_` +
            `fdr_across_all_alphas`,
        };
      })(),
      catalysts: {
        earnings_status: es.status,
        earnings_detail:
          es.status === "confirmed_date"
            ? { value: es.date, unit: "iso_date", as_of: iso(now), source: "earnings_calendar", method: "sessions_until_report" }
            : es.status === "confirmed_none"
              ? { value: es.nextDate, unit: "iso_date", as_of: iso(now), source: "earnings_calendar", method: "next_report_outside_window" }
              : unmeasured(es.reason, es.calendarAgeDays !== null ? { calendar_age_days: es.calendarAgeDays } : undefined),
        filings_since_prior_close: (() => {
          const c = input.catalysts.get(symbol);
          if (!c) return unmeasured("edgar_not_fetched");
          if (!c.ok) return unmeasured(c.reason);
          return {
            value: c.filings,
            unit: "filings",
            as_of: iso(now),
            source: "sec_edgar_submissions",
            // The window instant stays WITH the value, so a symbol's block is
            // still self-contained. Which forms qualify is identical for every
            // symbol, so it is declared once in catalyst_filter at the root.
            method: `accepted_after_${c.windowStart}`,
          };
        })(),
      },
      positioning: {
        net_dealer_gamma_per_1pct:
          pos?.netGexUsdPer1Pct != null
            ? {
                value: pos.netGexUsdPer1Pct,
                unit: "usd_per_1pct",
                as_of: pos.date,
                source: "cboe_delayed_chain",
                method: "call_gamma_minus_put_gamma_x_oi_x_100_x_spot_x_1pct",
              }
            : unmeasured("no_options_chain"),
        gamma_sign:
          pos?.gammaSign != null
            ? { value: pos.gammaSign, unit: "sign", as_of: pos.date, source: "cboe_delayed_chain" }
            : unmeasured("no_options_chain"),
        short_sale_volume_share_pct:
          pos?.shortRatioPct != null
            ? {
                value: pos.shortRatioPct,
                unit: "pct",
                as_of: pos.date,
                source: "finra_reg_sho_daily",
                // Named precisely: this is FLOW, not the standing short interest.
                method: "short_volume_over_total_volume_NOT_short_interest",
              }
            : unmeasured("no_finra_row"),
      },
      data_quality: {
        corporate_action_adjustments: dq.adjustments,
        undeclared_steps: dq.undeclared,
      },
    });
  }

  /*
   * The window is identical for every symbol — it is a function of `now`, not
   * of the ticker — so it is read off whichever fetch succeeded rather than
   * recomputed here. Null when none did, which is the honest answer: no
   * symbol was measured against any window.
   */
  const windowStart =
    [...input.catalysts.values()].find(
      (c): c is { ok: true; filings: CatalystFiling[]; windowStart: string } => c.ok
    )?.windowStart ?? null;

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: iso(now),
    session,
    catalyst_filter: {
      window_start: windowStart,
      forms_8k_items: [...RELEVANT_8K_ITEMS],
      other_forms: [...RELEVANT_OTHER_FORMS],
    },
    unknown_symbols: unknown,
    symbols: out,
  };
}
