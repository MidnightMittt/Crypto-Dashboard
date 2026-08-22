import { Field, MarketExposure, unmeasured } from "@/lib/pretrade/buildPretrade";
import { BASKETS, basketsOf } from "@/lib/markets/baskets";

/**
 * PORTFOLIO EXPOSURE — what the book is ACTUALLY long.
 *
 * The agent holds the positions; this analyses them. Nothing here connects to
 * a broker: Robinhood publishes no official API, so an integration could only
 * be an unofficial client, and the agent already knows its own holdings. It
 * posts them and gets analysis back — no credentials, no scraped session.
 *
 * ── Why exposure and not P&L ──────────────────────────────────────────
 *
 * At $100 a night the overnight strategy's expected gain is $0.374 against
 * $2.828 of noise. A prominent P&L number invites abandoning a working
 * strategy after an unlucky fortnight and scaling a broken one after a lucky
 * one, so none is computed here.
 *
 * What IS worth computing is the thing the alpha regression made urgent. Four
 * of these names is not a diversified basket: measured against overnight SPY
 * the cohort runs beta 2.87 to 4.81, so a book of them is roughly a 4x levered
 * index overnight trade with four names' worth of single-name risk stacked on
 * top. `market_equivalent_usd` is that sentence as a number.
 *
 * ── Coverage is the correctness problem ───────────────────────────────
 *
 * A weighted beta computed over the positions we happen to have betas for is
 * not the portfolio's beta. If half the book is uncovered, the number
 * understates the exposure by roughly half, and it understates it SILENTLY —
 * which is exactly the class of defect this codebase keeps finding. So there
 * are two separate coverage figures, both always reported, and the weighted
 * beta refuses outright below a declared floor.
 */

/** One holding, as the agent knows it. */
export interface PositionInput {
  symbol: string;
  /** Signed. Negative is short, and a short genuinely offsets market beta. */
  quantity: number;
  /**
   * The agent's own mark. Optional for equity: falls back to our last close,
   * and the provenance says which was used, because a stale close and a live
   * mark are different claims about what the position is worth.
   *
   * For an option leg this is the PER-CONTRACT premium (1.25, not 125) and
   * there is no fallback — our stored close is the stock's price, not the
   * contract's, and substituting one for the other is a category error.
   */
  price?: number;

  /*
   * ── Option legs ───────────────────────────────────────────────────────
   *
   * Supplying ANY of the fields below declares the position an option leg.
   * A leg that declares itself an option but cannot be fully modelled is
   * REJECTED by name, never valued as an equity. The alternative was
   * measured in production: a 1-lot call valued at $5.88 of market
   * equivalent against ~$823 of real delta exposure — 140x understated,
   * silently, because these fields were accepted and discarded.
   */
  strike?: number;
  /** Contract expiry, YYYY-MM-DD. An expired leg is rejected, not valued. */
  expiry?: string;
  /** "call" or "put" (case-insensitive). */
  right?: string;
  /**
   * The caller's own delta, signed per convention: calls in (0, 1], puts in
   * [-1, 0). We cannot derive it — there is no options-chain feed here — so
   * it is client-supplied with provenance saying exactly that.
   */
  delta?: number;
  /** Contract multiplier. Defaults to 100; the provenance says which. */
  multiplier?: number;
  /**
   * The caller's mark for the UNDERLYING, so delta and spot can come from
   * the same broker snapshot. Optional: falls back to our last close for the
   * symbol, with provenance saying which was used.
   */
  underlying_price?: number;
}

/** The option fields a leg is validated from — the subset parseOptionLeg reads. */
export interface OptionLegFields {
  strike?: number;
  expiry?: string;
  right?: string;
  delta?: number;
  multiplier?: number;
}

/** The accepted option contract, echoed so the caller can verify the leg. */
export interface OptionLegEcho {
  strike: number;
  expiry: string;
  right: "call" | "put";
  multiplier: number;
  multiplier_source: "client_supplied" | "default_us_equity_option_100";
  delta: number;
}

