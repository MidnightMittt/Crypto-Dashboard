import { Bar } from "./types";

/**
 * WOULD THIS STOP HAVE SURVIVED? — P(stop hit) by width and horizon.
 *
 * A stop is chosen as a number of percent and lived with as a probability, and
 * nothing a broker shows connects the two. "5% stop" says nothing about how
 * often this particular name takes out 5% on an ordinary day; a 5% stop on a
 * name whose typical daily range is 9% is not risk management, it is a coin
 * flip with commission. Every miner and datacenter name in this universe has
 * exactly that shape.
 *
 * So this measures the thing directly: enter at a close, hold h sessions, and
 * ask how often the LOW over those sessions took out a stop w percent below
 * entry. The answer is a survival rate for that name at that width and
 * horizon, computed from its own bars.
 *
 * ── Lows, not closes ─────────────────────────────────────────────────
 *
 * A stop is a resting order and gets taken out intraday. Measuring against
 * closes would report a much kinder number than any trader would actually
 * experience — a session that traded down 8% and closed flat did hit the 5%
 * stop, and the close cannot see it. The low is the honest instrument
 * available in daily bars, and it is still OPTIMISTIC: within-day path is
 * invisible, so a gap-down-and-recover looks the same as a slow bleed, and a
 * stop is likelier to fill worse than the low than better.
 *
 * ── Entry bar excluded ───────────────────────────────────────────────
 *
 * Entry is AT the close, so the entry bar's own low is unreachable — it is
 * already in the past when the position opens. Including it would manufacture
 * stop-outs that could not have happened and would bias every survival rate
 * downward by roughly one session's worth of range.
 *
 * ── Overlapping windows, stated rather than hidden ───────────────────
 *
 * Every session is an entry candidate, so consecutive windows share sessions
 * and the observations are correlated. That does NOT bias the survival rate —
 * it is still the fraction of entries that survived — but it does mean n
 * overstates the independent information, so a confidence interval built from
 * it would be too tight. `independentN` reports the non-overlapping count
 * beside it, and nothing here computes a p-value.
 */

/** One cell of the grid: a stop width at a holding horizon. */
export interface StopCell {
  /** Stop distance below entry, in percent. */
  widthPct: number;
  /** Sessions held. The stop is live for all of them. */
  horizonDays: number;
  /** Share of entries whose low never reached the stop, 0-100. */
  survivalPct: number;
  /** Entry sessions measured. Windows OVERLAP — see independentN. */
  n: number;
  /** Non-overlapping windows the same span would hold. The honest sample size. */
  independentN: number;
}

export interface StopGrid {
  symbol: string;
  cells: StopCell[];
  /** Sessions of usable history behind the grid. */
  sessions: number;
  /** First and last entry session, so the window is checkable. */
  fromDate: string;
  toDate: string;
}

/**
 * Below this survival the stop is doing more harm than the trade is worth.
 *
 * Not a tuned number and not claimed to be optimal: it is the point at which
 * roughly one entry in three is stopped out before the thesis has had its
 * horizon to work, which makes the stop — rather than the signal — the thing
 * deciding the outcome. Stated as a threshold so it can be argued with.
 */
export const SURVIVAL_FLOOR_PCT = 70;

/** Widths a retail stop is actually placed at. */
export const DEFAULT_WIDTHS_PCT = [2, 3, 5, 8, 10, 15] as const;
/** Horizons matching the holds this platform already measures. */
export const DEFAULT_HORIZONS = [1, 5, 10, 21] as const;

/** Below this many entry windows a survival rate is not worth printing. */
export const MIN_ENTRIES = 30;

/**
 * Survival of one stop width over one horizon.
 *
 * Returns null when too few complete windows exist, rather than a rate over a
 * handful of entries — a 100% survival on four windows is not a fact about the
 * stop, it is a fact about the sample.
 */
export function survivalAt(
  bars: readonly Bar[],
  widthPct: number,
  horizonDays: number,
  minEntries = MIN_ENTRIES
): StopCell | null {
  if (horizonDays < 1 || widthPct <= 0) return null;

  let survived = 0;
  let total = 0;
  for (let i = 0; i + horizonDays < bars.length; i++) {
    const entry = bars[i].close;
    if (!(entry > 0)) continue;
    const stop = entry * (1 - widthPct / 100);

    let hit = false;
    // From i+1: entry is AT the close of bar i, so its low is already past.
    for (let j = i + 1; j <= i + horizonDays; j++) {
      const low = bars[j].low;
      if (!(low > 0)) continue;
      if (low <= stop) {
        hit = true;
        break;
      }
    }
    total++;
    if (!hit) survived++;
  }

  if (total < minEntries) return null;
  return {
    widthPct,
    horizonDays,
    survivalPct: (survived / total) * 100,
    n: total,
    independentN: Math.floor(total / horizonDays),
  };
}

/**
 * The full grid for one symbol.
 *
 * Bars must already be corporate-action adjusted. An unadjusted split shows up
 * as a 50% low and would read as every stop being hit at once — the same guard
 * the replay and the ATR both apply, and the reason this takes bars rather
 * than fetching its own.
 */
export function stopGrid(
  symbol: string,
  bars: readonly Bar[],
  widths: readonly number[] = DEFAULT_WIDTHS_PCT,
  horizons: readonly number[] = DEFAULT_HORIZONS
): StopGrid | null {
  if (bars.length < MIN_ENTRIES + Math.max(...horizons) + 1) return null;

  const cells: StopCell[] = [];
  for (const h of horizons) {
    for (const w of widths) {
      const cell = survivalAt(bars, w, h);
      if (cell) cells.push(cell);
    }
  }
  if (cells.length === 0) return null;

  return {
    symbol,
    cells,
    sessions: bars.length,
    fromDate: new Date(bars[0].t).toISOString().slice(0, 10),
    toDate: new Date(bars[bars.length - 1].t).toISOString().slice(0, 10),
  };
}

