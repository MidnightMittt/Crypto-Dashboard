import { describe, expect, it } from "vitest";
import { buildCryptoSource, cryptoSeed, cryptoMeta } from "./cryptoSource";
import { RawAssetData, rollUpToDaily, rollUpTo4h } from "./run";

/**
 * MIGRATION EQUIVALENCE — the new interface must reproduce the old code path
 * exactly.
 *
 * The property under test is exact rather than statistical, so it needs no
 * real market data: for every cutoff, the bars served through
 * `MarketDataSource` must equal the bars the existing engine would have
 * computed via `rollUpToDaily` / `rollUpTo4h` and then truncated itself.
 * Synthetic input also means this runs in any checkout — the real datasets
 * are gitignored, and a correctness test that only runs on one machine is
 * not a correctness test.
 */

const HOUR = 3_600_000;

/** Deterministic hourly series with a visible intraday shape, so a rollup that mixed up open/high/low/close would be caught rather than averaged away. */
function syntheticHourly(hours: number, startT = Date.UTC(2023, 0, 1)) {
  return Array.from({ length: hours }, (_, i) => {
    const base = 100 + i * 0.05 + 8 * Math.sin(i / 11);
    return {
      t: startT + i * HOUR,
      open: base,
      high: base + 1.5,
      low: base - 1.5,
      close: base + 0.25,
      volumeUsd: 1_000_000 + i * 137,
    };
  });
}

function rawData(hours: number): RawAssetData {
  const klines = syntheticHourly(hours);
  return {
    asset: "BTC",
    futuresKlines: klines,
    spotKlines: [],
    fundingRate: klines
      .filter((_, i) => i % 8 === 0)
      .map((k, i) => ({ t: k.t, fundingRatePct: 0.001 * (i % 5) })),
    oiHistory: klines.filter((_, i) => i % 24 === 0).map((k) => ({ t: k.t, oiUsd: 1e9 })),
    longShortHistory: [],
    etfFlows: [],
  };
}

describe("crypto adapter — metadata", () => {
  it("declares crypto as continuous, so stops keep resolving intrabar exactly as today", () => {
    const meta = cryptoMeta("BTC");
    expect(meta.sessionModel.kind).toBe("continuous");
    // This is the field that must NOT change behaviour for crypto: if it
    // flipped to true, every historical crypto result would shift.
    expect(meta.sessionModel.gapsPossible).toBe(false);
    expect(meta.assetClass).toBe("crypto");
    expect(meta.adjustment).toBe("none");
  });

  it("uses a stable internal id distinct from the display symbol", () => {
    expect(cryptoMeta("ETH").id).toBe("ETH-USD-PERP");
    expect(cryptoMeta("ETH").displaySymbol).toBe("ETH");
  });
});