export interface PositionRow {
  symbol: string;
  quantity: number;
  /** What kind of instrument the row values. Never inferred silently. */
  instrument: "equity" | "option";
  price: Field<number>;
  /**
   * quantity x price for equity; quantity x premium x multiplier for an
   * option. Signed, so a short is negative. For an option this is the
   * CAPITAL in the position, not its exposure — exposure is
   * `delta_equivalent_usd`, and the two differ by an order of magnitude.
   */
  value_usd: Field<number>;
  /** Share of GROSS book value, using absolute values. */
  weight_pct: Field<number>;
  /** Beta of the UNDERLYING for an option leg — same lookup, same study. */
  beta: Field<number>;
  /**
   * The index-equivalent notional this holding carries. value x beta for
   * equity; delta_equivalent x beta for an option, because the market moves
   * the underlying and delta transmits that move to the contract.
   */
  market_equivalent_usd: Field<number>;
  /** Declared baskets this name belongs to. Overlapping by design. */
  baskets: string[];
  /** Present only on option legs: the contract as accepted. */
  option?: OptionLegEcho;
  /**
   * Present only on option legs: quantity x delta x multiplier x underlying
   * price — the stock-equivalent dollars the leg actually moves like.
   */
  delta_equivalent_usd?: Field<number>;
  /**
   * Present only on option legs: the most the leg can lose. Premium paid for
   * a long; strike-bounded for a short put; REFUSED for a short call,
   * because an unbounded loss reported as a number would be a lie.
   */
  capped_downside_usd?: Field<number>;
}

export interface PortfolioExposure {
  /** Sum of |value|. The capital actually at risk. */
  gross_value_usd: Field<number>;
  /** Sum of signed value. Differs from gross whenever anything is short. */
  net_value_usd: Field<number>;
  /**
   * Sum of value x beta, signed. "You believe you hold $10k of miners; you are
   * long $41k of SPY overnight."
   */
  market_equivalent_usd: Field<number>;
  /**
   * market_equivalent / covered gross. Named for what it is: the beta of the
   * part of the book we can measure, not of the whole book. When the book
   * holds options this is effective leverage per dollar of capital at risk —
   * a 1-lot call at $125 of premium moving like $800 of stock reads near
   * 19x here, and that reading is the point, not an artifact.
   */
  weighted_beta_of_covered: Field<number>;
  /** Share of gross value that could be priced at all. */
  price_coverage_pct: Field<number>;
  /**
   * Share of PRICED gross value whose market-equivalent is computable —
   * beta for equity; delta, multiplier and an underlying price besides for
   * an option leg.
   */
  beta_coverage_pct: Field<number>;
}

export interface BasketWeight {
  basket: string;
  weight_pct: number;
  members_held: string[];
  note: string;
}

export interface PortfolioResponse {
  schema_version: string;
  generated_at: string;
  positions: PositionRow[];
  exposure: PortfolioExposure;
  concentration: {
    largest_position_pct: Field<number>;
    /**
     * Weight per declared basket. These OVERLAP — "scanned" contains
     * "miners" — so the shares do not sum to 100 and are not meant to.
     */
    by_basket: BasketWeight[];
  };
  /** Positions that could not be used at all, and why. */
  rejected: { symbol: string; reason: string }[];
}

export const PORTFOLIO_SCHEMA_VERSION = "1.1";

/**
 * Below this share of priced value carrying a measured beta, the weighted beta
 * is not reported at all.
 *
 * Sixty percent is a judgement, and the direction of the error is what
 * decides it: a beta computed over a minority of the book reads LOW, which is
 * the dangerous direction for a leverage number. Better to refuse and say how
 * much was covered than to publish a figure that flatters the exposure.
 */
export const MIN_BETA_COVERAGE_PCT = 60;

const iso = (ms: number): string => new Date(ms).toISOString();

/** US listed-equity option contract multiplier, used when none is supplied. */
const DEFAULT_OPTION_MULTIPLIER = 100;

