/**
 * Harmonic pattern geometry — Scott Carney's Harmonic Trading methodology
 * (harmonictrader.com's published ratio definitions), reimplemented from the
 * ground up as a FORWARD-LOOKING projector rather than a completed-pattern
 * scanner.
 *
 * ── WHY THIS IS A DIFFERENT DESIGN FROM THE RESEARCH VERSION ──────────────
 *
 * scripts/backtest/harmonics.ts (research, Phase "harmonic study") scanned
 * for fully-formed five-point X-A-B-C-D patterns and then asked what
 * happened next. That is retrospective — by the time D exists, the reversal
 * it's supposed to warn about may already be underway or already over.
 *
 * A real harmonic trader projects the D completion zone THE MOMENT C forms,
 * from the X-A-B-C legs alone, and then waits — potentially for days — to
 * see whether price actually reaches that zone and how it behaves when it
 * does. That is what makes harmonics a genuinely forward-looking tool rather
 * than a coincidence detector, and it's the design this file implements.
 *
 * ── LOOK-AHEAD SAFETY (non-negotiable, and the reason for `knownAt`) ──────
 *
 * A centred-fractal pivot at bar i is only KNOWABLE once bar i+lookback has
 * closed — that's the bar that proves i was the extreme. Every pivot here
 * carries `knownAtT`, and a candidate's overall `knownAt` is the max across
 * all its pivots. The PRZ is projectable, and the pattern therefore usable,
 * ONLY from `knownAt` onward. The research phase found a subtle variant of
 * this bug (entering at D's own price, which a fractal low guarantees is
 * higher than the immediately following bars) that inflated apparent
 * performance roughly 2x. Never repeat it: nothing here returns a price
 * usable before its own `knownAtT`.
 *
 * ── PATTERNS IMPLEMENTED, AND WHY TWO ARE DELIBERATELY NOT ────────────────
 *
 * Implemented as pattern-specific rule sets (never a single generic
 * tolerance applied to every shape): Gartley, Bat, Butterfly, Crab, Deep
 * Crab, Shark, Cypher (all five-point X-A-B-C-D), plus AB=CD and its
 * Alternate variant (a distinct four-point A-B-C-D family with no X leg).
 *
 * 5-0 and Three Drives are NOT implemented. This is a genuine ambiguity, not
 * an oversight: 5-0's own published sources disagree on which leg the 0.5
 * completion ratio is measured against (some measure D against the AB leg,
 * others against the OX-to-C span), and Three Drives is not an XABCD shape
 * at all — it needs a different three-swing detector with its own pivot
 * topology. Implementing either from an uncertain or structurally different
 * definition risks shipping precise-looking numbers built on a guess, which
 * is worse than not shipping them. Flagged here rather than guessed.
 */

import { Candle } from "./indicators";

// ─────────────────────────────────────────────────────────────────────────
// Pivots
// ─────────────────────────────────────────────────────────────────────────

/** Bars either side required for a pivot — the same fractal lookback divergence.ts uses, so a swing point means the same thing everywhere in this app. */
export const PIVOT_LOOKBACK = 3;

export interface Pivot {
  index: number;
  t: number;
  price: number;
  kind: "high" | "low";
  /** Close time of the bar at which this pivot became knowable (bar[index + lookback]). Nothing may use this pivot's price before this timestamp. */
  knownAtT: number;
}

/**
 * Centred-fractal pivots. A bar is a pivot high when it is the STRICT
 * maximum of its `[i-lookback, i+lookback]` window (a tie produces no pivot
 * there, rather than guessing a side).
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

/** How many prior pivots a leg search may look back. Bounds the search to O(P^2 * span^2) instead of O(P^4) and keeps matched legs structurally adjacent rather than found by exhaustive search across the whole history. */
export const MAX_PIVOT_SPAN = 12;

// ─────────────────────────────────────────────────────────────────────────
// Pattern geometry
// ─────────────────────────────────────────────────────────────────────────

export type PatternName = "Gartley" | "Bat" | "Butterfly" | "Crab" | "DeepCrab" | "Shark" | "Cypher" | "AB=CD" | "AltAB=CD";

interface Window { min: number; max: number }
const w = (min: number, max = min): Window => ({ min, max });

/**
 * Tolerance is asymmetric BY DESIGN, not a single flat percentage applied to
 * every ratio. The B/retracement legs (AB/XA, BC/AB) are intermediate
 * structure — some slack there just reflects normal price noise. The D
 * completion ratio is what DEFINES the PRZ, so it is held to a tighter
 * tolerance: a loose D tolerance would widen the PRZ until "reversal zone"
 * stops meaning anything.
 */
const LEG_TOLERANCE = 0.08;
const COMPLETION_TOLERANCE = 0.03;

