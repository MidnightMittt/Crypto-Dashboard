import { describe, it, expect } from "vitest";
import { shouldRecord, BiasHistoryEntry } from "./biasHistory";
import { Verdict } from "../signals/types";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const entry = (
  t: number,
  score: number,
  verdict: Verdict = "bullish",
  regime: string | null = "Leaning Bullish"
): BiasHistoryEntry => ({ t, score, verdict, regime, reasons: [], topRisk: null });

/**
 * The recording rule IS the feature. A timeline that logs every poll buries
 * the two moments that mattered under ninety identical rows; one that logs
 * too little misses the turn. These pin both failure modes.
 */
describe("shouldRecord", () => {
  it("always records the first entry", () => {
    expect(shouldRecord(undefined, entry(0, 60))).toBe(true);
  });

  it("records when the verdict flips", () => {
    const prev = entry(0, 60, "bullish");
    expect(shouldRecord(prev, entry(HOUR, 58, "bearish"))).toBe(true);
  });

  it("records when the regime changes even at a similar score", () => {
    const prev = entry(0, 60, "bullish", "Leaning Bullish");
    expect(shouldRecord(prev, entry(HOUR, 61, "bullish", "Trending Bullish"))).toBe(true);
  });

  it("records a meaningful score move", () => {
    const prev = entry(0, 50);
    expect(shouldRecord(prev, entry(HOUR, 60))).toBe(true);
  });

  it("ignores score jitter that carries no meaning", () => {
    // The whole point: 96 near-identical rows a day is worse than none.
    const prev = entry(0, 50);
    expect(shouldRecord(prev, entry(HOUR, 53))).toBe(false);
  });

  it("records a heartbeat so a genuinely flat day still shows as flat", () => {
    const prev = entry(0, 50);
    expect(shouldRecord(prev, entry(5 * HOUR, 50))).toBe(true);
  });

  it("does not heartbeat before the interval elapses", () => {
    const prev = entry(0, 50);
    expect(shouldRecord(prev, entry(2 * HOUR, 50))).toBe(false);
  });

  it("suppresses a burst even when the verdict flips inside the minimum gap", () => {
    // Several requests can fill the cache in the same minute; without this
    // one volatile moment would write several rows.
    const prev = entry(0, 50, "bullish");
    expect(shouldRecord(prev, entry(2 * MIN, 80, "bearish"))).toBe(false);
  });

  it("records that same flip once the minimum gap has passed", () => {
    const prev = entry(0, 50, "bullish");
    expect(shouldRecord(prev, entry(11 * MIN, 80, "bearish"))).toBe(true);
  });

  it("treats a null regime as a real value rather than always-changed", () => {
    const prev = entry(0, 50, "neutral", null);
    expect(shouldRecord(prev, entry(HOUR, 51, "neutral", null))).toBe(false);
  });
});
