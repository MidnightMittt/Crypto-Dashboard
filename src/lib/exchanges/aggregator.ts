import { AggregateMarketData, AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { ALL_ASSETS, EXCHANGES, exchangesForAsset } from "./registry";
import { fetchBinance } from "./adapters/binance";
import { fetchBybit } from "./adapters/bybit";
import { fetchOkx } from "./adapters/okx";
import { fetchHyperliquid } from "./adapters/hyperliquid";
import { fetchDydx } from "./adapters/dydx";
import { fetchBitget } from "./adapters/bitget";
import { fetchGateio } from "./adapters/gateio";
import { fetchKraken } from "./adapters/kraken";
import { fetchJupiter } from "./adapters/jupiter";
import { fetchDrift } from "./adapters/drift";
import { fetchDriftOnchain, driftOnchainConfigured } from "./adapters/driftOnchain";
import { fetchGmx } from "./adapters/gmx";
import { fetchSynthetix } from "./adapters/synthetix";
import { fetchCoinbaseIntl } from "./adapters/coinbaseIntl";
import { fetchDeribit } from "./adapters/deribit";
import { fetchMexc } from "./adapters/mexc";
import { fetchKucoin } from "./adapters/kucoin";
import { fetchAster } from "./adapters/aster";
import { fetchHtx } from "./adapters/htx";
import { fetchParadex } from "./adapters/paradex";
import { fetchOrderly } from "./adapters/orderly";
import { fetchPhemex } from "./adapters/phemex";
import { fetchBackpack } from "./adapters/backpack";
import { fetchBitmex } from "./adapters/bitmex";
import { fetchAevo } from "./adapters/aevo";
import { ADAPTER_TIMEOUT_MS, withDeadline } from "../net/timeout";
import {
  ADAPTER_CONCURRENCY,
  ASSET_CONCURRENCY,
  mapWithConcurrency,
} from "../net/concurrency";
import { swr } from "../cache/swr";
import { computeBasisPct } from "../providers/dexscreener";
import { resolveSpotWithConfidence } from "../providers/spotPrice";
import { fetchJlpExposure } from "../providers/jlpExposure";
import { fetchGmxExposure } from "../providers/gmxExposure";
import { synthetixExposure } from "./adapters/synthetix";
import { PoolExposureSummary, LiquidationSummary, OrderFlowSummary, SpotCvdSummary, ExchangeFlowSummary, DeribitOptionsSummary } from "@/types/market";
import { LiveAdapter } from "./adapters/types";
import { fundingPer8h } from "../utils/format";
import { MarketDataProvider } from "../providers/types";
import { defillamaProvider } from "../providers/defillama";
import { coinalyzeProvider, fetchCoinalyzeLiquidations } from "../providers/coinalyze";
import { coingeckoProvider } from "../providers/coingecko";
import { fetchOkxBookDepth, fetchOkxTakerVolume, RawBookDepth } from "../providers/okxOrderFlow";
import { fetchOkxSpotTakerVolume } from "../providers/okxSpotFlow";
import { summarizeLiquidations } from "../sentiment/liquidations";
import { summarizeOrderFlow } from "../sentiment/orderFlow";
import { summarizeSpotCvd } from "../sentiment/spotCvd";
import { fetchBtcExchangeBalance } from "../providers/exchangeFlows/btc";
import { fetchEthExchangeBalance, etherscanConfigured } from "../providers/exchangeFlows/eth";
import { trackedVenues, BTC_ADDRESSES, ETH_ADDRESSES } from "../providers/exchangeFlows/addresses";
import { classifyExchangeFlow } from "../sentiment/exchangeFlow";
import { recordFlowBalance, balanceWindowAgo } from "../history/flowStore";
import { fetchDeribitOptions } from "../providers/deribitOptions";
import { fetchStablecoinSummary } from "../providers/stablecoins";
import { fetchFearGreed } from "../providers/fearGreed";
import { fetchSectorBreadth } from "../providers/sectorBreadth";
import { fetchMacroLiquidity } from "../providers/macroLiquidity";
import { fetchHyperliquidConfirmation } from "../providers/hyperliquidConfirm";
import { summarizeDeribitOptions } from "../sentiment/deribitOptions";

/**
 * Aggregators that redistribute data for many exchanges at once. Used to
 * reach venues that block direct API access from some regions.
 * Order matters: earlier providers win ties.
 */
const PROVIDERS: MarketDataProvider[] = [
  coinalyzeProvider, // richest (long/short + OI history), needs a free key
  coingeckoProvider, // broad venue coverage, no key
  defillamaProvider, // DEX-leaning, no key
];
import { computeLeverageHeat, computeOiPercentile } from "../sentiment/compositeIndex";
import { buildMarketThesis } from "../sentiment/marketThesis";
import {
  computeCexDexSplit,
  computeFundingDivergence,
  computeFundingPercentile,
  computeSqueezeRisk,
} from "../sentiment/positioning";
import { recordVenueHistory, enrichWithVenueHistory } from "../history/venueStore";
import {
  HistoryPoint,
  historySpanHours,
  oiChangeFromHistory,
  oiPercentileFromHistory,
  readHistory,
  recordHistory,
} from "../history/store";
import { recordDailyPoint } from "../history/dailyStore";
import { fetchOkxDailyCandles, fetchOkx4hCandles } from "../providers/okxCandles";
import { evaluateMarketStructure } from "../signals/marketStructureEvidence";
import { buildTechnicalRead, technicalAgreement } from "../sentiment/technicals";
import {
  buildVolumeProfile,
  buildSupportResistanceZones,
  mergeTimeframeZones,
  SupportResistanceZone,
} from "../technicals/marketStructure";
import {
  detectWalls,
  classifyWallVsZones,
  bookPriceRangeOf,
  LiquidityWall,
} from "../technicals/liquidityWalls";
import { recordAndGetPriorSnapshots, classifyPersistence } from "../store/bookSnapshotStore";
import { classifyRegime, regimeTagsToStrings } from "../technicals/regimes";
import { fetchEtfFlows } from "../providers/etfFlows";
import { fetchSpotVolumeUsd } from "../providers/spotVolume";
import { evaluateAll } from "../signals/evaluators";
import { buildMarketBias, snapshotVerdicts } from "../signals/marketBias";
import { gradeForComposite } from "../signals/evidenceGrade";
import { weightForBasis } from "../signals/scoring";
import { moduleGrades as moduleGradesSnapshot } from "@/data/backtestMetricStats.json";
import { readBiasSnapshot, writeBiasSnapshot } from "../history/biasStore";
import { recordBiasHistory, BiasHistoryEntry } from "../history/biasHistory";
import { readSwingThesis, writeSwingThesis } from "../history/swingThesisStore";
import type { MarketBias, Verdict, MetricVerdict } from "../signals/types";
import type { SwingThesisSnapshot } from "@/types/market";
import { applyDailyClose, applyTick, swingReasons } from "../signals/swingThesis";
import { CONTINUOUS_SESSION } from "../research/types";
import { buildHarmonicEvidence, selectBestHarmonic, HarmonicEvidence } from "../signals/harmonicEvidence";
import { buildPlannedSetups } from "../signals/plannedSetup";
import { planConstraintsFor, PlannerStatsSnapshot } from "../signals/planConstraints";
import { lookupTradeStatsBySide, ExecutionStatsSnapshot } from "../sentiment/backtestStats";
import executionStatsJson from "@/data/executionStats.json";
import type { TechnicalRead, EtfFlowSummary, SpotPerpVolume, LiquidityMapRead, LiquidityWallRead, LiquidityWallWithPersistence } from "@/types/market";

const ADAPTER_MAP: Record<string, LiveAdapter> = {
  binance: fetchBinance,
  bybit: fetchBybit,
  okx: fetchOkx,
  bitget: fetchBitget,
  gateio: fetchGateio,
  kraken: fetchKraken,
  hyperliquid: fetchHyperliquid,
  dydx: fetchDydx,
  jupiter: fetchJupiter,
  // Prefer on-chain when an RPC is configured: Drift's HTTP API is
  // geofenced (403) in some regions, while Solana chain state is not.
  drift: driftOnchainConfigured() ? fetchDriftOnchain : fetchDrift,
  gmx: fetchGmx,
  synthetix: fetchSynthetix,
  // Public market data, no key. One request covers every asset, so this is
  // one of the cheapest venues here to poll.
  "coinbase-intl": fetchCoinbaseIntl,
  deribit: fetchDeribit,
  mexc: fetchMexc,
  kucoin: fetchKucoin,
  aster: fetchAster,
  htx: fetchHtx,
  paradex: fetchParadex,
  orderly: fetchOrderly,
  phemex: fetchPhemex,
  backpack: fetchBackpack,
  bitmex: fetchBitmex,
  aevo: fetchAevo,
};

interface FetchResult {
  snapshots: ExchangeSnapshot[];
  unavailable: string[];
}

/**
 * Fill gaps in a first-hand snapshot from a provider's view of the same venue.
 *
 * WHY FIELD-LEVEL: the merge used to be all-or-nothing per venue, which
 * forced a bad choice for any adapter that publishes some metrics but not
 * others. Jupiter is the clear case — its public endpoint gives borrow rates
 * but no attributable open interest, so venue-level merging either threw
 * away the provider's complete row in favour of a partial direct one, or
 * discarded the first-hand rates entirely.
 *
 * The adapter contract says `0` and `null` mean "this venue doesn't publish
 * it", so those are exactly the gaps a provider may fill. Anything the
 * direct adapter actually reported is kept untouched — including a genuine
 * zero funding rate, which is why fundingRatePct is never overridden here.
 */
function fillGaps(direct: ExchangeSnapshot, provider: ExchangeSnapshot): ExchangeSnapshot {
  const preferDirect = (d: number, p: number) => (d > 0 ? d : p);

  return {
    ...direct,
    openInterestUsd: preferDirect(direct.openInterestUsd, provider.openInterestUsd),
    price: preferDirect(direct.price, provider.price),
    volume24hUsd: preferDirect(direct.volume24hUsd, provider.volume24hUsd),
    // A price change is only meaningful alongside a price. If the direct
    // adapter had no price, its 0% change is a placeholder, not an observation.
    priceChange24hPct:
      direct.price > 0 ? direct.priceChange24hPct : provider.priceChange24hPct,
    openInterestChange24hPct:
      direct.openInterestChange24hPct ?? provider.openInterestChange24hPct,
    longShortRatio: direct.longShortRatio ?? provider.longShortRatio,
    fundingHistory:
      direct.fundingHistory.length > 0 ? direct.fundingHistory : provider.fundingHistory,
    sparkline: direct.sparkline.length > 0 ? direct.sparkline : provider.sparkline,
  };
}

/**
 * Fetch every venue that lists this asset. A venue that errors, times out,
 * or doesn't list the market is simply excluded — never replaced with an
 * estimate. `unavailable` is surfaced to the UI so the omission is visible
 * rather than silent.
 */
async function snapshotsForAsset(asset: AssetSymbol): Promise<FetchResult> {
  const venues = exchangesForAsset(asset);

  // Direct adapters and aggregator providers run concurrently — a blocked
  // exchange shouldn't delay the providers that can cover for it.
  const [directResults, providerResults] = await Promise.all([
    // Bounded, not all-at-once. Firing 23 adapters simultaneously made cold
    // starts collapse — a third of the venues blew their deadline racing each
    // other through DNS and TLS. See net/concurrency.ts.
    mapWithConcurrency(venues, ADAPTER_CONCURRENCY, async (v) => {
      const adapter = ADAPTER_MAP[v.id];
      if (!adapter) return { id: v.id, snap: null };
      // Each of these is a third-party API and several geo-block by hanging
      // rather than refusing, so a per-adapter deadline is still needed —
      // concurrency limiting reduces contention, it doesn't bound a stall.
      const snap = await withDeadline(
        adapter(asset).catch(() => null),
        ADAPTER_TIMEOUT_MS,
        `${v.id}:${asset}`,
        null
      );
      return { id: v.id, snap };
    }),
    Promise.all(
      PROVIDERS.filter((p) => p.isConfigured()).map((p) =>
        withDeadline(
          p.fetch(asset).catch(() => [] as ExchangeSnapshot[]),
          ADAPTER_TIMEOUT_MS,
          `provider:${p.id}:${asset}`,
          [] as ExchangeSnapshot[]
        )
      )
    ),
  ]);

  // Index providers first so direct snapshots can borrow from them. Earlier
  // providers win ties, matching the PROVIDERS ordering above.
  const registered = new Set(EXCHANGES.map((e) => e.id));
  const byProvider = new Map<string, ExchangeSnapshot>();
  providerResults.flat().forEach((snap) => {
    if (!registered.has(snap.exchangeId)) return;
    if (byProvider.has(snap.exchangeId)) return;
    byProvider.set(snap.exchangeId, snap);
  });

  const merged = new Map<string, ExchangeSnapshot>();

  // First-hand data wins field by field: it's lower latency and not subject
  // to an aggregator's own refresh cadence or venue-name mapping.
  directResults.forEach((r) => {
    if (!r.snap) return;
    const direct = { ...r.snap, source: "direct" as const };
    const fallback = byProvider.get(r.id);
    merged.set(r.id, fallback ? fillGaps(direct, fallback) : direct);
  });

  // Venues we couldn't reach directly at all arrive whole from a provider.
  // Only accept ones we have registry metadata for, otherwise the snapshot
  // would have no name, colour, or card to render into.
  byProvider.forEach((snap, id) => {
    if (merged.has(id)) return;
    // A provider-only snapshot with no open interest can't be weighted and
    // would drag the aggregates toward zero — skip rather than admit it.
    if (!snap.openInterestUsd) return;
    merged.set(id, snap);
  });

  const snapshots = [...merged.values()];
  const covered = new Set(snapshots.map((s) => s.exchangeId));

  return {
    snapshots,
    // Provider-only venues aren't "unavailable" when absent — they were never
    // directly reachable to begin with. Reporting them would produce a
    // permanent wall of noise.
    unavailable: venues
      .filter((v) => !v.providerOnly && !covered.has(v.id))
      .map((v) => v.id),
  };
}

/**
 * Cache windows for the full aggregation.
 *
 * `freshMs` sits just under the 15s client poll so a request rarely does the
 * whole fan-out inline. Beyond it the cached value is still served
 * immediately while a refresh runs behind it, which is what makes polling
 * feel instant rather than costing a full round of exchange calls.
 *
 * `maxAgeMs` is the point where stale stops being acceptable and a caller
 * waits for real data.
 */
const AGGREGATE_CACHE = {
  freshMs: 8_000,
  maxAgeMs: 5 * 60_000,
  /**
   * Don't publish an obviously degraded result to the shared cache.
   *
   * A cold serverless instance can come back with far fewer venues than
   * normal — connections are still warming, and whatever misses its deadline
   * is excluded. That's fine as a one-off response, but writing it to Redis
   * would hand the short answer to every other instance too.
   *
   * Two thirds is deliberately loose. Venue counts move around legitimately
   * (an exchange rate-limits, a provider is briefly down) and this is meant
   * to catch a cold-start collapse, not to police normal variation. It also
   * never blocks the FIRST result, since there's nothing better to keep.
   */
  shouldShare: (next: AggregateMarketData, previous: AggregateMarketData | null) => {
    // Never publish an empty aggregate, baseline or not. This was the hole:
    // after a gap in traffic the Redis entry expires, so `previous` is null
    // and the first result became the shared baseline unconditionally — a
    // degraded or empty one included, which every instance then served.
    if (next.exchanges.length === 0) return false;
    if (!previous || previous.exchanges.length === 0) return true;
    return next.exchanges.length >= previous.exchanges.length * (2 / 3);
  },
};

/**
 * Beyond this, the perp and the spot reference are not the same asset.
 *
 * Generous on purpose — real basis is well under 1% on major venues, and even
 * a violently dislocated market stays inside single digits. This threshold is
 * only meant to catch a ticker collision, not to police market conditions.
 */
const MAX_PLAUSIBLE_BASIS_PCT = 25;

export async function getAggregateForAsset(asset: AssetSymbol): Promise<AggregateMarketData> {
  return swr(`aggregate:${asset}`, () => buildAggregateForAsset(asset), AGGREGATE_CACHE);
}

async function buildAggregateForAsset(asset: AssetSymbol): Promise<AggregateMarketData> {
  // The spot lookup hits three independent price sources and depends on
  // nothing in the venue fan-out — only the *basis* calculation at the end
  // needs both. Starting it here rather than awaiting it after the fan-out
  // overlaps the two, instead of adding spot's full latency to every load.
  const spot = resolveSpotWithConfidence(asset).catch((err) => {
    console.warn(`[spot] resolution failed for ${asset}:`, err);
    return { price: null, disagreementPct: null, sourceCount: 0, coinbasePremiumPct: null };
  });

  const { snapshots, unavailable } = await snapshotsForAsset(asset);
  const enriched = await withVenueHistory(asset, snapshots);
  const base = buildAggregate(asset, enriched, unavailable);
  return withRecordedHistory(asset, base, spot);
}

/**
 * Record each venue's current funding/OI, then backfill any snapshot whose
 * upstream didn't supply history. Most sources (CoinGecko in particular)
 * publish only a current reading, which would otherwise leave every card
 * without a sparkline and without a 24h OI change indefinitely.
 */
async function withVenueHistory(
  asset: AssetSymbol | "MARKET",
  snapshots: ExchangeSnapshot[]
): Promise<ExchangeSnapshot[]> {
  if (snapshots.length === 0) return snapshots;
  try {
    const history = await recordVenueHistory(asset, snapshots);
    return snapshots.map((s) => enrichWithVenueHistory(s, history));
  } catch (err) {
    console.warn("[venue-history] enrichment skipped:", err);
    return snapshots;
  }
}

export async function getAggregateForMarket(): Promise<AggregateMarketData> {
  return swr("aggregate:MARKET", buildAggregateForMarket, AGGREGATE_CACHE);
}

async function buildAggregateForMarket(): Promise<AggregateMarketData> {
  // Capped as well: ten assets x the per-asset adapter cap would be 80+
  // concurrent requests, which is the burst the cap above exists to avoid.
  const results = await mapWithConcurrency(ALL_ASSETS, ASSET_CONCURRENCY, (a) =>
    snapshotsForAsset(a)
  );
  const snapshots = results.flatMap((r) => r.snapshots);
  // A venue counts as unavailable market-wide only if it returned nothing
  // for every single asset.
  const covered = new Set(snapshots.map((s) => s.exchangeId));
  const unavailable = EXCHANGES.map((e) => e.id).filter((id) => !covered.has(id));
  const enriched = await withVenueHistory("MARKET", snapshots);
  const base = buildAggregate("MARKET", enriched, unavailable);
  return withRecordedHistory("MARKET", base);
}

/**
 * Record this snapshot to the local time series, then fill in any metric the
 * exchanges themselves couldn't supply.
 *
 * Exchange-provided history always wins when present — it's deeper and
 * predates this app's first run. The local store is the fallback that makes
 * these gauges work even when every history-publishing venue is unreachable
 * or geo-blocked.
 */
type SpotResolution = Awaited<ReturnType<typeof resolveSpotWithConfidence>>;

async function withRecordedHistory(
  asset: AssetSymbol | "MARKET",
  agg: AggregateMarketData,
  /** Started before the fan-out by the caller; awaited here. */
  spot?: Promise<SpotResolution>
): Promise<AggregateMarketData> {
  if (agg.exchanges.length === 0) return agg;

  /*
   * Derived scores are computed BEFORE the point is appended, against the
   * PRIOR series, then stored on the point itself.
   *
   * Two reasons the order matters:
   *
   *   - The gauges plot these scores, so their trail is only available if
   *     they're recorded. A percentile rank and a weighted composite can't be
   *     recomputed after the fact from the raw fields, because each depends on
   *     the trailing window and venue set as they were at that moment.
   *
   *   - Ranking today's open interest against a window that already contains
   *     today is subtly self-referential. Comparing against prior observations
   *     only is what a percentile is supposed to mean.
   */
  const prior = await readHistory(asset);

  const derivedOiChange24hPct =
    agg.oiChange24hPct ?? oiChangeFromHistory(prior, agg.totalOpenInterestUsd);
  const derivedOiPercentile =
    agg.oiPercentile ?? oiPercentileFromHistory(prior, agg.totalOpenInterestUsd);
  const derivedLeverageHeat =
    agg.leverageHeatScore ??
    computeLeverageHeat({
      weightedFundingRatePct: agg.weightedFundingRatePct,
      oiChange24hPct: derivedOiChange24hPct,
      priceChange24hPct: agg.priceChange24hPct,
    });

  const point: HistoryPoint = {
    t: agg.updatedAt,
    totalOpenInterestUsd: agg.totalOpenInterestUsd,
    weightedFundingRatePct: agg.weightedFundingRatePct,
    price: agg.exchanges[0]?.price ?? 0,
    longShortRatio: agg.longShortRatio,
    venueCount: agg.exchanges.length,
    oiPercentile: derivedOiPercentile,
    leverageHeatScore: derivedLeverageHeat,
  };

  const history = await recordHistory(asset, point);

  // Long-retention sibling of the write above — one point per UTC day, kept
  // for years, so scripts/backtest/'s replay window can eventually grow
  // past what OKX's 180-day-capped OI/long-short history alone allows. Same
  // already-computed fields, no new fetch; never allowed to break the
  // response if it fails.
  recordDailyPoint(asset, {
    t: point.t,
    totalOpenInterestUsd: point.totalOpenInterestUsd,
    weightedFundingRatePct: point.weightedFundingRatePct,
    longShortRatio: point.longShortRatio,
    price: point.price,
  }).catch((err) => console.warn(`[dailyHistory] record failed for ${asset}:`, err));

  // Spot reference from DexScreener, used only for basis. Whole-market view
  // has no single spot price, so it's skipped there.
  let spotPriceUsd: number | null = null;
  let spotSource: string | null = null;
  let basisPct: number | null = null;
  let spotDisagreementPct: number | null = null;
  let spotSourceCount = 0;
  let coinbasePremiumPct: number | null = null;
  if (asset !== "MARKET" && spot) {
    const { price: resolved, disagreementPct, sourceCount, coinbasePremiumPct: premium } = await spot;
    spotSourceCount = sourceCount;
    spotDisagreementPct = disagreementPct;
    coinbasePremiumPct = premium;
    if (resolved) {
      // OI-weighted perp price across venues that report one.
      const priced = agg.exchanges.filter((e) => e.price > 0);
      const totalW = priced.reduce((sum, e) => sum + e.openInterestUsd, 0);
      const perpPrice =
        totalW > 0
          ? priced.reduce((sum, e) => sum + e.price * e.openInterestUsd, 0) / totalW
          : 0;

      const candidate = computeBasisPct(perpPrice, resolved);

      // Plausibility check on the spot reference.
      //
      // DexScreener — the last fallback — matches on ticker text, and Solana
      // is full of worthless tokens calling themselves "BTC". When Alchemy
      // (403 on the shared demo key) and Jupiter both fail, that fallback
      // happily returned a $1 meme pool as the spot price for a $64,000 perp
      // and produced a basis of 6,120,642%.
      //
      // Perp and spot on the same asset track within a few percent —
      // arbitrage guarantees it, and a genuinely dislocated market is a few
      // percent, not five orders of magnitude. A gap this large means the two
      // sources are quoting different assets, so the reference is discarded
      // rather than displayed. Showing "—" is correct here: we do not have a
      // spot price we can stand behind.
      if (candidate !== null && Math.abs(candidate) > MAX_PLAUSIBLE_BASIS_PCT) {
        console.warn(
          `[spot] rejecting ${resolved.source} for ${asset}: $${resolved.priceUsd} against a ` +
            `$${perpPrice.toFixed(2)} perp mark implies ${candidate.toFixed(0)}% basis. ` +
            `Almost certainly a different asset with the same ticker.`
        );
      } else {
        spotPriceUsd = resolved.priceUsd;
        spotSource = resolved.source;
        basisPct = candidate;
      }
    }
  }

  // Already computed above, against the prior series, and recorded on the point.
  const oiChange24hPct = derivedOiChange24hPct;
  const oiPercentile = derivedOiPercentile;
  const leverageHeatScore = derivedLeverageHeat;

  /*
   * Started here, once, rather than inside buildOrderFlowSummary and
   * buildLiquidityMap separately — both need OKX's book depth (the latter
   * for Phase 5's wall detection), and unlike fetchOkxDailyCandles this
   * endpoint has no swr wrapper, so calling it from two places would be a
   * genuine second live request per poll, not a cache hit. Both consumers
   * below await this SAME promise; JS starts the fetch immediately on
   * creation, so sharing it costs nothing versus the old single-caller
   * shape and halves this feature's OKX request volume.
   */
  const bookDepthPromise = asset === "MARKET" ? Promise.resolve(null) : fetchOkxBookDepth(asset).catch(() => null);

  // Independent network calls, run concurrently rather than sequentially —
  // none depends on another's result.
  const [
    poolExposure,
    liquidations,
    orderFlow,
    spotCvd,
    exchangeFlow,
    deribitOptions,
    technicals,
    technicals4h,
    liquidityMap,
    regimeTags,
    etfFlows,
    spotPerpVolume,
    stablecoins,
    fearGreed,
    sectorBreadth,
    macroLiquidity,
    hyperliquidConfirm,
  ] = await Promise.all([
    buildPoolExposure(asset, agg.exchanges),
    buildLiquidationSummary(asset),
    buildOrderFlowSummary(asset, bookDepthPromise),
    buildSpotCvdSummary(asset),
    buildExchangeFlow(asset, point.price, point.t),
    buildDeribitOptions(asset, point.t),
    buildTechnicals(asset),
    buildTechnicals4h(asset),
    buildLiquidityMap(asset, bookDepthPromise),
    buildMarketRegimeTags(asset),
    buildEtfFlows(asset),
    buildSpotPerpVolume(asset, agg.exchanges),
    /*
     * Fetched here rather than threaded in from the route, even though the
     * route also fetches them for its own response. Both providers are
     * already swr-cached, so the second call costs nothing — and passing
     * them in as arguments would bake whatever happened to be present at
     * cache-fill time into this asset's cached aggregate.
     */
    fetchStablecoinSummary().catch(() => null),
    fetchFearGreed().catch(() => null),
    fetchSectorBreadth().catch(() => null),
    fetchMacroLiquidity().catch(() => null),
    asset === "MARKET"
      ? Promise.resolve({ funding: null, orderBook: null })
      : fetchHyperliquidConfirmation(asset).catch(() => ({ funding: null, orderBook: null })),
  ]);
  // BTC's fetcher is keyless; ETH's needs ETHERSCAN_API_KEY. Computed
  // separately from the fetch itself so the UI can tell "no key" apart
  // from "key present, still building history" instead of guessing.
  const exchangeFlowConfigured =
    asset === "BTC" ? true : asset === "ETH" ? etherscanConfigured() : false;

  /*
   * Ranked against `prior` — the series as it stood BEFORE this point was
   * appended — for the same reason the OI percentile is: including the current
   * observation in the window it's being ranked against is self-referential,
   * and biases every reading toward the middle.
   *
   * agg.weightedFundingRatePct is already per-8h normalized by buildAggregate,
   * and the history stores that same normalized figure, so the two are directly
   * comparable.
   */
  const fundingPercentile = computeFundingPercentile(agg.weightedFundingRatePct, prior);

  /*
   * Computed last because it consumes the other derived figures. Deliberately a
   * score and not a probability — see the note on SqueezeRisk in types/market.ts.
   */
  const squeezeRisk = computeSqueezeRisk({
    weightedFundingRatePct: agg.weightedFundingRatePct,
    fundingPercentile,
    oiPercentile,
    oiChange24hPct,
    longShortRatio: agg.longShortRatio,
    priceChange24hPct: agg.priceChange24hPct,
  });

  /*
   * Computed last of all — reads every other derived field above, the way
   * an analyst reads the whole board rather than one gauge at a time. See
   * sentiment/marketThesis.ts and MarketThesis's own doc comment for what
   * this deliberately is and is not (not a probability, no backtest).
   */
  const marketThesis = buildMarketThesis(
    {
      asset,
      weightedFundingRatePct: agg.weightedFundingRatePct,
      longShortRatio: agg.longShortRatio,
      basisPct,
      coinbasePremiumPct,
      orderFlow,
      squeezeRisk,
      deribitOptions,
      exchangeFlow,
      liquidations,
      priceChange24hPct: agg.priceChange24hPct,
      leverageHeatScore,
      technicals,
      regimeTags,
    },
    agg.updatedAt
  );

  /*
   * The decision engine's roll-up. Runs last of everything, because it reads
   * the finished verdicts of every metric above.
   *
   * `stablecoins` is fetched by the route rather than here, so the
   * stablecoin evaluator simply won't fire in this path — evaluateAll drops
   * absent metrics and renormalizes, which is the same rule every other
   * aggregate in this file follows.
   */
  const priorBias = await readBiasSnapshot(asset);
  const metricVerdicts = evaluateAll(
    {
      ...agg,
      oiChange24hPct,
      oiPercentile,
      fundingPercentile,
      leverageHeatScore,
      basisPct,
      coinbasePremiumPct,
      spotSourceCount,
      spotDisagreementPct,
      squeezeRisk,
      liquidations,
      orderFlow,
      spotCvd,
      exchangeFlow,
      deribitOptions,
      technicals,
      etfFlows,
      spotPerpVolume,
      marketThesis,
      updatedAt: agg.updatedAt,
    } as AggregateMarketData,
    {
      technicals,
      stablecoins,
      fearGreed,
      sectorBreadth,
      macroLiquidity,
      hyperliquidConfirm,
      priceChange24hPct: agg.priceChange24hPct,
      now: agg.updatedAt,
    }
  );

  /*
   * MARKET STRUCTURE — appended as a first-class metric rather than left as
   * a vote inside `technicals`. fetchOkxDailyCandles is swr-cached and
   * buildTechnicals already pulled this series this poll, so this is a cache
   * hit, not a second network call.
   *
   * Must stay in lockstep with the identical block in scripts/backtest/run.ts
   * — if the replay and production disagree about which metrics exist, every
   * published statistic describes a different engine than the live one.
   */
  if (asset !== "MARKET") {
    const structureBars = await fetchOkxDailyCandles(asset).catch(() => []);
    const structure = evaluateMarketStructure(
      { symbol: asset, bars: structureBars as never },
      Date.now()
    );
    if (structure) metricVerdicts.push(structure);
  }

  const marketBias = buildMarketBias({
    asset,
    metrics: metricVerdicts,
    technicals,
    squeezeScore: squeezeRisk?.score ?? null,
    previous: priorBias?.verdicts ?? null,
    now: agg.updatedAt,
    regimeTags,
  });

  /*
   * THE EDGE-BASIS COMPOSITE IS THE ONE WHERE THIS BITES.
   *
   * No `basis` is passed above, so this is the "edge" composite — the one
   * where funding (weight 0.15, measured BELOW its own null) and squeezeRisk
   * (0.14, a measured coin flip) actually vote. Measured 2026-08-15, 11% of
   * the weight behind this score comes from a module that earned it.
   *
   * Attached here rather than inside buildMarketBias because that module is
   * reachable from client components and the grades artifact is ~39KB with
   * no business in a browser bundle. Same helper the dossier uses, so the two
   * surfaces cannot drift into different answers about the same composite.
   */
  if (marketBias) {
    marketBias.evidenceGrade = gradeForComposite(
      marketBias,
      weightForBasis(marketBias.basis),
      moduleGradesSnapshot as Parameters<typeof gradeForComposite>[2]
    );
  }

  /*
   * Awaited rather than fire-and-forget: this IS the action rendered on the
   * page, so a response that raced ahead of the state advance would show a
   * stale thesis. The common poll does a read, one tick, and no write.
   */
  const swingThesis = await buildSwingThesis(
    asset,
    marketBias,
    technicals,
    technicals4h,
    liquidityMap?.supportResistance ?? [],
    point.price,
    agg.updatedAt
  ).catch(() => null);

  const harmonic = await buildHarmonics(
    asset,
    marketBias,
    technicals,
    technicals4h,
    liquidityMap?.supportResistance ?? [],
    metricVerdicts,
    point.price
  ).catch(() => null);

  let biasTimeline: BiasHistoryEntry[] = [];

  if (marketBias) {
    // Fire-and-forget: a failed snapshot costs one "what changed" diff, never
    // the response.
    writeBiasSnapshot(
      asset,
      { verdicts: snapshotVerdicts(metricVerdicts), score: marketBias.score, t: agg.updatedAt },
      priorBias
    ).catch(() => {});

    /*
     * Awaited, unlike the snapshot above, because the resulting series is
     * rendered in this same response. It only writes when the read has
     * actually moved (see biasHistory.shouldRecord), so the common case is a
     * read and an early return.
     */
    biasTimeline = await recordBiasHistory(asset, {
      t: agg.updatedAt,
      score: marketBias.score,
      verdict: marketBias.verdict,
      regime: marketThesis?.regime ?? null,
      // The metrics actually driving the read at this moment, so a row on
      // the timeline says WHY it moved, not just that it did.
      reasons: (marketBias.verdict === "bearish" ? marketBias.topBearish : marketBias.topBullish)
        .slice(0, 3)
        .map((m) => m.label),
      topRisk: marketBias.counterRisk?.label ?? null,
    }).catch(() => []);
  }

  return {
    ...agg,
    poolExposure,
    liquidations,
    orderFlow,
    spotCvd,
    exchangeFlow,
    exchangeFlowConfigured,
    deribitOptions,
    technicals,
    technicals4h,
    harmonic,
    liquidityMap,
    etfFlows,
    spotPerpVolume,
    marketBias,
    swingThesis,
    biasTimeline,
    marketThesis,
    oiChange24hPct,
    oiPercentile,
    leverageHeatScore,
    fundingPercentile,
    squeezeRisk,
    spotPriceUsd,
    spotSource,
    basisPct,
    spotDisagreementPct,
    spotSourceCount,
    coinbasePremiumPct,
    history,
    historyHours: historySpanHours(history),
  };
}

/** Weighted mean over entries that actually have a value. Null if none do. */
function weightedAverage(
  items: Array<{ value: number | null; weight: number }>
): number | null {
  const valid = items.filter(
    (i) => i.value !== null && Number.isFinite(i.value) && i.weight > 0
  );
  if (valid.length === 0) return null;
  const totalWeight = valid.reduce((s, i) => s + i.weight, 0);
  if (totalWeight === 0) return null;
  return valid.reduce((s, i) => s + (i.value as number) * i.weight, 0) / totalWeight;
}

/**
 * Cross-venue plausibility check.
 *
 * Funding rates on the same asset stay close across major venues —
 * arbitrageurs close meaningful gaps within hours. So a venue reading many
 * times the median is far more likely a unit-conversion bug in its adapter
 * than a real market condition.
 *
 * This exists because exactly that happened: Coinalyze returns funding
 * already as a percentage while most exchange APIs return a decimal
 * fraction, and a stray x100 made every Coinalyze venue read 27 bps against
 * a true 0.27 bps. It looked plausible enough to survive several releases
 * and would have shown "Crowded Longs" on a neutral market.
 *
 * Logs only — never mutates data. A genuine outlier is real information.
 */
function warnOnFundingOutliers(exchanges: ExchangeSnapshot[]): void {
  if (exchanges.length < 3) return;

  const normalized = exchanges.map((e) => ({
    id: e.exchangeId,
    source: e.source ?? "direct",
    per8h: fundingPer8h(e.fundingRatePct, e.fundingIntervalHours),
  }));

  const magnitudes = normalized.map((n) => Math.abs(n.per8h)).sort((a, b) => a - b);
  const median = magnitudes[Math.floor(magnitudes.length / 2)];
  if (median <= 0) return;

  for (const n of normalized) {
    const ratio = Math.abs(n.per8h) / median;
    // 20x the median, and large enough in absolute terms to matter.
    if (ratio >= 20 && Math.abs(n.per8h) > 0.05) {
      console.warn(
        `[sanity] ${n.id} (via ${n.source}) funding ${(n.per8h * 100).toFixed(1)}bps is ` +
          `${ratio.toFixed(0)}x the cross-venue median of ${(median * 100).toFixed(1)}bps. ` +
          `Suspect a unit-conversion bug in that adapter (decimal fraction vs percentage).`
      );
    }
  }
}

function buildAggregate(
  asset: AssetSymbol | "MARKET",
  exchanges: ExchangeSnapshot[],
  unavailableExchanges: string[]
): AggregateMarketData {
  const now = Date.now();

  if (exchanges.length === 0) {
    return {
      asset,
      weightedFundingRatePct: 0,
      fundingAnnualizedPct: 0,
      fundingChange24hPct: null,
      totalOpenInterestUsd: 0,
      oiChange24hPct: null,
      oiPercentile: null,
      longShortRatio: null,
      leverageHeatScore: null,
      priceChange24hPct: 0,
      exchanges: [],
      unavailableExchanges,
      // Nothing reported, so there is nothing to derive positioning from.
      fundingPercentile: null,
      fundingDivergence: null,
      cexDex: null,
      squeezeRisk: null,
      liquidations: null,
      orderFlow: null,
      spotCvd: null,
      exchangeFlow: null,
      exchangeFlowConfigured: false,
      deribitOptions: null,
      technicals: null,
      technicals4h: null,
      harmonic: null,
      liquidityMap: null,
      etfFlows: null,
      spotPerpVolume: null,
      marketBias: null,
      swingThesis: null,
      biasTimeline: [],
      marketThesis: null,
      spotPriceUsd: null,
      spotSource: null,
      basisPct: null,
      spotDisagreementPct: null,
      spotSourceCount: 0,
      coinbasePremiumPct: null,
      poolExposure: null,
      history: [],
      historyHours: 0,
      updatedAt: now,
    };
  }

  // Normalize to an 8h equivalent before averaging — an hourly venue's raw
  // rate is 1/8th the size of an 8h venue's for identical economics.
  warnOnFundingOutliers(exchanges);

  const weightedFundingRatePct =
    weightedAverage(
      exchanges.map((e) => ({
        value: fundingPer8h(e.fundingRatePct, e.fundingIntervalHours),
        weight: e.openInterestUsd,
      }))
    ) ?? 0;

  // Normalize each venue to a per-year rate using its own funding interval,
  // so 1h-funding venues and 8h-funding venues are actually comparable.
  const fundingAnnualizedPct =
    weightedAverage(
      exchanges.map((e) => ({
        value: e.fundingRatePct * (24 / e.fundingIntervalHours) * 365,
        weight: e.openInterestUsd,
      }))
    ) ?? 0;

  const fundingChange24hPct = weightedAverage(
    exchanges.map((e) => {
      const fundingSeries = e.fundingHistory.filter((p) => p.fundingRatePct !== undefined);
      if (fundingSeries.length < 2) return { value: null, weight: e.openInterestUsd };
      const dayAgo = fundingSeries.find((p) => p.t >= now - 24 * 3_600_000);
      if (!dayAgo || dayAgo.fundingRatePct === undefined) {
        return { value: null, weight: e.openInterestUsd };
      }
      return {
        value: fundingPer8h(e.fundingRatePct - dayAgo.fundingRatePct, e.fundingIntervalHours),
        weight: e.openInterestUsd,
      };
    })
  );

  const totalOpenInterestUsd = exchanges.reduce((s, e) => s + e.openInterestUsd, 0);

  const oiChange24hPct = weightedAverage(
    exchanges.map((e) => ({ value: e.openInterestChange24hPct, weight: e.openInterestUsd }))
  );

  const longShortRatio = weightedAverage(
    exchanges.map((e) => ({ value: e.longShortRatio, weight: e.openInterestUsd }))
  );

  // Some providers don't return price at all (price === 0). Excluding them
  // keeps a missing price from being averaged in as a 0% change.
  const priceChange24hPct =
    weightedAverage(
      exchanges.map((e) => ({
        value: e.price > 0 ? e.priceChange24hPct : null,
        weight: e.openInterestUsd,
      }))
    ) ?? 0;

  const oiPercentile = computeAggregateOiPercentile(exchanges, totalOpenInterestUsd);

  const leverageHeatScore = computeLeverageHeat({
    weightedFundingRatePct,
    oiChange24hPct,
    priceChange24hPct,
  });

  /*
   * These two need only the current venue set, so they belong here. The
   * funding percentile and squeeze score need the recorded history and are
   * filled in by withRecordedHistory, where that read already happens.
   *
   * Both normalize funding to an 8h equivalent internally — `exchanges` still
   * carries each venue's raw per-interval rate, so passing it anywhere that
   * compares across venues without normalizing would be wrong.
   */
  const fundingDivergence = computeFundingDivergence(exchanges);
  const cexDex = computeCexDexSplit(exchanges);

  return {
    asset,
    weightedFundingRatePct,
    fundingAnnualizedPct,
    fundingChange24hPct,
    totalOpenInterestUsd,
    oiChange24hPct,
    oiPercentile,
    longShortRatio,
    leverageHeatScore,
    priceChange24hPct,
    exchanges,
    unavailableExchanges,
    spotPriceUsd: null,
    spotSource: null,
    basisPct: null,
    spotDisagreementPct: null,
    spotSourceCount: 0,
    coinbasePremiumPct: null,
    // Filled in by withRecordedHistory, which is where the async work lives.
    poolExposure: null,
    fundingDivergence,
    cexDex,
    // Both need the recorded series; see withRecordedHistory.
    fundingPercentile: null,
    squeezeRisk: null,
    // Both need their own async fetch; see withRecordedHistory.
    liquidations: null,
    orderFlow: null,
    spotCvd: null,
    exchangeFlow: null,
    exchangeFlowConfigured: false,
    deribitOptions: null,
    technicals: null,
    technicals4h: null,
    harmonic: null,
    liquidityMap: null,
    etfFlows: null,
    spotPerpVolume: null,
    marketBias: null,
    swingThesis: null,
    biasTimeline: [],
    marketThesis: null,
    history: [],
    historyHours: 0,
    updatedAt: now,
  };
}

/**
 * Percentile of today's total OI against the trailing history.
 *
 * Only venues that publish OI history contribute. Their series are summed
 * into hourly buckets first, then today's equivalent sum (from those same
 * venues) is ranked against it — comparing a full 8-venue total against a
 * 3-venue history would pin the result at 100.
 */

/**
 * Notional positioning across peer-to-pool venues.
 *
 * Only venues where a pool takes the other side can report this — at an order
 * book, long notional always equals short notional, which is why those
 * venues publish an account headcount instead. The two are never mixed; see
 * the note on `poolExposure` in types/market.ts.
 *
 * Sources run concurrently and independently: Jupiter and GMX are keyless,
 * Synthetix needs THE_GRAPH_API_KEY and contributes nothing until it's set.
 *
 * Whole-market mode is skipped deliberately: summing notional skew across
 * ten assets would net SOL longs against BTC shorts and produce a number
 * about nothing.
 */
async function buildPoolExposure(
  asset: AssetSymbol | "MARKET",
  exchanges: ExchangeSnapshot[]
): Promise<PoolExposureSummary | null> {
  if (asset === "MARKET") return null;

  // Jupiter stores its long side in tokens, so it needs a price; the other
  // two publish USD directly.
  const jupiterPrice = exchanges.find((e) => e.exchangeId === "jupiter")?.price ?? 0;

  const [jupiter, gmx, synthetix] = await Promise.all([
    jupiterPrice > 0
      ? fetchJlpExposure(asset, jupiterPrice).catch(() => null)
      : Promise.resolve(null),
    fetchGmxExposure(asset).catch(() => null),
    synthetixExposure(asset).catch(() => null),
  ]);

  const parts: Array<{ id: string; longUsd: number; shortUsd: number }> = [];
  if (jupiter) parts.push({ id: "jupiter", ...jupiter });
  if (gmx) parts.push({ id: "gmx", ...gmx });
  if (synthetix) parts.push({ id: "synthetix", ...synthetix });
  if (parts.length === 0) return null;

  const longUsd = parts.reduce((sum, p) => sum + p.longUsd, 0);
  const shortUsd = parts.reduce((sum, p) => sum + p.shortUsd, 0);
  const total = longUsd + shortUsd;
  if (total <= 0) return null;

  return {
    longUsd,
    shortUsd,
    netSkewPct: ((longUsd - shortUsd) / total) * 100,
    venues: parts.map((p) => p.id),
  };
}

/**
 * Observed liquidation volume, single-asset only — skipped for MARKET mode.
 *
 * Unlike poolExposure's netSkewPct (which cannot be summed across assets: a
 * BTC long-skew and an ETH short-skew would cancel into a meaningless
 * "market skew"), raw liquidation DOLLARS could in principle be summed across
 * assets without that problem. Scoped to single-asset anyway, for now, to
 * avoid fetching this for all 10 assets in whole-market mode — the same
 * failure mode that took the entire provider down once already (see
 * ENDPOINTS_PER_SYMBOL's history in coinalyze.ts). Revisit only alongside a
 * concrete plan for the added budget draw.
 */
async function buildLiquidationSummary(
  asset: AssetSymbol | "MARKET"
): Promise<LiquidationSummary | null> {
  if (asset === "MARKET") return null;
  const venues = await fetchCoinalyzeLiquidations(asset).catch(() => []);
  return summarizeLiquidations(venues);
}

/**
 * Order-book depth and taker flow, single-asset only — OKX has no
 * whole-market instrument to query, so this is skipped for MARKET mode the
 * same way poolExposure and liquidations are.
 *
 * `bookDepth` is the shared promise started once above — this function no
 * longer fetches it itself, since buildLiquidityMap needs the identical
 * data for Phase 5's wall detection and a second live call would waste
 * request budget on data already in flight.
 *
 * No shared rate-budget concern here unlike Coinalyze: OKX's public REST
 * allows 5 requests per 2 seconds (150/min) per its docs, far more than the
 * calls this makes per asset per poll.
 */
async function buildOrderFlowSummary(
  asset: AssetSymbol | "MARKET",
  bookDepth: Promise<RawBookDepth | null>
): Promise<OrderFlowSummary | null> {
  if (asset === "MARKET") return null;
  const [depth, takerVolume] = await Promise.all([bookDepth, fetchOkxTakerVolume(asset).catch(() => [])]);
  return summarizeOrderFlow(depth, takerVolume);
}

/**
 * OKX SPOT taker flow, single-asset only — same MARKET-mode skip as
 * buildOrderFlowSummary above, and same OKX rate-budget headroom (2 more
 * calls per asset per poll, well inside the 150/min public REST limit).
 */
async function buildSpotCvdSummary(asset: AssetSymbol | "MARKET"): Promise<SpotCvdSummary | null> {
  if (asset === "MARKET") return null;
  const takerVolume = await fetchOkxSpotTakerVolume(asset).catch(() => []);
  return summarizeSpotCvd(takerVolume);
}

/** Matches every other "24h" figure in this app (oiChange24hPct, priceChange24hPct, ...). */
const EXCHANGE_FLOW_WINDOW_HOURS = 24;

/**
 * Only BTC and ETH have a verified address set — see
 * providers/exchangeFlows/addresses.ts for why the other 8 assets can't
 * extend this without either a paid data source or address verification
 * this app hasn't done.
 *
 * Records the current balance on every call (throttled to one point per 5
 * minutes inside flowStore, same as the price/OI history), then diffs
 * against the closest snapshot ~24h back. Null on a cold start — there's no
 * prior point yet to diff against — and null whenever the balance fetch
 * itself fails (no key configured, upstream down, etc.).
 */
async function buildExchangeFlow(
  asset: AssetSymbol | "MARKET",
  priceUsd: number,
  now: number
): Promise<ExchangeFlowSummary | null> {
  if (asset !== "BTC" && asset !== "ETH") return null;

  const balance =
    asset === "BTC"
      ? await fetchBtcExchangeBalance().catch(() => null)
      : await fetchEthExchangeBalance().catch(() => null);
  if (!balance) return null;

  const currentBalanceNative = "balanceBtc" in balance ? balance.balanceBtc : balance.balanceEth;

  const history = await recordFlowBalance(asset, { t: now, balanceNative: currentBalanceNative });
  const prior = balanceWindowAgo(history, EXCHANGE_FLOW_WINDOW_HOURS);

  const addresses = asset === "BTC" ? BTC_ADDRESSES : ETH_ADDRESSES;

  return classifyExchangeFlow({
    asset,
    currentBalanceNative,
    currentT: now,
    prior,
    priceUsd,
    venues: trackedVenues(addresses),
    trackedAddressCount: balance.trackedAddressCount,
  });
}

/**
 * BTC/ETH options positioning, Deribit only — see DeribitOptionsSummary's
 * doc comment for why this isn't cross-venue aggregated. Scored via
 * evaluateOptions (lib/signals/evaluators.ts) into the single market-bias
 * engine, the same as every other directional metric — no separate
 * composite exists anymore for it to be folded into or excluded from.
 */
/**
 * Daily price-action read. Null for MARKET, which is a roll-up across ten
 * assets and therefore has no single price series to run indicators on —
 * the thesis for that view simply renormalizes without this evidence, the
 * same way it already handles any other absent source.
 */
/**
 * Advances the swing-thesis state machine (signals/swingThesis.ts).
 *
 * Runs after the bias because it consumes it, and does exactly two things:
 * folds in the newest CLOSED daily bar if one has appeared since the last
 * run, then applies the current price as a tick. The reducer is idempotent
 * per close, so the overwhelmingly common case — a poll with no new daily
 * bar — reduces to a cheap tick and, usually, no write at all.
 *
 * Returns `available: false` rather than an empty store when persistence
 * can't be consulted. The action shown to the trader depends on this state,
 * so "no thesis" and "couldn't check" must not render identically.
 */
async function buildSwingThesis(
  asset: AssetSymbol | "MARKET",
  bias: MarketBias | null,
  technicals: TechnicalRead | null,
  technicals4h: TechnicalRead | null,
  supportResistance: SupportResistanceZone[],
  price: number,
  now: number
): Promise<SwingThesisSnapshot | null> {
  if (asset === "MARKET" || !bias || price <= 0) return null;

  const { store, available } = await readSwingThesis(asset);
  if (!available) return { available: false, store };

  // Cache hit: buildTechnicals already pulled this series this poll.
  const candles = await fetchOkxDailyCandles(asset).catch(() => []);
  const lastClosed = candles[candles.length - 1];

  /*
   * Excursion/EV constraints for both sides, from the execution replay's
   * published planner cells + TODAY's volatility regime. Computed here — on
   * the LIVE path only — because the backtest replay must never gate itself
   * (measurement vs policy; see scripts/backtest/plannerStats.ts). BTC/ETH
   * only: the excursion record is those assets' perp trades, and attaching
   * one market's drawdown habits to another's plan would be borrowed
   * evidence.
   */
  const plannerSnapshot = (executionStatsJson as { planner?: PlannerStatsSnapshot }).planner;
  const liveRegime = asset === "BTC" || asset === "ETH" ? await buildMarketRegimeTags(asset) : null;
  const liveTags = liveRegime ? regimeTagsToStrings(liveRegime) : null;
  const constraintsBySide = liveTags
    ? {
        long: planConstraintsFor("long", liveTags, plannerSnapshot),
        short: planConstraintsFor("short", liveTags, plannerSnapshot),
      }
    : null;

  let next = store;

  if (lastClosed && lastClosed.t > store.lastCloseAt) {
    /*
     * `technicalAgreement` is evaluated against the BIAS verdict, not
     * `marketThesis.dominant`. dominant has no deadband at all — it flips
     * whenever bullWeight and bearWeight cross by any epsilon, which
     * measured ~8 times a day in production and dragged the agreement label
     * (and therefore the ENTER gate) along with it.
     */
    next = applyDailyClose(next, {
      t: lastClosed.t,
      closePrice: lastClosed.close,
      biasScore: bias.score,
      biasVerdict: bias.verdict,
      dailyAgreement: technicals ? technicalAgreement(technicals, bias.verdict) : null,
      dailyDirection: technicals?.direction ?? null,
      fourHourAgreement: technicals4h ? technicalAgreement(technicals4h, bias.verdict) : null,
      planInputs: {
        verdict: bias.verdict,
        confidence: bias.confidence,
        agreement: bias.agreement,
        price: lastClosed.close,
        atrPct: technicals?.atrPct ?? null,
        supportResistance,
        ...swingWinRate(bias.verdict),
      },
      reasons: swingReasons(bias),
      constraintsBySide,
    });
  }

  /*
   * Forward-looking setups, anchored to the same closed daily bar.
   *
   * Keyed on `builtAt !== lastClosed.t` rather than on "a new close
   * appeared", which matters for two cases the stricter condition gets
   * wrong: a record written before planned setups existed, and any close
   * where the thesis reducer short-circuited. Both would otherwise show no
   * setups until the next midnight, which is exactly the empty page this
   * feature exists to fix.
   *
   * Rebuilding is safe precisely BECAUSE the anchor is the closed bar and
   * not the tick: the same close always yields the same plans, so this is
   * idempotent rather than a second source of drift.
   *
   * Unlike the thesis these are unconditional — they exist whenever
   * structure supports an honest plan, regardless of what the composite
   * thinks. A swing trader always knows the level they want; only the
   * decision to act on it depends on evidence.
   */
  if (lastClosed && next.plannedSetups?.builtAt !== lastClosed.t) {
    next = {
      ...next,
      plannedSetups: buildPlannedSetups({
        constraintsBySide,
        t: lastClosed.t,
        closePrice: lastClosed.close,
        atrPct: technicals?.atrPct ?? null,
        zones: supportResistance,
        dailyDirection: technicals?.direction ?? null,
        fourHourDirection: technicals4h?.direction ?? null,
        quality: {
          confidence: bias.confidence,
          agreement: bias.agreement,
          ...swingWinRate(bias.verdict),
        },
      }),
    };
  }

  /*
   * CONTINUOUS_SESSION, declared rather than defaulted: this path is crypto,
   * and crypto cannot gap. No `open` either — a live poll is a spot quote,
   * not a closed bar, so there is no gap information to pass and inventing
   * one would be worse than the honest absence. See `TickEvidence.open`.
   */
  next = applyTick(next, { t: now, price }, CONTINUOUS_SESSION);

  if (next !== store) {
    // Awaited: the very next poll reads this back, and a lost write would
    // silently re-run the same close.
    await writeSwingThesis(asset, next);
  }
  return { available: true, store: next };
}

/**
 * Best harmonic (Fibonacci-pattern) evidence across Daily and 4H — additive
 * context only, never wired into activation/scoring (see
 * harmonicEvidence.ts's own header for why). Mirrors `buildSwingThesis`'s
 * shape but needs no persisted store: the PRZ is frozen the moment its
 * candidate forms, and status is a pure function of price against it, so
 * recomputing from the same swr-cached candles every poll is sufficient —
 * see harmonicEvidence.ts's header for the full reasoning.
 */
async function buildHarmonics(
  asset: AssetSymbol | "MARKET",
  bias: MarketBias | null,
  technicals: TechnicalRead | null,
  technicals4h: TechnicalRead | null,
  supportResistance: SupportResistanceZone[],
  metricVerdicts: MetricVerdict[],
  price: number
): Promise<HarmonicEvidence | null> {
  if (asset === "MARKET" || price <= 0) return null;

  // Cache hits: buildTechnicals/buildTechnicals4h already pulled these this poll.
  const [dailyCandles, fourHourCandles] = await Promise.all([
    fetchOkxDailyCandles(asset).catch(() => []),
    fetchOkx4hCandles(asset).catch(() => []),
  ]);

  const metricVerdictMap = new Map(metricVerdicts.map((m) => [m.id, m.verdict] as const));
  const baseCtx = {
    zones: supportResistance,
    biasVerdict: bias?.verdict ?? null,
    metricVerdicts: metricVerdictMap,
    price,
  };

  const dailyEvidence =
    technicals?.atrPct && dailyCandles.length > 0
      ? buildHarmonicEvidence({
          ...baseCtx,
          candles: dailyCandles,
          timeframe: "1D",
          atrAbs: (technicals.atrPct / 100) * price,
          currentDivergence: { rsi: technicals.rsiDivergence, macd: technicals.macdDivergence },
        })
      : [];

  const fourHourEvidence =
    technicals4h?.atrPct && fourHourCandles.length > 0
      ? buildHarmonicEvidence({
          ...baseCtx,
          candles: fourHourCandles,
          timeframe: "4H",
          atrAbs: (technicals4h.atrPct / 100) * price,
          currentDivergence: { rsi: technicals4h.rsiDivergence, macd: technicals4h.macdDivergence },
        })
      : [];

  return selectBestHarmonic(dailyEvidence, fourHourEvidence);
}

/**
 * The measured win rate for comparable TRADES, matching what
 * `EntryQualityCard` already displays. Only feeds the star score, never the
 * levels.
 */
function swingWinRate(verdict: Verdict): { historicalWinRatePct: number | null; historicalWinRateN: number | null } {
  const stats = lookupTradeStatsBySide(
    executionStatsJson as unknown as ExecutionStatsSnapshot,
    verdict === "bullish" ? "long" : "short"
  );
  return {
    historicalWinRatePct: stats?.winRatePct ?? null,
    historicalWinRateN: stats?.n ?? null,
  };
}

async function buildTechnicals(asset: AssetSymbol | "MARKET"): Promise<TechnicalRead | null> {
  if (asset === "MARKET") return null;

  const candles = await fetchOkxDailyCandles(asset).catch(() => []);
  return buildTechnicalRead(candles);
}

/**
 * The same read as `buildTechnicals` above, against 4-hour candles instead
 * of daily — see providers/okxCandles.ts for why this is a separate,
 * shorter series (live-only, ~50 days of history) rather than a resample
 * of the daily one.
 */
async function buildTechnicals4h(asset: AssetSymbol | "MARKET"): Promise<TechnicalRead | null> {
  if (asset === "MARKET") return null;

  const candles = await fetchOkx4hCandles(asset).catch(() => []);
  return buildTechnicalRead(candles);
}

/**
 * Approximated market structure for the Liquidity Map dashboard section —
 * same candles `buildTechnicals` above uses, re-fetched rather than
 * threaded through: `fetchOkxDailyCandles` is already swr-cached (same
 * "second call costs nothing" precedent already used for stablecoins/
 * fearGreed below), so this costs one cache hit, not a second real fetch.
 *
 * `bookDepth` is the shared promise started once above — see its own
 * comment for why it's passed in rather than fetched here.
 */
async function buildLiquidityMap(
  asset: AssetSymbol | "MARKET",
  bookDepth: Promise<RawBookDepth | null>
): Promise<LiquidityMapRead | null> {
  if (asset === "MARKET") return null;

  const [candles, candles4h] = await Promise.all([
    fetchOkxDailyCandles(asset).catch(() => []),
    fetchOkx4hCandles(asset).catch(() => []),
  ]);
  if (candles.length === 0) return null;

  const volumeProfile = buildVolumeProfile(candles);

  /*
   * Structure is read on BOTH swing timeframes. Daily supplies the major
   * levels, the clustering tolerance and the status classification; 4H adds
   * precision between them and, where the two overlap, marks the level as
   * multi-timeframe confirmed. Both series are already fetched and cached
   * this poll, so this costs no extra requests.
   */
  const dailyZones = buildSupportResistanceZones(candles, volumeProfile, "1D");
  const supportResistance =
    candles4h.length > 0
      ? mergeTimeframeZones(dailyZones, buildSupportResistanceZones(candles4h, null, "4H"), candles)
      : dailyZones;

  const walls = await buildLiquidityWallRead(asset, bookDepth, supportResistance);
  return { volumeProfile, supportResistance, walls };
}

/**
 * Phase 5's wall-detection pipeline, isolated from buildLiquidityMap's
 * candle-based structure above so a failure here (KV timeout, degenerate
 * book) can never take down the S/R read it sits beside — `walls: null`
 * on any problem, exactly like every other optional field in this
 * aggregator.
 */
async function buildLiquidityWallRead(
  asset: AssetSymbol,
  bookDepth: Promise<RawBookDepth | null>,
  supportResistance: SupportResistanceZone[]
): Promise<LiquidityWallRead | null> {
  const depth = await bookDepth;
  if (!depth) return null;

  const bidResult = detectWalls(depth.bids, "bid");
  const askResult = detectWalls(depth.asks, "ask");
  if (!bidResult.reliable && !askResult.reliable) return null;

  const bookPriceRange = bookPriceRangeOf(depth.bids, depth.asks);
  const zoneRelationships = classifyWallVsZones(bidResult.walls, askResult.walls, supportResistance, bookPriceRange);

  // Best-effort: a KV outage degrades persistence to "unavailable" per
  // classifyPersistence's own contract, never blocks the walls themselves.
  const priorSnapshots = await recordAndGetPriorSnapshots(asset, Date.now(), [
    ...bidResult.walls,
    ...askResult.walls,
  ]).catch(() => []);

  const withPersistence = (walls: LiquidityWall[]): LiquidityWallWithPersistence[] =>
    walls.map((w) => ({ ...w, persistence: classifyPersistence(w, priorSnapshots) }));

  return {
    bidWalls: withPersistence(bidResult.walls),
    askWalls: withPersistence(askResult.walls),
    zoneRelationships,
    bookPriceRange,
  };
}

/**
 * TODAY's trend/volatility/range-bound classification — the exact same
 * `classifyRegime` scripts/backtest/run.ts uses to tag every historical
 * day, called against the most recent index instead of a historical one.
 * Re-fetches the same swr-cached daily candles `buildTechnicals`/
 * `buildLiquidityMap` above already use, same "second call costs nothing"
 * precedent as those two.
 */
async function buildMarketRegimeTags(asset: AssetSymbol | "MARKET") {
  if (asset === "MARKET") return null;

  const candles = await fetchOkxDailyCandles(asset).catch(() => []);
  if (candles.length === 0) return null;

  return classifyRegime(candles, candles.length - 1);
}

/** US spot ETF flows. BTC/ETH only — no such complex exists for the rest. */
async function buildEtfFlows(asset: AssetSymbol | "MARKET"): Promise<EtfFlowSummary | null> {
  if (asset !== "BTC" && asset !== "ETH") return null;
  return fetchEtfFlows(asset).catch(() => null);
}

/**
 * Spot turnover against perpetual turnover, BOTH LEGS FROM OKX.
 *
 * The perp leg must not be the all-venue sum. Measured live, that compared
 * one venue's spot book ($136M) against nineteen venues' perp volume
 * ($11.9B) and produced a 0.008 "ratio" that mostly encoded how many venues
 * were in each leg — it would have read as extreme leverage-dominance on
 * every asset, forever, regardless of what traders were doing.
 *
 * Same-venue keeps it a real comparison. The trade-off is that the absolute
 * level now reflects OKX's product mix (a derivatives-first venue, where
 * perps genuinely run an order of magnitude above spot), which is why the
 * evaluator treats the level cautiously rather than as a calibrated scale.
 */
async function buildSpotPerpVolume(
  asset: AssetSymbol | "MARKET",
  exchanges: ExchangeSnapshot[]
): Promise<SpotPerpVolume | null> {
  if (asset === "MARKET") return null;

  const okxPerp = exchanges.find((e) => e.exchangeId === "okx")?.volume24hUsd ?? 0;
  if (okxPerp <= 0) return null;

  const spotVolumeUsd = await fetchSpotVolumeUsd(asset).catch(() => null);
  if (spotVolumeUsd === null) return null;

  return {
    spotVolumeUsd,
    perpVolumeUsd: okxPerp,
    spotToPerpRatio: spotVolumeUsd / okxPerp,
  };
}

async function buildDeribitOptions(
  asset: AssetSymbol | "MARKET",
  now: number
): Promise<DeribitOptionsSummary | null> {
  if (asset !== "BTC" && asset !== "ETH") return null;

  const rows = await fetchDeribitOptions(asset).catch(() => null);
  if (!rows) return null;

  return summarizeDeribitOptions(asset, rows, now);
}

function computeAggregateOiPercentile(
  exchanges: ExchangeSnapshot[],
  _totalOi: number
): number | null {
  /*
   * Two guards here, both learned the hard way.
   *
   * 1. MIN_POINTS. Any venue with even one recorded point used to qualify as
   *    a contributor. venueStore backfills a point for every venue on every
   *    poll, so that meant ~17 venues contributing 2 points each alongside
   *    OKX's 720. Two points is not a distribution to rank against.
   *
   * 2. Buckets must be COMPLETE. Summing whatever happened to be present in
   *    each hour compared apples to oranges across time: recent buckets held
   *    all 18 venues (~$28B), older ones held only OKX (~$2.6B). Ranking the
   *    current 18-venue total against a series mostly built from single-venue
   *    sums pinned the gauge at 100 — exactly the failure the comment above
   *    warns about, reintroduced from a different direction.
   *
   * Requiring every contributor in every bucket makes the series a
   * like-for-like measurement of one fixed venue set over time, which is the
   * only thing a percentile can honestly be computed from.
   */
  const MIN_POINTS = 12;

  const contributors = exchanges.filter(
    (e) => e.fundingHistory.filter((p) => p.openInterestUsd !== undefined).length >= MIN_POINTS
  );
  if (contributors.length === 0) return null;

  const buckets = new Map<number, { sum: number; venues: Set<string> }>();
  contributors.forEach((e) => {
    e.fundingHistory.forEach((p: FundingPoint) => {
      if (p.openInterestUsd === undefined) return;
      const hour = Math.floor(p.t / 3_600_000);
      const b = buckets.get(hour) ?? { sum: 0, venues: new Set<string>() };
      // Stop a venue reporting twice in one hour from double-counting.
      if (b.venues.has(e.exchangeId)) return;
      b.sum += p.openInterestUsd;
      b.venues.add(e.exchangeId);
      buckets.set(hour, b);
    });
  });

  const series = [...buckets.entries()]
    .filter(([, b]) => b.venues.size === contributors.length)
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ openInterestUsd: b.sum }));

  if (series.length < MIN_POINTS) return null;

  // Rank the contributors' current combined OI, not the full cross-venue total.
  const contributorCurrentOi = contributors.reduce((s, e) => s + e.openInterestUsd, 0);
  return computeOiPercentile(contributorCurrentOi, series);
}

export function listExchangeIds(): string[] {
  return EXCHANGES.map((e) => e.id);
}
