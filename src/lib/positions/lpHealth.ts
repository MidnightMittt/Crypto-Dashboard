import { Thesis } from "./book";

/**
 * LP HEALTH MATH — coverage, yield, and the thesis evaluator. Pure.
 *
 * Every formula here carries a scar from the screener era, encoded as a rule:
 *
 *  - Sigma is measured on the TOKEN RATIO, never a USD leg. Using the base
 *    token's USD price on a stable-base pair once read the stablecoin's
 *    volatility and printed coverage of 766x. The caller passes a ratio
 *    sigma; this file cannot tell the difference, so the magnitude assertions
 *    below are the backstop.
 *
 *  - Yield comes from the 6h window, with decay = y6/y24 shown. One pool read
 *    2.32%/day on its 24h volume and 0.034%/day on its last 7 hours — 69x
 *    apart. A single window is a claim about the past day; the pair is a
 *    claim about the trend, and the trend is what a holder acts on.
 *
 *  - Never extrapolate silently: every rate carries its window.
 *
 *  - ASSERT MAGNITUDES. Every real bug in this project announced itself as an
 *    implausible magnitude, never as an exception — a 40-digit fee, a 766x
 *    coverage. plausible() refuses values outside generous physical bounds
 *    rather than letting them flow into a verdict.
 */

/** Generous physical bounds. Outside these, the number is a bug, not a market. */
export const BOUNDS = {
  sigmaDaily: { min: 0.0001, max: 3.0 }, // 0.01%/day to 300%/day
  coverage: { min: 0, max: 100 }, // 766x was a unit error, not a market
  feeYieldDailyPct: { min: 0, max: 50 },
} as const;

export class ImplausibleMagnitude extends Error {
  constructor(name: string, value: number, lo: number, hi: number) {
    super(
      `${name} = ${value} is outside plausible bounds [${lo}, ${hi}] — ` +
        `refusing to use it. Every real bug here announced itself as a magnitude, not an exception.`
    );
    this.name = "ImplausibleMagnitude";
  }
}

export function assertPlausible(name: keyof typeof BOUNDS, value: number): number {
  const { min, max } = BOUNDS[name];
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ImplausibleMagnitude(name, value, min, max);
  }
  return value;
}

/** Fee yield from a volume window, as %/day of pool reserve. */
export function feeYieldDailyPct(params: {
  volumeUsd: number;
  windowHours: number;
  feePips: number;
  /** Fraction of fees LPs keep after the protocol take (5/6 under feeProtocol 102). */
  lpKeep: number;
  reserveUsd: number;
}): number | null {
  const { volumeUsd, windowHours, feePips, lpKeep, reserveUsd } = params;
  if (!(reserveUsd > 0) || !(windowHours > 0) || !(volumeUsd >= 0)) return null;
  const dailyVolume = volumeUsd * (24 / windowHours);
  const pct = ((dailyVolume * (feePips / 1_000_000) * lpKeep) / reserveUsd) * 100;
  return assertPlausible("feeYieldDailyPct", pct);
}

/** feeProtocol → the fraction LPs keep. 102 packs 6|6 → 1/6 take each side. */
export function lpKeepFraction(feeProtocol: number): number {
  // v3 packs token1's denominator in the high 4 bits, token0's in the low 4.
  // 0 means no protocol take. Non-zero d means the protocol takes 1/d.
  const d0 = feeProtocol % 16;
  const d1 = Math.floor(feeProtocol / 16);
  const keep0 = d0 === 0 ? 1 : 1 - 1 / d0;
  const keep1 = d1 === 0 ? 1 : 1 - 1 / d1;
  // The two sides can differ in principle; fees accrue on both. Mean is honest
  // to within rounding for same-denominator packs (the only case seen: 102).
  return (keep0 + keep1) / 2;
}

export interface YieldReading {
  /** From the 6h window — the actionable number. */
  y6DailyPct: number | null;
  /** From the 24h window — the context number. */
  y24DailyPct: number | null;
  /** y6/y24. Below 1 the pool is slowing; 0.034/2.32 was the 69x lesson. */
  decay: number | null;
  windows: { fast: string; slow: string };
}

