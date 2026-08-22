/**
 * FORWARD SCORING FOR THE VERDICT — the headline claim, finally on the hook.
 *
 * The reach rate was scored first because it resolves in ten bars with one
 * question. But the number a reader actually acts on is the word at the top
 * of the page: BULLISH, BEARISH, NEUTRAL. That claim has never been scored
 * out of sample, and it is the one most worth doubting.
 *
 * ── The baseline is the whole design ──────────────────────────────────
 *
 * "Bullish calls were right 58% of the time" is close to meaningless on its
 * own. US equities rise more often than they fall, so a coin that always
 * said BULLISH would post a winning hit rate and a positive mean return in
 * most windows. The only question that matters is whether the bullish calls
 * did better than the SAME UNIVERSE over the SAME WINDOW — so the mean
 * forward return of every resolved prediction, whatever it was labelled, is
 * carried as the baseline and every cell is reported net of it.
 *
 * That baseline is computed inside the forward sample rather than borrowed
 * from the replay. A drift figure from 2008-2026 would not describe the
 * particular fortnight these predictions actually lived through.
 *
 * ── Same discipline as the reach record ───────────────────────────────
 *
 * Registration is idempotent per (date, symbol); resolved rows are never
 * rewritten; a prediction resolves only once its full horizon of sessions
 * exists, so an unfinished window never drags a cell toward zero.
 */

export const VERDICT_HORIZON_SESSIONS = 10;

/**
 * WHICH ENGINE MADE THE CALL — because the record's one job is to score
 * what the site actually published, and for its first weeks it did not.
 *
 * Engine 1 (rows with no tag): the registration job passed `marketWide: []`
 * and `benchmarkCloses: null`, so it scored a chart-only read with no
 * relative strength — while the pages published a backdrop-voting composite
 * that read bullish on 131 of 131 equities. Two engines, one record, and
 * the drift was invisible because both wrote the same three verdict words.
 *
 * Engine 2: the backdrop no longer votes anywhere (see liveAnalysis.ts),
 * and registration passes the same benchmark closes the page uses — the
 * registered verdict IS the published verdict. Cells must never mix
 * engines: a hit rate pooled across two different claim-makers describes
 * neither.
 */
export const CURRENT_VERDICT_ENGINE = 2;

export type ForwardVerdict = "bullish" | "bearish" | "neutral";

export interface VerdictPrediction {
  date: string;
  symbol: string;
  verdict: ForwardVerdict;
  /** The engine's own confidence at registration, frozen. */
  confidence: number;
  closePrice: number;
  /** Null until the horizon has fully elapsed. */
  forwardReturnPct: number | null;
  resolvedDate: string | null;
  /** Which engine version made this call. Absent means engine 1. */
  engine?: number;
}

export interface VerdictCell {
  verdict: ForwardVerdict;
  n: number;
  /** Share that moved the way the verdict implied. Neutral has no direction, so null. */
  hitRatePct: number | null;
  meanReturnPct: number;
  medianReturnPct: number;
  /**
   * Mean return minus the baseline, SIGNED so that positive always means
   * "the call added something". A bearish call that fell less than the
   * market still scores negative here, which is correct: it lost money.
   */
  edgeVsBaselinePct: number | null;
}

export interface ForwardVerdictRecord {
  version: 1;
  horizonSessions: number;
  generatedAt: number;
  predictions: VerdictPrediction[];
  /** Cells, baseline and totals describe the CURRENT engine's rows only. */
  cells: VerdictCell[];
  /** Mean forward return over every resolved CURRENT-engine prediction — the honest null. */
  baselineReturnPct: number | null;
  totals: { resolved: number; open: number };
  /** Which engine the headline summary describes. Absent on records written before engines existed. */
  engine?: number;
  /**
   * The retired engine's own summary, preserved and labelled — its ~658
   * open calls were registered before the published verdict and the
   * registered verdict were the same computation, and they still resolve
   * into evidence about the chart-only engine rather than into noise.
   */
  legacy?: {
    engine: number;
    note: string;
    cells: VerdictCell[];
    baselineReturnPct: number | null;
    totals: { resolved: number; open: number };
  };
}

export const EMPTY_FORWARD_VERDICT: ForwardVerdictRecord = {
  version: 1,
  horizonSessions: VERDICT_HORIZON_SESSIONS,
  generatedAt: 0,
  predictions: [],
  cells: [],
  baselineReturnPct: null,
  totals: { resolved: 0, open: 0 },
};

