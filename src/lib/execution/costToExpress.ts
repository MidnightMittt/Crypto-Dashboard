/**
 * WHICH INSTRUMENT SHOULD THIS VIEW BE EXPRESSED IN?
 *
 * The platform could already say what to trade. It could not say what to
 * trade it WITH — equity, option, or spot — priced on one axis. That gap
 * mattered more than it looked, because Rule 63 ("an edge smaller than the
 * spread is not an edge") has been the binding constraint on this book, and
 * it was only ever enforceable within one asset class at a time.
 *
 * ── The common axis, and why the obvious one is wrong ─────────────────
 *
 * Comparing raw spreads is the obvious move and it overstates the gap by
 * an order of magnitude. Measured on the real book:
 *
 *   BTDR 2026-08-28 10.50C   1.05 / 1.45   3,200 bp of mid
 *   STX/USD spot                            9 bp of mid
 *   ratio on spread                         354x
 *
 * But the option's spread is charged on the PREMIUM, and that premium
 * controls 6.6x its own value in delta-equivalent exposure. Charging a
 * levered instrument's cost against its unlevered notional is the same
 * category error as reading `value_usd` on an option leg — the one that
 * understated this book's exposure 140x.
 *
 * The axis that survives the comparison is: HOW FAR MUST THE UNDERLYING
 * MOVE TO PAY FOR THE TRADE?
 *
 *   spot / equity   move = (ask − bid) / mid
 *   option          move = (ask − bid) / (delta × underlying)
 *
 *   BTDR call       4.86%
 *   STX spot        0.09%
 *   ratio            54x
 *
 * Fifty-four times, not three hundred. Both figures are true; only this one
 * is denominated in the same unit as an edge, which is what makes it the
 * one a decision can be made on.
 *
 * ── What this deliberately does NOT do ───────────────────────────────
 *
 * It does not say which instrument is BETTER. Cheaper is not better: the
 * option costs 54x more to enter and buys 6.6x the exposure per dollar with
 * a downside that cannot exceed the premium, and no scalar ranking captures
 * that trade. Every candidate is priced; the choice stays with the reader.
 *
 * It also carries NO reach or hit-rate statistics for crypto. Those are
 * drift-contaminated on a sample that fell 84.5% — down-touch would read as
 * a property of the asset when it is a property of the period — and the
 * symmetric/antisymmetric decomposition that made the equity version
 * honest has not been run on crypto. A crypto leaderboard will not enter
 * through the door the equity one was refused at.
 */

/** A quoted two-sided market. Both sides required; a one-sided book is not a spread. */
export interface Quote {
  bid: number;
  ask: number;
}

export type CandidateInput =
  | {
      kind: "equity";
      label: string;
      /** Measured round-trip cost in bp from the spread history, when the symbol has one. */
      measuredRoundTripBp: number | null;
      /** Live quote, used only when no measured history exists. */
      quote: Quote | null;
    }
  | {
      kind: "spot";
      label: string;
      quote: Quote | null;
      venue: string;
    }
  | {
      kind: "option";
      label: string;
      quote: Quote | null;
      /** Signed per convention. Calls (0,1], puts [-1,0). */
      delta: number;
      multiplier: number;
      underlyingPrice: number;
    };

export interface PricedCandidate {
  label: string;
  kind: "equity" | "spot" | "option";
  /** Spread as bp of the instrument's OWN mid. Honest, but not comparable across kinds. */
  spread_bp_of_own_price: number | null;
  /** THE COMMON AXIS: percent the UNDERLYING must move to cover a round trip. */
  breakeven_underlying_move_pct: number | null;
  /** Dollars of underlying exposure obtained per dollar committed. 1.0 for unlevered. */
  exposure_per_dollar: number | null;
  /** True when the most that can be lost is the amount committed. */
  downside_capped: boolean;
  /** Where the cost figure came from — measured history, a live book, or a caller quote. */
  source: string;
  /** Present instead of numbers when the candidate cannot be priced. */
  refused: string | null;
}

export interface CostComparison {
  candidates: PricedCandidate[];
  /** Cheapest priced candidate by breakeven move, or null when none could be priced. */
  cheapest: string | null;
  /** Ratio of dearest to cheapest on the common axis. Null unless two were priced. */
  spread_of_spreads: number | null;
  interpretation: string;
}

const r = (v: number, dp = 4) => Number(v.toFixed(dp));

