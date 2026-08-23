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
  /**
   * The entry close actually used to score this row, read at resolution
   * time on the same adjustment basis as the exit. Differs from
   * `closePrice` exactly when the series was re-adjusted in between — which
   * is what makes the difference auditable rather than invisible.
   */
  resolvedEntryClose?: number;
  /**
   * True when the call can no longer resolve — its horizon plus a grace
   * period elapsed with no scoring bars, which in practice means the symbol
   * left the data set between registration and resolution. Expired rows are
   * neither open nor resolved: counting them open would inflate the
   * "waiting out their window" figure forever, and scoring them would
   * require bars that do not exist.
   */
  expired?: boolean;
}

/**
 * Sessions of slack past the horizon before an unresolved call is declared
 * unresolvable. Generous, because the cure for a transient ingest gap is
 * patience and the cure for expiry is nothing — a symbol whose data returns
 * on day 12 should still score.
 */
export const EXPIRY_GRACE_SESSIONS = 10;

/**
 * Expire calls that can never resolve.
 *
 * Time-based, NOT presence-based: 17 calls were registered on 2026-08-21
 * for symbols the scoring job's data set does not carry, and a
 * presence-based rule would also have censored any symbol whose file was
 * missing for one night. A call expires only when horizon + grace sessions
 * (converted at 7/5 calendar days per session) have passed since
 * registration with no resolution — at that point either the symbol is
 * gone or the pipeline has been dark for two weeks, and both are facts the
 * totals should carry rather than hide inside a forever-open count.
 */
export function expireUnresolvable(
  predictions: VerdictPrediction[],
  todayIso: string,
  horizon = VERDICT_HORIZON_SESSIONS,
  graceSessions = EXPIRY_GRACE_SESSIONS
): VerdictPrediction[] {
  const budgetDays = Math.ceil(((horizon + graceSessions) * 7) / 5);
  const cutoff = Date.parse(`${todayIso}T00:00:00Z`) - budgetDays * 86_400_000;
  return predictions.map((p) => {
    if (p.forwardReturnPct !== null || p.expired) return p;
    if (Date.parse(`${p.date}T00:00:00Z`) < cutoff) return { ...p, expired: true };
    return p;
  });
}

export interface VerdictCell {
  verdict: ForwardVerdict;
  /**
   * Resolved predictions in the cell. NOT the evidence count — see
   * `independentN`, which is usually very much smaller.
   */
  n: number;
  /**
   * NON-OVERLAPPING DATE BLOCKS behind this cell, and the only honest
   * sample size here.
   *
   * Two corrections are folded into one number. Within a registration date
   * the calls are cross-sectionally correlated — this panel runs rho near
   * 0.8, so 48 bullish calls on one day are approximately ONE observation,
   * not 48. And across dates, a 10-session forward window overlaps every
   * date inside 10 sessions of it, so consecutive days are not independent
   * either.
   *
   * The consequence is blunt and worth stating before the record lands: on
   * 2026-08-27 the first two cohorts resolve (125 predictions, dated 08-12
   * and 08-13, one session apart) and `independentN` is 1. A cell printing
   * n=48 with a hit rate would be one observation wearing a large sample's
   * clothes — the same error the momentum study and the touch-calibration
   * grid were both built to avoid.
   */
  independentN: number;
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
  /**
   * What may honestly be said about this cell — either the edge claim, or a
   * REFUSAL naming what is missing. Never a bare number, because a number
   * with no claim attached gets read as a claim.
   */
  claim: string;
  /** False when `independentN` cannot support any inference; the numbers are still shown. */
  publishable: boolean;
}

