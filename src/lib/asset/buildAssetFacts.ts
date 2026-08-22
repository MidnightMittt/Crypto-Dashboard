import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { assessPriceStaleness } from "./priceStaleness";
import { CONSTANT_MATURITY_DAYS, ivRichness } from "@/lib/options/ivTermStructure";
import { PositioningPoint } from "@/lib/history/positioningHistory";
import { PanelRow, SymbolPanel } from "@/lib/research/barsPanel";
import { StopWidthVerdict, stopGrid, stopVerdictAt } from "@/lib/research/stopViability";
import { trendState } from "@/lib/research/trendState";
import { Bar } from "@/lib/research/types";

/**
 * ONE SYMBOL, FLAT, FOR A MACHINE IN A HURRY.
 *
 * The consumer is the trading agent, mid-decision. Pulling raw bars from the
 * broker to answer "is a −8% twenty-day return unusual for this name?" blew
 * a token limit three times in one session — 200KB of bars to reach one
 * percentile. This module answers from data the repository already commits —
 * the bars panel, the positioning projection, the earnings calendar — and
 * consults NO provider at all. That is what keeps the route in milliseconds,
 * and it is not merely an optimisation: the one live probe this originally
 * carried failed on every production request (Nasdaq rejects datacenter IPs)
 * while spending its full 1.2s timeout, and answered differently on a laptop
 * than on the server for the same symbol.
 *
 * Four rules, from the brief that commissioned this, each load-bearing:
 *
 *   - `null` for missing, NEVER 0. A zero short-share is a real observation;
 *     a missing one is not, and a filter cannot tell them apart once merged.
 *   - `earnings_status` is three-state. "We found no earnings" and "we could
 *     not find out" have OPPOSITE trading consequences: one clears an event
 *     veto, the other demands a manual check.
 *   - TWO timestamps. `asof` is when this response was computed;
 *     `price_asof` is the session the price belongs to. The night this was
 *     commissioned, a book was 7.5 minutes stale while a trade printed 4
 *     seconds earlier — and which side was stale kept flipping. Merging the
 *     clocks destroys exactly the information that resolves that.
 *   - No verdicts. Like /api/pretrade: facts with their instants, so the
 *     agent's own judgement has something honest to stand on.
 */

/** Snake_case on the wire, matching the brief and /api/pretrade's contract. */
export interface AssetFacts {
  symbol: string;
  /** When this response was computed. NOT the age of any value in it. */
  asof: string;

  /** Last real close in the committed panel — never an interpolated fill. */
  price: number | null;
  /** The session that close belongs to. Its distance from `asof` is real information. */
  price_asof: string | null;
  price_source: "daily-close";
  /**
   * WHETHER THIS PRICE IS THE LATEST CLOSE, stated rather than left to be
   * inferred from `price_asof`.
   *
   * A consumer cannot tell a healthy one-day-old close from a pipeline that
   * stopped updating four sessions ago by looking at a date alone, and it
   * cannot tell either from the VALUE: a 2026-08-14 close read 10.6% from
   * the live price one morning and 3.6% from it that same afternoon, having
   * become no more current in between. `price_stale` is a claim about
   * provenance only — nothing here inspects the number.
   */
  price_stale: boolean;
  /** Completed sessions between `price_asof` and the latest close. 0 = current. */
  price_age_sessions: number;
  /** What is wrong and what not to do with it. Null when current. */
  price_stale_reason: string | null;
  /** The session this price SHOULD have been, so the arithmetic is checkable. */
  latest_completed_session: string;

  /** Current 20-session return, percent. Null until the panel holds 21 sessions. */
  ret_20d_pct: number | null;
  /**
   * Empirical percentiles of this name's own 20-session returns over the
   * panel window — the distribution position sizing is computed from. The
   * windows OVERLAP, so `independent_n` is the honest sample size; these are
   * descriptive quantiles, not a significance claim.
   */
  ret_pctile_20d: {
    p05: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p95: number | null;
    n: number;
    independent_n: number;
  };

  /** Wilder ATR(14), same formula as the dossier. */
  atr_usd: number | null;
  atr_pct: number | null;

  /** The mechanical exit: trailing high of closes less 1.5 ATR, in dollars. */
  trail_stop_usd: number | null;
  trailing_high_usd: number | null;
  trend_intact: boolean | null;
  room_atr: number | null;

  /**
   * The stop question with its reason attached, per horizon. `width_pct`
   * null used to collapse "no width survives" and "too little history" into
   * one token; the verdict now discriminates them, and on a refusal the
   * widest tested width and its survival say how close the name came.
   * (Replaces the flat `narrowest_viable_stop_pct_5d/21d` numbers.)
   */
  narrowest_viable_stop_5d: StopWidthVerdict;
  narrowest_viable_stop_21d: StopWidthVerdict;

