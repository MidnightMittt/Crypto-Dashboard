import { Bar } from "./types";

/**
 * CORPORATE ACTIONS AND BROKEN PRINTS — the guard on everything computed
 * from a price series.
 *
 * A single unadjusted split, merger or post-bankruptcy relisting injects one
 * enormous return into a series, and every statistic that touches it is then
 * wrong: ATR, realised volatility, momentum, forward returns, reach rates.
 * The damage is invisible downstream because the output is a plausible
 * number either way — a stock does not look broken for having high measured
 * volatility.
 *
 * ── What the audit actually found, 2026-08-16 ─────────────────────────
 *
 * Scanned 1,110,759 sessions across the whole ingest. Four moves beyond
 * 100%, forty-one beyond 50%, and they are NOT all the same defect:
 *
 *   NVR  1993-10-01   0.38 -> 10.25  (+2633%)   STEP
 *   MARA 2012-09-10 104.00 -> 30.16  (-71%)     SPIKE, down leg
 *   MARA 2012-09-11  30.16 -> 104.00 (+245%)    SPIKE, up leg
 *   MS   2008-10-13   6.52 -> 12.19  (+87%)     REAL (Mitsubishi UFJ)
 *
 * NVR sat flat at 0.38 for days, stepped once, and stayed at the new level —
 * its Chapter 11 emergence, unadjusted. Prices either side are internally
 * consistent; exactly one return is fictional.
 *
 * MARA is a different animal. It printed O=H=L=C=104.00 for weeks at a time,
 * interrupted by single sessions at 30.16 or 53.04 and straight back. That is
 * a broken or placeholder print, not a corporate action, and it injects TWO
 * fictional returns — a crash and a recovery. A rule that only drops moves
 * beyond +100% would delete the +245% and KEEP the -71%, leaving a one-sided
 * crash in the series. That is worse than leaving both alone, which is why
 * the two kinds are separated here rather than handled by one threshold.
 *
 * MS in October 2008 is a real +87% on the Mitsubishi UFJ investment. No
 * threshold can tell it apart from an unadjusted action by magnitude alone,
 * which is the honest limit of this module: the default 100% cut-off is set
 * above the largest genuine move in the sample, not derived from theory. It
 * will miss a fabricated 60% jump and it would catch a real 150% one.
 *
 * ── Why STEPS are rescaled rather than dropped ────────────────────────
 *
 * Dropping the offending BAR does not remove the offending RETURN: the gap
 * simply closes and the return from i-1 to i+1 is just as large. What works
 * is rescaling the earlier segment onto the later one, and it is safe for a
 * reason worth stating — multiplying a segment by a positive constant leaves
 * every return INSIDE that segment exactly unchanged. So back-adjustment
 * repairs the one fictional return and preserves all the real ones. Nothing
 * is discarded and no price is invented; only historical price LEVELS move,
 * and nothing here reads a historical level except through a ratio.
 *
 * The break session's own return becomes zero by construction. That is an
 * assumption, and it is the conservative one: it contributes no volatility
 * and no momentum in either direction.
 */

/**
 * Default cut-off, as a fraction: 1.0 means the price changed by a factor of
 * more than 2 in EITHER direction. Set above the largest genuine move in this
 * sample (MS +87%, a factor of 1.87) rather than derived — see the limit
 * stated above.
 *
 * ── Why the test is on the FACTOR and not on the percentage ───────────
 *
 * A percentage threshold is silently one-sided. Price cannot fall more than
 * 100%, so `|ratio - 1| > 1.0` can never fire on a drop: MARA's -71% crash
 * scores 0.71 and slips through while its +245% recovery is caught. A rule
 * like that removes recoveries and keeps crashes, which is the opposite of
 * what it is for. Comparing max(ratio, 1/ratio) treats a halving and a
 * doubling as the same size of event, which is what they are.
 */
export const MAX_SESSION_MOVE = 1.0;

/** Symmetric size of a move: 2 for a doubling, 2 for a halving. */
function moveFactor(ratio: number): number {
  return ratio >= 1 ? ratio : 1 / ratio;
}

/**
 * How many sessions a price has to come back within for the excursion to be
 * a spike rather than a step. MARA's return trip took one session; three
 * allows for a short bad patch without swallowing a genuine round trip.
 */
export const SPIKE_REVERSION_SESSIONS = 3;

/**
 * How close the price must return for the excursion to count as reverted.
 * 0.25 means "back within 25% of where it started" — loose, because the
 * recovery from a bad print need not be exact.
 */
export const SPIKE_REVERSION_TOLERANCE = 0.25;

export type PriceBreakKind = "step" | "spike";

