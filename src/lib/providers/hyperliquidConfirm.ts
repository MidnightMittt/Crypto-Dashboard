import { swr } from "../cache/swr";
import { timeoutSignal, PROVIDER_FETCH_TIMEOUT_MS } from "../net/timeout";
import type { AssetSymbol } from "@/types/market";

/**
 * Hyperliquid derivatives confirmation layer — Dashboard v2 spec's
 * Sub-phase C. Per the brief: "Do NOT duplicate existing gauges. Instead
 * increase confidence in existing signals." This module produces NO new
 * scored metric and NO new UI card — it feeds an optional cross-check into
 * evaluateFunding/evaluateOrderFlow in evaluators.ts, which raises or
 * lowers those metrics' existing `agreement`/`conflicts`, exactly the
 * user's own worked example: "Funding Bullish + Hyperliquid Aggressive
 * Buyers + Positive Order Book Imbalance = Higher confidence bullish
 * thesis."
 *
 * Hyperliquid is a genuinely independent venue from this app's existing
 * funding/order-flow sources (a DEX vs. the CEX venues Coinalyze/OKX
 * already aggregate), so agreement here is real corroborating evidence,
 * not a second read of the same underlying data.
 *
 * Two keyless REST endpoints, confirmed live before writing this file:
 *   - `metaAndAssetCtxs`: one call returns funding + open interest for
 *     EVERY Hyperliquid asset (232 as of this writing) — fetched once,
 *     shared across all 10 of this app's tracked assets (all 10 confirmed
 *     present in Hyperliquid's universe).
 *   - `l2Book`: full order book per asset, WITH per-level order counts.
 *     Point-in-time only, fetched per-asset.
 *
 * IMPORTANT unit note: Hyperliquid settles funding HOURLY, not every 8h
 * like most CEX perps — confirmed by inspecting `fundingHistory`'s own
 * timestamps (one row per hour, not one per 8h). This app's funding bands
 * (FUNDING_BANDS in sentiment/bands.ts) and `weightedFundingRatePct` are
 * both %/8h. Hyperliquid's raw `funding` field is therefore multiplied by
 * 8 before classification — comparing it unnormalized against an 8h band
 * would silently misclassify every reading by roughly 8x.
 */

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const CTX_FRESH_MS = 60_000;
const CTX_MAX_AGE_MS = 10 * 60_000;
const BOOK_FRESH_MS = 30_000;
const BOOK_MAX_AGE_MS = 5 * 60_000;
/** Top-N book levels summed into the imbalance read — deep enough to smooth single-order noise, shallow enough to stay a genuine "near touch" read. */
const BOOK_DEPTH_LEVELS = 10;

export interface HyperliquidFundingReading {
  /** Normalized to %/8h, matching this app's FUNDING_BANDS convention. */
  fundingRatePct8h: number;
  openInterest: number;
}

export interface HyperliquidBookImbalance {
  /** (bid notional - ask notional) / total, over the top BOOK_DEPTH_LEVELS — same convention as sentiment/orderFlow.ts's bookImbalance. */
  imbalancePct: number;
}

export interface HyperliquidConfirmation {
  funding: HyperliquidFundingReading | null;
  orderBook: HyperliquidBookImbalance | null;
}

interface AssetCtx {
  funding?: string;
  openInterest?: string;
}

interface UniverseAsset {
  name?: string;
}

async function fetchFundingMap(): Promise<Map<AssetSymbol, HyperliquidFundingReading>> {
  return swr(
    "hyperliquid:metaAndAssetCtxs",
    async () => {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Hyperliquid metaAndAssetCtxs HTTP ${res.status}`);
      const json = (await res.json()) as [{ universe?: UniverseAsset[] }, AssetCtx[]];
      const [meta, ctxs] = json;
      const universe = meta?.universe ?? [];

      const map = new Map<AssetSymbol, HyperliquidFundingReading>();
      universe.forEach((u, i) => {
        const name = u.name as AssetSymbol | undefined;
        if (!name) return;
        const ctx = ctxs[i];
        const hourlyPct = Number(ctx?.funding);
        const openInterest = Number(ctx?.openInterest);
        if (!Number.isFinite(hourlyPct) || !Number.isFinite(openInterest)) return;
        map.set(name, { fundingRatePct8h: hourlyPct * 8 * 100, openInterest });
      });
      return map;
    },
    { freshMs: CTX_FRESH_MS, maxAgeMs: CTX_MAX_AGE_MS }
  ).catch((err) => {
    console.warn("[hyperliquidConfirm] metaAndAssetCtxs fetch failed:", err);
    return new Map<AssetSymbol, HyperliquidFundingReading>();
  });
}

interface L2Level {
  px?: string;
  sz?: string;
}

async function fetchBookImbalance(asset: AssetSymbol): Promise<HyperliquidBookImbalance | null> {
  return swr(
    `hyperliquid:l2Book:${asset}`,
    async () => {
      const res = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: asset }),
        signal: timeoutSignal(PROVIDER_FETCH_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Hyperliquid l2Book HTTP ${res.status} for ${asset}`);
      const json = (await res.json()) as { levels?: [L2Level[], L2Level[]] };
      const [bids, asks] = json.levels ?? [[], []];

      const notional = (levels: L2Level[]) =>
        levels.slice(0, BOOK_DEPTH_LEVELS).reduce((sum, l) => {
          const px = Number(l.px);
          const sz = Number(l.sz);
          return Number.isFinite(px) && Number.isFinite(sz) ? sum + px * sz : sum;
        }, 0);

      const bidNotional = notional(bids);
      const askNotional = notional(asks);
      const total = bidNotional + askNotional;
      if (total <= 0) throw new Error(`Hyperliquid l2Book returned no usable depth for ${asset}`);

      return { imbalancePct: ((bidNotional - askNotional) / total) * 100 };
    },
    { freshMs: BOOK_FRESH_MS, maxAgeMs: BOOK_MAX_AGE_MS }
  ).catch((err) => {
    console.warn(`[hyperliquidConfirm] l2Book fetch failed for ${asset}:`, err);
    return null;
  });
}

export async function fetchHyperliquidConfirmation(asset: AssetSymbol): Promise<HyperliquidConfirmation> {
  const [fundingMap, orderBook] = await Promise.all([fetchFundingMap(), fetchBookImbalance(asset)]);
  return { funding: fundingMap.get(asset) ?? null, orderBook };
}
