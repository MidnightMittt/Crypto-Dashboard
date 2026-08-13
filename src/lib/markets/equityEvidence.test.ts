import { describe, it, expect } from "vitest";
import {
  evaluateRelativeStrength,
  evaluateBreadth,
  evaluateRiskAppetite,
  evaluateVolatilityRegime,
  evaluateTrendQuality,
  evaluateMarketStructure,
  buildEquityEvidence,
  EquityInstrumentInput,
} from "./equityEvidence";
import { Bar } from "@/lib/research/types";
import { contributionOf } from "@/lib/signals/categories";
import { weightForBasis } from "@/lib/signals/scoring";

/**
 * Constructed series, hand-reasoned before being asserted — the discipline
 * metrics.test.ts and tradeExecution.test.ts follow. These verdicts are shown
 * to someone sizing a position, so each rule is pinned to a case a human can
 * check rather than to a snapshot.
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);

/** A series of `n` daily bars whose close compounds at `dailyPct` per session. */
function series(symbol: string, n: number, dailyPct: number, start = 100): EquityInstrumentInput {
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    bars.push({ t: T0 + i * DAY, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 });
    close *= 1 + dailyPct / 100;
  }
  return { symbol, bars };
}

/** Flat for most of history, then a sharp move over the final `moveSessions`. */
function flatThenMove(symbol: string, n: number, moveSessions: number, movePct: number): EquityInstrumentInput {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const inMove = i >= n - moveSessions;
    const progress = inMove ? (i - (n - moveSessions) + 1) / moveSessions : 0;
    const close = 100 * (1 + (movePct / 100) * progress);
    bars.push({ t: T0 + i * DAY, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 });
  }
  return { symbol, bars };
}

const ASOF = T0 + 900 * DAY;

describe("evaluateRelativeStrength", () => {
  it("returns null for the benchmark against itself — a non-observation, not neutral evidence", () => {
    const spy = series("SPY", 600, 0.05);
    expect(evaluateRelativeStrength(spy, spy, ASOF)).toBeNull();
  });

  it("returns null when there is not enough history to form a distribution", () => {
    const a = series("QQQ", 70, 0.1);
    const b = series("SPY", 70, 0.05);
    expect(evaluateRelativeStrength(a, b, ASOF)).toBeNull();
  });

  it("reads bullish when an instrument breaks out against a flat benchmark", () => {
    // Flat for 540 sessions, then +25% over the last 60 — far and away the
    // strongest relative reading in its own history.
    const leader = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    const v = evaluateRelativeStrength(leader, bench, ASOF)!;
    expect(v.verdict).toBe("bullish");
    expect(v.confidence).toBeGreaterThan(50);
    expect(v.id).toBe("equityRelativeStrength");
  });

  it("reads bearish when an instrument breaks DOWN against a flat benchmark", () => {
    const laggard = flatThenMove("IWM", 600, 60, -25);
    const bench = series("SPY", 600, 0);
    const v = evaluateRelativeStrength(laggard, bench, ASOF)!;
    expect(v.verdict).toBe("bearish");
  });

  it("is neutral when both rise together — outperformance, not direction, is the measure", () => {
    // Both compound identically, so relative strength is ~0 throughout and
    // the latest reading is unremarkable against its own history.
    const a = series("VTI", 600, 0.05);
    const b = series("SPY", 600, 0.05);
    const v = evaluateRelativeStrength(a, b, ASOF)!;
    expect(v.verdict).toBe("neutral");
    expect(v.confidence).toBeLessThan(40);
  });

  it("aligns the benchmark by timestamp, not index, when calendars differ", () => {
    // The benchmark starts 100 sessions earlier, so equal indices are
    // different dates. Index alignment would compare mismatched windows and
    // manufacture a signal out of nothing.
    const inst = series("XLF", 600, 0);
    const longBench: EquityInstrumentInput = { symbol: "SPY", bars: [] };
    let close = 100;
    for (let i = 0; i < 700; i++) {
      longBench.bars.push({
        t: T0 - 100 * DAY + i * DAY,
        open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000,
      });
    }
    const v = evaluateRelativeStrength(inst, longBench, ASOF)!;
    // Both series are genuinely flat, so a correct comparison is neutral.
    expect(v.verdict).toBe("neutral");
  });

  it("states the percentile it used, so the verdict is auditable", () => {
    const v = evaluateRelativeStrength(flatThenMove("QQQ", 600, 60, 25), series("SPY", 600, 0), ASOF)!;
    expect(v.explanation).toMatch(/percentile/);
    expect(v.confidenceBasis).toMatch(/percentile/);
  });
});

