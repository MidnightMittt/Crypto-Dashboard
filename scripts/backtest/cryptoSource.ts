import { RawAssetData, rollUpToDaily, rollUpTo4h } from "./run";
import { InMemoryDataSource, InstrumentSeed } from "../../src/lib/research/inMemorySource";
import { Bar, CONTINUOUS_SESSION, InstrumentMeta, MarketDataSource } from "../../src/lib/research/types";

/**
 * Adapts the existing crypto backtest dataset onto `MarketDataSource`.
 *
 * This is the migration step that proves the abstraction: BTC and ETH — a
 * dataset whose behaviour is already understood in detail — must produce
 * byte-identical bars through the new interface and the old code path. If
 * they diverge, the abstraction is wrong, and it is far better to discover
 * that against known data than against a newly imported equity series where
 * a discrepancy could plausibly be blamed on the data vendor.
 *
 * Scope note. Only the RESEARCH path is migrated here, deliberately. The
 * live aggregator (src/lib/exchanges/aggregator.ts) keeps its own SWR-cached
 * "latest value" access, because that is a genuinely different access
 * pattern from "as of T, never past it", and routing a working deployed
 * product through a point-in-time interface would add risk without adding
 * research power. The property that actually matters — one decision engine,
 * not two — already holds: both paths call the same buildTechnicalRead,
 * buildHarmonicEvidence and buildMarketBias out of src/lib.
 */

/** Crypto perps trade continuously, so `gapsPossible` is false and stops resolve intrabar — the behaviour the existing engine already assumes. */
export function cryptoMeta(asset: "BTC" | "ETH"): InstrumentMeta {
  return {
    id: `${asset}-USD-PERP`,
    displaySymbol: asset,
    assetClass: "crypto",
    sessionModel: CONTINUOUS_SESSION,
    // Perps have no corporate actions; "none" is accurate, not a placeholder.
    adjustment: "none",
    inceptionT: 0,
    delistedT: null,
    quoteCurrency: "USD",
  };
}

/** The backtest's hourly klines carry no explicit volume field on every row; absent volume is reported as null rather than zero. */
function toBar(k: { t: number; open: number; high: number; low: number; close: number; volumeUsd?: number }): Bar {
  return {
    t: k.t,
    open: k.open,
    high: k.high,
    low: k.low,
    close: k.close,
    volume: typeof k.volumeUsd === "number" ? k.volumeUsd : null,
  };
}

/**
 * Builds one instrument seed from the raw backtest asset file.
 *
 * Bars come from the SAME `rollUpToDaily` / `rollUpTo4h` the existing engine
 * uses, imported rather than reimplemented. That is the point: any
 * difference between old and new must come from the interface, not from a
 * second copy of the rollup logic that could drift.
 */
export function cryptoSeed(asset: "BTC" | "ETH", data: RawAssetData): InstrumentSeed {
  const hourly = data.futuresKlines;
  const daily = rollUpToDaily(hourly);
  const fourHour = rollUpTo4h(hourly);

  return {
    meta: cryptoMeta(asset),
    bars: {
      "1h": hourly.map(toBar),
      "4h": fourHour.map(toBar),
      "1D": daily.map(toBar),
    },
    capabilities: {
      /*
       * Each point's `knownAtT` is the observation's own timestamp: these
       * are all published series where the value IS the reading at that
       * instant, with no reporting lag to model. Where a future capability
       * does have a lag (earnings, economic releases), knownAtT must be the
       * RELEASE time, not the period the figure describes — the field is
       * named knownAtT rather than `t` precisely to force that distinction.
       */
      funding: {
        points: data.fundingRate.map((f) => ({ knownAtT: f.t, value: f.fundingRatePct })),
      },
      openInterest: {
        points: (data.oiHistory ?? []).map((o) => ({ knownAtT: o.t, value: o })),
      },
    },
  };
}

export function buildCryptoSource(assets: Array<{ asset: "BTC" | "ETH"; data: RawAssetData }>): MarketDataSource {
  return new InMemoryDataSource(assets.map(({ asset, data }) => cryptoSeed(asset, data)));
}
