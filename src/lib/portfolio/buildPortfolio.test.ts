import { describe, expect, it } from "vitest";
import { MarketExposure } from "@/lib/pretrade/buildPretrade";
import {
  MIN_BETA_COVERAGE_PCT,
  PortfolioInputs,
  buildPortfolio,
} from "./buildPortfolio";

const NOW = Date.UTC(2026, 7, 17);

const exposure = (beta: number): MarketExposure => ({
  proxy: "SPY",
  window_sessions: 250,
  observations: 250,
  beta,
  alpha_bp: 25.1,
  alpha_t: 1.4,
  alpha_significant_after_fdr: false,
  detectable_alpha_at_t3_bp: 53.6,
  r_squared: 0.44,
  proxy_net_bp: 6.36,
  derivation: "regressed_ols",
});

const inputs = (over: Partial<PortfolioInputs> = {}): PortfolioInputs => ({
  positions: [
    { symbol: "APLD", quantity: 100 },
    { symbol: "IREN", quantity: 50 },
  ],
  now: NOW,
  lastClose: new Map([
    ["APLD", { price: 31.2, asOf: "2026-08-14" }],
    ["IREN", { price: 44.16, asOf: "2026-08-14" }],
    ["SPY", { price: 640, asOf: "2026-08-14" }],
  ]),
  marketExposure: new Map([
    ["APLD", exposure(4.63)],
    ["IREN", exposure(4.14)],
  ]),
  ...over,
});

/**
 * Hand-computed throughout:
 *   APLD 100 x 31.20 = 3,120   x beta 4.63 = 14,445.60
 *   IREN  50 x 44.16 = 2,208   x beta 4.14 =  9,141.12
 *   gross 5,328    market equivalent 23,586.72
 *   weighted beta 23,586.72 / 5,328 = 4.4270
 */
describe("buildPortfolio — what the book is actually long", () => {
  it("values each position and converts it to index-equivalent notional", () => {
    const p = buildPortfolio(inputs());
    const apld = p.positions.find((r) => r.symbol === "APLD")!;
    expect(apld.value_usd.value).toBeCloseTo(3120, 6);
    expect(apld.market_equivalent_usd.value).toBeCloseTo(14445.6, 4);
    expect(apld.weight_pct.value).toBeCloseTo((3120 / 5328) * 100, 6);
  });

  /*
   * THE SENTENCE THIS ENDPOINT EXISTS TO PRODUCE. $5,328 of these names is
   * $23,587 of overnight SPY. A bot that thinks it holds a diversified
   * two-name basket is running 4.4x index leverage.
   */
  it("reports the gross book and the market exposure it really carries", () => {
    const p = buildPortfolio(inputs());
    expect(p.exposure.gross_value_usd.value).toBeCloseTo(5328, 6);
    expect(p.exposure.market_equivalent_usd.value).toBeCloseTo(23586.72, 4);
    expect(p.exposure.weighted_beta_of_covered.value).toBeCloseTo(4.427, 3);
    expect(p.exposure.beta_coverage_pct.value).toBe(100);
  });

  /*
   * A short genuinely offsets index beta, so value and equivalent are signed
   * while gross and concentration use absolute values. Conflating the two
   * would make a hedged book look twice as large as it is.
   */
  /*
   * The proxy's beta against itself is arithmetic, not a fit. This was caught
   * by reading live output on a hedged book: the SPY row claimed
   * "ols_overnight_on_SPY_250_sessions", which is a false statement about how
   * a declared identity was obtained.
   */
  it("labels the proxy's own beta as an identity, never as a regression", () => {
    const p = buildPortfolio(
      inputs({
        positions: [{ symbol: "SPY", quantity: 10 }],
        marketExposure: new Map([
          ["SPY", { ...exposure(1), derivation: "identity_by_definition" as const, r_squared: 1 }],
        ]),
      })
    );
    const beta = p.positions[0].beta as { value: number; method: string };
    expect(beta.value).toBe(1);
    expect(beta.method).toBe("beta_of_SPY_against_itself_is_one_by_definition");
    expect(beta.method).not.toContain("ols");
  });

  it("lets a short offset the market exposure without shrinking the gross", () => {
    const p = buildPortfolio(
      inputs({
        positions: [
          { symbol: "APLD", quantity: 100 },
          { symbol: "SPY", quantity: -20 },
        ],
        marketExposure: new Map([["APLD", exposure(4.63)], ["SPY", exposure(1)]]),
      })
    );
    // APLD 3,120 long; SPY -12,800 short. Gross 15,920, net -9,680.
    expect(p.exposure.gross_value_usd.value).toBeCloseTo(15920, 6);
    expect(p.exposure.net_value_usd.value).toBeCloseTo(-9680, 6);
    // 14,445.60 - 12,800 = 1,645.60 of net index exposure.
    expect(p.exposure.market_equivalent_usd.value).toBeCloseTo(1645.6, 4);
  });
});