/** dMeasuredAgainst: "XA" for the standard family; Cypher measures D against XC, which is its defining quirk. */
interface FiveLegSpec {
  name: Exclude<PatternName, "AB=CD" | "AltAB=CD">;
  ab_xa: Window;
  bc_ab: Window;
  cd_bc: Window;
  d: Window;
  dMeasuredAgainst: "XA" | "XC";
}

const FIVE_LEG_SPECS: FiveLegSpec[] = [
  { name: "Gartley", ab_xa: w(0.618), bc_ab: w(0.382, 0.886), cd_bc: w(1.13, 1.618), d: w(0.786), dMeasuredAgainst: "XA" },
  { name: "Bat", ab_xa: w(0.382, 0.5), bc_ab: w(0.382, 0.886), cd_bc: w(1.618, 2.618), d: w(0.886), dMeasuredAgainst: "XA" },
  { name: "Butterfly", ab_xa: w(0.786), bc_ab: w(0.382, 0.886), cd_bc: w(1.618, 2.24), d: w(1.27, 1.618), dMeasuredAgainst: "XA" },
  { name: "Crab", ab_xa: w(0.382, 0.618), bc_ab: w(0.382, 0.886), cd_bc: w(2.618, 3.618), d: w(1.618), dMeasuredAgainst: "XA" },
  { name: "DeepCrab", ab_xa: w(0.886), bc_ab: w(0.382, 0.886), cd_bc: w(2.0, 3.618), d: w(1.618), dMeasuredAgainst: "XA" },
  { name: "Shark", ab_xa: w(0.446, 0.618), bc_ab: w(1.13, 1.618), cd_bc: w(1.618, 2.24), d: w(0.886, 1.13), dMeasuredAgainst: "XA" },
  { name: "Cypher", ab_xa: w(0.382, 0.618), bc_ab: w(1.13, 1.414), cd_bc: w(1.272, 2.0), d: w(0.786), dMeasuredAgainst: "XC" },
];

function within(value: number, win: Window, tol: number): boolean {
  return value >= win.min * (1 - tol) && value <= win.max * (1 + tol);
}

/** 0 at the centre of the window, 1 at the tolerance edge. Used for quality, never for pass/fail. */
function fitError(value: number, win: Window, tol: number): number {
  const centre = (win.min + win.max) / 2;
  const halfWidth = Math.max((win.max - win.min) / 2, 1e-9) + centre * tol;
  return Math.min(1, Math.abs(value - centre) / halfWidth);
}

// ─────────────────────────────────────────────────────────────────────────
// Candidates — the FORWARD-LOOKING core.
//
// A candidate is an X-A-B-C structure whose AB/XA and BC/AB ratios fit at
// least one pattern's spec. D has NOT happened yet. From X-A-B-C alone this
// projects where D (and therefore the PRZ) SHOULD complete if the pattern is
// real — the actual, tradeable use of harmonic geometry.
// ─────────────────────────────────────────────────────────────────────────

export interface PrzLevel {
  /** Which Fibonacci relationship produced this level. */
  source: string;
  price: number;
}

export interface Prz {
  low: number;
  high: number;
  mid: number;
  /** high - low, in absolute price terms. */
  width: number;
  /** width / ATR at projection time — the unit the rest of the app already measures distance in. */
  widthAtr: number;
  /** The individual Fibonacci-derived levels that converged to form this zone. */
  levels: PrzLevel[];
  /** levels.length — how many INDEPENDENT relationships agree. More is a stronger PRZ, but never assumed to mean higher expected return; that is a separate, measured question. */
  convergenceCount: number;
}

export interface HarmonicCandidate {
  pattern: PatternName;
  /** bullish = D completes as a low (the pattern implies buying there); bearish = D completes as a high. */
  direction: "bullish" | "bearish";
  x: Pivot; a: Pivot; b: Pivot; c: Pivot;
  /** AB/XA and BC/AB as actually measured — kept so the engine can explain why this candidate qualified. */
  ratios: { ab_xa: number; bc_ab: number };
  /** Fit quality of the two known legs, 0-1, 1 = dead centre of the spec window. */
  legQuality: number;
  prz: Prz;
  /**
   * The X-based structural invalidation price: beyond this, the entire
   * pattern is void — not "D missed the PRZ" but "the structure this pattern
   * was built on no longer exists." Beyond X for a bullish candidate,
   * beyond X for a bearish one is a price ABOVE X — direction-aware.
   */
  invalidationPrice: number;
  /** Close of the bar at which C's own pivot became knowable — the earliest instant this candidate could be projected. */
  knownAtT: number;
}

/**
 * Projects the D-completion PRZ from X-A-B-C for one pattern spec, or null
 * if the spec's completion window can't produce a valid zone (e.g. the
 * projected level would sit on the wrong side of C).
 */
