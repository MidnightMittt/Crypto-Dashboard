import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * Aevo — direct adapter. Public API, no key.
 * Docs: https://api-docs.aevo.xyz/
 *
 * ── Which funding field to trust ───────────────────────────────────────
 *
 * /statistics exposes `funding_daily_avg`, which is tempting and wrong for
 * this purpose: it's the mean of the hourly rates over a day, not the
 * current rate. /funding returns the live one.
 *
 * The two were compared to confirm the units line up — 0.000012 live against
 * a 0.00001 daily mean — which also confirms the rate is HOURLY rather than
 * 8-hourly. That distinction matters: reported as 8-hourly it would look
 * eight times larger than it is against the CEXs.
 *
 * `next_epoch` is in NANOSECONDS, unlike every other timestamp in this
 * codebase. It's divided down below.
 *
 * Aevo is small — roughly $2M open interest on BTC — so it contributes
 * almost nothing to OI-weighted aggregates. It's included for completeness
 * of venue coverage, not because it moves the numbers.
 */
const BASE = "https://api.aevo.xyz";

interface AevoStatistics {
  open_interest?: { total?: string };
  mark_price?: string;
  index_price?: string;
  mark_price_24h_ago?: string;
  daily_volume?: string;
}

interface AevoFunding {
  /** Decimal fraction over one hour. */
  funding_rate?: string;
  /** Nanoseconds since epoch. */
  next_epoch?: string;
}

export async function fetchAevo(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const [stats, funding] = await Promise.all([
      fetchJson<AevoStatistics>(
        `${BASE}/statistics?asset=${asset}&instrument_type=PERPETUAL`
      ),
      fetchJson<AevoFunding>(`${BASE}/funding?instrument_name=${asset}-PERP`).catch(
        () => null
      ),
    ]);

    const price = safeNumber(stats.mark_price) || safeNumber(stats.index_price);
    if (!price) return null;

    const prior = safeNumber(stats.mark_price_24h_ago);
    const now = Date.now();

    // Nanoseconds -> milliseconds.
    const nextEpochNs = safeNumber(funding?.next_epoch);
    const nextFundingAt = nextEpochNs > 0 ? Math.round(nextEpochNs / 1e6) : now;

    return {
      exchangeId: "aevo",
      asset,
      fundingRatePct: safeNumber(funding?.funding_rate) * 100,
      fundingIntervalHours: 1,
      nextFundingAt,
      openInterestUsd: safeNumber(stats.open_interest?.total) * price,
      openInterestChange24hPct: null,
      volume24hUsd: safeNumber(stats.daily_volume),
      longShortRatio: null,
      price,
      priceChange24hPct: prior > 0 ? ((price - prior) / prior) * 100 : 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[aevo] fetch failed for ${asset}:`, err);
    return null;
  }
}
