/**
 * The classification and significance statistics the hypothesis-testing
 * framework needs — pure, dependency-free, and each one verified against a
 * hand-computable reference case before touching any real backtest data
 * (see metrics.test.ts). No stats library exists in this codebase (checked
 * directly before writing this), so these are hand-rolled rather than
 * pulling in a new dependency for a handful of well-defined formulas.
 *
 * Every function here operates on ALREADY-COMPUTED forward returns and
 * verdicts — nothing here re-derives a signal's direction or re-implements
 * any evaluator. This is purely the measurement layer.
 */

export type Verdict = "bullish" | "bearish" | "neutral";

export interface Occurrence {
  /** Chronological key so maxDrawdown can walk the sequence in order. */
  t: number;
  verdict: Verdict;
  forwardReturnPct: number | null;
}

// ── Win rate / return stats ─────────────────────────────────────────────

/**
 * Success = the forward return's sign matches the signal's direction —
 * the SAME sign-only rule report.ts's existing `fadeHitRatePct` already
 * uses for squeezeRisk. No magnitude threshold (e.g. "must move >1%") is
 * introduced here: any such number would itself be an unjustified new
 * claim, and sign-only keeps every metric in this framework measured the
 * same way.
 */
export function winRate(occurrences: Occurrence[]): number | null {
  const scored = occurrences.filter((o) => o.verdict !== "neutral" && o.forwardReturnPct !== null);
  if (scored.length === 0) return null;
  const wins = scored.filter(
    (o) => (o.verdict === "bullish" ? o.forwardReturnPct! > 0 : o.forwardReturnPct! < 0)
  ).length;
  return wins / scored.length;
}

export function meanReturn(returns: number[]): number | null {
  return returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
}

export function medianReturn(returns: number[]): number | null {
  if (!returns.length) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Largest peak-to-trough decline across the sequence of occurrence returns,
 * taken chronologically and compounded as if each occurrence were a
 * trade taken independently and sequentially — NOT a portfolio simulation.
 * No capital allocation, position sizing, or overlap-handling exists here,
 * because this is a descriptive backtest of "what happened after this
 * signal fired," the same scope every prior backtest in this session has
 * had. Returns null with fewer than 2 points, since a single trade has no
 * peak-to-trough to speak of.
 */
export function maxDrawdown(occurrencesChronological: Occurrence[]): number | null {
  const returns = occurrencesChronological
    .filter((o) => o.forwardReturnPct !== null)
    .sort((a, b) => a.t - b.t)
    .map((o) => o.forwardReturnPct!);
  if (returns.length < 2) return null;

  let equity = 1;
  let peak = 1;
  let worstDrawdownPct = 0;
  for (const r of returns) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    const drawdownPct = ((peak - equity) / peak) * 100;
    worstDrawdownPct = Math.max(worstDrawdownPct, drawdownPct);
  }
  return worstDrawdownPct;
}

// ── Confusion matrix (one-vs-rest) ──────────────────────────────────────

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
}

/**
 * One-vs-rest confusion matrix for a single class ("bullish" or "bearish").
 *
 * Predicted positive = the signal fired this class. Actual positive = the
 * forward return's sign agrees with this class (same sign-only rule as
 * winRate, so "success" can't quietly mean something different between two
 * sections of the same report). A signal that fired the OTHER class or
 * neutral, while the actual return still agreed with this class, counts as
 * a false negative — the standard one-vs-rest definition, and the honest
 * one: neutral is a real, scoreable miss when the price actually moved.
 */
export function confusionMatrix(occurrences: Occurrence[], forClass: "bullish" | "bearish"): ConfusionMatrix {
  const scored = occurrences.filter((o) => o.forwardReturnPct !== null);
  const actualPositive = (o: Occurrence) => (forClass === "bullish" ? o.forwardReturnPct! > 0 : o.forwardReturnPct! < 0);
  const predictedPositive = (o: Occurrence) => o.verdict === forClass;

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;

  for (const o of scored) {
    const pred = predictedPositive(o);
    const actual = actualPositive(o);
    if (pred && actual) truePositives++;
    else if (pred && !actual) falsePositives++;
    else if (!pred && actual) falseNegatives++;
    else trueNegatives++;
  }

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : null,
    recall: truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : null,
  };
}

