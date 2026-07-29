import { AssetSymbol, ExchangeSnapshot } from "@/types/market";
import { fetchJson, safeNumber } from "./types";

/**
 * BitMEX — direct adapter. Public API, no key.
 * Docs: https://www.bitmex.com/api/explorer/
 *
 * ── Open interest: two contract types, two completely different units ──
 *
 * This is the reason the adapter took care to write. `openInterest` means
 * something different depending on the contract:
 *
 *   INVERSE (XBTUSD, isInverse: true)
 *     Quoted in USD directly — each contract is $1. 85,538,000 => $85.54M.
 *     Cross-checked against openValue (satoshis): 132,794,323,480 / 1e8
 *     × $64,414 = $85.54M. Both agree.
 *
 *   LINEAR (XBTUSDT, isInverse: false)
 *     Quoted in position units, where `underlyingToPositionMultiplier`
 *     units make one coin. 97,431,100 / 1e6 = 97.43 XBT => $6.28M.
 *     Cross-checked against openValue / quoteToSettleMultiplier:
 *     6,282,287,177,608 / 1e6 = $6.28M. Both agree.
 *
 * Reading the linear contract with the inverse rule would report $97 billion
 * for a $6 million book. Every branch below is derived twice and was only
 * accepted because the two derivations matched.
 *
 * BitMEX also uses XBT rather than BTC for bitcoin.
 */
const BASE = "https://www.bitmex.com/api/v1";
const CACHE_MS = 10_000;

interface BitmexInstrument {
  symbol?: string;
  rootSymbol?: string;
  state?: string;
  /** 'FFWCSX' = perpetual contract. */
  typ?: string;
  isInverse?: boolean;
  isQuanto?: boolean;
  openInterest?: number;
  openValue?: number;
  markPrice?: number;
  underlyingToPositionMultiplier?: number | null;
  quoteToSettleMultiplier?: number | null;
  /** Decimal fraction, e.g. 0.0001 = 0.01%. */
  fundingRate?: number;
  /** ISO timestamp whose TIME component is the interval, e.g. ...T08:00:00Z. */
  fundingInterval?: string;
  /** Decimal fraction: 0.0148 = +1.48%. */
  lastChangePcnt?: number;
  /** 24h volume in the quote currency. */
  foreignNotional24h?: number;
}

let cache: { rows: BitmexInstrument[]; fetchedAt: number } | null = null;
let inflight: Promise<BitmexInstrument[]> | null = null;

async function getActive(): Promise<BitmexInstrument[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.rows;
  if (inflight) return inflight;

  inflight = fetchJson<BitmexInstrument[]>(`${BASE}/instrument/active`)
    .then((rows) => {
      // FFWCSX is BitMEX's type code for a perpetual swap. Excluding
      // everything else keeps dated futures out of the perp aggregate.
      const perps = rows.filter((r) => r.typ === "FFWCSX" && r.state === "Open");
      cache = { rows: perps, fetchedAt: Date.now() };
      return perps;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

/** BitMEX's ticker for bitcoin. */
function bitmexRoot(asset: AssetSymbol): string {
  return asset === "BTC" ? "XBT" : asset;
}

/** Hours between funding settlements, parsed from the ISO interval string. */
function intervalHours(iso: string | undefined): number {
  if (!iso) return 8;
  const match = /T(\d{2}):(\d{2})/.exec(iso);
  if (!match) return 8;
  const hours = Number(match[1]) + Number(match[2]) / 60;
  return hours > 0 ? hours : 8;
}

/** USD open interest for one instrument, honouring its contract convention. */
function openInterestUsd(r: BitmexInstrument): number {
  const oi = safeNumber(r.openInterest);
  if (oi <= 0) return 0;

  // Inverse contracts are denominated in USD already.
  if (r.isInverse) return oi;

  // Linear: position units -> coins -> USD.
  const posMultiplier = safeNumber(r.underlyingToPositionMultiplier);
  const mark = safeNumber(r.markPrice);
  if (posMultiplier > 0 && mark > 0) return (oi / posMultiplier) * mark;

  // Fallback: openValue in settle-currency minor units.
  const quoteMultiplier = safeNumber(r.quoteToSettleMultiplier);
  const openValue = safeNumber(r.openValue);
  if (quoteMultiplier > 0 && openValue > 0) return openValue / quoteMultiplier;

  // Neither derivation available — report nothing rather than a guess.
  return 0;
}

export async function fetchBitmex(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  try {
    const rows = await getActive();
    const root = bitmexRoot(asset);

    // Quanto contracts settle in a third currency and their notional isn't
    // comparable to the rest — excluded rather than mis-weighted.
    const matches = rows.filter((r) => r.rootSymbol === root && !r.isQuanto);
    if (matches.length === 0) return null;

    const priced = matches.filter((r) => safeNumber(r.markPrice) > 0);
    if (priced.length === 0) return null;

    const legs = priced.map((r) => ({ row: r, oi: openInterestUsd(r) }));
    const totalOi = legs.reduce((s, l) => s + l.oi, 0);

    // OI-weighted so the dominant book drives the venue's headline numbers.
    const weight = (l: { oi: number }) => (totalOi > 0 ? l.oi : 1);
    const totalWeight = legs.reduce((s, l) => s + weight(l), 0);
    const wavg = (pick: (r: BitmexInstrument) => number) =>
      totalWeight > 0
        ? legs.reduce((s, l) => s + pick(l.row) * weight(l), 0) / totalWeight
        : 0;

    const price = wavg((r) => safeNumber(r.markPrice));
    if (!price) return null;

    const now = Date.now();
    const hours = intervalHours(priced[0].fundingInterval);

    return {
      exchangeId: "bitmex",
      asset,
      fundingRatePct: wavg((r) => safeNumber(r.fundingRate)) * 100,
      fundingIntervalHours: hours,
      nextFundingAt: Math.ceil(now / (hours * 3_600_000)) * (hours * 3_600_000),
      openInterestUsd: totalOi,
      openInterestChange24hPct: null,
      volume24hUsd: legs.reduce((s, l) => s + safeNumber(l.row.foreignNotional24h), 0),
      longShortRatio: null,
      price,
      priceChange24hPct: wavg((r) => safeNumber(r.lastChangePcnt)) * 100,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: now,
    };
  } catch (err) {
    console.warn(`[bitmex] fetch failed for ${asset}:`, err);
    return null;
  }
}
