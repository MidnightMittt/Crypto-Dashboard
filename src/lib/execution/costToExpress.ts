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
 * ── The cost that dominates, and nearly went unpriced ────────────────
 *
 * Execution is what you pay to GET IN. For a dated instrument it is not the
 * cost that decides the trade. Measured on the real decision:
 *
 *   MARA equity              execution 27.83 bp   carry  none
 *   MARA 2026-09-18 12C      execution 355 bp     carry  0.0207/day x 26d
 *
 * That carry is 0.54 of a 0.845 premium — 64% — against an execution cost
 * of 3% of premium. Decay is roughly TWENTY TIMES execution, and a page
 * that printed the 3% beside a silent 64% invited the reader to conclude
 * the option was cheap to hold, which is the reverse of true.
 *
 * Carry converts onto the same axis through the same denominator:
 *
 *   execution move = (ask − bid)      / (delta × underlying)   0.58%
 *   carry move     = (theta × days)   / (delta × underlying)  10.48%
 *
 * ── Why these ARE summed, against the obvious objection ──────────────
 *
 * One is paid on entry and one is paid for holding, so a single figure
 * hides which — and that is an argument about DISPLAY, which is answered
 * by printing all three lines, not by refusing the total. On this axis they
 * are additive: a buyer who holds to expiry and exits pays both. The total
 * is also the only one of the three that changes the decision. Ranked on
 * execution alone the call is 2.1x dearer than the shares; ranked all-in it
 * is 40x dearer. The reader carries away the headline number, so the
 * headline number has to be the one that is load-bearing.
 *
 * ── What the carry figure is NOT ─────────────────────────────────────
 *
 * It is not a loss. Theta is the PRICE OF THE CONVEXITY — the Black-Scholes
 * relation θ + ½σ²S²Γ ≈ rV says the decay is what buys the gamma. Reported
 * as "you lose 64% of premium" it would be false unless the underlying sits
 * still. Reported on the move axis it says the true thing: the underlying
 * must travel ~11% in 26 days for the call to beat flat, and that is what
 * the premium purchased. The endpoint prints the move, never the loss.
 *
 * Three approximations, all of which are stated on the response:
 *
 *   instantaneous theta, extrapolated linearly. Real decay ACCELERATES into
 *     expiry, so held near the end this figure understates. It is capped at
 *     the premium, because value cannot decay below zero.
 *   delta held constant. Over a move as large as 10% delta will not be, and
 *     for a long call it RISES with the underlying — so the true required
 *     move is smaller than the linear one. The figure is an upper bound.
 *   long positions only, consistent with the rest of this endpoint and with
 *     an account that cannot short.
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
      /**
       * The RECORDED shape of this book, preferred over `quote` whenever it
       * exists. A single snapshot is one draw: STX/USD printed 9.1bp and
       * 22.7bp twenty seconds apart, which moved this endpoint's headline
       * ratio from 54x to 18x on nothing but timing.
       */
      distribution: { medianBp: number; p90Bp: number; n: number; medianEffectiveBp: number | null } | null;
    }
  | {
      kind: "option";
      label: string;
      quote: Quote | null;
      /** Signed per convention. Calls (0,1], puts [-1,0). */
      delta: number;
      multiplier: number;
      underlyingPrice: number;
      /**
       * Premium lost per CALENDAR day, as the chain quotes it. Sign is
       * ignored — a long option decays whichever way the vendor signs it.
       * Null means the caller did not supply one, and carry is then refused
       * by name rather than assumed to be zero.
       */
      thetaPerDay: number | null;
      /**
       * Calendar days the carry figure covers — days to expiry unless the
       * caller declared a shorter hold. Null when neither was supplied.
       */
      carryDays: number | null;
    };

/**
 * Decay for a dated instrument, on the SAME axis as execution.
 *
 * Reported as a move, never as a loss: theta is what buys the gamma, and a
 * percentage-of-premium figure reads as a loss the holder has already taken
 * when it is really the hurdle the underlying has to clear.
 */