/**
 * The narrowest stop that clears the floor at a given horizon, or null.
 *
 * This is the number a trader actually wants: not a grid, but "how much room
 * does this name need". Null is a real answer and an important one — it means
 * no width on the grid survives often enough, which is a reason not to take
 * the trade rather than a reason to widen indefinitely.
 */
export function narrowestViable(
  grid: StopGrid,
  horizonDays: number,
  floorPct = SURVIVAL_FLOOR_PCT
): StopCell | null {
  return (
    grid.cells
      .filter((c) => c.horizonDays === horizonDays && c.survivalPct >= floorPct)
      .sort((a, b) => a.widthPct - b.widthPct)[0] ?? null
  );
}

/**
 * The stop question answered WITH its reason attached — the API shape.
 *
 * A bare `narrowest_viable_pct: null` collapses three different facts into
 * one token: no width survives, too little history to measure, and (in a
 * caller's own bugs) never computed. The library always knew which; the API
 * destroyed the distinction on the way out, and the trading side spent a
 * session treating "unmeasurable" and "measured and hopeless" as the same
 * state. This carries the meaning through.
 *
 * `widest_tested_pct` is the most survivable width the grid tried — the
 * best case, so `survival_at_widest_pct` says how close the name came to
 * having a stop at all. (The requesting spec called this field "tightest",
 * but the value it holds is the WIDEST width; naming it tightest would be a
 * field reporting a true number under a false name.)
 */
export interface StopWidthVerdict {
  /** Narrowest width clearing the floor. Null exactly when verdict is not "viable". */
  width_pct: number | null;
  verdict: "viable" | "no_width_survives" | "insufficient_history";
  floor_pct: number;
  /** Survival at the viable width. Null when there is none. */
  survival_pct: number | null;
  /** The widest (most survivable) width the grid tested at this horizon. */
  widest_tested_pct: number | null;
  /** Survival at that widest width — the best case this name achieved. */
  survival_at_widest_pct: number | null;
  independent_n: number | null;
  /** One sentence a reader can act on without the fields. */
  note: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function stopVerdictAt(
  grid: StopGrid | null,
  horizonDays: number,
  floorPct = SURVIVAL_FLOOR_PCT
): StopWidthVerdict {
  const atHorizon = grid?.cells.filter((c) => c.horizonDays === horizonDays) ?? [];
  if (atHorizon.length === 0) {
    return {
      width_pct: null,
      verdict: "insufficient_history",
      floor_pct: floorPct,
      survival_pct: null,
      widest_tested_pct: null,
      survival_at_widest_pct: null,
      independent_n: null,
      note: `Too little history to measure stop survival at ${horizonDays} sessions. Unmeasured is not the same as safe.`,
    };
  }

  const widest = [...atHorizon].sort((a, b) => b.widthPct - a.widthPct)[0];
  const viable = grid ? narrowestViable(grid, horizonDays, floorPct) : null;

  if (!viable) {
    return {
      width_pct: null,
      verdict: "no_width_survives",
      floor_pct: floorPct,
      survival_pct: null,
      widest_tested_pct: widest.widthPct,
      survival_at_widest_pct: r1(widest.survivalPct),
      independent_n: widest.independentN,
      note:
        `No tested width survives ${floorPct}% of ${horizonDays}-session holds — even ` +
        `${widest.widthPct}% survives only ${r1(widest.survivalPct)}%. At this volatility the ` +
        `position's downside must be bounded by construction (a defined-risk structure) or by ` +
        `time, not by an exit level.`,
    };
  }

  return {
    width_pct: viable.widthPct,
    verdict: "viable",
    floor_pct: floorPct,
    survival_pct: r1(viable.survivalPct),
    widest_tested_pct: widest.widthPct,
    survival_at_widest_pct: r1(widest.survivalPct),
    independent_n: viable.independentN,
    note:
      `A ${viable.widthPct}% stop survives ${r1(viable.survivalPct)}% of ${horizonDays}-session ` +
      `holds — the narrowest tested width clearing the ${floorPct}% floor.`,
  };
}

/**
 * One sentence, naming the width and what it costs.
 *
 * Never a bare percentage: the whole point is that "5%" is meaningless until
 * it is attached to how often this name takes it out.
 */
export function describeStop(grid: StopGrid, horizonDays: number): string {
  const viable = narrowestViable(grid, horizonDays);
  const tightest = grid.cells
    .filter((c) => c.horizonDays === horizonDays)
    .sort((a, b) => a.widthPct - b.widthPct)[0];

  if (!tightest) return `No stop grid at a ${horizonDays}-session hold.`;

  if (!viable) {
    const widest = grid.cells
      .filter((c) => c.horizonDays === horizonDays)
      .sort((a, b) => b.widthPct - a.widthPct)[0];
    return (
      `NO stop on this grid survives ${SURVIVAL_FLOOR_PCT}% of ${horizonDays}-session holds in ${grid.symbol}. ` +
      `Even ${widest.widthPct}% is taken out ${(100 - widest.survivalPct).toFixed(0)}% of the time over ` +
      `${widest.n} entries. The stop would be deciding this trade, not the signal.`
    );
  }

  return (
    `${grid.symbol} needs at least a ${viable.widthPct}% stop to survive a ${horizonDays}-session hold ` +
    `${viable.survivalPct.toFixed(0)}% of the time (${viable.n} entries). A ${tightest.widthPct}% stop ` +
    `survives only ${tightest.survivalPct.toFixed(0)}%.`
  );
}