function przFor(spec: FiveLegSpec, x: Pivot, a: Pivot, b: Pivot, c: Pivot, atrAbs: number): Prz | null {
  const XA = Math.abs(a.price - x.price);
  const BC = Math.abs(c.price - b.price);
  // D always alternates from C, so D is a low (bullish completion) precisely
  // when C is a HIGH — the classic X(low) A(high) B(low) C(high) D(low) shape.
  const bullish = c.kind === "high";

  const levels: PrzLevel[] = [];

  // Level 1: D as a retracement/extension of XA (or of XC for Cypher).
  // Retracement is measured from the LEG'S ENDPOINT back toward its start —
  // the standard convention (D = A - ratio*(A-X), not X + ratio*(A-X)).
  // "XA" retraces from A; "XC" (Cypher's own convention) retraces from C.
  const base = spec.dMeasuredAgainst === "XA" ? a.price : c.price;
  const baseLeg = spec.dMeasuredAgainst === "XA" ? XA : Math.abs(c.price - x.price);
  for (const ratio of [spec.d.min, spec.d.max]) {
    const price = bullish ? base - ratio * baseLeg : base + ratio * baseLeg;
    levels.push({ source: `${(ratio * 100).toFixed(1)}% of ${spec.dMeasuredAgainst}`, price });
  }

  // Level 2: D as a BC extension.
  for (const ratio of [spec.cd_bc.min, spec.cd_bc.max]) {
    const price = bullish ? c.price - ratio * BC : c.price + ratio * BC;
    levels.push({ source: `${ratio.toFixed(2)}x BC extension`, price });
  }

  // Level 3: AB=CD — the CD leg projected equal (1.0x) to AB, the classic
  // harmonic symmetry check. Only added when it lands on the correct side of
  // C; a pattern with a very short AB leg can otherwise project an AB=CD
  // level that doesn't even clear C, which is not a real completion level.
  const AB = Math.abs(b.price - a.price);
  const abcdPrice = bullish ? c.price - AB : c.price + AB;
  if (bullish ? abcdPrice < c.price : abcdPrice > c.price) {
    levels.push({ source: "AB=CD", price: abcdPrice });
  }

  const prices = levels.map((l) => l.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (!(high > low)) return null;

  // Sanity bound: if the projected zone is absurdly wide (the legs
  // disagreed rather than converged), it isn't a PRZ — a "reversal zone"
  // spanning 5+ ATR conveys no location information at all.
  const width = high - low;
  if (atrAbs > 0 && width / atrAbs > 5) return null;

  return {
    low, high, mid: (low + high) / 2, width,
    widthAtr: atrAbs > 0 ? width / atrAbs : NaN,
    levels,
    convergenceCount: levels.length,
  };
}

/**
 * Scans X-A-B-C-alternating-pivot quadruples and, for each that fits a
 * pattern's leg ratios, projects that pattern's PRZ. C must be the MOST
 * RECENT pivot of its kind — a candidate whose C has already been
 * superseded by a later same-kind pivot is stale structure, not a live
 * setup, and is excluded here rather than surfaced and immediately
 * contradicted by the chart.
 */
export function findCandidates(candles: Candle[], atrAbs: number, lookback = PIVOT_LOOKBACK): HarmonicCandidate[] {
  const pivots = findPivots(candles, lookback);
  const out: HarmonicCandidate[] = [];

  const latestOfKind = (kind: "high" | "low"): number => {
    for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].kind === kind) return i;
    return -1;
  };

  for (const cKind of ["high", "low"] as const) {
    const ci = latestOfKind(cKind);
    if (ci < 0) continue;
    const c = pivots[ci];

    for (let bi = ci - 1; bi >= Math.max(0, ci - MAX_PIVOT_SPAN); bi--) {
      const b = pivots[bi];
      if (b.kind === cKind) continue;
      for (let ai = bi - 1; ai >= Math.max(0, bi - MAX_PIVOT_SPAN); ai--) {
        const a = pivots[ai];
        if (a.kind !== cKind) continue;
        for (let xi = ai - 1; xi >= Math.max(0, ai - MAX_PIVOT_SPAN); xi--) {
          const x = pivots[xi];
          if (x.kind === cKind) continue;

          const XA = Math.abs(a.price - x.price);
          const AB = Math.abs(b.price - a.price);
          const BC = Math.abs(c.price - b.price);
          if (XA <= 0 || AB <= 0 || BC <= 0) continue;

          const ab_xa = AB / XA;
          const bc_ab = BC / AB;
          const knownAtT = Math.max(x.knownAtT, a.knownAtT, b.knownAtT, c.knownAtT);

          for (const spec of FIVE_LEG_SPECS) {
            if (!within(ab_xa, spec.ab_xa, LEG_TOLERANCE)) continue;
            if (!within(bc_ab, spec.bc_ab, LEG_TOLERANCE)) continue;

            const prz = przFor(spec, x, a, b, c, atrAbs);
            if (!prz) continue;

            const legQuality = 1 - (fitError(ab_xa, spec.ab_xa, LEG_TOLERANCE) + fitError(bc_ab, spec.bc_ab, LEG_TOLERANCE)) / 2;
            const bullish = c.kind === "high"; // matches przFor's convention: D alternates from C.

            out.push({
              pattern: spec.name,
              direction: bullish ? "bullish" : "bearish",
              x, a, b, c,
              ratios: { ab_xa, bc_ab },
              legQuality,
              prz,
              invalidationPrice: x.price,
              knownAtT,
            });
          }
        }
      }
    }
  }

  // Dedup: many (X,pattern) combinations can share the same live C. Keep the
  // single best-fitting pattern per direction — showing seven simultaneous
  // "candidates" off the same three pivots would be the same shape counted
  // seven times, not seven independent setups.
  const best = new Map<string, HarmonicCandidate>();
  for (const cand of out) {
    const key = cand.direction;
    const prior = best.get(key);
    if (!prior || cand.legQuality > prior.legQuality) best.set(key, cand);
  }
  return [...best.values()].sort((p, q) => q.legQuality - p.legQuality);
}

