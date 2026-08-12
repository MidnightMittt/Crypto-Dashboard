import { describe, expect, it } from "vitest";
import { InMemoryDataSource } from "./inMemorySource";
import { extractFeatures, UNIVERSAL_FEATURES, FeatureDefinition } from "./features";
import { runModules, EvidenceModule, Bar, InstrumentMeta, CONTINUOUS_SESSION, US_EQUITY_SESSION, ResearchContext } from "./types";

const DAY = 86_400_000;

function bars(closes: number[], startT = 0): Bar[] {
  return closes.map((c, i) => ({
    t: startT + i * DAY,
    open: c,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 1000 + i,
  }));
}

const cryptoMeta: InstrumentMeta = {
  id: "BTC-USD",
  displaySymbol: "BTC",
  assetClass: "crypto",
  sessionModel: CONTINUOUS_SESSION,
  adjustment: "none",
  inceptionT: 0,
  delistedT: null,
  quoteCurrency: "USD",
};

const equityMeta: InstrumentMeta = {
  ...cryptoMeta,
  id: "SPY",
  displaySymbol: "SPY",
  assetClass: "equity-etf",
  sessionModel: US_EQUITY_SESSION,
  adjustment: "splits-and-dividends",
};

/**
 * 200 sessions of a decisive uptrend. 0.6%/session is chosen so the move
 * clears all three trend deadbands (2% over 5d, 5% over 20d, 10% over 60d) —
 * a gentler ramp reads "flat" on the short horizons, which is correct
 * behaviour but tests nothing.
 */
const TREND = Array.from({ length: 200 }, (_, i) => 100 * 1.006 ** i);

type Seed = ConstructorParameters<typeof InMemoryDataSource>[0][number];

function sourceWith(capabilities?: Seed["capabilities"]) {
  return new InMemoryDataSource([
    { meta: cryptoMeta, bars: { "1D": bars(TREND) }, capabilities },
    { meta: equityMeta, bars: { "1D": bars(TREND) } },
  ]);
}

function ctxAt(source: InMemoryDataSource, id: string, asOf: number): ResearchContext {
  return { instrument: source.meta(id)!, source, asOf };
}

describe("InMemoryDataSource — point-in-time enforcement", () => {
  it("never returns a bar past the cutoff", () => {
    const source = sourceWith();
    for (const cut of [10, 50, 137, 199]) {
      const got = source.bars("BTC-USD", "1D", cut * DAY);
      expect(got).toHaveLength(cut + 1);
      expect(got[got.length - 1].t).toBe(cut * DAY);
      expect(got.every((b) => b.t <= cut * DAY)).toBe(true);
    }
  });

  it("returns an empty series before the first bar, not a truncated guess", () => {
    expect(sourceWith().bars("BTC-USD", "1D", -1)).toEqual([]);
  });

  it("returns nothing for an unknown instrument or timeframe", () => {
    const source = sourceWith();
    expect(source.bars("NOPE", "1D", Infinity)).toEqual([]);
    expect(source.bars("BTC-USD", "1W", Infinity)).toEqual([]);
    expect(source.meta("NOPE")).toBeNull();
  });

  it("rejects unsorted bars at construction rather than silently mis-truncating", () => {
    expect(
      () =>
        new InMemoryDataSource([
          { meta: cryptoMeta, bars: { "1D": [bars([100])[0], { ...bars([100])[0], t: -DAY }] } },
        ])
    ).toThrow(/not strictly ascending/);
  });

  it("serves the latest capability observation that was already KNOWABLE, never a future one", () => {
    const source = sourceWith({
      funding: {
        points: [
          { knownAtT: 10 * DAY, value: 0.01 },
          { knownAtT: 20 * DAY, value: 0.05 },
          { knownAtT: 30 * DAY, value: 0.09 },
        ],
      },
    });
    expect(source.capability<number>("BTC-USD", "funding", 5 * DAY)).toBeNull();
    expect(source.capability<number>("BTC-USD", "funding", 10 * DAY)).toBe(0.01);
    expect(source.capability<number>("BTC-USD", "funding", 25 * DAY)).toBe(0.05);
    expect(source.capability<number>("BTC-USD", "funding", 1000 * DAY)).toBe(0.09);
  });

  it("reports capability presence per instrument", () => {
    const source = sourceWith({ funding: { points: [{ knownAtT: 0, value: 1 }] } });
    expect(source.hasCapability("BTC-USD", "ohlcv")).toBe(true);
    expect(source.hasCapability("BTC-USD", "funding")).toBe(true);
    expect(source.hasCapability("SPY", "funding")).toBe(false);
    expect(source.hasCapability("SPY", "ohlcv")).toBe(true);
  });
});