const EXPIRY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "BTDR 2026-08-28 10.5 call", with "?" where a part was not supplied. */
const legName = (symbol: string, p: OptionLegFields): string =>
  [
    symbol,
    typeof p.expiry === "string" ? p.expiry : "?",
    Number.isFinite(p.strike) ? String(p.strike) : "?",
    typeof p.right === "string" ? p.right.toLowerCase() : "?",
  ].join(" ");

export type LegParse = { ok: true; leg: OptionLegEcho } | { ok: false; reason: string };

/**
 * Validates a declared option leg completely before anything is computed.
 * Every rejection names the leg and the specific defect, because "refused"
 * with no reason is as unarguable as a bare BLOCK — and because the failure
 * this replaces was the opposite: fields accepted, discarded, and the leg
 * confidently valued as 1.25 shares of stock.
 *
 * Exported: the pre-trade auditor validates held option legs with THIS
 * function, so one contract cannot be a valid leg to /api/portfolio and an
 * invalid one to /api/pretrade/check.
 */
export function parseOptionLeg(symbol: string, p: OptionLegFields, nowMs: number): LegParse {
  const name = legName(symbol, p);

  const missing: string[] = [];
  if (!(Number.isFinite(p.strike) && (p.strike as number) > 0)) missing.push("strike");
  if (typeof p.expiry !== "string" || !EXPIRY_RE.test(p.expiry)) missing.push("expiry");
  const right = typeof p.right === "string" ? p.right.toLowerCase() : "";
  if (right !== "call" && right !== "put") missing.push("right");
  if (!Number.isFinite(p.delta)) missing.push("delta");
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `option_leg_missing_or_invalid: ${missing.join(", ")} — ` +
        `refusing to value ${name} rather than misprice it as an equity`,
    };
  }

  const expiryMs = Date.parse(`${p.expiry}T23:59:59Z`);
  if (!Number.isFinite(expiryMs)) {
    return { ok: false, reason: `option_leg_invalid_expiry_date: ${name}` };
  }
  if (expiryMs < nowMs) {
    return {
      ok: false,
      reason: `option_expired: ${name} — an expired contract has no forward exposure to model`,
    };
  }

  const delta = p.delta as number;
  if (right === "call" && !(delta > 0 && delta <= 1)) {
    return {
      ok: false,
      reason: `option_delta_inconsistent_with_right: ${name} — a call's delta lies in (0, 1], got ${delta}`,
    };
  }
  if (right === "put" && !(delta >= -1 && delta < 0)) {
    return {
      ok: false,
      reason: `option_delta_inconsistent_with_right: ${name} — a put's delta lies in [-1, 0), got ${delta}`,
    };
  }

  const suppliedMult = p.multiplier !== undefined && p.multiplier !== null;
  if (suppliedMult && !(Number.isFinite(p.multiplier) && (p.multiplier as number) > 0)) {
    return { ok: false, reason: `option_leg_invalid_multiplier: ${name}` };
  }

  return {
    ok: true,
    leg: {
      strike: p.strike as number,
      expiry: p.expiry as string,
      right: right as "call" | "put",
      multiplier: suppliedMult ? (p.multiplier as number) : DEFAULT_OPTION_MULTIPLIER,
      multiplier_source: suppliedMult ? "client_supplied" : "default_us_equity_option_100",
      delta,
    },
  };
}

export interface PortfolioInputs {
  positions: PositionInput[];
  now: number;
  /** Our last close per symbol, used when the agent supplies no mark. */
  lastClose: Map<string, { price: number; asOf: string }>;
  /** Beta/alpha rows from the overnight study. */
  marketExposure: Map<string, MarketExposure>;
}

