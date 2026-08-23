import { Bar } from "./types";

/**
 * A MATCHED DAILY-BAR PANEL — every positioning symbol on one calendar.
 *
 * The defect this exists to close is a silent join. Positioning history is
 * recorded for ~105 symbols, but committed bars existed for only a handful,
 * so a cross-sectional test joining "short-sale share" to "next-day return"
 * quietly kept the intersection: a 105-symbol hypothesis was measured on 10,
 * n collapsed to 32/16/8, and the answer (t = −1.52, p = 0.145) said more
 * about the join than about short sellers. Matched bars for the whole
 * universe are what make that test's n mean what it appears to mean.
 *
 * ── The calendar is a QUORUM, not a union ─────────────────────────────
 *
 * A union calendar lets one off-convention series define sessions for
 * everyone. That is not hypothetical here: one such series once turned a
 * 5-day hold into 2 real sessions and made a robustness test a no-op in 29%
 * of periods. A date only becomes a session if at least half the symbols
 * LISTED by that date actually traded. All 105 symbols are US-listed, so in
 * practice this is the NYSE calendar — but derived from the data rather than
 * asserted, so a half-day or an exchange outage cannot desynchronise the
 * panel from itself.
 *
 * ── Interpolation is flagged, bounded, and honest ─────────────────────
 *
 * A matched panel needs a value in every interior cell, and the only honest
 * fill for a missed session is the previous close carried forward: the name
 * existed, it had a price, nobody traded it here. Three rules keep the fill
 * from becoming fabrication:
 *
 *   - INTERIOR gaps only. Before a symbol's first bar there is no price to
 *     carry — those cells are null, never invented. After its last bar the
 *     symbol may be delisted or the feed dead, and carrying a close forward
 *     indefinitely would quote a live price for a dead name — null again.
 *   - Volume is null on filled bars, not 0. Zero is a number a volume
 *     filter would act on; null says "not observed", which is the truth.
 *   - Every filled index is listed in `interpolated`, per symbol, so any
 *     consumer can exclude fills entirely rather than trusting the policy.
 *
 * Prices arrive already split- and dividend-adjusted by the ingest (the
 * whole bar is scaled by the adjusted close's factor, so high/low
 * containment survives). This module never re-adjusts.
 */

/** [open, high, low, close, volume]. Volume null = not observed (filled bar). */
export type PanelRow = [number, number, number, number, number | null];

export interface SymbolPanel {
  /** One entry per session in `sessions`; null where no honest value exists. */
  bars: (PanelRow | null)[];
  /** Indices into `sessions` whose row is a carried-forward fill. */
  interpolated: number[];
}

export interface BarsPanel {
  version: 1;
  generatedAt: number;
  /** ISO dates, oldest first. The one calendar every symbol is matched to. */
  sessions: string[];
  fields: ["open", "high", "low", "close", "volume"];
  adjusted: "splits-and-dividends";
  symbols: Record<string, SymbolPanel>;
}

/** Share of active symbols that must trade on a date for it to be a session. */
export const SESSION_QUORUM = 0.5;

/** Sessions kept in the committed panel. Headroom over the 250 tests need. */
export const PANEL_SESSIONS = 300;

/**
 * Prices are rounded to 4 decimals: sub-basis-point noise on a $1 name, far
 * below any spread in this universe, and it keeps the committed artifact
 * within a size the repository can carry daily.
 */
const PRICE_DECIMALS = 4;

const round = (v: number) => Number(v.toFixed(PRICE_DECIMALS));

/** UTC date of a close timestamp. Bars are close-stamped by the ingest. */
export function sessionKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Build the matched panel from per-symbol bar series.
 *
 * Series need not be aligned, sorted, or complete; they must already be
 * corporate-action adjusted. Symbols with no bars at all still appear in the
 * output (all-null), so absence is visible rather than silently dropped —
 * the caller decides whether that fails the build.
 */