export interface ForwardVerdictRecord {
  version: 1;
  horizonSessions: number;
  generatedAt: number;
  predictions: VerdictPrediction[];
  /** Cells, baseline and totals describe the CURRENT engine's rows only. */
  cells: VerdictCell[];
  /**
   * Mean forward return over every resolved CURRENT-engine prediction — the
   * COHORT baseline. This is what edgeVsBaselinePct is measured against:
   * the record's own other calls over the same windows, not an index. On a
   * mixed cohort (the register runs ~42% bullish / 31% bearish / 26%
   * neutral) that nets the tide fairly; the label matters because "beat the
   * market" and "beat the rest of this register" are different claims.
   */
  baselineReturnPct: number | null;
  /**
   * Mean SPY return over the SAME windows as the resolved rows — the
   * external market baseline, carried beside the cohort one so a reader can
   * see both "did this call beat the register" and "did the register's
   * windows beat the index". Null until rows resolve or when SPY bars are
   * unavailable.
   */
  marketBaselineReturnPct?: number | null;
  totals: { resolved: number; open: number };
  /** The headline in plain words, including the null. See summariseVerdicts. */
  finding?: string;
  /** What the record cannot answer yet, beside what it can. */
  cannotYetAnswer?: string[];
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
    marketBaselineReturnPct?: number | null;
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
  /**
   * The ENTRY bar's close, read at RESOLUTION time from the same series as
   * the exit bar. Required, and the reason is a bug this audit found while
   * the record was still empty.
   *
   * `closePrice` is frozen when a prediction is registered, on that day's
   * split/dividend adjustment basis. Bars are re-adjusted RETROACTIVELY
   * every time a dividend goes ex, so a return computed as
   * `(exit_today − entry_frozen) / entry_frozen` straddles two different
   * bases and understates dividend payers by roughly the yield. Measured on
   * the real record: 63 symbols affected, up to 1.59% on one, and — the
   * part that makes it fatal rather than untidy — UNEVEN across cells. On
   * the cohort maturing 2026-08-27 the mean distortion was bearish −0.082%
   * against bullish −0.039% and neutral 0.000%, which inflates the bearish
   * cell's apparent edge for no reason but the dividend calendar.
   *
   * Reading both ends at resolution time puts them on one basis and makes
   * the figure a true total return. Null means the entry bar is no longer
   * in the series, and the prediction is left UNRESOLVED rather than scored
   * on a basis mismatch — an unscoreable row is an honest absence, a
   * silently mis-based one is a published error.
   */
  entryCloseOf: (symbol: string, dateIso: string) => number | null,
  horizon = VERDICT_HORIZON_SESSIONS
): VerdictPrediction[] {
  return predictions.map((p) => {
    if (p.forwardReturnPct !== null || p.expired) return p;
    const bars = barsAfter(p.symbol, p.date);
    if (bars.length < horizon) return p;
    const entry = entryCloseOf(p.symbol, p.date);
    if (entry === null || !(entry > 0)) return p;
    const end = bars[horizon - 1];
    return {
      ...p,
      forwardReturnPct: ((end.close - entry) / entry) * 100,
      resolvedDate: new Date(end.t).toISOString().slice(0, 10),
      resolvedEntryClose: entry,
    };
  });
}

/** Below this a cell is not published; the totals still count it. */
export const MIN_VERDICT_N = 30;

/**
 * Independent blocks required before a cell may claim an edge.
 *
 * Two is the floor at which a spread even exists — one block has no
 * variance and therefore no standard error, so any "edge" computed from it
 * is a point with no error bar. Eight is where the estimate starts being
 * worth reading; between the two the numbers are shown and the claim is
 * refused, which is the same contract as `no_width_survives`.
 */
export const MIN_INDEPENDENT_BLOCKS = 8;

/**
 * Non-overlapping blocks among a set of registration dates.
 *
 * Greedy from the earliest: a date opens a new block only when it sits at
 * least `horizon` sessions after the block currently open, because
 * anything nearer shares most of its forward window. Sessions are
 * approximated from calendar days at 5/7, the same convention
 * `expireUnresolvable` uses.
 */