export interface CarryLine {
  /** Calendar days covered. Theta is quoted per calendar day, not per session. */
  days: number;
  /** Premium lost per day, sign-normalised to a cost. */
  per_day_premium: number;
  /** Premium lost over `days`, capped at the premium — value cannot decay past zero. */
  total_premium: number;
  /** Share of the premium that decay accounts for over the period. */
  pct_of_premium: number;
  /** THE COMMON AXIS: percent the underlying must move to offset that decay. */
  move_pct: number;
  basis: string;
}

export interface PricedCandidate {
  label: string;
  kind: "equity" | "spot" | "option";
  /** Spread as bp of the instrument's OWN mid. Honest, but not comparable across kinds. */
  spread_bp_of_own_price: number | null;
  /**
   * EXECUTION ONLY: percent the UNDERLYING must move to cover a round trip.
   * Paid once, on entry. This field's meaning has never changed and does not
   * change now — carry is reported beside it, not folded into it.
   */
  breakeven_underlying_move_pct: number | null;
  /** Decay over the holding period. Null for undated instruments and when refused. */
  carry: CarryLine | null;
  /**
   * A STATED exclusion, present only when the instrument HAS carry that could
   * not be priced. A silent omission is worth less than a named one, and this
   * is the difference between "no decay" and "decay not measured".
   */
  carry_excluded: string | null;
  /**
   * Execution + carry — the move that actually has to happen for the trade to
   * beat flat, and the axis the comparison ranks on. Equal to the execution
   * figure for undated instruments. Null when carry exists and was refused,
   * which is what keeps an unpriced option out of the ranking instead of
   * letting it in at a flattering execution-only number.
   */
  breakeven_move_pct_all_in: number | null;
  /** Dollars of underlying exposure obtained per dollar committed. 1.0 for unlevered. */
  exposure_per_dollar: number | null;
  /** True when the most that can be lost is the amount committed. */
  downside_capped: boolean;
  /** Where the cost figure came from — measured history, a live book, or a caller quote. */
  source: string;
  /**
   * The same axis at the DISTRIBUTION'S TAIL (p90), when one was recorded.
   * The median is what a typical fill costs; this is what a bad one does,
   * and an edge that does not clear it does not clear.
   */
  tail_breakeven_underlying_move_pct: number | null;
  /** Samples behind the figures, when they come from a recorded distribution. */
  samples: number | null;
  /** Present instead of numbers when the candidate cannot be priced. */
  refused: string | null;
}

export interface CostComparison {
  candidates: PricedCandidate[];
  /** Cheapest candidate by ALL-IN breakeven move, or null when none could be priced. */
  cheapest: string | null;
  /** Ratio of dearest to cheapest on the ALL-IN axis. Null unless two were priced. */
  spread_of_spreads: number | null;
  interpretation: string;
}

const r = (v: number, dp = 4) => Number(v.toFixed(dp));

/** Everything except carry, which is layered on afterwards so one rule covers every kind. */
type CoreCandidate = Omit<
  PricedCandidate,
  "carry" | "carry_excluded" | "breakeven_move_pct_all_in"
>;