// ── Statistical significance ────────────────────────────────────────────

/**
 * Exact binomial pmf at p=0.5, computed iteratively via the standard
 * C(n,k) = C(n,k-1) * (n-k+1)/k recurrence rather than raw factorials —
 * factorials of n~200 overflow long before the final ratio would, while
 * this stays numerically stable at any N this app will ever see.
 */
function binomialPmf(n: number, k: number): number {
  const half = 0.5 ** n;
  let coeff = 1;
  for (let i = 1; i <= k; i++) coeff *= (n - i + 1) / i;
  return coeff * half;
}

/**
 * Two-sided exact sign test: did this signal do better than a coin flip?
 * `wins` out of `n` trials, tested against the null that wins ~ Binomial(n, 0.5).
 *
 * Deliberately EXACT (summing the binomial pmf), not a normal approximation
 * — the sample sizes in this app (10-200) are exactly the range where a
 * normal approximation is least reliable, and an exact test needs no
 * justification for why the approximation is valid here.
 */
export function signTestPValue(n: number, wins: number): number {
  if (n === 0) return 1;
  const pmf: number[] = [];
  for (let i = 0; i <= n; i++) pmf.push(binomialPmf(n, i));
  const cdfLE = pmf.slice(0, wins + 1).reduce((a, b) => a + b, 0);
  const cdfGE = pmf.slice(wins).reduce((a, b) => a + b, 0);
  return Math.min(1, 2 * Math.min(cdfLE, cdfGE));
}

export interface SignificanceResult {
  n: number;
  wins: number;
  pValue: number;
  /** True only when N clears MIN_SAMPLE_N AND p < 0.05 — both conditions, not either alone. */
  significant: boolean;
}

/**
 * Bundles the sign test with the SAME minimum-sample floor already used
 * everywhere else in this app's backtest lookups (`MIN_SAMPLE_N` in
 * backtestStats.ts) — a technically "significant" p-value from N=6 is not
 * a claim this framework will make, matching the standing rule that a
 * small sample is hidden rather than stated with false confidence.
 */
export function testSignificance(occurrences: Occurrence[], minSampleN: number): SignificanceResult | null {
  const scored = occurrences.filter((o) => o.verdict !== "neutral" && o.forwardReturnPct !== null);
  if (scored.length === 0) return null;
  const wins = scored.filter(
    (o) => (o.verdict === "bullish" ? o.forwardReturnPct! > 0 : o.forwardReturnPct! < 0)
  ).length;
  const pValue = signTestPValue(scored.length, wins);
  return {
    n: scored.length,
    wins,
    pValue,
    significant: scored.length >= minSampleN && pValue < 0.05,
  };
}

// ── Bundled summary ─────────────────────────────────────────────────────

export interface OccurrenceSummary {
  /** Scored occurrences: verdict was bullish or bearish AND a forward return exists. */
  n: number;
  winRate: number | null;
  meanReturnPct: number | null;
  medianReturnPct: number | null;
  maxDrawdownPct: number | null;
  bullish: ConfusionMatrix;
  bearish: ConfusionMatrix;
  significance: SignificanceResult | null;
}

/**
 * Every metric this module produces, bundled for one set of occurrences —
 * shared by report.ts's per-metric hypothesis section and combinations.ts's
 * category-combination testing so the two can never compute "the same
 * measurement" two different ways.
 */
export function summarizeOccurrences(occurrences: Occurrence[], minSampleN: number): OccurrenceSummary {
  const scored = occurrences.filter((o) => o.verdict !== "neutral" && o.forwardReturnPct !== null);
  const returns = scored.map((o) => o.forwardReturnPct as number);
  return {
    n: scored.length,
    winRate: winRate(occurrences),
    meanReturnPct: meanReturn(returns),
    medianReturnPct: medianReturn(returns),
    maxDrawdownPct: maxDrawdown(scored),
    bullish: confusionMatrix(occurrences, "bullish"),
    bearish: confusionMatrix(occurrences, "bearish"),
    significance: testSignificance(occurrences, minSampleN),
  };
}
