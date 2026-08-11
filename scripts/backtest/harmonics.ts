/**
 * Harmonic pattern detection — RESEARCH ONLY.
 *
 * Deliberately lives under scripts/, not src/, so it physically cannot be
 * imported by the app. Nothing here touches the decision engine.
 *
 * ── LOOK-AHEAD SAFETY, THE ONLY PART THAT REALLY MATTERS ─────────────────
 *
 * A harmonic pattern is five pivots (X A B C D). A centred-fractal pivot at
 * bar `i` cannot be known until bar `i + LOOKBACK` has closed, because that
 * is when the bars proving it was an extreme exist. So every pattern carries
 * TWO timestamps:
 *
 *   completedAt — the close of D's own bar (when a chartist would draw it)
 *   knownAt     — the close of bar D_index + LOOKBACK (when it was KNOWABLE)
 *
 * All forward outcomes are measured from `knownAt`, never `completedAt`.
 * Measuring from `completedAt` would silently grant LOOKBACK bars of hindsight
 * and is the single most common way a harmonic backtest becomes worthless.
 *
 * Detection is fully deterministic: fixed pivot rule, fixed Fibonacci windows,
 * fixed tolerance. No visual judgement, no "close enough" discretion.
 */

export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Bars either side required for a pivot. Matches divergence.ts's own fractal lookback so the two agree about what a swing point is. */
export const PIVOT_LOOKBACK = 3;

/** Fractional tolerance applied to every Fibonacci window, e.g. 0.05 = ±5%. */
export const FIB_TOLERANCE = 0.05;

export type PatternName = "Gartley" | "Bat" | "Butterfly" | "Crab" | "DeepCrab" | "Cypher" | "Shark";

export interface Pivot {
  index: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** Close time of the bar at which this pivot became knowable. */
  knownAtT: number;
}

/**
 * Centred fractal pivots. A bar is a pivot high when it is the strict maximum
 * of the window [i-L, i+L]; equivalently for lows.
 *
 * `knownAtT` is the close of bar i+L — the first moment the pivot could be
 * asserted. Nothing downstream is allowed to use a pivot before that time.
 */
export function findPivots(candles: Candle[], lookback = PIVOT_LOOKBACK): Pivot[] {
  const out: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    const knownAtT = candles[i + lookback].t;
    if (isHigh) out.push({ index: i, t: candles[i].t, price: candles[i].high, kind: "high", knownAtT });
    if (isLow) out.push({ index: i, t: candles[i].t, price: candles[i].low, kind: "low", knownAtT });
  }
  return out.sort((a, b) => a.index - b.index);
}

interface Window { min: number; max: number }
const w = (min: number, max = min): Window => ({ min, max });

/**
 * Standard harmonic ratio definitions.
 *
 * `retraceD` is measured against XA for the classic patterns. Cypher and
 * Shark use their own conventions — Cypher's D retraces XC, Shark's D extends
 * XA — so they carry an explicit `dMeasuredAgainst`.
 */
interface Spec {
  name: PatternName;
  ab_xa: Window;
  bc_ab: Window;
  cd_bc: Window;
  d: Window;
  dMeasuredAgainst: "XA" | "XC";
}

const SPECS: Spec[] = [
  { name: "Gartley",   ab_xa: w(0.618),        bc_ab: w(0.382, 0.886), cd_bc: w(1.13, 1.618),  d: w(0.786),        dMeasuredAgainst: "XA" },
  { name: "Bat",       ab_xa: w(0.382, 0.5),   bc_ab: w(0.382, 0.886), cd_bc: w(1.618, 2.618), d: w(0.886),        dMeasuredAgainst: "XA" },
  { name: "Butterfly", ab_xa: w(0.786),        bc_ab: w(0.382, 0.886), cd_bc: w(1.618, 2.24),  d: w(1.27),         dMeasuredAgainst: "XA" },
  { name: "Crab",      ab_xa: w(0.382, 0.618), bc_ab: w(0.382, 0.886), cd_bc: w(2.618, 3.618), d: w(1.618),        dMeasuredAgainst: "XA" },
  { name: "DeepCrab",  ab_xa: w(0.886),        bc_ab: w(0.382, 0.886), cd_bc: w(2.0, 3.618),   d: w(1.618),        dMeasuredAgainst: "XA" },
  { name: "Cypher",    ab_xa: w(0.382, 0.618), bc_ab: w(1.13, 1.414),  cd_bc: w(0, 99),        d: w(0.786),        dMeasuredAgainst: "XC" },
  { name: "Shark",     ab_xa: w(0, 99),        bc_ab: w(1.13, 1.618),  cd_bc: w(1.618, 2.24),  d: w(0.886, 1.13),  dMeasuredAgainst: "XA" },
];

function within(value: number, win: Window, tol = FIB_TOLERANCE): boolean {
  return value >= win.min * (1 - tol) && value <= win.max * (1 + tol);
}

/** 0 = perfect centre of the window, 1 = at the tolerance edge. Lower is a tighter fit. */
function fitError(value: number, win: Window): number {
  const centre = (win.min + win.max) / 2;
  const halfWidth = Math.max((win.max - win.min) / 2, 1e-9) + centre * FIB_TOLERANCE;
  return Math.min(1, Math.abs(value - centre) / halfWidth);
}

