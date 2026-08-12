import { describe, expect, it } from "vitest";
import { validateBars, assertValid, summarizeReport } from "./validation";
import { UNIVERSE, validateUniverse, findInstrument, liveAt, instrumentsByProvider } from "./universe";
import { Bar, InstrumentMeta, CONTINUOUS_SESSION, US_EQUITY_SESSION } from "./types";

const DAY = 86_400_000;

const equityMeta: InstrumentMeta = {
  id: "TEST.US",
  displaySymbol: "TEST",
  assetClass: "equity-etf",
  sessionModel: US_EQUITY_SESSION,
  adjustment: "splits-and-dividends",
  inceptionT: Date.UTC(2000, 0, 1),
  delistedT: null,
  quoteCurrency: "USD",
};

const cryptoMeta: InstrumentMeta = {
  ...equityMeta,
  id: "TEST-PERP",
  assetClass: "crypto",
  sessionModel: CONTINUOUS_SESSION,
  adjustment: "none",
};

function bar(t: number, close = 100, volume: number | null = 1000): Bar {
  return { t, open: close, high: close * 1.01, low: close * 0.99, close, volume };
}

/** Weekday-only daily closes at 16:00 ET (20:00Z, EDT), starting on a Monday. */
function tradingDays(count: number, startUTC = Date.UTC(2024, 5, 3, 20)): Bar[] {
  const out: Bar[] = [];
  let t = startUTC;
  while (out.length < count) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(bar(t, 100 + out.length * 0.1));
    t += DAY;
  }
  return out;
}

/** Continuous daily closes at 00:00Z. */
function continuousDays(count: number, startUTC = Date.UTC(2024, 5, 3)): Bar[] {
  return Array.from({ length: count }, (_, i) => bar(startUTC + i * DAY, 100 + i * 0.1));
}

describe("clean series pass", () => {
  it("a well-formed equity series passes with no errors", () => {
    const r = validateBars(equityMeta, tradingDays(300), "1D");
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  it("a well-formed continuous series passes", () => {
    const r = validateBars(cryptoMeta, continuousDays(300), "1D");
    expect(r.passed).toBe(true);
    expect(r.errors).toBe(0);
  });

  it("summarizeReport is readable", () => {
    expect(summarizeReport(validateBars(equityMeta, tradingDays(60), "1D"))).toMatch(/TEST\.US 1D: 60 bars, PASS/);
  });
});

describe("1. sorted timestamps", () => {
  it("fails on out-of-order bars", () => {
    const bars = tradingDays(20);
    [bars[5], bars[6]] = [bars[6], bars[5]];
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "sorted")).toBe(true);
  });
});

describe("2. duplicate detection", () => {
  it("fails on a repeated timestamp", () => {
    const bars = tradingDays(20);
    bars[7] = { ...bars[7], t: bars[6].t };
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "duplicates")).toBe(true);
  });

  it("reports a duplicate as a duplicate, not as an ordering error", () => {
    const bars = tradingDays(10);
    bars[5] = { ...bars[5], t: bars[4].t };
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.findings.filter((f) => f.check === "duplicates").length).toBeGreaterThan(0);
  });
});

describe("3. OHLC sanity", () => {
  it("fails when high is below low", () => {
    const bars = tradingDays(10);
    bars[3] = { ...bars[3], high: 50, low: 150 };
    expect(validateBars(equityMeta, bars, "1D").findings.some((f) => f.check === "ohlc-range")).toBe(true);
  });

  it("fails when high/low do not contain open/close", () => {
    const bars = tradingDays(10);
    bars[3] = { ...bars[3], open: 200, high: 101, low: 99, close: 100 };
    expect(validateBars(equityMeta, bars, "1D").findings.some((f) => f.check === "ohlc-containment")).toBe(true);
  });

  it("fails on a non-positive price", () => {
    const bars = tradingDays(10);
    bars[2] = { ...bars[2], low: 0, open: 0, high: 1, close: 1 };
    expect(validateBars(equityMeta, bars, "1D").findings.some((f) => f.check === "ohlc-positive")).toBe(true);
  });

  it("fails on NaN", () => {
    const bars = tradingDays(10);
    bars[1] = { ...bars[1], close: NaN };
    expect(validateBars(equityMeta, bars, "1D").findings.some((f) => f.check === "ohlc-finite")).toBe(true);
  });
});

describe("4. volume sanity", () => {
  it("fails on negative volume", () => {
    const bars = tradingDays(10);
    bars[4] = { ...bars[4], volume: -5 };
    expect(validateBars(equityMeta, bars, "1D").findings.some((f) => f.check === "volume-non-negative")).toBe(true);
  });

  it("warns (does not fail) on an all-zero volume column", () => {
    const bars = tradingDays(30).map((b) => ({ ...b, volume: 0 }));
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(true);
    expect(r.findings.some((f) => f.check === "volume-all-zero" && f.severity === "warning")).toBe(true);
  });

  it("accepts null volume without complaint — genuinely absent is not an error", () => {
    const bars = tradingDays(30).map((b) => ({ ...b, volume: null }));
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(true);
    expect(r.findings.some((f) => f.check.startsWith("volume"))).toBe(false);
  });
});