export function alignPanel(
  seriesBySymbol: Record<string, readonly Bar[]>,
  opts: { sessions?: number; quorum?: number; now?: number } = {}
): BarsPanel {
  const window = opts.sessions ?? PANEL_SESSIONS;
  const quorum = opts.quorum ?? SESSION_QUORUM;

  // Per symbol: session-keyed map (last bar wins on a duplicate key), plus
  // first/last dates defining when the symbol is "active".
  const bySymbol = new Map<string, { byDate: Map<string, Bar>; first: string; last: string }>();
  for (const [symbol, series] of Object.entries(seriesBySymbol)) {
    const byDate = new Map<string, Bar>();
    for (const bar of [...series].sort((a, b) => a.t - b.t)) byDate.set(sessionKey(bar.t), bar);
    if (byDate.size === 0) continue;
    const dates = [...byDate.keys()].sort();
    bySymbol.set(symbol, { byDate, first: dates[0], last: dates[dates.length - 1] });
  }

  // Quorum calendar: a date is a session only if at least `quorum` of the
  // symbols LISTED by then actually traded. Deliberately not bounded by each
  // symbol's last bar: if it were, a date past everyone's history would pass
  // on the strength of the one series that has it — the off-convention
  // failure again, at the calendar's tail. So a delisted name votes against
  // a session rather than abstaining; with 105 live names that costs
  // nothing, and it means no single series can ever extend the calendar.
  const candidates = [...new Set([...bySymbol.values()].flatMap((s) => [...s.byDate.keys()]))].sort();
  const sessions = candidates
    .filter((date) => {
      let active = 0;
      let traded = 0;
      for (const s of bySymbol.values()) {
        if (date < s.first) continue;
        active++;
        if (s.byDate.has(date)) traded++;
      }
      return active > 0 && traded / active >= quorum;
    })
    .slice(-window);

  const symbols: Record<string, SymbolPanel> = {};
  for (const symbol of Object.keys(seriesBySymbol).sort()) {
    const s = bySymbol.get(symbol);
    const bars: (PanelRow | null)[] = [];
    const interpolated: number[] = [];
    let prevClose: number | null = null;

    for (let i = 0; i < sessions.length; i++) {
      const date = sessions[i];
      const bar = s?.byDate.get(date);
      if (bar) {
        bars.push([round(bar.open), round(bar.high), round(bar.low), round(bar.close), bar.volume ?? null]);
        prevClose = round(bar.close);
      } else if (s && prevClose !== null && date > s.first && date < s.last) {
        // Interior gap: the name existed and had a price; nobody traded it here.
        bars.push([prevClose, prevClose, prevClose, prevClose, null]);
        interpolated.push(i);
      } else {
        bars.push(null);
      }
    }
    symbols[symbol] = { bars, interpolated };
  }

  return {
    version: 1,
    generatedAt: opts.now ?? Date.now(),
    sessions,
    fields: ["open", "high", "low", "close", "volume"],
    adjusted: "splits-and-dividends",
    symbols,
  };
}

/** Sessions with a usable (real or filled) row for one symbol. */
export function coverage(panel: SymbolPanel): number {
  return panel.bars.filter((b) => b !== null).length;
}

/**
 * Closes on the panel calendar, ALIGNED — index i is always session i.
 *
 * The distinction from every other reader in this codebase is that nothing is
 * compacted away. `realBars` drops missing and interpolated rows, which is
 * right for a per-symbol path measurement and wrong for anything comparing
 * two symbols: dropping a row shifts every later value up by one and silently
 * correlates one name's Tuesday against another's Wednesday. That does not
 * fail loudly. It just returns a lower number and reports the panel as more
 * diverse than it is.
 *
 * Interpolated fills are nulled for the same reason they are excluded
 * elsewhere — a carried-forward close manufactures a zero return, and zeros
 * against real returns drag any correlation toward zero.
 *
 * Lives here rather than in the routes that need it because two of them now
 * do, and a correlation input duplicated per caller is a correlation input
 * that will eventually disagree with itself.
 */
export function alignedCloses(panel: BarsPanel, symbol: string): (number | null)[] {
  const sp = panel.symbols[symbol];
  if (!sp) return panel.sessions.map(() => null);
  const filled = new Set(sp.interpolated);
  return panel.sessions.map((_, i) => (filled.has(i) ? null : (sp.bars[i]?.[3] ?? null)));
}
