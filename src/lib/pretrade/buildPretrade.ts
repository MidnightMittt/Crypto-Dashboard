import {
  EarningsCalendar,
  earningsStatus,
} from "@/lib/markets/earningsVeto";
import { PositioningPoint } from "@/lib/history/positioningHistory";

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
 */
export const SCHEMA_VERSION = "1.0";

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
  tradability: {
    /** Halt state needs a live venue feed; not wired, so it says so. */
    status: Field<string>;
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
  catalysts: {
    /** Three states, never a boolean. See earningsVeto.ts. */
    earnings_status: "confirmed_date" | "confirmed_none" | "lookup_failed";
    earnings_detail: Field<string>;
    filings_since_prior_close: Field<unknown[]>;
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

    out.push({
      symbol,
      tradability: {
        // Halt and fractional eligibility need a live venue feed. Not wired.
        status: unmeasured("no_venue_status_feed"),
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
      catalysts: {
        earnings_status: es.status,
        earnings_detail:
          es.status === "confirmed_date"
            ? { value: es.date, unit: "iso_date", as_of: iso(now), source: "earnings_calendar", method: "sessions_until_report" }
            : es.status === "confirmed_none"
              ? { value: es.nextDate, unit: "iso_date", as_of: iso(now), source: "earnings_calendar", method: "next_report_outside_window" }
              : unmeasured(es.reason, es.calendarAgeDays !== null ? { calendar_age_days: es.calendarAgeDays } : undefined),
        // EDGAR after-hours filings are not wired yet; saying so beats omitting it.
        filings_since_prior_close: unmeasured("edgar_intraday_feed_not_wired"),
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

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: iso(now),
    unknown_symbols: unknown,
    symbols: out,
  };
}
