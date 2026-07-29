import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Deribit — direct adapter. Public API, no key.
 * Docs: https://docs.deribit.com/
 *
 * ── Two perps per asset, and it matters ────────────────────────────────
 *
 * Deribit lists BTC and ETH perps in two forms:
 *   BTC-PERPETUAL       inverse, USD-margined  — open_interest is in USD
 *   BTC_USDC-PERPETUAL  linear, USDC-margined  — open_interest is in BASE
 *
 * The inverse contract is by far the larger of the two ($728M vs $25M for
 * BTC at the time of writing). CoinGecko only surfaced the USDC one, so the
 * dashboard was understating Deribit by ~30x. Querying both and summing is
 * the whole reason this adapter exists.
 *
 * THE UNIT DIFFERENCE IS THE TRAP: `open_interest` means USD on the inverse
 * contract and base units on the linear one. Multiplying the inverse figure
 * by price would report $47 trillion. Each branch is converted explicitly
 * below — do not consolidate them.
 *
 * Assets other than BTC/ETH have only the USDC linear perp.
 */
const BASE = "https://www.deribit.com/api/v2/public";

interface DeribitTicker {
  result?: {
    instrument_name?: string;
    open_interest?: number;
    mark_price?: number;
    index_price?: number;
    /** Decimal fraction over 8 hours, e.g. 4.863e-05 = 0.004863%. */
    funding_8h?: number;
    current_funding?: number;
    stats?: { price_change?: number; volume_usd?: number };
  };
}

/** Assets with an inverse (USD-margined) perpetual on Deribit. */
const INVERSE_ASSETS = new Set(["BTC", "ETH"]);

async function ticker(instrument: string): Promise<DeribitTicker["result"] | null> {
  try {
    const res = await fetchJson<DeribitTicker>(
      `${BASE}/ticker?instrument_name=${instrument}`
    );
    return res.result ?? null;
  } catch {
    // Instrument not listed — a normal outcome, not a failure.
    return null;
  }
}

export async function fetchDeribit(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const [inverse, linear] = await Promise.all([
      INVERSE_ASSETS.has(asset) ? ticker(`${asset}-PERPETUAL`) : Promise.resolve(null),
      ticker(`${asset}_USDC-PERPETUAL`),
    ]);

    if (!inverse && !linear) return null;

    const price =
      safeNumber(inverse?.mark_price) || safeNumber(linear?.mark_price) || 0;
    if (!price) return null;

    // Inverse: open_interest is already USD (each contract is $1).
    const inverseOi = safeNumber(inverse?.open_interest);
    // Linear: open_interest is in base units, so convert at mark price.
    const linearOi = safeNumber(linear?.open_interest) * safeNumber(linear?.mark_price, price);
    const openInterestUsd = inverseOi + linearOi;

    // Weight the two books' funding by their size — a $25M contract
    // shouldn't move the venue's reported rate as much as a $728M one.
    const rates: Array<{ rate: number; weight: number }> = [];
    if (inverse?.funding_8h !== undefined) {
      rates.push({ rate: inverse.funding_8h, weight: inverseOi || 1 });
    }
    if (linear?.funding_8h !== undefined) {
      rates.push({ rate: linear.funding_8h, weight: linearOi || 1 });
    }
    const totalWeight = rates.reduce((s, r) => s + r.weight, 0);
    const funding8h =
      totalWeight > 0 ? rates.reduce((s, r) => s + r.rate * r.weight, 0) / totalWeight : 0;

    const now = Date.now();
    return {
      exchangeId: "deribit",
      asset,
      // funding_8h is a decimal fraction covering a full 8h period, which is
      // exactly the interval declared below — no rescaling needed, only the
      // fraction-to-percent conversion.
      fundingRatePct: funding8h * 100,
      fundingIntervalHours: 8,
      nextFundingAt: Math.ceil(now / 28_800_000) * 28_800_000,
      openInterestUsd,
      // Deribit publishes no OI history on the public endpoint; the local
      // recorder backfills this once it has enough samples.
      openInterestChange24hPct: null,
      volume24hUsd:
        safeNumber(inverse?.stats?.volume_usd) + safeNumber(linear?.stats?.volume_usd),
      longShortRatio: null,
      price,
      // stats.price_change is already a percentage (1.5517 = +1.55%).
      priceChange24hPct: safeNumber(
        inverse?.stats?.price_change ?? linear?.stats?.price_change
      ),
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[deribit] fetch failed for ${asset}:`, err);
    return null;
  }
}