const keyOf = (p: { date: string; symbol: string }) => `${p.date}|${p.symbol}`;

export function registerVerdicts(
  existing: VerdictPrediction[],
  fresh: VerdictPrediction[]
): VerdictPrediction[] {
  const byKey = new Map(existing.map((p) => [keyOf(p), p]));
  for (const p of fresh) {
    const prior = byKey.get(keyOf(p));
    if (prior && prior.forwardReturnPct !== null) continue; // history is history
    byKey.set(keyOf(p), p);
  }
  return [...byKey.values()];
}

export interface CloseBar {
  t: number;
  close: number;
}

/**
 * Resolve to the close `horizon` sessions after registration.
 *
 * Deliberately the CLOSE of the nth session rather than the best price
 * reached along the way: the verdict is a claim about where price ends up,
 * not about whether it ever traded favourably at some point in between.
 * Scoring the latter would flatter every call in a volatile tape.
 */
export function resolveVerdicts(
  predictions: VerdictPrediction[],
  barsAfter: (symbol: string, dateIso: string) => CloseBar[],
  horizon = VERDICT_HORIZON_SESSIONS
): VerdictPrediction[] {
  return predictions.map((p) => {
    if (p.forwardReturnPct !== null) return p;
    const bars = barsAfter(p.symbol, p.date);
    if (bars.length < horizon || p.closePrice <= 0) return p;
    const end = bars[horizon - 1];
    return {
      ...p,
      forwardReturnPct: ((end.close - p.closePrice) / p.closePrice) * 100,
      resolvedDate: new Date(end.t).toISOString().slice(0, 10),
    };
  });
}

/** Below this a cell is not published; the totals still count it. */
export const MIN_VERDICT_N = 30;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function summariseVerdicts(
  predictions: VerdictPrediction[],
  /**
   * Summarise ONE engine's rows. Omitted means all rows — kept only for
   * tests that construct single-engine samples; production always names the
   * engine, because a cell pooled across engines describes neither.
   */
  engine?: number
): {
  cells: VerdictCell[];
  baselineReturnPct: number | null;
  totals: { resolved: number; open: number };
} {
  const mine =
    engine === undefined ? predictions : predictions.filter((p) => (p.engine ?? 1) === engine);
  const resolved = mine.filter((p) => p.forwardReturnPct !== null);
  const open = mine.length - resolved.length;
  if (resolved.length === 0) {
    return { cells: [], baselineReturnPct: null, totals: { resolved: 0, open } };
  }

  const baseline = resolved.reduce((s, p) => s + (p.forwardReturnPct ?? 0), 0) / resolved.length;

  const cells: VerdictCell[] = [];
  for (const verdict of ["bullish", "bearish", "neutral"] as ForwardVerdict[]) {
    const group = resolved.filter((p) => p.verdict === verdict);
    if (group.length < MIN_VERDICT_N) continue;
    const rets = group.map((p) => p.forwardReturnPct ?? 0);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;

    cells.push({
      verdict,
      n: group.length,
      hitRatePct:
        verdict === "neutral"
          ? null
          : (rets.filter((r) => (verdict === "bullish" ? r > 0 : r < 0)).length / rets.length) * 100,
      meanReturnPct: mean,
      medianReturnPct: median(rets),
      // Bearish is scored against the baseline with the sign flipped: being
      // short a market that rose 2% while your names rose 1% is not a win.
      edgeVsBaselinePct: verdict === "neutral" ? null : verdict === "bullish" ? mean - baseline : baseline - mean,
    });
  }

  return { cells, baselineReturnPct: baseline, totals: { resolved: resolved.length, open } };
}

export const MAX_VERDICT_PREDICTIONS = 60_000;

export function pruneVerdicts(
  predictions: VerdictPrediction[],
  cap = MAX_VERDICT_PREDICTIONS
): VerdictPrediction[] {
  if (predictions.length <= cap) return predictions;
  const open = predictions.filter((p) => p.forwardReturnPct === null);
  const closed = predictions
    .filter((p) => p.forwardReturnPct !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
  return [...closed.slice(Math.max(0, closed.length - Math.max(0, cap - open.length))), ...open];
}