// ─────────────────────────────────────────────────────────────────────────
// AB=CD / Alternate AB=CD — a genuinely different four-point family, no X.
// ─────────────────────────────────────────────────────────────────────────

export interface AbcdCandidate {
  pattern: "AB=CD" | "AltAB=CD";
  direction: "bullish" | "bearish";
  a: Pivot; b: Pivot; c: Pivot;
  cdProjection: number; // AB:CD ratio actually implied by the projected D
  prz: Prz;
  invalidationPrice: number;
  knownAtT: number;
}

/** Classic AB=CD projects CD equal to AB (1.0x); the Alternate variant projects an extension, most commonly 1.27x or 1.618x. */
const ABCD_RATIOS: Array<{ name: "AB=CD" | "AltAB=CD"; ratio: Window }> = [
  { name: "AB=CD", ratio: w(0.786, 1.27) },
  { name: "AltAB=CD", ratio: w(1.27, 1.618) },
];

export function findAbcdCandidates(candles: Candle[], atrAbs: number, lookback = PIVOT_LOOKBACK): AbcdCandidate[] {
  const pivots = findPivots(candles, lookback);
  const out: AbcdCandidate[] = [];

  const latestOfKind = (kind: "high" | "low"): number => {
    for (let i = pivots.length - 1; i >= 0; i--) if (pivots[i].kind === kind) return i;
    return -1;
  };

  for (const cKind of ["high", "low"] as const) {
    const ci = latestOfKind(cKind);
    if (ci < 0) continue;
    const c = pivots[ci];
    for (let bi = ci - 1; bi >= Math.max(0, ci - MAX_PIVOT_SPAN); bi--) {
      const b = pivots[bi];
      if (b.kind === cKind) continue;
      for (let ai = bi - 1; ai >= Math.max(0, bi - MAX_PIVOT_SPAN); ai--) {
        const a = pivots[ai];
        if (a.kind !== cKind) continue;

        const AB = Math.abs(b.price - a.price);
        if (AB <= 0) continue;
        const bullish = c.kind === "high"; // D alternates from C, same convention as findCandidates.
        const knownAtT = Math.max(a.knownAtT, b.knownAtT, c.knownAtT);

        for (const { name, ratio } of ABCD_RATIOS) {
          const levels: PrzLevel[] = [ratio.min, ratio.max].map((r) => ({
            source: `${r.toFixed(2)}x AB`,
            price: bullish ? c.price - r * AB : c.price + r * AB,
          }));
          const prices = levels.map((l) => l.price);
          const low = Math.min(...prices);
          const high = Math.max(...prices);
          if (!(high > low)) continue;
          const width = high - low;
          if (atrAbs > 0 && width / atrAbs > 5) continue;

          out.push({
            pattern: name,
            direction: bullish ? "bullish" : "bearish",
            a, b, c,
            cdProjection: (ratio.min + ratio.max) / 2,
            prz: { low, high, mid: (low + high) / 2, width, widthAtr: atrAbs > 0 ? width / atrAbs : NaN, levels, convergenceCount: levels.length },
            invalidationPrice: bullish ? Math.min(a.price, b.price) : Math.max(a.price, b.price),
            knownAtT,
          });
        }
      }
    }
  }

  const best = new Map<string, AbcdCandidate>();
  for (const cand of out) {
    const key = cand.direction;
    const prior = best.get(key);
    if (!prior) best.set(key, cand);
  }
  return [...best.values()];
}