describe("5. session validation", () => {
  it("fails when a session-based instrument prints a weekend bar", () => {
    const bars = tradingDays(20);
    // Saturday 8 June 2024, 20:00Z.
    bars.push(bar(Date.UTC(2024, 5, 8, 20)));
    bars.sort((a, b) => a.t - b.t);
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "session-weekday")).toBe(true);
  });

  it("permits weekend bars for a continuous instrument", () => {
    const r = validateBars(cryptoMeta, continuousDays(60), "1D");
    expect(r.findings.some((f) => f.check === "session-weekday")).toBe(false);
  });
});

describe("6. timezone / session-key validation", () => {
  /*
   * The check that catches a WRONG SessionModel rather than wrong data. If
   * two daily bars collapse onto one session key, the panel estimator would
   * treat two independent days as contemporaneous and understate the sample.
   */
  it("fails when two daily bars map to the same session date", () => {
    const bars = [bar(Date.UTC(2024, 5, 3, 14)), bar(Date.UTC(2024, 5, 3, 20))];
    const r = validateBars(equityMeta, bars, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "session-key-collision")).toBe(true);
  });

  it("does not flag genuinely distinct sessions", () => {
    expect(validateBars(equityMeta, tradingDays(50), "1D").findings.some((f) => f.check === "session-key-collision")).toBe(false);
  });
});

describe("7. missing bars / calendar continuity", () => {
  it("fails a continuous market on any missing bar", () => {
    const bars = continuousDays(40);
    bars.splice(20, 3);
    const r = validateBars(cryptoMeta, bars, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "continuity")).toBe(true);
  });

  it("does NOT fail a session market for weekends — that would be pure noise", () => {
    const r = validateBars(equityMeta, tradingDays(250), "1D");
    expect(r.findings.some((f) => f.check === "continuity")).toBe(false);
  });

  it("fails a session market when coverage falls materially short of its declared bars-per-year", () => {
    // Keep every third trading day across a long span: ~84/year vs 252.
    const sparse = tradingDays(750).filter((_, i) => i % 3 === 0);
    const r = validateBars(equityMeta, sparse, "1D");
    expect(r.passed).toBe(false);
    expect(r.findings.some((f) => f.check === "continuity")).toBe(true);
  });

  it("warns on a gap longer than any regular market closure", () => {
    const bars = tradingDays(120);
    const cut = bars.splice(60, 10);
    expect(cut.length).toBe(10);
    const r = validateBars(equityMeta, bars, "1D", { expectedCoverage: 0.5 });
    expect(r.findings.some((f) => f.check === "continuity-gap" && f.severity === "warning")).toBe(true);
  });
});

describe("8. listing-window bounds", () => {
  it("fails on a bar predating declared inception — guards against synthetic backfill", () => {
    const late: InstrumentMeta = { ...equityMeta, inceptionT: Date.UTC(2024, 5, 10) };
    expect(validateBars(late, tradingDays(20), "1D").findings.some((f) => f.check === "listing-window")).toBe(true);
  });

  it("fails on a bar after a declared delisting", () => {
    const dead: InstrumentMeta = { ...equityMeta, delistedT: Date.UTC(2024, 5, 5) };
    expect(validateBars(dead, tradingDays(20), "1D").findings.some((f) => f.check === "listing-window")).toBe(true);
  });

  it("a fully delisted instrument with in-window bars still passes — designed for, not merely tolerated", () => {
    const dead: InstrumentMeta = { ...equityMeta, delistedT: Date.UTC(2024, 7, 1) };
    const r = validateBars(dead, tradingDays(30), "1D");
    expect(r.passed).toBe(true);
  });
});

describe("no silent repairs", () => {
  it("validation never mutates the input", () => {
    const bars = tradingDays(30);
    bars[5] = { ...bars[5], high: 1, low: 1000 }; // deliberately broken
    const snapshot = JSON.stringify(bars);
    validateBars(equityMeta, bars, "1D");
    expect(JSON.stringify(bars)).toBe(snapshot);
  });

  it("assertValid throws loudly and names the failing checks", () => {
    const bars = tradingDays(20);
    bars[3] = { ...bars[3], high: 1, low: 1000 };
    expect(() => assertValid(equityMeta, bars, "1D")).toThrow(/failed validation/);
    expect(() => assertValid(equityMeta, bars, "1D")).toThrow(/ohlc-range/);
  });

  it("assertValid is silent on a clean series", () => {
    expect(() => assertValid(equityMeta, tradingDays(100), "1D")).not.toThrow();
  });

  it("an empty series fails rather than passing vacuously", () => {
    const r = validateBars(equityMeta, [], "1D");
    expect(r.passed).toBe(false);
  });
});