describe("universal features", () => {
  it("computes every feature on a warmed series", () => {
    const source = sourceWith();
    const v = extractFeatures(UNIVERSAL_FEATURES, ctxAt(source, "BTC-USD", 199 * DAY));
    expect(v.unavailable).toEqual([]);
    expect(v.errored).toEqual([]);
    for (const def of UNIVERSAL_FEATURES) {
      expect(v.values[def.key], `${def.key} should be computable`).not.toBeNull();
    }
  });

  it("reads a steady uptrend as up on every horizon, with efficiency near 1", () => {
    const source = sourceWith();
    const v = extractFeatures(UNIVERSAL_FEATURES, ctxAt(source, "BTC-USD", 199 * DAY));
    expect(v.values.trend_short).toBe("up");
    expect(v.values.trend_medium).toBe("up");
    expect(v.values.trend_long).toBe("up");
    // A monotonic series travels no wasted distance.
    expect(v.values.efficiency_20d as number).toBeCloseTo(1, 6);
    // At the highs by construction.
    expect(v.values.dist_from_20d_high_pct as number).toBeLessThan(1.5);
  });

  it("returns null rather than a fabricated value before enough history exists", () => {
    const source = sourceWith();
    const v = extractFeatures(UNIVERSAL_FEATURES, ctxAt(source, "BTC-USD", 3 * DAY));
    expect(v.values.return_60d).toBeNull();
    expect(v.values.efficiency_20d).toBeNull();
    expect(v.values.atr_percentile).toBeNull();
    // The short-horizon one is still unavailable at 3 bars but must not throw.
    expect(v.errored).toEqual([]);
  });

  /*
   * The look-ahead guard, in the form this codebase has standardised on:
   * truncate the world to the decision instant and require an identical
   * answer. If any feature reached past `asOf`, these would diverge.
   */
  it("is point-in-time safe: features at T are unchanged by the existence of bars after T", () => {
    const full = new InMemoryDataSource([{ meta: cryptoMeta, bars: { "1D": bars(TREND) } }]);
    const truncated = new InMemoryDataSource([
      { meta: cryptoMeta, bars: { "1D": bars(TREND.slice(0, 121)) } },
    ]);
    const a = extractFeatures(UNIVERSAL_FEATURES, ctxAt(full, "BTC-USD", 120 * DAY));
    const b = extractFeatures(UNIVERSAL_FEATURES, ctxAt(truncated, "BTC-USD", 120 * DAY));
    expect(a.values).toEqual(b.values);
  });

  it("marks a feature unavailable, not null-valued, when its capability is missing", () => {
    const source = sourceWith();
    const needsFunding: FeatureDefinition = {
      key: "funding_rate",
      description: "Perp funding.",
      kind: "numeric",
      requires: ["funding"],
      extract: () => 0.01,
    };
    const v = extractFeatures([...UNIVERSAL_FEATURES, needsFunding], ctxAt(source, "SPY", 199 * DAY));
    expect(v.unavailable).toContain("funding_rate");
    expect(v.values.funding_rate).toBeNull();
    // The universal ones still computed — one missing capability must not void the record.
    expect(v.values.return_20d).not.toBeNull();
  });

  it("isolates a throwing extractor instead of losing the whole vector", () => {
    const source = sourceWith();
    const broken: FeatureDefinition = {
      key: "boom",
      description: "Always throws.",
      kind: "numeric",
      requires: ["ohlcv"],
      extract: () => {
        throw new Error("nope");
      },
    };
    const v = extractFeatures([...UNIVERSAL_FEATURES, broken], ctxAt(source, "BTC-USD", 199 * DAY));
    expect(v.errored).toEqual(["boom"]);
    expect(v.values.boom).toBeNull();
    expect(v.values.return_20d).not.toBeNull();
  });
});

describe("capability-gated modules — the engine never asks what asset it is", () => {
  const cryptoOnly: EvidenceModule<string> = {
    id: "funding-read",
    description: "Crypto-only.",
    requires: ["funding"],
    compute: () => "funding says neutral",
  };
  const universal: EvidenceModule<string> = {
    id: "trend-read",
    description: "Works anywhere.",
    requires: ["ohlcv"],
    compute: () => "trend is up",
  };
  const inconclusive: EvidenceModule<string> = {
    id: "quiet",
    description: "Runs but concludes nothing.",
    requires: ["ohlcv"],
    compute: () => null,
  };
  const broken: EvidenceModule<string> = {
    id: "broken",
    description: "Throws.",
    requires: ["ohlcv"],
    compute: () => {
      throw new Error("kaboom");
    },
  };

  it("runs a crypto module on crypto and skips it on an equity, with no asset-class branch anywhere", () => {
    const source = sourceWith({ funding: { points: [{ knownAtT: 0, value: 0.01 }] } });
    const mods = [cryptoOnly, universal];

    const onCrypto = runModules(mods, ctxAt(source, "BTC-USD", 199 * DAY));
    expect(onCrypto.map((o) => o.status)).toEqual(["ok", "ok"]);

    const onEquity = runModules(mods, ctxAt(source, "SPY", 199 * DAY));
    expect(onEquity[0].status).toBe("skipped-missing-capability");
    expect(onEquity[0].missing).toEqual(["funding"]);
    expect(onEquity[1].status).toBe("ok");
  });

  it("distinguishes skipped, inconclusive and errored — three different facts", () => {
    const source = sourceWith();
    const out = runModules([cryptoOnly, inconclusive, broken], ctxAt(source, "SPY", 199 * DAY));
    expect(out[0].status).toBe("skipped-missing-capability");
    expect(out[1].status).toBe("no-conclusion");
    expect(out[2].status).toBe("errored");
    expect(out[2].error).toContain("kaboom");
  });

  it("one broken module does not prevent the others from running", () => {
    const source = sourceWith();
    const out = runModules([broken, universal], ctxAt(source, "BTC-USD", 199 * DAY));
    expect(out[0].status).toBe("errored");
    expect(out[1].status).toBe("ok");
    expect(out[1].value).toBe("trend is up");
  });
});