describe("evaluateBreadth", () => {
  const above = (s: string) => flatThenMove(s, 200, 20, 10); // ends above its own 50d average
  const below = (s: string) => flatThenMove(s, 200, 20, -10);

  it("returns null when too few instruments report", () => {
    expect(evaluateBreadth([above("SPY"), above("QQQ")], ASOF)).toBeNull();
  });

  it("reads bullish when most of the complex is above its own average", () => {
    const v = evaluateBreadth([above("SPY"), above("QQQ"), above("DIA"), above("IWM"), below("XLF")], ASOF)!;
    expect(v.verdict).toBe("bullish"); // 4/5 = 80%
    expect(v.explanation).toMatch(/80%/);
  });

  it("reads bearish when most of the complex is below", () => {
    const v = evaluateBreadth([below("SPY"), below("QQQ"), below("DIA"), below("IWM"), above("XLF")], ASOF)!;
    expect(v.verdict).toBe("bearish"); // 1/5 = 20%
  });

  it("flags split participation as a conflict rather than smoothing it", () => {
    const v = evaluateBreadth([above("SPY"), above("QQQ"), below("DIA"), below("IWM")], ASOF)!;
    expect(v.verdict).toBe("neutral"); // 50%
    expect(v.conflicts.length).toBeGreaterThan(0);
  });

  it("caps confidence and labels itself a proxy — it is not an advance/decline line", () => {
    const v = evaluateBreadth([above("SPY"), above("QQQ"), above("DIA"), above("IWM"), above("XLF")], ASOF)!;
    expect(v.confidence).toBeLessThanOrEqual(60);
    expect(v.label).toMatch(/proxy/i);
    expect(v.confidenceBasis).toMatch(/PROXY/);
  });
});

describe("evaluateRiskAppetite", () => {
  it("returns null when either leg is missing — never guesses one side", () => {
    const hyg = series("HYG", 600, 0.02);
    expect(evaluateRiskAppetite(hyg, undefined, ASOF)).toBeNull();
    expect(evaluateRiskAppetite(undefined, hyg, ASOF)).toBeNull();
  });

  it("reads bullish when credit sharply outperforms duration", () => {
    const credit = flatThenMove("HYG", 600, 20, 8);
    const duration = series("TLT", 600, 0);
    const v = evaluateRiskAppetite(credit, duration, ASOF)!;
    expect(v.verdict).toBe("bullish");
    expect(v.explanation).toMatch(/outperforming/);
  });

  it("reads bearish on a flight to duration", () => {
    const credit = flatThenMove("HYG", 600, 20, -8);
    const duration = series("TLT", 600, 0);
    const v = evaluateRiskAppetite(credit, duration, ASOF)!;
    expect(v.verdict).toBe("bearish");
    expect(v.explanation).toMatch(/rotating into duration/);
  });
});

describe("buildEquityEvidence", () => {
  it("drops unavailable modules rather than emitting placeholder verdicts", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    // No credit/duration supplied, so risk appetite must be absent entirely.
    const evidence = buildEquityEvidence({
      instrument: inst,
      benchmark: bench,
      universe: [inst, bench, series("DIA", 600, 0), series("IWM", 600, 0)],
      asOf: ASOF,
    });
    const ids = evidence.map((e) => e.id);
    expect(ids).toContain("equityRelativeStrength");
    expect(ids).toContain("equityBreadth");
    expect(ids).not.toContain("equityRiskAppetite");
  });

  it("emits the MetricVerdict contract the crypto engine already consumes", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    const [first] = buildEquityEvidence({
      instrument: inst,
      benchmark: bench,
      universe: [inst, bench, series("DIA", 600, 0), series("IWM", 600, 0)],
      credit: flatThenMove("HYG", 600, 20, 8),
      duration: series("TLT", 600, 0),
      asOf: ASOF,
    });
    // Same shape every crypto evaluator produces — this is what lets
    // buildMarketBias score an equity with no equity-specific code path.
    for (const key of [
      "id", "label", "verdict", "confidence", "confidenceBasis",
      "explanation", "whyItMatters", "asOf", "conflicts", "nextTrigger",
    ]) {
      expect(first).toHaveProperty(key);
    }
    expect(first.confidence).toBeGreaterThanOrEqual(0);
    expect(first.confidence).toBeLessThanOrEqual(100);
  });

  it("omits market structure on a series with no swing sequence, rather than guessing", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    const evidence = buildEquityEvidence({
      instrument: inst,
      benchmark: bench,
      universe: [inst, bench, series("DIA", 600, 0), series("IWM", 600, 0)],
      credit: flatThenMove("HYG", 600, 20, 8),
      duration: series("TLT", 600, 0),
      asOf: ASOF,
    });
    // A flat-then-ramp path has no pivots, so market structure correctly
    // returns null and the other five modules report. Absence here is the
    // module refusing to read a sequence that does not exist.
    expect(evidence).toHaveLength(5);
    expect(evidence.map((e) => e.id)).not.toContain("marketStructure");
  });
});

