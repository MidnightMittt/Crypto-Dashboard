import { TickerDossier } from "@/lib/dossier/types";
import {
  DEFAULT_HORIZONS,
  DEFAULT_WIDTHS_PCT,
  SURVIVAL_FLOOR_PCT,
  StopGrid,
  describeStop,
  narrowestViable,
} from "@/lib/research/stopViability";

/**
 * HOW MUCH ROOM DOES THE STOP NEED?
 *
 * A stop is chosen as a percentage and lived with as a probability, and no
 * broker connects the two. The grid answers it for this name: enter at a
 * close, hold h sessions, and how often did the intraday low take out a stop
 * w percent below entry.
 *
 * The headline is a SENTENCE, not the grid — "APLD needs at least a 15% stop
 * to survive a 5-session hold" is the decision; the grid is the working. That
 * ordering is the same one the rest of the dossier follows.
 */

/** The horizon the plan actually uses, and therefore the one to lead with. */
const HEADLINE_HORIZON = 5;

function cellTone(survivalPct: number): string {
  if (survivalPct >= SURVIVAL_FLOOR_PCT) return "text-success";
  if (survivalPct >= 50) return "text-amber";
  return "text-danger";
}

export default function StopGridPanel({ d }: { d: TickerDossier }) {
  const read = d.stopGrid;
  if (read.status === "unavailable") {
    return (
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Stop survival not measured — {read.reason}
      </p>
    );
  }

  const grid: StopGrid = read.data;
  const viable = narrowestViable(grid, HEADLINE_HORIZON);
  const horizons = DEFAULT_HORIZONS.filter((h) => grid.cells.some((c) => c.horizonDays === h));
  const widths = DEFAULT_WIDTHS_PCT.filter((w) => grid.cells.some((c) => c.widthPct === w));
  const at = (w: number, h: number) => grid.cells.find((c) => c.widthPct === w && c.horizonDays === h);
  const sample = grid.cells.find((c) => c.horizonDays === HEADLINE_HORIZON);

  return (
    <div className="flex flex-col gap-3">
      {/* The answer, before the working. */}
      <p className="text-[13px] leading-relaxed text-ink">{describeStop(grid, HEADLINE_HORIZON)}</p>

      {!viable && (
        <p className="rounded-md border border-danger/30 bg-danger/[0.05] px-3 py-2 text-[11px] leading-relaxed text-ink">
          <span className="font-semibold uppercase tracking-[0.12em] text-danger">No viable stop</span> · Widening
          further is not the fix. A position that cannot be stopped at any width on this grid is one whose size is
          the only remaining risk control.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-ink-faint">
              <th className="pb-1 pr-3 text-left font-normal">stop</th>
              {horizons.map((h) => (
                <th key={h} className="pb-1 pr-3 text-right font-normal">
                  {h}d
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {widths.map((w) => (
              <tr key={w}>
                <td className="py-0.5 pr-3 text-ink-muted">{w}%</td>
                {horizons.map((h) => {
                  const c = at(w, h);
                  return (
                    <td key={h} className={`py-0.5 pr-3 text-right ${c ? cellTone(c.survivalPct) : "text-ink-faint"}`}>
                      {c ? `${c.survivalPct.toFixed(0)}%` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] leading-relaxed text-ink-faint">
        Share of entries whose intraday LOW never reached the stop. Green clears the {SURVIVAL_FLOOR_PCT}% floor,
        red is below half. Measured over {grid.sessions} sessions, {grid.fromDate} to {grid.toDate}
        {sample ? `, ${sample.n} entry windows per cell at ${HEADLINE_HORIZON}d` : ""}.
      </p>
      {/*
        Two caveats that change how the numbers should be read, and neither is
        optional: the windows overlap, and daily bars cannot see intraday path.
      */}
      <p className="text-[10px] leading-relaxed text-ink-faint">
        Windows overlap — every session is an entry candidate — so the entry count overstates independent
        observations{sample ? ` (${sample.independentN} non-overlapping at ${HEADLINE_HORIZON}d)` : ""}. And a daily
        low cannot show within-session path, so a real fill is likelier to be worse than the low than better. Both
        make these rates optimistic rather than conservative.
      </p>
    </div>
  );
}
