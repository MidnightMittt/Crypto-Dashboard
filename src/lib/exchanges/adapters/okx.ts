import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

// OKX v5 public API. No key required for these endpoints.
// Docs: https://www.okx.com/docs-v5/en/
const BASE = "https://www.okx.com";

/**
 * OKX reports SWAP volume and open interest in CONTRACTS, not base units.
 * Each contract represents `ctVal` of the base currency (e.g. 0.01 BTC), so
 * volume must be multiplied by ctVal before converting to USD. Skipping it
 * overstates volume by 1/ctVal — 100x for BTC, which showed as $659B of
 * daily OKX volume against a realistic ~$6B.
 */
const ctValCache = new Map<string, { value: number; fetchedAt: number }>();

async function contractValue(instId: string): Promise<number> {
  const cached = ctValCache.get(instId);
  // Contract specs effectively never change; cache for an hour.
  if (cached && Date.now() - cached.fetchedAt < 3_600_000) return cached.value;

  try {
    const res = await fetchJson<{ data: Array<{ ctVal: string }> }>(
      `${BASE}/api/v5/public/instruments?instType=SWAP&instId=${instId}`
    );
    const value = safeNumber(res.data?.[0]?.ctVal, 1) || 1;
    ctValCache.set(instId, { value, fetchedAt: Date.now() });
    return value;
  } catch {
    // Fall back to 1 rather than guessing — a wrong multiplier is worse
    // than an unscaled figure we can spot.
    return 1;
  }
}

export async function fetchOkx(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const instId = `${asset}-USDT-SWAP`;
  try {
    const [funding, oi, ticker, longShort, oiHist, ctVal] = await Promise.all([
      fetchJson<{ data: Array<{ fundingRate: string; nextFundingTime: string }> }>(
        `${BASE}/api/v5/public/funding-rate?instId=${instId}`
      ),
      fetchJson<{ data: Array<{ oiCcy: string }> }>(
        `${BASE}/api/v5/public/open-interest?instId=${instId}`
      ),
      fetchJson<{ data: Array<{ last: string; vol24h: string; open24h: string }> }>(
        `${BASE}/api/v5/market/ticker?instId=${instId}`
      ),
      fetchJson<{ data: Array<[string, string]> }>(
        `${BASE}/api/v5/rubik-stat/contracts/long-short-account-ratio?ccy=${asset}&period=5m`
      ).catch(() => ({ data: [] as Array<[string, string]> })),
      // [ts, oiCcy, oiUsd] triples, newest first.
      fetchJson<{ data: Array<[string, string, string]> }>(
        `${BASE}/api/v5/rubik-stat/contracts/open-interest-volume?ccy=${asset}&period=1H`
      ).catch(() => ({ data: [] as Array<[string, string, string]> })),
      contractValue(instId),
    ]);

    const f = funding.data?.[0];
    const t = ticker.data?.[0];
    if (!f || !t) return null;

    const price = safeNumber(t.last);
    if (!price) return null;

    const openInterestUsd = oi.data?.[0] ? safeNumber(oi.data[0].oiCcy) * price : 0;
    const open24h = safeNumber(t.open24h);

    const oiPoints: FundingPoint[] = [...(oiHist.data ?? [])]
      .reverse()
      .map((row) => ({ t: safeNumber(row[0]), openInterestUsd: safeNumber(row[1]) }));

    let openInterestChange24hPct: number | null = null;
    if (oiPoints.length > 24) {
      const then = oiPoints[oiPoints.length - 25].openInterestUsd;
      if (then && then > 0) {
        openInterestChange24hPct = ((openInterestUsd - then) / then) * 100;
      }
    }

    // Rubik long/short rows are [timestamp, ratio], newest first.
    const lsRow = longShort.data?.[0];

    return {
      exchangeId: "okx",
      asset,
      fundingRatePct: safeNumber(f.fundingRate) * 100,
      fundingIntervalHours: 8,
      nextFundingAt: safeNumber(f.nextFundingTime),
      openInterestUsd,
      openInterestChange24hPct,
      // vol24h is in contracts — scale by ctVal before pricing.
      volume24hUsd: safeNumber(t.vol24h) * ctVal * price,
      longShortRatio: lsRow ? safeNumber(lsRow[1]) : null,
      price,
      priceChange24hPct: open24h ? ((price - open24h) / open24h) * 100 : 0,
      sparkline: [],
      fundingHistory: oiPoints,
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[okx] fetch failed for ${asset}:`, err);
    return null;
  }
}
