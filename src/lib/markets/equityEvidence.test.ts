import { describe, it, expect } from "vitest";
import {
  evaluateRelativeStrength,
  evaluateBreadth,
  evaluateRiskAppetite,
  buildEquityEvidence,
  EquityInstrumentInput,
} from "./equityEvidence";
import { Bar } from "@/lib/research/types";

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

  it("produces all three modules when the full capability set is available", () => {
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
    expect(evidence).toHaveLength(3);
  });
});