describe("universe registry — configuration, not implementation", () => {
  it("is structurally valid", () => {
    expect(validateUniverse()).toEqual([]);
  });

  it("registers the five proving ETFs alongside the existing crypto pair", () => {
    const ids = UNIVERSE.map((c) => c.meta.id);
    for (const s of ["SPY.US", "QQQ.US", "DIA.US", "IWM.US", "XLF.US"]) expect(ids).toContain(s);
    for (const s of ["BTC-USD-PERP", "ETH-USD-PERP"]) expect(ids).toContain(s);
  });

  it("uses stable ids distinct from bare tickers, since tickers get recycled", () => {
    expect(findInstrument("SPY.US")!.meta.displaySymbol).toBe("SPY");
    expect(findInstrument("SPY")).toBeNull();
  });

  it("assigns the correct session model per asset class without any per-ticker branch", () => {
    expect(findInstrument("SPY.US")!.meta.sessionModel.kind).toBe("session-based");
    expect(findInstrument("SPY.US")!.meta.sessionModel.gapsPossible).toBe(true);
    expect(findInstrument("BTC-USD-PERP")!.meta.sessionModel.kind).toBe("continuous");
    expect(findInstrument("BTC-USD-PERP")!.meta.sessionModel.gapsPossible).toBe(false);
  });

  it("declares capabilities per instrument, so modules degrade rather than special-case", () => {
    expect(findInstrument("BTC-USD-PERP")!.capabilities).toContain("funding");
    expect(findInstrument("SPY.US")!.capabilities).toEqual(["ohlcv"]);
  });

  it("groups by provider so a new data source is a new ingest script, not an engine change", () => {
    const yahoo = instrumentsByProvider("yahoo");
    const okx = instrumentsByProvider("okx");
    // Assert the PARTITION rather than a literal count: the registry is
    // expected to grow, and a test that pins its size just breaks on every
    // addition without checking anything meaningful.
    expect(yahoo.length + okx.length).toBe(UNIVERSE.length);
    expect(yahoo.every((c) => c.source.provider === "yahoo")).toBe(true);
    expect(okx.every((c) => c.source.provider === "okx")).toBe(true);
    expect(okx.map((c) => c.meta.displaySymbol).sort()).toEqual(["BTC", "ETH"]);
  });

  it("spans multiple asset classes, which is the whole point of the expansion", () => {
    const classes = new Set(UNIVERSE.map((c) => c.meta.assetClass));
    for (const k of ["crypto", "equity-etf", "bond", "commodity", "fx"]) expect(classes).toContain(k);
  });

  it("assigns FX the session model that models its weekend gap", () => {
    const eur = findInstrument("EURUSD.FX")!;
    expect(eur.meta.sessionModel.gapsPossible).toBe(true);
    expect(eur.meta.quoteCurrency).toBe("USD");
    // No corporate actions on a currency pair; "none" is accurate here.
    expect(eur.meta.adjustment).toBe("none");
  });

  it("does not demand price adjustment from instruments that have no corporate actions", () => {
    // FX and crypto legitimately declare "none"; flagging them would be a
    // false positive that trains people to ignore the check.
    const problems = validateUniverse();
    expect(problems).toEqual([]);
  });

  it("liveAt honours the listing window at both ends", () => {
    // Before QQQ existed (1999) but after SPY (1993).
    const ids1995 = liveAt(Date.UTC(1995, 0, 1)).map((c) => c.meta.id);
    expect(ids1995).toContain("SPY.US");
    expect(ids1995).not.toContain("QQQ.US");
    expect(liveAt(Date.UTC(2024, 0, 1)).length).toBe(UNIVERSE.length);
  });

  it("rejects a malformed config — the registry validates itself", () => {
    const bad = [
      { ...findInstrument("SPY.US")!, capabilities: [] },
      { ...findInstrument("QQQ.US")!, meta: { ...findInstrument("QQQ.US")!.meta, id: "SPY.US" } },
    ];
    const problems = validateUniverse(bad as typeof UNIVERSE);
    expect(problems.some((p) => /must declare "ohlcv"/.test(p))).toBe(true);
    expect(problems.some((p) => /Duplicate instrument id/.test(p))).toBe(true);
  });

  it("flags an exchange-traded fund declaring unadjusted prices", () => {
    const bad = [{ ...findInstrument("SPY.US")!, meta: { ...findInstrument("SPY.US")!.meta, adjustment: "none" as const } }];
    expect(validateUniverse(bad as typeof UNIVERSE).some((p) => /unadjusted prices corrupt returns/.test(p))).toBe(true);
  });
});
