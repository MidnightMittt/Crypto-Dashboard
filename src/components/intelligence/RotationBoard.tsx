import {
  RotationRead,
  RotationState,
  ROTATION_STATE_LABEL,
  ROTATION_STATE_MEANING,
} from "@/lib/markets/rotation";

/**
 * THE ROTATION BOARD.
 *
 * Four columns, ordered by where a decision is rather than by rank:
 * IMPROVING first (capital arriving, least crowded), then LEADING, then
 * WEAKENING, then LAGGING. A conventional table sorted by performance buries
 * the two transition states in the middle, which is exactly backwards —
 * "leading" and "lagging" describe positions already taken, and only the
 * transitions are actionable.
 *
 * Computes nothing. Every value is `buildRotation` output; this groups it.
 */

const ORDER: RotationState[] = ["improving", "leading", "weakening", "lagging"];

const COLUMN: Record<RotationState, { accent: string; bar: string; note: string }> = {
  improving: { accent: "text-success", bar: "bg-success", note: "Capital arriving" },
  leading: { accent: "text-cyan", bar: "bg-cyan", note: "Capital here" },
  weakening: { accent: "text-amber", bar: "bg-amber", note: "Capital leaving" },
  lagging: { accent: "text-ink-faint", bar: "bg-ink-faint", note: "Capital absent" },
};

export function RotationBoard({ read, narrative }: { read: RotationRead; narrative: string | null }) {
  /* Scale bars against the largest absolute move on the board, so the visual
     is proportional to what actually happened rather than to a fixed range. */
  const maxAbs = Math.max(...read.sectors.map((s) => Math.abs(s.shortRelPct)), 1);

  return (
    <section className="rounded-xl border border-hairline bg-panel/60 px-5 py-5 shadow-glass backdrop-blur-xs sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-muted">
          Capital rotation
        </h2>
        <span className="font-mono text-[10px] text-ink-faint">
          {read.sectors.length} sectors vs {read.benchmark} · dispersion {read.dispersionPct.toFixed(1)}pp
        </span>
      </div>

      {narrative && <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-ink">{narrative}</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ORDER.map((state) => {
          const rows = read.sectors.filter((s) => s.state === state);
          const cfg = COLUMN[state];
          return (
            <div key={state} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2 border-b border-hairline pb-1.5">
                <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${cfg.accent}`}>
                  {ROTATION_STATE_LABEL[state]}
                </span>
                <span className="text-[9px] uppercase tracking-[0.12em] text-ink-faint">{cfg.note}</span>
              </div>

              {rows.length === 0 ? (
                <p className="text-[11px] leading-relaxed text-ink-faint">None.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {rows.map((s) => (
                    <li key={s.symbol}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[12px] text-ink">{s.name}</span>
                        <span className="shrink-0 font-mono text-[11px] text-ink-faint">{s.symbol}</span>
                      </div>
                      {/* Bar reads left-to-right from a centre line: the 1-month
                          relative move, which is the axis the ordering uses. */}
                      <div className="mt-1 flex items-center gap-2">
                        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-void">
                          <span
                            className={`absolute top-0 h-full ${cfg.bar}`}
                            style={{
                              left: s.shortRelPct >= 0 ? "50%" : undefined,
                              right: s.shortRelPct < 0 ? "50%" : undefined,
                              width: `${(Math.abs(s.shortRelPct) / maxAbs) * 50}%`,
                            }}
                          />
                          <span className="absolute left-1/2 top-0 h-full w-px bg-hairline" />
                        </div>
                        <span className={`w-14 shrink-0 text-right font-mono text-[11px] ${cfg.accent}`}>
                          {s.shortRelPct >= 0 ? "+" : ""}
                          {s.shortRelPct.toFixed(1)}
                        </span>
                      </div>
                      <p className="mt-0.5 font-mono text-[9px] text-ink-faint">
                        6m {s.longRelPct >= 0 ? "+" : ""}
                        {s.longRelPct.toFixed(1)}pp · shift {s.momentumPct >= 0 ? "+" : ""}
                        {s.momentumPct.toFixed(1)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{ROTATION_STATE_MEANING[state]}</p>
            </div>
          );
        })}
      </div>

      <p className="mt-4 border-t border-hairline pt-3 text-[10px] leading-relaxed text-ink-faint">
        Every number is one sector&apos;s return minus {read.benchmark}&apos;s over the same window — 21
        sessions for the bar, 126 for the six-month figure. Dividing by the benchmark cancels the market
        factor the sectors share, so what is left is the part that is about that sector. Nothing here is
        a house view: the order is whatever the ratio lines produce, and the only boundary is zero.
      </p>
    </section>
  );
}