describe("buildPortfolio — coverage is the correctness problem", () => {
  /*
   * A weighted beta over a minority of the book reads LOW, and understating
   * leverage is the dangerous direction to be wrong in. So it refuses, and
   * says how much was covered rather than publishing a flattering number.
   */
  it("refuses the weighted beta when too little of the book has one", () => {
    const p = buildPortfolio(
      inputs({
        positions: [
          { symbol: "APLD", quantity: 10 },   // 312, covered
          { symbol: "MSFT", quantity: 100, price: 500 }, // 50,000, not in the study
        ],
      })
    );
    expect(p.exposure.weighted_beta_of_covered.value).toBeNull();
    const r = p.exposure.weighted_beta_of_covered as {
      reason: string;
      detail: Record<string, number>;
    };
    expect(r.reason).toBe("beta_coverage_below_floor");
    expect(r.detail.floor_pct).toBe(MIN_BETA_COVERAGE_PCT);
    expect(r.detail.beta_coverage_pct).toBe(1); // 312 of 50,312
    // The market-equivalent figure is refused for the same reason, together.
    expect(p.exposure.market_equivalent_usd.value).toBeNull();
    // But the gross is still known and still reported.
    expect(p.exposure.gross_value_usd.value).toBeCloseTo(50312, 6);
  });

  it("reports both coverage figures separately, because they fail differently", () => {
    const p = buildPortfolio(
      inputs({
        positions: [
          { symbol: "APLD", quantity: 100 },
          { symbol: "NOPRICE", quantity: 5 },
        ],
      })
    );
    // One of two positions could be priced at all.
    expect(p.exposure.price_coverage_pct.value).toBe(50);
    // Of the value that COULD be priced, all of it has a beta.
    expect(p.exposure.beta_coverage_pct.value).toBe(100);
  });

  /*
   * An unpriced position must not silently vanish. Dropping it would shrink
   * the gross and inflate every remaining weight.
   */
  it("keeps an unpriced position visible with its reason", () => {
    const p = buildPortfolio(
      inputs({ positions: [{ symbol: "APLD", quantity: 100 }, { symbol: "NOPRICE", quantity: 5 }] })
    );
    const row = p.positions.find((r) => r.symbol === "NOPRICE")!;
    expect(row.quantity).toBe(5);
    expect((row.price as { reason: string }).reason).toBe("no_price_available");
    expect((row.weight_pct as { reason: string }).reason).toBe("no_price_available");
    expect(p.positions).toHaveLength(2);
  });
});

describe("buildPortfolio — provenance and concentration", () => {
  /* A client mark and a stale close are different claims about the value. */
  it("says whether the price came from the caller or from our close", () => {
    const p = buildPortfolio(
      inputs({ positions: [{ symbol: "APLD", quantity: 1, price: 33.5 }, { symbol: "IREN", quantity: 1 }] })
    );
    const supplied = p.positions[0].price as { source: string; value: number };
    const ours = p.positions[1].price as { source: string; as_of: string };
    expect(supplied.source).toBe("client_supplied_mark");
    expect(supplied.value).toBe(33.5);
    expect(ours.source).toBe("yahoo_daily_bars");
    expect(ours.as_of).toBe("2026-08-14");
  });

  /*
   * Baskets OVERLAP by construction — "scanned" contains "datacenter" — so
   * the shares are not a partition and must not be read as one.
   */
  it("reports overlapping basket weights that deliberately exceed 100 together", () => {
    const p = buildPortfolio(inputs());
    const names = p.concentration.by_basket.map((b) => b.basket);
    expect(names).toContain("scanned");
    expect(names).toContain("datacenter");
    const total = p.concentration.by_basket.reduce((s, b) => s + b.weight_pct, 0);
    expect(total).toBeCloseTo(200, 6);
    // Every basket names the members actually held, so a row is checkable.
    expect(p.concentration.by_basket.find((b) => b.basket === "datacenter")!.members_held).toEqual([
      "APLD",
      "IREN",
    ]);
  });

  it("reports the largest position as a share of gross", () => {
    const p = buildPortfolio(inputs());
    expect(p.concentration.largest_position_pct.value).toBeCloseTo((3120 / 5328) * 100, 6);
  });

  it("omits baskets nothing is held in rather than listing them at zero", () => {
    const p = buildPortfolio(inputs());
    expect(p.concentration.by_basket.map((b) => b.basket)).not.toContain("benchmarks");
  });
});

describe("buildPortfolio — refusals", () => {
  /* A zero-quantity holding is not a position. */
  it("rejects zero and non-finite quantities with a reason", () => {
    const p = buildPortfolio(
      inputs({
        positions: [
          { symbol: "APLD", quantity: 0 },
          { symbol: "IREN", quantity: Number.NaN },
          { symbol: "  ", quantity: 5 },
        ],
      })
    );
    expect(p.positions).toHaveLength(0);
    expect(p.rejected.map((r) => r.reason)).toEqual([
      "zero_or_invalid_quantity",
      "zero_or_invalid_quantity",
      "empty_symbol",
    ]);
  });

  it("survives an empty book without inventing an exposure", () => {
    const p = buildPortfolio(inputs({ positions: [] }));
    expect(p.exposure.gross_value_usd.value).toBeNull();
    expect(p.exposure.weighted_beta_of_covered.value).toBeNull();
    expect(p.concentration.largest_position_pct.value).toBeNull();
    expect(p.concentration.by_basket).toEqual([]);
  });

  it("upper-cases and trims symbols so a lowercase holding still matches", () => {
    const p = buildPortfolio(inputs({ positions: [{ symbol: " apld ", quantity: 10 }] }));
    expect(p.positions[0].symbol).toBe("APLD");
    expect(p.positions[0].beta.value).toBe(4.63);
  });
});
