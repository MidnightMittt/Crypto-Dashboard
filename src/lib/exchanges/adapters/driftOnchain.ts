import { AssetSymbol, ExchangeSnapshot } from "@/types/market";

/**
 * Drift Protocol — read directly from Solana chain state.
 *
 * WHY THIS EXISTS: data.api.drift.trade returns HTTP 403 from geofenced
 * regions. But Solana chain state is NOT geofenced — Drift's perp market
 * accounts hold open interest, funding, and the long/short skew as public
 * on-chain data readable from anywhere. This reads that directly, which is
 * both unblockable and unpaywallable.
 *
 * Requires an RPC endpoint. Helius, Alchemy, or any Solana RPC works:
 *   HELIUS_API_KEY=...                (simplest)
 *   or SOLANA_RPC_URL=https://...     (any provider)
 *
 * ── PRECISION, verified against @drift-labs/sdk v2.155 source ────────────
 * These are the numbers that make or break a Drift integration:
 *
 *   lastFundingRate     FUNDING_RATE_PRECISION = 10^9
 *                       (PRICE_PRECISION_EXP 6 + FUNDING_RATE_BUFFER_EXP 3)
 *   baseAssetAmountLong BASE_PRECISION = AMM_RESERVE_PRECISION = 10^9
 *   baseAssetAmountShort  同上
 *   lastOraclePriceTwap PRICE_PRECISION = 10^6
 *
 * Drift's funding is stored in quote/base units, so per their docs it must
 * be divided by the oracle TWAP to become a percentage. Skipping that step
 * yields a number wrong by roughly the price of the asset — for BTC that's
 * a ~100,000x error.
 */

import type { PerpMarketAccount } from "@drift-labs/sdk";

const FUNDING_RATE_PRECISION = 1e9;
const BASE_PRECISION = 1e9;
const PRICE_PRECISION = 1e6;

/** Drift perp market indexes for the assets this dashboard tracks. */
const MARKET_INDEX: Partial<Record<AssetSymbol, number>> = {
  SOL: 0,
  BTC: 1,
  ETH: 2,
};

export function driftRpcUrl(): string | null {
  const explicit = process.env.SOLANA_RPC_URL?.trim();
  if (explicit) return explicit;
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://mainnet.helius-rpc.com/?api-key=${helius}`;
  return null;
}

export function driftOnchainConfigured(): boolean {
  return driftRpcUrl() !== null;
}

interface CachedMarkets {
  markets: Map<number, PerpMarketAccount>;
  fetchedAt: number;
}

let cache: CachedMarkets | null = null;
const CACHE_MS = 20_000;

/**
 * Loads Drift perp market accounts.
 *
 * The SDK and its Solana dependencies are imported lazily so they're only
 * pulled into the bundle when this adapter is actually configured — the
 * dependency tree is large, and most users won't enable it.
 */
async function loadMarkets(): Promise<Map<number, PerpMarketAccount>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache.markets;

  const rpc = driftRpcUrl();
  if (!rpc) return new Map();

  const { Connection, Keypair } = await import("@solana/web3.js");
  const { DriftClient, Wallet, initialize } = await import("@drift-labs/sdk");

  const connection = new Connection(rpc, "confirmed");
  // Read-only: a throwaway keypair satisfies the client's wallet requirement.
  // No transactions are ever signed or sent.
  const wallet = new Wallet(Keypair.generate());

  const sdkConfig = initialize({ env: "mainnet-beta" });

  const client = new DriftClient({
    connection,
    wallet,
    programID: new (await import("@solana/web3.js")).PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: "mainnet-beta",
  });

  await client.subscribe();

  const markets = new Map<number, PerpMarketAccount>();
  for (const [, index] of Object.entries(MARKET_INDEX)) {
    if (index === undefined) continue;
    const account = client.getPerpMarketAccount(index);
    if (account) markets.set(index, account);
  }

  await client.unsubscribe();

  console.info(`[drift-onchain] loaded ${markets.size} perp markets from ${rpc.split("?")[0]}`);
  cache = { markets, fetchedAt: Date.now() };
  return markets;
}

export async function fetchDriftOnchain(asset: AssetSymbol): Promise<ExchangeSnapshot | null> {
  const index = MARKET_INDEX[asset];
  if (index === undefined) return null;
  if (!driftOnchainConfigured()) return null;

  try {
    const markets = await loadMarkets();
    const market = markets.get(index);
    if (!market) return null;

    const amm = market.amm;

    // Oracle TWAP in USD.
    const oracleTwap = amm.historicalOracleData.lastOraclePriceTwap.toNumber() / PRICE_PRECISION;
    if (!oracleTwap) return null;

    // Long/short base exposure. baseAssetAmountShort is stored negative.
    const longBase = amm.baseAssetAmountLong.toNumber() / BASE_PRECISION;
    const shortBase = Math.abs(amm.baseAssetAmountShort.toNumber()) / BASE_PRECISION;

    // Open interest: total notional on both sides.
    const openInterestUsd = (longBase + shortBase) * oracleTwap;
    if (!openInterestUsd) return null;

    // Funding: quote/base units -> divide by oracle TWAP to get a rate.
    const rawFunding = amm.lastFundingRate.toNumber() / FUNDING_RATE_PRECISION;
    const fundingRatePct = (rawFunding / oracleTwap) * 100;

    // fundingPeriod is in seconds; Drift settles hourly.
    const periodSeconds = amm.fundingPeriod.toNumber() || 3600;
    const intervalHours = Math.max(1, Math.round(periodSeconds / 3600));

    const lastFundingTs = amm.lastFundingRateTs.toNumber() * 1000;

    return {
      exchangeId: "drift",
      asset,
      fundingRatePct,
      fundingIntervalHours: intervalHours,
      nextFundingAt: lastFundingTs + periodSeconds * 1000,
      openInterestUsd,
      openInterestChange24hPct: null,
      volume24hUsd: 0, // not held in market account state
      // Real on-chain positioning — the long/short skew of the AMM.
      longShortRatio: shortBase > 0 ? longBase / shortBase : null,
      price: oracleTwap,
      priceChange24hPct: 0,
      sparkline: [],
      fundingHistory: [],
      source: "direct",
      updatedAt: Date.now(),
    };
  } catch (err) {
    console.warn(`[drift-onchain] failed for ${asset}:`, err);
    return null;
  }
}