export interface PriceBreak {
  /** Index of the bar whose return FROM the previous bar broke the threshold. */
  index: number;
  date: string;
  kind: PriceBreakKind;
  /** close[index] / close[index - 1]. */
  ratio: number;
  previousClose: number;
  close: number;
  /** For a spike, the index the series had returned to normal by. */
  revertsAtIndex: number | null;
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Locate every session whose close-to-close move exceeds the threshold, and
 * classify each as a step (permanent level change) or a spike (excursion that
 * comes back).
 */
export function findPriceBreaks(bars: Bar[], threshold = MAX_SESSION_MOVE): PriceBreak[] {
  const breaks: PriceBreak[] = [];
  /*
   * Sessions already accounted for by a spike's return trip. Without this the
   * recovery leg is re-detected as a fresh break and — having nothing to
   * revert to — misclassified as a STEP, which would then rescale the entire
   * history before it. One excursion must produce one finding.
   */
  let consumedThrough = 0;

  for (let i = 1; i < bars.length; i++) {
    if (i <= consumedThrough) continue;
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (!(prev > 0) || !(cur > 0)) continue;
    const ratio = cur / prev;
    if (moveFactor(ratio) <= 1 + threshold) continue;

    /*
     * Reverted? Compare against the price BEFORE the excursion. A spike is
     * defined by coming home, not by its direction, so this catches the
     * down-then-up shape and the up-then-down one identically.
     */
    let revertsAtIndex: number | null = null;
    for (let j = i + 1; j <= Math.min(i + SPIKE_REVERSION_SESSIONS, bars.length - 1); j++) {
      const back = bars[j].close;
      if (!(back > 0)) continue;
      if (Math.abs(back / prev - 1) <= SPIKE_REVERSION_TOLERANCE) {
        revertsAtIndex = j;
        break;
      }
    }

    breaks.push({
      index: i,
      date: iso(bars[i].t),
      kind: revertsAtIndex === null ? "step" : "spike",
      ratio,
      previousClose: prev,
      close: cur,
      revertsAtIndex,
    });
    // The return trip belongs to this excursion, not to a new one.
    if (revertsAtIndex !== null) consumedThrough = revertsAtIndex;
  }
  return breaks;
}

/**
 * DECLARED PRICE EVENTS — steps are judged, never auto-repaired.
 *
 * Magnitude alone cannot tell an unadjusted action from a violent real move,
 * and the two errors are not symmetric. Missing an action leaves one bad
 * return. "Fixing" a real one DELETES a genuine return and rescales all the
 * history before it — so the default for anything unjudged is to leave it
 * alone and say so loudly.
 *
 * What separates them in this sample is volume and intraday range, not size:
 *
 *   REGN 2003-03-31  -57%   28.3M vs 678K normal (42x), wide range, three
 *                           days of follow-through — the Axokine Phase 3
 *                           failure. REAL.
 *   MARA 2017-11-24  +173%  11.1M vs 150K (73x), traded 12.76-24.16 and kept
 *                           running the next session — the crypto pivot. REAL.
 *   NVR  1987-06-23  -78%   91K against a prior 287K, high equal to close,
 *                           low equal to open, and the NEXT session printed
 *                           zero volume. Nobody traded it. ACTION.
 *
 * A genuine crash is the highest-volume session in a symbol's history. An
 * unadjusted action is a session nobody traded. That is the test a human
 * applies here before adding a row.
 */
export interface DeclaredPriceEvent {
  symbol: string;
  /** ISO date of the bar whose return from the prior close is affected. */
  date: string;
  /** "adjust" back-adjusts the prior segment; "keep" states the move is real. */
  treatment: "adjust" | "keep";
  reason: string;
}

export const DECLARED_PRICE_EVENTS: DeclaredPriceEvent[] = [
  {
    symbol: "NVR",
    date: "1993-10-01",
    treatment: "adjust",
    reason: "Chapter 11 emergence, unadjusted by the provider: flat at 0.38 for days, one step to 10.25, level held",
  },
  {
    symbol: "NVR",
    date: "1987-06-23",
    treatment: "adjust",
    reason: "unadjusted action: volume BELOW the prior session and a degenerate range, followed by a zero-volume session",
  },
  {
    symbol: "REGN",
    date: "2003-03-31",
    treatment: "keep",
    reason: "real — Axokine Phase 3 failure on 42x normal volume with three sessions of follow-through",
  },
  {
    symbol: "MARA",
    date: "2017-11-24",
    treatment: "keep",
    reason: "real — crypto-pivot repricing on 73x normal volume, wide intraday range, continued the next session",
  },
  /*
   * The four surfaced when the scanner names were first ingested, 2026-08-16.
   * Every one is real, and every one would have been destroyed by a rule that
   * back-adjusts anything past a size threshold — which is the case for
   * judging rather than guessing, made concrete.
   */
  {
    symbol: "APLD",
    date: "2022-06-13",
    treatment: "keep",
    reason: "real — the June 2022 crypto collapse: -53% on 8.8x volume, a 73% intraday range and three sessions of follow-through",
  },
  {
    symbol: "CLSK",
    date: "2018-09-19",
    treatment: "keep",
    reason: "real — 76x volume and a 185% intraday range. Traded on 10-400 shares a session before this, so the PRICES are barely meaningful, but the move is not an unadjusted action",
  },
  {
    symbol: "CLSK",
    date: "2020-05-05",
    treatment: "keep",
    reason: "real — 80.3M shares against a 290K median, 277x, on a 93% range. Among the most heavily traded sessions in the symbol's history",
  },
  {
    symbol: "OKLO",
    date: "2024-05-10",
    treatment: "keep",
    reason: "real — first session trading as an operating company after the AltC de-SPAC: -54% on 18.3x volume, 94% range, sustained for days. The shares are the same shares; the market repriced them",
  },
];

export interface AdjustOptions {
  threshold?: number;
  /** Injectable so tests declare their own verdicts rather than the real registry. */
  declared?: DeclaredPriceEvent[];
}

export interface AdjustmentNote {
  date: string;
  kind: PriceBreakKind;
  ratio: number;
  /** What was done, in words, for the log. */
  action: string;
  /** Bars affected, so the size of the intervention is visible. */
  barsAffected: number;
  /**
   * True when a step was found that nobody has judged. The series is left
   * ALONE and the caller is expected to surface this — an unreviewed step is
   * a question for a human, not a licence to rewrite history.
   */
  undeclared: boolean;
}

export interface AdjustedSeries {
  bars: Bar[];
  notes: AdjustmentNote[];
  /** Steps found with no declared verdict. Non-empty means the data needs a look. */
  undeclared: AdjustmentNote[];
}

function scaleBar(b: Bar, k: number): Bar {
  return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
}

/**
 * Repair a series for unadjusted corporate actions and broken prints.
 *
 * STEPS are back-adjusted: every bar before the break is multiplied so the
 * segments join. SPIKES have their excursion bars replaced by the last good
 * close, which removes both fictional returns instead of one.
 *
 * Never silent: every intervention is returned as a note, and callers are
 * expected to log them. A series with no breaks comes back untouched and
 * with an empty note list, so this is safe to run over everything.
 */
export function adjustForCorporateActions(
  bars: Bar[],
  symbol: string,
  opts: AdjustOptions = {}
): AdjustedSeries {
  const threshold = opts.threshold ?? MAX_SESSION_MOVE;
  const registry = opts.declared ?? DECLARED_PRICE_EVENTS;
  const declaredFor = (d: string) =>
    registry.find((e) => e.symbol === symbol && e.date === d);

  const breaks = findPriceBreaks(bars, threshold);
  if (breaks.length === 0) return { bars, notes: [], undeclared: [] };

  const out = bars.map((b) => ({ ...b }));
  const notes: AdjustmentNote[] = [];

  /*
   * Latest break first. Rescaling a prefix changes the levels of everything
   * before it, so working backwards means each adjustment is applied to a
   * segment whose later neighbour is already settled.
   */
  for (const br of [...breaks].sort((a, b) => b.index - a.index)) {
    if (br.kind === "spike" && br.revertsAtIndex !== null) {
      /*
       * Flatten the excursion onto the last good close. Carrying the price
       * forward is the one repair that invents no direction: the sessions
       * become zero-return rather than guessing what the price "should" have
       * been.
       */
      const good = out[br.index - 1].close;
      let affected = 0;
      for (let i = br.index; i < br.revertsAtIndex; i++) {
        const k = good / out[i].close;
        out[i] = scaleBar(out[i], k);
        affected++;
      }
      notes.push({
        date: br.date,
        kind: "spike",
        ratio: br.ratio,
        action: `excursion flattened to the prior close ${good.toFixed(4)}; both the move and its recovery removed`,
        barsAffected: affected,
        undeclared: false,
      });
      continue;
    }

    /*
     * STEP: only ever repaired against a declared verdict. Rescaling on
     * suspicion would delete a real crash and rewrite every price before it,
     * which is a far worse outcome than leaving one bad return in place.
     */
    const declared = declaredFor(br.date);
    if (!declared) {
      notes.push({
        date: br.date,
        kind: "step",
        ratio: br.ratio,
        action:
          `UNDECLARED step of x${moveFactor(br.ratio).toFixed(2)} — series left untouched. ` +
          `Judge it (volume and intraday range, not size) and add it to DECLARED_PRICE_EVENTS`,
        barsAffected: 0,
        undeclared: true,
      });
      continue;
    }
    if (declared.treatment === "keep") {
      notes.push({
        date: br.date,
        kind: "step",
        ratio: br.ratio,
        action: `kept as a real move — ${declared.reason}`,
        barsAffected: 0,
        undeclared: false,
      });
      continue;
    }

    const k = br.ratio;
    for (let i = 0; i < br.index; i++) out[i] = scaleBar(out[i], k);
    notes.push({
      date: br.date,
      kind: "step",
      ratio: br.ratio,
      action: `back-adjusted ${br.index} prior bars by x${k.toFixed(6)} — ${declared.reason}`,
      barsAffected: br.index,
      undeclared: false,
    });
  }

  notes.reverse(); // chronological, for a readable log
  return { bars: out, notes, undeclared: notes.filter((n) => n.undeclared) };
}

/** One line per intervention, for the ingest log. Never called on an empty list. */
export function formatAdjustmentNotes(symbol: string, notes: AdjustmentNote[]): string[] {
  return notes.map(
    (n) =>
      `[corporate-action] ${symbol} ${n.date} ${n.kind.toUpperCase()} ` +
      `ratio ${n.ratio.toFixed(4)} — ${n.action} (${n.barsAffected} bars)`
  );
}