describe("crypto adapter — bar equivalence with the existing engine", () => {
  const HOURS = 24 * 200;
  const data = rawData(HOURS);
  const source = buildCryptoSource([{ asset: "BTC", data }]);
  const id = "BTC-USD-PERP";

  /** What the OLD path produces: roll up the whole series, then truncate. */
  const oldDaily = rollUpToDaily(data.futuresKlines);
  const oldFourHour = rollUpTo4h(data.futuresKlines);

  it("daily bars are identical to rollUpToDaily at every cutoff", () => {
    for (const cutIdx of [10, 50, 120, 199]) {
      const until = oldDaily[cutIdx].t;
      const viaSource = source.bars(id, "1D", until);
      const viaOldPath = oldDaily.filter((b) => b.t <= until);

      expect(viaSource).toHaveLength(viaOldPath.length);
      viaSource.forEach((bar, i) => {
        expect(bar.t).toBe(viaOldPath[i].t);
        expect(bar.open).toBe(viaOldPath[i].open);
        expect(bar.high).toBe(viaOldPath[i].high);
        expect(bar.low).toBe(viaOldPath[i].low);
        expect(bar.close).toBe(viaOldPath[i].close);
      });
    }
  });

  it("4H bars are identical to rollUpTo4h at every cutoff", () => {
    for (const cutIdx of [20, 100, 400, oldFourHour.length - 1]) {
      const until = oldFourHour[cutIdx].t;
      const viaSource = source.bars(id, "4h", until);
      const viaOldPath = oldFourHour.filter((b) => b.t <= until);
      expect(viaSource.map((b) => [b.t, b.open, b.high, b.low, b.close])).toEqual(
        viaOldPath.map((b) => [b.t, b.open, b.high, b.low, b.close])
      );
    }
  });

  it("hourly bars pass through untouched", () => {
    const until = data.futuresKlines[500].t;
    const viaSource = source.bars(id, "1h", until);
    expect(viaSource).toHaveLength(501);
    expect(viaSource[500].close).toBe(data.futuresKlines[500].close);
  });

  it("truncation is inclusive of the cutoff bar and excludes everything after", () => {
    const until = oldDaily[100].t;
    const bars = source.bars(id, "1D", until);
    expect(bars[bars.length - 1].t).toBe(until);
    expect(bars.every((b) => b.t <= until)).toBe(true);
    // The very next daily bar exists in the dataset but must not be served.
    expect(oldDaily[101].t).toBeGreaterThan(until);
  });

  /*
   * The look-ahead guard restated at the adapter level: a source built over
   * the FULL history and queried at T must serve exactly what a source built
   * over only the data available at T would serve. Any leakage in the
   * adapter or the truncation would break this.
   */
  it("is point-in-time safe: full-history and truncated-history sources agree at the cutoff", () => {
    const cutHours = 24 * 120;
    const until = oldDaily[110].t;

    const truncatedData: RawAssetData = { ...data, futuresKlines: data.futuresKlines.slice(0, cutHours) };
    const truncatedSource = buildCryptoSource([{ asset: "BTC", data: truncatedData }]);

    expect(truncatedSource.bars(id, "1D", until)).toEqual(source.bars(id, "1D", until));
    expect(truncatedSource.bars(id, "4h", until)).toEqual(source.bars(id, "4h", until));
  });
});

describe("crypto adapter — capabilities", () => {
  const data = rawData(24 * 100);
  const source = buildCryptoSource([{ asset: "BTC", data }]);
  const id = "BTC-USD-PERP";

  it("reports the crypto capabilities it can actually serve, and nothing else", () => {
    expect(source.hasCapability(id, "ohlcv")).toBe(true);
    expect(source.hasCapability(id, "funding")).toBe(true);
    expect(source.hasCapability(id, "openInterest")).toBe(true);
    // Never claimed, so any module requiring them is skipped rather than
    // silently handed a fabricated default.
    expect(source.hasCapability(id, "earnings")).toBe(false);
    expect(source.hasCapability(id, "optionsFlow")).toBe(false);
    expect(source.hasCapability(id, "onChainFlow")).toBe(false);
  });

  it("never returns a funding value from the future", () => {
    const points = data.fundingRate;
    // Just before the first observation there is nothing knowable yet.
    expect(source.capability<number>(id, "funding", points[0].t - 1)).toBeNull();
    // At an instant between observations 2 and 3, observation 2 is current.
    const between = (points[2].t + points[3].t) / 2;
    expect(source.capability<number>(id, "funding", between)).toBe(points[2].fundingRatePct);
    // Exactly on an observation, that observation is knowable.
    expect(source.capability<number>(id, "funding", points[3].t)).toBe(points[3].fundingRatePct);
  });
});

describe("crypto adapter — multi-instrument", () => {
  it("keeps two instruments independent", () => {
    const btc = rawData(24 * 60);
    const eth: RawAssetData = { ...rawData(24 * 60), asset: "ETH" };
    const source = buildCryptoSource([
      { asset: "BTC", data: btc },
      { asset: "ETH", data: eth },
    ]);
    expect(source.listInstruments().map((m) => m.id).sort()).toEqual(["BTC-USD-PERP", "ETH-USD-PERP"]);
    expect(source.meta("BTC-USD-PERP")!.displaySymbol).toBe("BTC");
    expect(source.meta("ETH-USD-PERP")!.displaySymbol).toBe("ETH");
  });

  it("produces a seed whose bars are all strictly ascending (the InMemoryDataSource contract)", () => {
    const seed = cryptoSeed("BTC", rawData(24 * 40));
    for (const [, bars] of Object.entries(seed.bars)) {
      if (!bars) continue;
      for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
    }
  });
});