/** A series with controllable per-session noise, for exercising path efficiency. */
function noisy(symbol: string, n: number, driftPct: number, noisePct: number): EquityInstrumentInput {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    // Deterministic alternating noise — no PRNG, so the test cannot flake.
    const noise = (i % 2 === 0 ? 1 : -1) * noisePct;
    close = close * (1 + (driftPct + noise) / 100);
    const span = Math.abs(close * (noisePct / 100)) + 0.01;
    bars.push({ t: T0 + i * DAY, open: close, high: close + span, low: close - span, close, volume: 1000 });
  }
  return { symbol, bars };
}

describe("evaluateVolatilityRegime", () => {
  it("returns null without enough history to form a distribution", () => {
    expect(evaluateVolatilityRegime(series("SPY", 30, 0.05), ASOF)).toBeNull();
  });

  it("reads BEARISH on elevated volatility — vol expands into equity drawdowns", () => {
    // Calm for 540 sessions, then a violently wide-ranged final stretch.
    const calm = noisy("SPY", 540, 0.02, 0.1).bars;
    const stressed = noisy("SPY", 60, -0.2, 3).bars.map((b, i) => ({ ...b, t: T0 + (540 + i) * DAY }));
    const v = evaluateVolatilityRegime({ symbol: "SPY", bars: [...calm, ...stressed] }, ASOF)!;
    expect(v.verdict).toBe("bearish");
    expect(v.explanation).toMatch(/Elevated volatility/);
  });

  it("halves confidence — a conditional regularity must not outweigh a direct read", () => {
    const calm = noisy("SPY", 540, 0.02, 0.1).bars;
    const stressed = noisy("SPY", 60, -0.2, 3).bars.map((b, i) => ({ ...b, t: T0 + (540 + i) * DAY }));
    const v = evaluateVolatilityRegime({ symbol: "SPY", bars: [...calm, ...stressed] }, ASOF)!;
    expect(v.confidence).toBeLessThanOrEqual(50);
    expect(v.confidenceBasis).toMatch(/halved/);
  });
});

describe("evaluateTrendQuality", () => {
  it("returns null when history is shorter than the window", () => {
    expect(evaluateTrendQuality(series("SPY", 30, 0.1), ASOF)).toBeNull();
  });

  it("reads bullish with high confidence on a clean upward path", () => {
    // A straight line: efficiency is 1.0 by construction.
    const v = evaluateTrendQuality(series("QQQ", 200, 0.2), ASOF)!;
    expect(v.verdict).toBe("bullish");
    expect(v.confidence).toBe(100);
    expect(v.explanation).toMatch(/clean, persistent path/);
  });

  it("reads bearish on a clean downward path", () => {
    const v = evaluateTrendQuality(series("IWM", 200, -0.2), ASOF)!;
    expect(v.verdict).toBe("bearish");
  });

  it("refuses a direction when the path is a round trip, and says so", () => {
    // Tiny drift swamped by alternating noise — the sign is positive but the
    // path is chop. Claiming "bullish" here is the false precision the
    // deadband exists to prevent.
    const v = evaluateTrendQuality(noisy("XLF", 200, 0.001, 2), ASOF)!;
    expect(v.verdict).toBe("neutral");
    expect(v.conflicts.length).toBeGreaterThan(0);
    expect(v.explanation).toMatch(/round trip/);
  });

  it("scales confidence with efficiency, not with the size of the move", () => {
    const clean = evaluateTrendQuality(series("A", 200, 0.05), ASOF)!;   // small but perfectly efficient
    const choppy = evaluateTrendQuality(noisy("B", 200, 0.05, 1.5), ASOF)!; // larger swings, poor path
    expect(clean.confidence).toBeGreaterThan(choppy.confidence);
  });
});