function priceCore(c: CandidateInput): CoreCandidate {
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
        tail_breakeven_underlying_move_pct: null,
        samples: null,
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
        tail_breakeven_underlying_move_pct: null,
        samples: null,
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
      tail_breakeven_underlying_move_pct: null,
      samples: null,
      source: "none",
      refused:
        "No measured spread history for this symbol and no usable quote supplied. A modelled cost is not a substitute — Corwin-Schultz returned 114-177bp on these names where the observed book was one tick.",
    };
  }

  if (c.kind === "spot") {
    /*
     * A recorded distribution beats a live book for the same reason
     * measured equity history beats a snapshot: one draw is not a
     * distribution, and here the draws differ by 2.5x within a minute.
     */
    if (c.distribution && c.distribution.n > 0) {
      const d = c.distribution;
      return {
        ...base,
        spread_bp_of_own_price: r(d.medianBp, 2),
        breakeven_underlying_move_pct: r(d.medianBp / 100, 4),
        tail_breakeven_underlying_move_pct: r(d.p90Bp / 100, 4),
        samples: d.n,
        exposure_per_dollar: 1,
        downside_capped: false,
        source: `${c.venue} recorded book, ${d.n} samples — median with p90 tail, never a mean`,
        refused: null,
      };
    }
    if (!c.quote || !(c.quote.ask > c.quote.bid) || !(c.quote.bid > 0)) {
      return {
        ...base,
        spread_bp_of_own_price: null,
        breakeven_underlying_move_pct: null,
        exposure_per_dollar: null,
        downside_capped: false,
        tail_breakeven_underlying_move_pct: null,
        samples: null,
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
      tail_breakeven_underlying_move_pct: null,
    samples: null,
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
      tail_breakeven_underlying_move_pct: null,
    samples: null,
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
      tail_breakeven_underlying_move_pct: null,
    samples: null,
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
    tail_breakeven_underlying_move_pct: null,
    samples: null,
    source: "caller-supplied chain quote; delta is the caller's claim and is not verifiable here",
    refused: null,
  };
}

/**
 * Layer carry onto a priced candidate.
 *
 * Undated instruments get carry `null` with NO exclusion note — they have no
 * decay, and saying "not priced" about a cost that does not exist would be
 * the same false alarm in the other direction. Only an instrument that has
 * carry and could not have it measured gets a stated exclusion.
 *
 * Margin interest is not priced for equity or spot. That is a real carry for
 * a levered cash position, and it is out of scope on an account trading cash
 * with $137 of buying power; if this ever prices a margined hold, this is the
 * comment that has to change.
 */
function priceOne(c: CandidateInput): PricedCandidate {
  const core = priceCore(c);

  if (c.kind !== "option") {
    return {
      ...core,
      carry: null,
      carry_excluded: null,
      breakeven_move_pct_all_in: core.breakeven_underlying_move_pct,
    };
  }

  // A refused option is already unpriceable; carry adds nothing to say.
  const exec = core.breakeven_underlying_move_pct;
  if (core.refused !== null || exec === null || !c.quote) {
    return { ...core, carry: null, carry_excluded: null, breakeven_move_pct_all_in: null };
  }

  const days = c.carryDays;
  const theta = c.thetaPerDay === null ? null : Math.abs(c.thetaPerDay);
  const exclude = (reason: string): PricedCandidate => ({
    ...core,
    carry: null,
    carry_excluded: reason,
    breakeven_move_pct_all_in: null,
  });

  if (days === null && theta === null) {
    return exclude(
      "Execution cost only. This instrument is dated and therefore also carries decay, which is not priced here because neither an expiry nor a theta was supplied. Send `expiry` and `theta` from the chain to price it."
    );
  }
  if (theta === null) {
    return exclude(
      `Execution cost only. This contract carries ${days} days of decay, not priced here — no theta was supplied. On a comparable contract that decay ran roughly twenty times the execution cost, so the figure above is not the cost that decides the trade.`
    );
  }
  if (days === null) {
    return exclude(
      "Execution cost only. A theta was supplied but no expiry or `hold_days`, and decay without a horizon is not a quantity. Send either."
    );
  }
  if (!(days > 0)) {
    return exclude(
      `Execution cost only. The expiry supplied resolves to ${days} days, which is not in the future; decay over a non-positive horizon is not priced.`
    );
  }

  const mid = (c.quote.ask + c.quote.bid) / 2;
  /*
   * Capped at the premium because value cannot decay below zero. The cap
   * binds exactly when linear theta over-extrapolates a near-expiry
   * contract, and the basis string says so rather than letting a silently
   * clipped number look like a measurement.
   */
  const uncapped = theta * days;
  const capped = Math.min(uncapped, mid);
  const carryMovePct = (capped / (Math.abs(c.delta) * c.underlyingPrice)) * 100;

  return {
    ...core,
    carry: {
      days,
      per_day_premium: r(theta, 4),
      total_premium: r(capped, 4),
      pct_of_premium: r((capped / mid) * 100, 1),
      move_pct: r(carryMovePct, 4),
      basis:
        `Instantaneous theta held constant over ${days} calendar days` +
        (capped < uncapped
          ? `, capped at the ${r(mid, 2)} premium — linear decay would have exceeded the contract's whole value, which is the signature of extrapolating theta into expiry.`
          : `. Real decay ACCELERATES into expiry, so a contract held to the end loses more than this. Not a loss figure: theta is the price of the convexity, and this is the move that offsets it.`),
    },
    carry_excluded: null,
    breakeven_move_pct_all_in: r(exec + carryMovePct, 4),
  };
}

export function compareCostToExpress(candidates: readonly CandidateInput[]): CostComparison {
  const priced = candidates.map(priceOne);
  /*
   * The comparison ranks ALL-IN, not on execution. An option priced on
   * execution alone reads 2.1x dearer than the shares where all-in it is
   * 40x, and the headline number is the one the reader carries away.
   * A candidate whose carry was refused is deliberately NOT ranked — letting
   * it in at its execution-only figure is precisely how the flattering
   * number would get published.
   */
  const usable = priced.filter(
    (p): p is PricedCandidate & { breakeven_move_pct_all_in: number } =>
      p.breakeven_move_pct_all_in !== null
  );
  const unranked = priced.filter((p) => p.carry_excluded !== null);

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
    (a, b) => a.breakeven_move_pct_all_in - b.breakeven_move_pct_all_in
  );
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  /** "0.58% execution + 10.48% decay over 26 days" — the split, kept visible beside the total. */
  const split = (p: PricedCandidate): string =>
    p.carry
      ? ` (${p.breakeven_underlying_move_pct}% execution paid once, plus ${p.carry.move_pct}% of decay over ${p.carry.days} days of holding)`
      : "";
  /*
   * A ratio against a near-free book is arithmetically true and unreadable:
   * XBT/USD's median spread is under a basis point, which turns a genuine
   * comparison into "48,592x". Below the floor the ratio is refused and the
   * interpretation says the cheapest leg is effectively costless instead —
   * the fact a reader actually needs, without a number they cannot trust.
   */
  const RATIO_FLOOR_PCT = 0.01;
  const cheapestIsFree = lo.breakeven_move_pct_all_in < RATIO_FLOOR_PCT;
  const ratio =
    sorted.length > 1 && !cheapestIsFree && lo.breakeven_move_pct_all_in > 0
      ? r(hi.breakeven_move_pct_all_in / lo.breakeven_move_pct_all_in, 1)
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

  /*
   * A candidate held out of the ranking has to say so IN the interpretation.
   * Listing it only in the candidate array would leave the headline sentence
   * describing a comparison the reader thinks was complete.
   */
  const excludedNote = unranked.length
    ? ` NOT RANKED: ${unranked
        .map((p) => p.label)
        .join(", ")} — carry could not be priced, and ranking on execution alone would flatter a dated instrument by exactly the cost that decides it.`
    : "";

  const decayNote = usable.some((p) => p.carry)
    ? ` Decay is NOT a loss already taken: theta is the price of the convexity, so the carry figure is the distance the underlying must travel to offset it, not money gone.`
    : "";

  return {
    candidates: priced,
    cheapest: lo.label,
    spread_of_spreads: ratio,
    interpretation:
      `Priced on one axis — the move the UNDERLYING must make for the trade to beat flat, ` +
      `entry cost and holding cost together — ` +
      `${lo.label} is cheapest at ${lo.breakeven_move_pct_all_in}%${split(lo)}` +
      (ratio !== null
        ? `, and ${hi.label} is ${ratio}x dearer at ${hi.breakeven_move_pct_all_in}%${split(hi)}`
        : cheapestIsFree && sorted.length > 1
          ? ` — under a basis point, effectively costless, so no ratio against it would be readable; ${hi.label} is the dearest at ${hi.breakeven_move_pct_all_in}%${split(hi)}`
          : "") +
      `. CHEAPEST IS NOT BEST: this ranks cost alone, and cost is only half the trade.${leverNote}${decayNote}${excludedNote} ` +
      `Rule 63 applies per candidate: an edge smaller than the figure beside it is not an edge in that instrument.`,
  };
}