function priceOne(c: CandidateInput): PricedCandidate {
  const base = { label: c.label, kind: c.kind } as const;

  if (c.kind === "equity") {
    /*
     * MEASURED HISTORY BEATS A LIVE QUOTE and is preferred whenever it
     * exists — a single snapshot of the book is one draw from a
     * distribution, and this book's own history is why: modelled costs
     * came back 1.9-12.8x wrong against observed ones. The round-trip bp
     * already covers both legs, so it converts straight to a move.
     */
    if (c.measuredRoundTripBp !== null && c.measuredRoundTripBp > 0) {
      return {
        ...base,
        spread_bp_of_own_price: r(c.measuredRoundTripBp, 2),
        breakeven_underlying_move_pct: r(c.measuredRoundTripBp / 100, 4),
        exposure_per_dollar: 1,
        downside_capped: false,
        source: "measured spread history, entry and exit windows",
        refused: null,
      };
    }
    if (c.quote && c.quote.ask > c.quote.bid && c.quote.bid > 0) {
      const mid = (c.quote.ask + c.quote.bid) / 2;
      const movePct = ((c.quote.ask - c.quote.bid) / mid) * 100;
      return {
        ...base,
        spread_bp_of_own_price: r(movePct * 100, 2),
        breakeven_underlying_move_pct: r(movePct, 4),
        exposure_per_dollar: 1,
        downside_capped: false,
        source: "caller-supplied quote — one snapshot, not a measured distribution",
        refused: null,
      };
    }
    return {
      ...base,
      spread_bp_of_own_price: null,
      breakeven_underlying_move_pct: null,
      exposure_per_dollar: null,
      downside_capped: false,
      source: "none",
      refused:
        "No measured spread history for this symbol and no usable quote supplied. A modelled cost is not a substitute — Corwin-Schultz returned 114-177bp on these names where the observed book was one tick.",
    };
  }

  if (c.kind === "spot") {
    if (!c.quote || !(c.quote.ask > c.quote.bid) || !(c.quote.bid > 0)) {
      return {
        ...base,
        spread_bp_of_own_price: null,
        breakeven_underlying_move_pct: null,
        exposure_per_dollar: null,
        downside_capped: false,
        source: c.venue,
        refused: `No two-sided book returned from ${c.venue}. A one-sided quote is not a spread.`,
      };
    }
    const mid = (c.quote.ask + c.quote.bid) / 2;
    const movePct = ((c.quote.ask - c.quote.bid) / mid) * 100;
    return {
      ...base,
      spread_bp_of_own_price: r(movePct * 100, 2),
      breakeven_underlying_move_pct: r(movePct, 4),
      exposure_per_dollar: 1,
      downside_capped: false,
      source: `${c.venue} order book, live`,
      refused: null,
    };
  }

  // ── Option ──
  if (!c.quote || !(c.quote.ask > c.quote.bid) || !(c.quote.bid > 0)) {
    return {
      ...base,
      spread_bp_of_own_price: null,
      breakeven_underlying_move_pct: null,
      exposure_per_dollar: null,
      downside_capped: true,
      source: "none",
      refused: "No two-sided option quote supplied; a mid without a spread cannot price execution.",
    };
  }
  if (!(Math.abs(c.delta) > 0) || !(c.underlyingPrice > 0) || !(c.multiplier > 0)) {
    return {
      ...base,
      spread_bp_of_own_price: null,
      breakeven_underlying_move_pct: null,
      exposure_per_dollar: null,
      downside_capped: true,
      source: "none",
      refused:
        "An option needs delta, multiplier and an underlying price to convert its premium spread into an underlying move. Without them the cost is not comparable to anything.",
    };
  }

  const mid = (c.quote.ask + c.quote.bid) / 2;
  const spreadPremium = c.quote.ask - c.quote.bid;
  /*
   * The conversion that makes the comparison possible. A dollar of premium
   * spread is recovered by delta dollars of underlying move per unit, so
   * the multiplier cancels and the move depends only on delta and spot.
   */
  const movePct = (spreadPremium / (Math.abs(c.delta) * c.underlyingPrice)) * 100;
  const exposure = Math.abs(c.delta) * c.multiplier * c.underlyingPrice;
  return {
    ...base,
    spread_bp_of_own_price: r((spreadPremium / mid) * 10_000, 2),
    breakeven_underlying_move_pct: r(movePct, 4),
    exposure_per_dollar: r(exposure / (mid * c.multiplier), 3),
    downside_capped: true,
    source: "caller-supplied chain quote; delta is the caller's claim and is not verifiable here",
    refused: null,
  };
}

export function compareCostToExpress(candidates: readonly CandidateInput[]): CostComparison {
  const priced = candidates.map(priceOne);
  const usable = priced.filter(
    (p): p is PricedCandidate & { breakeven_underlying_move_pct: number } =>
      p.breakeven_underlying_move_pct !== null
  );

  if (usable.length === 0) {
    return {
      candidates: priced,
      cheapest: null,
      spread_of_spreads: null,
      interpretation:
        "No candidate could be priced, so no comparison is offered. Each refusal above names what was missing.",
    };
  }

  const sorted = [...usable].sort(
    (a, b) => a.breakeven_underlying_move_pct - b.breakeven_underlying_move_pct
  );
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const ratio =
    sorted.length > 1 && lo.breakeven_underlying_move_pct > 0
      ? r(hi.breakeven_underlying_move_pct / lo.breakeven_underlying_move_pct, 1)
      : null;

  const levered = usable.filter((p) => (p.exposure_per_dollar ?? 1) > 1.5);
  const leverNote = levered.length
    ? ` ${levered
        .map(
          (p) =>
            `${p.label} costs more to enter but obtains ${p.exposure_per_dollar}x its own value in exposure, with the most it can lose capped at what is committed`
        )
        .join("; ")}.`
    : "";

  return {
    candidates: priced,
    cheapest: lo.label,
    spread_of_spreads: ratio,
    interpretation:
      `Priced on one axis — the move the UNDERLYING must make to cover a round trip — ` +
      `${lo.label} is cheapest at ${lo.breakeven_underlying_move_pct}%` +
      (ratio !== null ? `, and ${hi.label} is ${ratio}x dearer at ${hi.breakeven_underlying_move_pct}%` : "") +
      `. CHEAPEST IS NOT BEST: this ranks cost alone, and cost is only half the trade.${leverNote} ` +
      `Rule 63 applies per candidate: an edge smaller than the figure beside it is not an edge in that instrument.`,
  };
}