/**
 * Builds a series from explicit pivot values so the swing sequence under test
 * is stated in the fixture rather than emerging from noise. Each pivot is
 * separated by enough filler for the centered fractal detector to see it.
 */
// gap 20 keeps every fixture above the module's 60-bar minimum: the first
// draft used 8, produced 56 bars, and every case returned null.
function withPivots(symbol: string, pivots: number[], gap = 20): EquityInstrumentInput {
  const closes: number[] = [];
  for (let p = 0; p < pivots.length; p++) {
    const from = p === 0 ? pivots[0] : pivots[p - 1];
    for (let k = 1; k <= gap; k++) closes.push(from + ((pivots[p] - from) * k) / gap);
  }
  /*
   * The tail must REVERSE toward the previous pivot, not simply drift down.
   * A descending tail never brackets a final swing LOW, so the detector
   * silently loses it — which is what made the broadening-range and coil
   * cases fail on the first draft.
   */
  const last = pivots[pivots.length - 1];
  const prior = pivots.length > 1 ? pivots[pivots.length - 2] : last;
  for (let k = 1; k <= gap; k++) closes.push(last + ((prior - last) * k) / (gap * 2));

  const bars: Bar[] = closes.map((c, i) => ({
    t: T0 + i * DAY, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000,
  }));
  return { symbol, bars };
}

describe("evaluateMarketStructure", () => {
  it("returns null without enough pivots to form a sequence", () => {
    // One high and one low is a location, not a direction.
    expect(evaluateMarketStructure(withPivots("SPY", [100, 120]), ASOF)).toBeNull();
  });

  it("reads bullish on higher highs AND higher lows", () => {
    const v = evaluateMarketStructure(withPivots("SPY", [100, 130, 110, 150, 125, 170]), ASOF)!;
    expect(v.verdict).toBe("bullish");
    expect(v.explanation).toMatch(/higher highs and higher lows/);
    expect(v.confidence).toBeGreaterThan(0);
  });

  it("reads bearish on lower highs AND lower lows", () => {
    const v = evaluateMarketStructure(withPivots("IWM", [170, 125, 150, 110, 130, 90]), ASOF)!;
    expect(v.verdict).toBe("bearish");
    expect(v.explanation).toMatch(/lower highs and lower lows/);
  });

  it("refuses a direction on a broadening range, and names it", () => {
    // Higher highs with LOWER lows: volatility expanding, no trend. Calling
    // this bullish because one leg rose is the half-read the module refuses.
    const v = evaluateMarketStructure(withPivots("QQQ", [100, 140, 90, 160, 70]), ASOF)!;
    expect(v.verdict).toBe("neutral");
    expect(v.confidence).toBe(0);
    expect(v.conflicts.length).toBeGreaterThan(0);
    expect(v.explanation).toMatch(/broadening range/);
  });

  it("refuses a direction on a coil, and says it resolves on the break", () => {
    const v = evaluateMarketStructure(withPivots("DIA", [70, 160, 90, 140, 100, 130]), ASOF)!;
    expect(v.verdict).toBe("neutral");
    expect(v.explanation).toMatch(/coil/);
    expect(v.nextTrigger).toMatch(/resolves on a close outside/);
  });

  it("names the level that would break the structure", () => {
    const v = evaluateMarketStructure(withPivots("SPY", [100, 130, 110, 150, 125, 170]), ASOF)!;
    expect(v.nextTrigger).toMatch(/breaks down below the last swing low/);
  });

  it("caps confidence at 75 — a two-pivot sequence is real but short", () => {
    const v = evaluateMarketStructure(withPivots("SPY", [10, 200, 20, 400, 30, 600]), ASOF)!;
    expect(v.confidence).toBeLessThanOrEqual(75);
  });
});