export function independentBlocks(dates: string[], horizon = VERDICT_HORIZON_SESSIONS): number {
  const unique = [...new Set(dates)].sort();
  if (unique.length === 0) return 0;
  const sessionsBetween = (a: string, b: string) =>
    ((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) * (5 / 7);
  let blocks = 1;
  let anchor = unique[0];
  for (const d of unique.slice(1)) {
    if (sessionsBetween(anchor, d) >= horizon) {
      blocks++;
      anchor = d;
    }
  }
  return blocks;
}

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
  /**
   * The headline in plain words, INCLUDING the null. "Nothing here has a
   * measurable edge" is a real finding and by far the likeliest one; a
   * record that can only phrase positives will phrase a positive.
   */
  finding: string;
  /** What the record cannot answer yet, stated beside what it can. */
  cannotYetAnswer: string[];
} {
  const mine =
    engine === undefined ? predictions : predictions.filter((p) => (p.engine ?? 1) === engine);
  const resolved = mine.filter((p) => p.forwardReturnPct !== null);
  // Expired rows are neither open nor resolved — see expireUnresolvable.
  const open = mine.filter((p) => p.forwardReturnPct === null && !p.expired).length;
  if (resolved.length === 0) {
    return {
      cells: [],
      baselineReturnPct: null,
      totals: { resolved: 0, open },
      finding: "Nothing has resolved yet. The record is empty, which is not the same as neutral.",
      cannotYetAnswer: [
        `${open} calls are still inside their ${VERDICT_HORIZON_SESSIONS}-session window.`,
        "Every question this record exists to answer. An empty record is honest and says nothing.",
      ],
    };
  }

  const baseline = resolved.reduce((s, p) => s + (p.forwardReturnPct ?? 0), 0) / resolved.length;

  const cells: VerdictCell[] = [];
  for (const verdict of ["bullish", "bearish", "neutral"] as ForwardVerdict[]) {
    const group = resolved.filter((p) => p.verdict === verdict);
    if (group.length < MIN_VERDICT_N) continue;
    const rets = group.map((p) => p.forwardReturnPct ?? 0);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;

    const blocks = independentBlocks(group.map((p) => p.date));
    const publishable = blocks >= MIN_INDEPENDENT_BLOCKS;
    const edge =
      verdict === "neutral" ? null : verdict === "bullish" ? mean - baseline : baseline - mean;

    cells.push({
      verdict,
      n: group.length,
      independentN: blocks,
      publishable,
      claim: !publishable
        ? `NO CLAIM. ${group.length} resolved calls, but only ${blocks} independent ` +
          `${blocks === 1 ? "period" : "periods"} — calls made on the same day are ` +
          `cross-correlated and windows within ${VERDICT_HORIZON_SESSIONS} sessions overlap, so ` +
          `this is ${blocks === 1 ? "one observation" : `${blocks} observations`} wearing a large ` +
          `sample's clothes. ${MIN_INDEPENDENT_BLOCKS} independent periods are needed before an ` +
          `edge here means anything. The numbers are shown so they can be watched, not acted on.`
        : verdict === "neutral"
          ? `Neutral calls have no direction, so no hit rate or edge is claimed. Their returns are ` +
            `reported because they belong in the baseline, not because they are a call.`
          : `Over ${blocks} independent periods, ${verdict} calls returned ` +
            `${mean >= 0 ? "+" : ""}${mean.toFixed(2)}% against a ${baseline >= 0 ? "+" : ""}` +
            `${baseline.toFixed(2)}% cohort baseline — an edge of ${(edge ?? 0) >= 0 ? "+" : ""}` +
            `${(edge ?? 0).toFixed(2)}pp.`,
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

  /*
   * THE NULL, SAID IN THOSE WORDS. A record that can only phrase a positive
   * will eventually phrase one, so the sentence for "nothing here" is
   * written first and is the default.
   */
  const publishableCells = cells.filter((c) => c.publishable);
  const withEdge = publishableCells.filter((c) => (c.edgeVsBaselinePct ?? 0) > 0);
  const finding =
    resolved.length === 0
      ? "Nothing has resolved yet. The record is empty, which is not the same as neutral."
      : publishableCells.length === 0
        ? `NOTHING HERE HAS A MEASURABLE EDGE YET. ${resolved.length} calls have resolved, but no ` +
          `cell has the ${MIN_INDEPENDENT_BLOCKS} independent periods an edge claim needs — the ` +
          `most any cell has is ${Math.max(0, ...cells.map((c) => c.independentN))}. This is a ` +
          `statement about the evidence, not about the engine: the calls may be good or bad and ` +
          `this record cannot yet tell you which.`
        : withEdge.length === 0
          ? `NOTHING HERE HAS A MEASURABLE EDGE. Every cell with enough independent periods to ` +
            `judge came in at or below its cohort baseline. That is a real result and the record ` +
            `states it rather than reaching for a positive.`
          : `${withEdge.map((c) => c.verdict).join(" and ")} clear the cohort baseline over ` +
            `${withEdge.map((c) => c.independentN).join("/")} independent periods.`;

  const cannotYetAnswer: string[] = [];
  if (open > 0) cannotYetAnswer.push(`${open} calls are still inside their window and contribute nothing yet.`);
  if (cells.some((c) => !c.publishable))
    cannotYetAnswer.push(
      `Whether any verdict has an edge — no cell yet has ${MIN_INDEPENDENT_BLOCKS} independent periods.`
    );
  cannotYetAnswer.push(
    "Whether an edge, once measurable, survives costs. These are gross forward returns; the round-trip cost of expressing them is priced separately by /api/cost/express."
  );
  cannotYetAnswer.push(
    "Anything about a symbol not in the registered universe, and anything at a horizon other than " +
      `${VERDICT_HORIZON_SESSIONS} sessions.`
  );

  return {
    cells,
    baselineReturnPct: baseline,
    totals: { resolved: resolved.length, open },
    finding,
    cannotYetAnswer,
  };
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