export function buildPortfolio(input: PortfolioInputs): PortfolioResponse {
  const { now, lastClose, marketExposure } = input;
  const rejected: { symbol: string; reason: string }[] = [];
  const rows: PositionRow[] = [];

  for (const p of input.positions) {
    const symbol = p.symbol.trim().toUpperCase();
    if (!symbol) {
      rejected.push({ symbol: p.symbol, reason: "empty_symbol" });
      continue;
    }
    /*
     * A zero-quantity holding is not a position. Including it would add a row
     * with no value and drag the position count away from what is held.
     */
    if (!Number.isFinite(p.quantity) || p.quantity === 0) {
      rejected.push({ symbol, reason: "zero_or_invalid_quantity" });
      continue;
    }

    /*
     * ANY option field declares the leg an option. Detection must be this
     * eager: a leg carrying a lone `multiplier: 100` or a discarded `strike`
     * is exactly the input that was previously valued as stock, silently,
     * 140x understated.
     */
    const declaresOption =
      p.strike !== undefined ||
      p.expiry !== undefined ||
      p.right !== undefined ||
      p.delta !== undefined ||
      p.multiplier !== undefined ||
      p.underlying_price !== undefined;

    const supplied = Number.isFinite(p.price) && (p.price as number) > 0 ? (p.price as number) : null;
    const ours = lastClose.get(symbol) ?? null;

    const m = marketExposure.get(symbol) ?? null;
    const beta: Field<number> = m
      ? {
          value: m.beta,
          unit: "beta",
          as_of: iso(now),
          source: "overnight_premium_study",
          /*
           * The proxy's own beta is an identity, not a fit. Labelling it as a
           * regression would be a false claim about how it was obtained.
           */
          method:
            m.derivation === "identity_by_definition"
              ? `beta_of_${m.proxy}_against_itself_is_one_by_definition`
              : `ols_overnight_on_${m.proxy}_${m.window_sessions}_sessions`,
        }
      : unmeasured("not_in_overnight_study");

    if (declaresOption) {
      const parsed = parseOptionLeg(symbol, p, now);
      if (!parsed.ok) {
        rejected.push({ symbol, reason: parsed.reason });
        continue;
      }
      const leg = parsed.leg;

      /*
       * No close-price fallback for the premium: our stored close is the
       * STOCK's price, not the contract's. A missing premium stays missing.
       */
      const price: Field<number> =
        supplied !== null
          ? {
              value: supplied,
              unit: "usd",
              as_of: iso(now),
              source: "client_supplied_mark",
              method: "per_contract_premium_as_posted_by_the_caller",
            }
          : unmeasured("option_premium_not_supplied_and_the_stored_close_prices_the_stock_not_the_contract");

      const value: Field<number> =
        price.value === null
          ? unmeasured("no_premium_available")
          : {
              value: p.quantity * price.value * leg.multiplier,
              unit: "usd",
              as_of: price.as_of,
              source: price.source,
              method: "quantity_x_premium_x_multiplier_signed_short_is_negative",
            };

      const suppliedUnderlying =
        Number.isFinite(p.underlying_price) && (p.underlying_price as number) > 0
          ? (p.underlying_price as number)
          : null;
      const underlying: Field<number> =
        suppliedUnderlying !== null
          ? {
              value: suppliedUnderlying,
              unit: "usd",
              as_of: iso(now),
              source: "client_supplied_mark",
              method: "underlying_price_as_posted_by_the_caller",
            }
          : ours
            ? {
                value: ours.price,
                unit: "usd",
                as_of: ours.asOf,
                source: "yahoo_daily_bars",
                method: "split_and_dividend_adjusted_close_of_the_underlying",
              }
            : unmeasured("no_underlying_price_available");

      const deltaEquivalent: Field<number> =
        underlying.value === null
          ? unmeasured("no_underlying_price_available")
          : {
              value: p.quantity * leg.delta * leg.multiplier * underlying.value,
              unit: "usd",
              as_of: underlying.as_of,
              source: `client_supplied_delta_x_${underlying.source}`,
              method: "quantity_x_delta_x_multiplier_x_underlying_price",
            };

      /*
       * The cap depends on which side of the contract this book is on. A
       * long's loss stops at the premium; a short put's at the strike; a
       * short call's does not stop, and a field that answered anyway would
       * be reporting a bound that does not exist.
       */
      const cappedDownside: Field<number> =
        p.quantity > 0
          ? value.value === null
            ? unmeasured("premium_required_to_state_the_cap")
            : {
                value: Math.abs(value.value),
                unit: "usd",
                as_of: value.as_of,
                source: value.source,
                method: "long_option_maximum_loss_is_the_premium_paid",
              }
          : leg.right === "call"
            ? unmeasured("short_call_downside_is_unbounded")
            : value.value === null
              ? unmeasured("premium_required_to_net_against_the_strike_bound")
              : {
                  value: leg.strike * leg.multiplier * Math.abs(p.quantity) - Math.abs(value.value),
                  unit: "usd",
                  as_of: value.as_of,
                  source: value.source,
                  method: "short_put_maximum_loss_is_strike_x_multiplier_less_premium_received",
                };

      const equivalent: Field<number> =
        deltaEquivalent.value === null || beta.value === null
          ? unmeasured(
              deltaEquivalent.value === null ? "no_underlying_price_available" : "not_in_overnight_study"
            )
          : {
              value: deltaEquivalent.value * beta.value,
              unit: "usd",
              as_of: iso(now),
              source: "overnight_premium_study",
              method: "delta_equivalent_usd_x_beta_on_overnight_market",
            };

      rows.push({
        symbol,
        quantity: p.quantity,
        instrument: "option",
        price,
        value_usd: value,
        weight_pct: unmeasured("pending_gross"),
        beta,
        market_equivalent_usd: equivalent,
        baskets: basketsOf(symbol),
        option: leg,
        delta_equivalent_usd: deltaEquivalent,
        capped_downside_usd: cappedDownside,
      });
      continue;
    }

    const price: Field<number> =
      supplied !== null
        ? {
            value: supplied,
            unit: "usd",
            as_of: iso(now),
            source: "client_supplied_mark",
            method: "as_posted_by_the_caller",
          }
        : ours
          ? {
              value: ours.price,
              unit: "usd",
              as_of: ours.asOf,
              source: "yahoo_daily_bars",
              method: "split_and_dividend_adjusted_close",
            }
          : unmeasured("no_price_available");

    const value: Field<number> =
      price.value === null
        ? unmeasured("no_price_available")
        : {
            value: p.quantity * price.value,
            unit: "usd",
            as_of: price.as_of,
            source: price.source,
            method: "quantity_x_price_signed_short_is_negative",
          };

    const equivalent: Field<number> =
      value.value === null || beta.value === null
        ? unmeasured(value.value === null ? "no_price_available" : "not_in_overnight_study")
        : {
            value: value.value * beta.value,
            unit: "usd",
            as_of: iso(now),
            source: "overnight_premium_study",
            method: "position_value_x_beta_on_overnight_market",
          };

    rows.push({
      symbol,
      quantity: p.quantity,
      instrument: "equity",
      price,
      value_usd: value,
      // Filled once the gross is known — a weight needs a denominator.
      weight_pct: unmeasured("pending_gross"),
      beta,
      market_equivalent_usd: equivalent,
      baskets: basketsOf(symbol),
    });
  }

  const priced = rows.filter((r) => r.value_usd.value !== null);
  const grossPriced = priced.reduce((s, r) => s + Math.abs(r.value_usd.value as number), 0);
  const netPriced = priced.reduce((s, r) => s + (r.value_usd.value as number), 0);

  /*
   * Unpriced positions are counted in the DENOMINATOR of price coverage but
   * cannot contribute to gross, so coverage below 100% means every ratio below
   * describes only part of the book. Reported, never inferred.
   */
  const priceCoveragePct = rows.length > 0 ? (priced.length / rows.length) * 100 : null;

  /*
   * "Covered" means the market-equivalent could actually be computed, not
   * merely that a beta exists. An option leg with a measured underlying beta
   * but no underlying price contributes nothing to the sum, and counting it
   * as covered would understate the exposure silently — the defect class
   * this file exists to refuse.
   */
  const withEquivalent = priced.filter((r) => r.market_equivalent_usd.value !== null);
  const grossWithBeta = withEquivalent.reduce((s, r) => s + Math.abs(r.value_usd.value as number), 0);
  const betaCoveragePct = grossPriced > 0 ? (grossWithBeta / grossPriced) * 100 : null;
  const marketEquivalent = withEquivalent.reduce(
    (s, r) => s + (r.market_equivalent_usd.value as number),
    0
  );

  for (const r of rows) {
    r.weight_pct =
      r.value_usd.value === null || grossPriced <= 0
        ? unmeasured(r.value_usd.value === null ? "no_price_available" : "no_priced_value_in_book")
        : {
            value: (Math.abs(r.value_usd.value) / grossPriced) * 100,
            unit: "pct",
            as_of: iso(now),
            source: "derived",
            method: "abs_position_value_over_gross_priced_value",
          };
  }

  const money = (v: number, method: string): Field<number> => ({
    value: v,
    unit: "usd",
    as_of: iso(now),
    source: "derived",
    method,
  });

  const enoughCoverage = betaCoveragePct !== null && betaCoveragePct >= MIN_BETA_COVERAGE_PCT;

  const exposure: PortfolioExposure = {
    gross_value_usd:
      grossPriced > 0 ? money(grossPriced, "sum_of_absolute_position_values") : unmeasured("no_priced_positions"),
    net_value_usd:
      priced.length > 0 ? money(netPriced, "sum_of_signed_position_values") : unmeasured("no_priced_positions"),
    market_equivalent_usd: enoughCoverage
      ? money(marketEquivalent, "sum_of_position_value_x_beta_signed")
      : unmeasured("beta_coverage_below_floor", {
          beta_coverage_pct: Math.round(betaCoveragePct ?? 0),
          floor_pct: MIN_BETA_COVERAGE_PCT,
        }),
    /*
     * Refused rather than reported when coverage is thin. A leverage figure
     * computed over a minority of the book reads LOW, and understating
     * leverage is the dangerous direction to be wrong in.
     */
    weighted_beta_of_covered: enoughCoverage && grossWithBeta > 0
      ? {
          value: marketEquivalent / grossWithBeta,
          unit: "beta",
          as_of: iso(now),
          source: "derived",
          method: "market_equivalent_over_gross_value_of_covered_positions_only",
        }
      : unmeasured("beta_coverage_below_floor", {
          beta_coverage_pct: Math.round(betaCoveragePct ?? 0),
          floor_pct: MIN_BETA_COVERAGE_PCT,
        }),
    price_coverage_pct:
      priceCoveragePct === null
        ? unmeasured("no_positions")
        : {
            value: priceCoveragePct,
            unit: "pct",
            as_of: iso(now),
            source: "derived",
            method: "priced_positions_over_all_accepted_positions",
          },
    beta_coverage_pct:
      betaCoveragePct === null
        ? unmeasured("no_priced_positions")
        : {
            value: betaCoveragePct,
            unit: "pct",
            as_of: iso(now),
            source: "derived",
            method: "gross_value_with_computable_market_equivalent_over_gross_priced_value",
          },
  };

  const byBasket: BasketWeight[] = BASKETS.map((b) => {
    const members = priced.filter((r) => (b.symbols as readonly string[]).includes(r.symbol));
    const weight = members.reduce((s, r) => s + Math.abs(r.value_usd.value as number), 0);
    return {
      basket: b.name,
      weight_pct: grossPriced > 0 ? (weight / grossPriced) * 100 : 0,
      members_held: members.map((r) => r.symbol),
      note: b.note,
    };
  }).filter((b) => b.members_held.length > 0);

  const largest = priced.length
    ? Math.max(...priced.map((r) => Math.abs(r.value_usd.value as number)))
    : null;

  return {
    schema_version: PORTFOLIO_SCHEMA_VERSION,
    generated_at: iso(now),
    positions: rows,
    exposure,
    concentration: {
      largest_position_pct:
        largest === null || grossPriced <= 0
          ? unmeasured("no_priced_positions")
          : {
              value: (largest / grossPriced) * 100,
              unit: "pct",
              as_of: iso(now),
              source: "derived",
              method: "largest_absolute_position_over_gross_priced_value",
            },
      by_basket: byBasket,
    },
    rejected,
  };
}
