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
      // These two "rubik" endpoints were previously requested at
      // /api/v5/rubik-stat/... — a hyphen where the path needs a slash. OKX
      // answers that with a 404, the `.catch` below swallowed it, and both
      // series silently arrived empty on every poll.
      //
      // The cost was three dead gauges: long/short had no source at all
      // (Binance and Bybit, the only other venues publishing it, are
      // geoblocked), and without OI history there was no OI percentile and
      // therefore no leverage-heat score either.
      fetchJson<{ data: Array<[string, string]> }>(
        `${BASE}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${asset}&period=5m`
      ).catch(() => ({ data: [] as Array<[string, string]> })),
      // [ts, oiUsd, volUsd] triples, newest first. Confirmed USD-denominated
      // against /public/open-interest: rubik reports 2.597e9 where oiCcy ×
      // price gives 2.03e9 for the same instrument, both ~$2-2.6B.
      fetchJson<{ data: Array<[string, string, string]> }>(
        `${BASE}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${asset}&period=1H`
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

    /*
     * SCALE MISMATCH — read before changing any of this.
     *
     * `openInterestUsd` above is the BTC-USDT-SWAP instrument alone (~$2.03B
     * for BTC). The rubik series covers EVERY OKX contract on that currency —
     * both swaps and dated futures, across all quote currencies (~$2.60B).
     * They are different measurements of different universes.
     *
     * Comparing the two directly, which this adapter used to do, produced a
     * "-23.3% 24h OI change" that was not a change at all: it was the gap
     * between the two definitions, reported fresh on every poll. It also
     * pinned the OI percentile.
     *
     * OKX publishes no per-instrument OI history, so the series is normalised
     * onto the instrument's current level. Both metrics derived from it —
     * percent change and percentile rank — depend only on the SHAPE of the
     * series, and scaling by a constant preserves shape exactly. The levels
     * shown on the chart stay consistent with the venue's headline OI.
     */
    const rawPoints = [...(oiHist.data ?? [])]
      .reverse() // rubik returns newest-first; we want oldest-first
      .map((row) => ({ t: safeNumber(row[0]), oi: safeNumber(row[1]) }))
      .filter((p) => p.oi > 0);

    const rubikLatest = rawPoints[rawPoints.length - 1]?.oi ?? 0;
    const scale = rubikLatest > 0 && openInterestUsd > 0 ? openInterestUsd / rubikLatest : 1;

    const oiPoints: FundingPoint[] = rawPoints.map((p) => ({
      t: p.t,
      openInterestUsd: p.oi * scale,
    }));

    // Computed within the series rather than against the instrument snapshot,
    // so both ends of the comparison are the same measurement. The scale
    // factor cancels, making this the true rubik ratio either way.
    let openInterestChange24hPct: number | null = null;
    if (rawPoints.length > 24) {
      const then = rawPoints[rawPoints.length - 25].oi;
      const latest = rawPoints[rawPoints.length - 1].oi;
      if (then > 0) openInterestChange24hPct = ((latest - then) / then) * 100;
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