  /** Positioning, passed through from the daily recording with each group's own instant. */
  positioning_session: string | null;
  short_ratio_pct: number | null;
  short_volume_asof: string | null;
  net_gex_usd_per_1pct: number | null;
  gamma_sign: "positive" | "negative" | null;
  put_call_oi_ratio: number | null;
  put_call_volume_ratio: number | null;
  chain_oi: number | null;
  atm_iv_pct: number | null;
  atm_iv_days_to_expiry: number | null;
  options_asof: string | null;

  /**
   * IMPLIED VOL YOU CAN RANK, and the rank itself.
   *
   * `atm_iv_pct` above is whatever expiry sat nearest the money — 1 day on
   * every row recorded so far — which is dominated by pin risk and useless
   * as a baseline. This is the same curve read at a FIXED tenor every
   * session, so today's number and last month's describe the same point.
   *
   * `iv_percentile` is null with a reason until the series is deep enough;
   * `iv_percentile_reason` says which. A rank over a handful of sessions is
   * arithmetic wearing the costume of evidence.
   */
  iv_constant_maturity_pct: number | null;
  iv_constant_maturity_days: number;
  iv_percentile: number | null;
  iv_percentile_n: number;
  iv_percentile_reason: string | null;
  /** One sentence naming which side of the trade the reading argues for. */
  iv_sentence: string | null;

  earnings_status: "confirmed" | "none" | "lookup_failed";
  earnings_date: string | null;
  earnings_source: "committed-calendar" | null;
}

export interface AssetFactsInputs {
  symbol: string;
  /** The panel calendar and this symbol's matched rows. */
  sessions: readonly string[];
  panel: SymbolPanel;
  positioning: PositioningPoint | null;
  /**
   * The committed calendar, sweep block included. NOT a live provider call:
   * Nasdaq rejects datacenter IPs, so a request-time probe fails every time
   * in production while costing its full timeout — measured at 1.2s of a
   * 1.7s response, and it made the same symbol answer differently on a
   * laptop than on the server.
   */
  calendar: EarningsCalendar;
  /**
   * This symbol's past constant-maturity vols, oldest first. Must all be at
   * CONSTANT_MATURITY_DAYS — a precondition the caller owns, because an array
   * of numbers cannot carry its own tenor.
   */
  ivHistory?: readonly number[];
  now: number;
}

export const RET_WINDOW_SESSIONS = 20;

/**
 * Type-7 linear-interpolation quantile (R's and NumPy's default), on a copy.
 * Chosen for being the convention a reader will reproduce first when they
 * check these numbers by hand.
 */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Panel rows → Bars. Interpolated fills are EXCLUDED — see each use site. */
function realBars(sessions: readonly string[], panel: SymbolPanel): Bar[] {
  const filled = new Set(panel.interpolated);
  const bars: Bar[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const row = panel.bars[i];
    if (!row || filled.has(i)) continue;
    bars.push({
      t: Date.parse(sessions[i]),
      open: row[0],
      high: row[1],
      low: row[2],
      close: row[3],
      volume: row[4],
    });
  }
  return bars;
}

/**
 * Closes on the FULL calendar, fills included. Returns are measured across
 * sessions whether or not the name traded, so a carried close is the honest
 * value here — unlike range-based measures (ATR, stop survival), where a
 * filled bar's zero range would understate volatility, which is why those
 * use realBars above.
 */
function closesWithFills(panel: SymbolPanel): number[] {
  return panel.bars.filter((r): r is PanelRow => r !== null).map((r) => r[3]);
}

/**
 * THE THREE STATES, from a swept calendar rather than a live probe.
 *
 * A confirmed date needs only an entry. The hard state is `none`, and it is
 * earned by three conditions together: the sweep completed, it still covers
 * today, and this symbol was in its scope. Then — and only then — does the
 * absence of an entry mean "no earnings before throughDate" rather than
 * "nobody looked". Any condition missing degrades to `lookup_failed`, which
 * does NOT clear an event veto.
 */
function resolveEarnings(
  symbol: string,
  calendar: EarningsCalendar,
  today: string
): Pick<AssetFacts, "earnings_status" | "earnings_date" | "earnings_source"> {
  const entry = calendar.entries.find((e) => e.symbol === symbol && e.date >= today);
  if (entry) {
    return { earnings_status: "confirmed", earnings_date: entry.date, earnings_source: "committed-calendar" };
  }

  const sweep = calendar.sweep;
  const swept =
    sweep !== undefined &&
    // A window that ended before today proves nothing about what is ahead.
    sweep.throughDate >= today &&
    sweep.universe.includes(symbol);

  return swept
    ? { earnings_status: "none", earnings_date: null, earnings_source: "committed-calendar" }
    : { earnings_status: "lookup_failed", earnings_date: null, earnings_source: null };
}