export type HarmonicState = "completed" | "invalidated" | "expired";

export interface HarmonicPattern {
  name: PatternName;
  /** bullish = D is a low, the pattern implies buying; bearish = D is a high. */
  direction: "bullish" | "bearish";
  x: Pivot; a: Pivot; b: Pivot; c: Pivot; d: Pivot;
  /** Close of D's own bar. NOT safe to trade from. */
  completedAtT: number;
  /** First moment the whole pattern was knowable. All outcomes measure from here. */
  knownAtT: number;
  /** Price at D — the completion level. */
  completionPrice: number;
  /** Structural invalidation: beyond X the pattern is void. */
  invalidationPrice: number;
  /** 0-1, higher is a tighter Fibonacci fit across all four legs. */
  quality: number;
  ratios: { ab_xa: number; bc_ab: number; cd_bc: number; d: number };
}

/**
 * How many pivots back each leg may reach when searching for the previous
 * point. Without this the search is O(P^5) — with ~800 pivots on a 4H series
 * that is ~10^14 combinations and the scan never terminates (measured: it
 * did not finish in 90 seconds and had to be killed).
 *
 * The bound is not merely a performance trick. A harmonic pattern whose legs
 * are separated by dozens of intervening swings is not the shape the theory
 * describes — it is a coincidence found by exhaustive search. Restricting
 * each leg to nearby pivots is what keeps the detector honest as well as fast.
 */
export const MAX_PIVOT_SPAN = 10;

/**
 * Scans for completed XABCD patterns.
 *
 * Only pivots are considered — a pattern cannot form on unconfirmed bars —
 * and the five points must strictly alternate high/low, which is what makes
 * the shape a zig-zag rather than an arbitrary five points.
 */
export function detectHarmonics(candles: Candle[], lookback = PIVOT_LOOKBACK): HarmonicPattern[] {
  const pivots = findPivots(candles, lookback);
  const found: HarmonicPattern[] = [];

  for (let di = 4; di < pivots.length; di++) {
    const d = pivots[di];
    // Walk back four alternating pivots. Alternation is required: X and B and
    // D share a kind, A and C share the opposite.
    for (let ci = di - 1; ci >= Math.max(3, di - MAX_PIVOT_SPAN); ci--) {
      const c = pivots[ci];
      if (c.kind === d.kind) continue;
      for (let bi = ci - 1; bi >= Math.max(2, ci - MAX_PIVOT_SPAN); bi--) {
        const b = pivots[bi];
        if (b.kind !== d.kind) continue;
        for (let ai = bi - 1; ai >= Math.max(1, bi - MAX_PIVOT_SPAN); ai--) {
          const a = pivots[ai];
          if (a.kind === d.kind) continue;
          for (let xi = ai - 1; xi >= Math.max(0, ai - MAX_PIVOT_SPAN); xi--) {
            const x = pivots[xi];
            if (x.kind !== d.kind) continue;

            const XA = Math.abs(a.price - x.price);
            const AB = Math.abs(b.price - a.price);
            const BC = Math.abs(c.price - b.price);
            const CD = Math.abs(d.price - c.price);
            const XC = Math.abs(c.price - x.price);
            const AD = Math.abs(d.price - a.price);
            if (XA <= 0 || AB <= 0 || BC <= 0 || CD <= 0) continue;

            const ab_xa = AB / XA;
            const bc_ab = BC / AB;
            const cd_bc = CD / BC;

            for (const spec of SPECS) {
              const dRatio = spec.dMeasuredAgainst === "XA" ? AD / XA : Math.abs(d.price - x.price) / XC;
              if (!within(ab_xa, spec.ab_xa)) continue;
              if (!within(bc_ab, spec.bc_ab)) continue;
              if (!within(cd_bc, spec.cd_bc)) continue;
              if (!within(dRatio, spec.d)) continue;

              const err = (fitError(ab_xa, spec.ab_xa) + fitError(bc_ab, spec.bc_ab) + fitError(cd_bc, spec.cd_bc) + fitError(dRatio, spec.d)) / 4;
              found.push({
                name: spec.name,
                // D a low means the pattern completes into demand: bullish.
                direction: d.kind === "low" ? "bullish" : "bearish",
                x, a, b, c, d,
                completedAtT: d.t,
                // The LAST of the five to become knowable governs the whole
                // pattern — in practice always D, but taking the max is what
                // makes that a guarantee rather than an assumption.
                knownAtT: Math.max(x.knownAtT, a.knownAtT, b.knownAtT, c.knownAtT, d.knownAtT),
                completionPrice: d.price,
                invalidationPrice: x.price,
                quality: 1 - err,
                ratios: { ab_xa, bc_ab, cd_bc, d: dRatio },
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate: the same D can satisfy several specs or several X choices.
  // Keep the highest-quality reading per (D pivot, direction) so one shape
  // counts once, not seven times.
  const best = new Map<string, HarmonicPattern>();
  for (const p of found) {
    const key = `${p.d.index}:${p.direction}`;
    const prior = best.get(key);
    if (!prior || p.quality > prior.quality) best.set(key, p);
  }
  return [...best.values()].sort((a, b) => a.knownAtT - b.knownAtT);
}