export function yieldReading(params: {
  vol6hUsd: number | null;
  vol24hUsd: number | null;
  feePips: number;
  lpKeep: number;
  reserveUsd: number | null;
}): YieldReading {
  const { vol6hUsd, vol24hUsd, feePips, lpKeep, reserveUsd } = params;
  const y6 =
    vol6hUsd !== null && reserveUsd !== null
      ? feeYieldDailyPct({ volumeUsd: vol6hUsd, windowHours: 6, feePips, lpKeep, reserveUsd })
      : null;
  const y24 =
    vol24hUsd !== null && reserveUsd !== null
      ? feeYieldDailyPct({ volumeUsd: vol24hUsd, windowHours: 24, feePips, lpKeep, reserveUsd })
      : null;
  return {
    y6DailyPct: y6,
    y24DailyPct: y24,
    decay: y6 !== null && y24 !== null && y24 > 0 ? y6 / y24 : null,
    windows: { fast: "6h", slow: "24h" },
  };
}

/**
 * Coverage = yield / LVR, with LVR = sigma^2/8 per day.
 *
 * RANGE-INVARIANT: concentration scales fees and LVR equally, so pool-level
 * yield against pool-level LVR is the position's coverage too. Sigma must be
 * the TOKEN-RATIO sigma — see the module header for the 766x scar.
 */
export function coverage(params: { yieldDailyPct: number | null; sigmaDaily: number | null }): number | null {
  const { yieldDailyPct, sigmaDaily } = params;
  if (yieldDailyPct === null || sigmaDaily === null) return null;
  assertPlausible("sigmaDaily", sigmaDaily);
  const lvrDailyPct = ((sigmaDaily * sigmaDaily) / 8) * 100;
  if (!(lvrDailyPct > 0)) return null;
  return assertPlausible("coverage", yieldDailyPct / lvrDailyPct);
}

/** One recorded read of a position's thesis metrics, persisted by the cron. */
export interface PositionRead {
  ts: string;
  id: string;
  /**
   * Whether the position was in range at this read. Carried separately from
   * the hours metric because the clock needs to distinguish "in range"
   * (clock reset) from "first read out of range" (clock at 0 but RUNNING) —
   * two states a single number collapses, which briefly produced a clock
   * that could never start.
   */
  inRange?: boolean | null;
  metrics: Partial<Record<Thesis["metric"], number | null>>;
}

export interface ThesisVerdict {
  metric: Thesis["metric"];
  rule: string;
  /** Latest value, or null when unmeasurable. */
  value: number | null;
  /**
   * "ok" — the rule holds. "broken" — violated on BOTH of the last two reads.
   * "breaking" — violated on the latest read only; one more confirms.
   * "unmeasured" — the metric could not be read.
   */
  state: "ok" | "breaking" | "broken" | "unmeasured";
  /** ISO of the first read of the current violation streak, when broken. */
  brokenSince: string | null;
}

function violates(t: Thesis, value: number | null): boolean | null {
  if (value === null) return null;
  return t.op === ">=" ? value < t.threshold : value > t.threshold;
}

/**
 * Evaluate one thesis against the read history (oldest first).
 *
 * BROKEN requires the violation on two CONSECUTIVE reads — a single stale API
 * read produced a false signal once, and this function is where that lesson
 * is enforced rather than remembered. brokenSince walks back to the start of
 * the violation streak, because "BROKEN since 09-29" is the actionable fact
 * and "broken now" hides how long it has been bleeding.
 */
export function evaluateThesis(t: Thesis, reads: readonly PositionRead[]): ThesisVerdict {
  const rule = `${t.metric} ${t.op} ${t.threshold}`;
  const vals = reads.map((r) => ({ ts: r.ts, v: r.metrics[t.metric] ?? null }));
  const latest = vals.length ? vals[vals.length - 1] : null;
  if (!latest || latest.v === null) {
    return { metric: t.metric, rule, value: latest?.v ?? null, state: "unmeasured", brokenSince: null };
  }
  const latestViolates = violates(t, latest.v);
  if (latestViolates === false) {
    return { metric: t.metric, rule, value: latest.v, state: "ok", brokenSince: null };
  }
  const prev = vals.length >= 2 ? vals[vals.length - 2] : null;
  const prevViolates = prev ? violates(t, prev.v) : null;
  if (prevViolates !== true) {
    return { metric: t.metric, rule, value: latest.v, state: "breaking", brokenSince: null };
  }
  // Walk back to the start of the consecutive-violation streak.
  let since = prev!.ts;
  for (let i = vals.length - 3; i >= 0; i--) {
    if (violates(t, vals[i].v) === true) since = vals[i].ts;
    else break;
  }
  return { metric: t.metric, rule, value: latest.v, state: "broken", brokenSince: since };
}
