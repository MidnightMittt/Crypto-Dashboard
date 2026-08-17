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
   * The agent's own mark. Optional: falls back to our last close, and the
   * provenance says which was used, because a stale close and a live mark are
   * different claims about what the position is worth.
   */
  price?: number;
}

export interface PositionRow {
  symbol: string;
  quantity: number;
  price: Field<number>;
  /** quantity x price. Signed, so a short is negative. */
  value_usd: Field<number>;
  /** Share of GROSS book value, using absolute values. */
  weight_pct: Field<number>;
  beta: Field<number>;
  /** value x beta — the index-equivalent notional this holding carries. */
  market_equivalent_usd: Field<number>;
  /** Declared baskets this name belongs to. Overlapping by design. */
  baskets: string[];
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
   * part of the book we can measure, not of the whole book.
   */
  weighted_beta_of_covered: Field<number>;
  /** Share of gross value that could be priced at all. */
  price_coverage_pct: Field<number>;
  /** Share of PRICED gross value that has a measured beta. */
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

export const PORTFOLIO_SCHEMA_VERSION = "1.0";

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

    const supplied = Number.isFinite(p.price) && (p.price as number) > 0 ? (p.price as number) : null;
    const ours = lastClose.get(symbol) ?? null;

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

  const withBeta = priced.filter((r) => r.beta.value !== null);
  const grossWithBeta = withBeta.reduce((s, r) => s + Math.abs(r.value_usd.value as number), 0);
  const betaCoveragePct = grossPriced > 0 ? (grossWithBeta / grossPriced) * 100 : null;
  const marketEquivalent = withBeta.reduce(
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
            method: "gross_value_with_measured_beta_over_gross_priced_value",
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
