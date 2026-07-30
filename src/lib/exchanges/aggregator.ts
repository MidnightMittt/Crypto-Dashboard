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
import { PoolExposureSummary } from "@/types/market";
import { LiveAdapter } from "./adapters/types";
import { fundingPer8h } from "../utils/format";
import { MarketDataProvider } from "../providers/types";
import { defillamaProvider } from "../providers/defillama";
import { coinalyzeProvider } from "../providers/coinalyze";
import { coingeckoProvider } from "../providers/coingecko";

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
import { computeCompositeSentiment, computeLeverageHeat, computeOiPercentile } from "../sentiment/compositeIndex";
import { recordVenueHistory, enrichWithVenueHistory } from "../history/venueStore";
import {
  HistoryPoint,
  historySpanHours,
  oiChangeFromHistory,
  oiPercentileFromHistory,
  recordHistory,
} from "../history/store";

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
    return { price: null, disagreementPct: null, sourceCount: 0 };
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

  const point: HistoryPoint = {
    t: agg.updatedAt,
    totalOpenInterestUsd: agg.totalOpenInterestUsd,
    weightedFundingRatePct: agg.weightedFundingRatePct,
    price: agg.exchanges[0]?.price ?? 0,
    longShortRatio: agg.longShortRatio,
    venueCount: agg.exchanges.length,
  };

  const history = await recordHistory(asset, point);

  // Spot reference from DexScreener, used only for basis. Whole-market view
  // has no single spot price, so it's skipped there.
  let spotPriceUsd: number | null = null;
  let spotSource: string | null = null;
  let basisPct: number | null = null;
  let spotDisagreementPct: number | null = null;
  let spotSourceCount = 0;
  if (asset !== "MARKET" && spot) {
    const { price: resolved, disagreementPct, sourceCount } = await spot;
    spotSourceCount = sourceCount;
    spotDisagreementPct = disagreementPct;
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

  const oiChange24hPct =
    agg.oiChange24hPct ?? oiChangeFromHistory(history, agg.totalOpenInterestUsd);
  const oiPercentile =
    agg.oiPercentile ?? oiPercentileFromHistory(history, agg.totalOpenInterestUsd);

  // Heat depends on the OI trend, so recompute it now that we may have one.
  const leverageHeatScore =
    agg.leverageHeatScore ??
    computeLeverageHeat({
      weightedFundingRatePct: agg.weightedFundingRatePct,
      oiChange24hPct,
      priceChange24hPct: agg.priceChange24hPct,
    });

  const poolExposure = await buildPoolExposure(asset, agg.exchanges);

  return {
    ...agg,
    poolExposure,
    oiChange24hPct,
    oiPercentile,
    leverageHeatScore,
    spotPriceUsd,
    spotSource,
    basisPct,
    spotDisagreementPct,
    spotSourceCount,
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
      compositeSentimentScore: 50,
      priceChange24hPct: 0,
      exchanges: [],
      unavailableExchanges,
      spotPriceUsd: null,
      spotSource: null,
      basisPct: null,
      spotDisagreementPct: null,
      spotSourceCount: 0,
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

  const compositeSentimentScore = computeCompositeSentiment({
    weightedFundingRatePct,
    oiChange24hPct,
    oiPercentile,
    longShortRatio,
    priceChange24hPct,
    exchanges,
  });

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
    compositeSentimentScore,
    priceChange24hPct,
    exchanges,
    unavailableExchanges,
    spotPriceUsd: null,
    spotSource: null,
    basisPct: null,
    spotDisagreementPct: null,
    spotSourceCount: 0,
    // Filled in by withRecordedHistory, which is where the async work lives.
    poolExposure: null,
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