export function buildAssetFacts(inputs: AssetFactsInputs): AssetFacts {
  const { symbol, sessions, panel, positioning: pos, now } = inputs;

  // Last REAL close: an interpolated fill is a session the name did not
  // trade, and quoting it as "price" would stamp a fabricated observation
  // with a date. Walk back to the last bar somebody actually printed.
  let price: number | null = null;
  let priceAsof: string | null = null;
  const filled = new Set(panel.interpolated);
  for (let i = sessions.length - 1; i >= 0; i--) {
    const row = panel.bars[i];
    if (row && !filled.has(i)) {
      price = row[3];
      priceAsof = sessions[i];
      break;
    }
  }

  const staleness = assessPriceStaleness(priceAsof, new Date(now));

  /*
   * Ranked ONLY against readings at the same constant maturity. Mixing tenors
   * would make the percentile a measure of days-to-expiry rather than of
   * volatility, which is the defect the constant-maturity series exists to
   * remove — so a missing field is skipped rather than substituted.
   */
  const ivHistory = inputs.ivHistory ?? [];
  const richness =
    pos?.ivConstantMaturityPct != null
      ? ivRichness(pos.ivConstantMaturityPct, ivHistory)
      : ({ ok: false, reason: "no constant-maturity implied vol recorded for this session" } as const);

  const closes = closesWithFills(panel);
  const rets: number[] = [];
  for (let i = RET_WINDOW_SESSIONS; i < closes.length; i++) {
    if (closes[i - RET_WINDOW_SESSIONS] > 0) {
      rets.push((closes[i] / closes[i - RET_WINDOW_SESSIONS] - 1) * 100);
    }
  }
  const sorted = [...rets].sort((a, b) => a - b);
  const q = (p: number) => {
    const v = quantile(sorted, p);
    return v === null ? null : r2(v);
  };
  const retNow = rets.length > 0 ? r2(rets[rets.length - 1]) : null;

  const bars = realBars(sessions, panel);
  const trend = trendState(symbol, bars);
  const grid = stopGrid(symbol, bars);

  return {
    symbol,
    asof: new Date(now).toISOString(),

    price,
    price_asof: priceAsof,
    price_source: "daily-close",
    price_stale: staleness.stale,
    price_age_sessions: staleness.ageSessions,
    price_stale_reason: staleness.reason,
    latest_completed_session: staleness.latestCompletedSession,

    ret_20d_pct: retNow,
    ret_pctile_20d: {
      p05: q(0.05),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p95: q(0.95),
      n: rets.length,
      independent_n: Math.floor(rets.length / RET_WINDOW_SESSIONS),
    },

    atr_usd: trend ? r2(trend.atr) : null,
    atr_pct: trend ? r2(trend.atrPct) : null,
    trail_stop_usd: trend ? r2(trend.trailStop) : null,
    trailing_high_usd: trend ? r2(trend.trailingHigh) : null,
    trend_intact: trend ? trend.intact : null,
    room_atr: trend ? r2(trend.roomAtr) : null,

    narrowest_viable_stop_5d: stopVerdictAt(grid, 5),
    narrowest_viable_stop_21d: stopVerdictAt(grid, 21),

    positioning_session: pos?.date ?? null,
    short_ratio_pct: pos?.shortRatioPct ?? null,
    short_volume_asof: pos?.sourceAsOf?.shortVolume ?? null,
    net_gex_usd_per_1pct: pos?.netGexUsdPer1Pct ?? null,
    gamma_sign: pos?.gammaSign ?? null,
    put_call_oi_ratio: pos?.putCallOiRatio ?? null,
    put_call_volume_ratio: pos?.putCallVolumeRatio ?? null,
    chain_oi: pos?.chainOi ?? null,
    atm_iv_pct: pos?.atmIvPct ?? null,
    atm_iv_days_to_expiry: pos?.atmIvDaysToExpiry ?? null,
    options_asof: pos?.sourceAsOf?.options ?? null,

    iv_constant_maturity_pct: pos?.ivConstantMaturityPct ?? null,
    iv_constant_maturity_days: CONSTANT_MATURITY_DAYS,
    iv_percentile: richness.ok ? richness.percentile : null,
    iv_percentile_n: ivHistory.length,
    iv_percentile_reason: richness.ok ? null : richness.reason,
    iv_sentence: richness.ok ? richness.sentence : null,

    ...resolveEarnings(symbol, inputs.calendar, new Date(now).toISOString().slice(0, 10)),
  };
}