describe("evidence module contract — market structure as the reference", () => {
  const uptrend = () => withPivots("SPY", [100, 130, 110, 150, 125, 170]);

  it("emits discrete evidenceFor claims, not prose", () => {
    const v = evaluateMarketStructure(uptrend(), ASOF)!;
    expect(v.evidenceFor!.length).toBeGreaterThanOrEqual(3);
    expect(v.evidenceFor!.some((e) => /Higher high confirmed/.test(e))).toBe(true);
    expect(v.evidenceFor!.some((e) => /no structural break/i.test(e))).toBe(true);
  });

  it("gives a NEUTRAL verdict no supporting evidence — absence is not a body of evidence", () => {
    const v = evaluateMarketStructure(withPivots("QQQ", [100, 140, 90, 160, 70]), ASOF)!;
    expect(v.verdict).toBe("neutral");
    expect(v.evidenceFor).toEqual([]);
    expect(v.conflicts.length).toBeGreaterThan(0);
  });

  it("carries measurements in `supporting` so no UI re-derives them", () => {
    const v = evaluateMarketStructure(uptrend(), ASOF)!;
    const labels = v.supporting!.map((s) => s.label);
    expect(labels).toContain("Last swing high");
    expect(labels).toContain("Swing lows");
  });

  it("reports level distances when a level provider supplies them", () => {
    const v = evaluateMarketStructure(uptrend(), ASOF, { supportPct: 3.2, resistancePct: 7.8 })!;
    const s = v.supporting!;
    expect(s.find((x) => x.label === "Nearest support")!.value).toBe("3.2% below");
    expect(s.find((x) => x.label === "Nearest resistance")!.value).toBe("7.8% above");
  });

  it("still produces a complete verdict when no level provider is available", () => {
    const v = evaluateMarketStructure(uptrend(), ASOF)!;
    expect(v.verdict).toBe("bullish");
    expect(v.supporting!.some((x) => x.label.startsWith("Nearest"))).toBe(false);
  });

  it("declares NO score or risk contribution — those are the engine's to derive", () => {
    const v = evaluateMarketStructure(uptrend(), ASOF)! as unknown as Record<string, unknown>;
    expect(v.scoreContribution).toBeUndefined();
    expect(v.riskContribution).toBeUndefined();
  });
});

describe("contributionOf — derived by the engine, never declared", () => {
  it("shares out by weight x confidence and sums to ~100", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    const all = buildEquityEvidence({
      instrument: inst, benchmark: bench,
      universe: [inst, bench, series("DIA", 600, 0), series("IWM", 600, 0)],
      credit: flatThenMove("HYG", 600, 20, 8), duration: series("TLT", 600, 0),
      asOf: ASOF,
    });
    // Equity modules combine on the STATE basis (they stopped voting on the
    // edge basis when TRANSITIONAL_STATE_VOTERS was retired), so their
    // contribution shares only exist against the state weights.
    const stateWeights = weightForBasis("state");
    const total = all.reduce((sum, m) => sum + contributionOf(m, all, stateWeights).sharePct, 0);
    expect(total).toBeGreaterThanOrEqual(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it("gives the SAME module a bigger share on a thinner evidence base", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const bench = series("SPY", 600, 0);
    const universe = [inst, bench, series("DIA", 600, 0), series("IWM", 600, 0)];
    const thin = buildEquityEvidence({ instrument: inst, benchmark: bench, universe, asOf: ASOF });
    const rich = buildEquityEvidence({
      instrument: inst, benchmark: bench, universe,
      credit: flatThenMove("HYG", 600, 20, 8), duration: series("TLT", 600, 0), asOf: ASOF,
    });
    const pick = (ms: typeof thin) => ms.find((m) => m.id === "equityRelativeStrength")!;
    const stateWeights = weightForBasis("state");
    // This is the whole reason contribution cannot be a module export: the
    // same module is worth more when fewer others reported.
    expect(contributionOf(pick(thin), thin, stateWeights).sharePct)
      .toBeGreaterThan(contributionOf(pick(rich), rich, stateWeights).sharePct);
  });

  it("reports the metric's category, or null for an unregistered id", () => {
    const inst = flatThenMove("QQQ", 600, 60, 25);
    const all = buildEquityEvidence({
      instrument: inst, benchmark: series("SPY", 600, 0),
      universe: [inst, series("SPY", 600, 0), series("DIA", 600, 0), series("IWM", 600, 0)],
      asOf: ASOF,
    });
    expect(contributionOf(all[0], all).category).not.toBeNull();
    const orphan = { ...all[0], id: "notRegisteredAnywhere" };
    expect(contributionOf(orphan, all).category).toBeNull();
  });
});
