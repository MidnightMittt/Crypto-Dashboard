import { TickerDossier } from "@/lib/dossier/types";
import { TRAIL_ATR_MULTIPLE, TrendState } from "@/lib/research/trendState";

/**
 * THE EXIT LEVEL, AS A PRICE.
 *
 * The failure this renders against is behavioural, not analytical: an exit
 * taken mid-session with no reference level on screen is a decision made by
 * the tape. So the level is the largest thing in the panel, in dollars, above
 * everything that explains it — a number you can hold in your head and act on
 * without re-reading the card.
 *
 * Everything else here exists to stop the number being misread: the ATR in
 * dollars AND percent, because the whole reason the line is where it is is
 * that a percentage trail would sit inside one session's range.
 */

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

export default function TrendStatePanel({ d }: { d: TickerDossier }) {
  const read = d.trendState;
  if (read.status === "unavailable") {
    return <p className="text-[11px] leading-relaxed text-ink-faint">Exit level not measured — {read.reason}</p>;
  }

  const t: TrendState = read.data;

  return (
    <div className="flex flex-col gap-3">
      {/* The number, first and loudest. Everything below is why it is there. */}
      <div
        className={`rounded-md border px-3 py-3 ${
          t.intact ? "border-line/60 bg-surface/40" : "border-danger/30 bg-danger/[0.05]"
        }`}
      >
        <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          {t.intact ? "Trend is over below" : "Trend is over — already through"}
        </div>
        <div className="font-mono text-[26px] leading-tight text-ink">{money(t.trailStop)}</div>
        <div className="mt-1 font-mono text-[11px] text-ink-muted">
          now {money(t.price)}
          {t.intact ? (
            <>
              {" · "}
              <span className="text-ink">{money(t.roomUsd)}</span> of room ({t.roomAtr.toFixed(1)} ATR)
            </>
          ) : (
            <>
              {" · "}
              <span className="text-danger">{money(Math.abs(t.roomUsd))} below the line</span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-ink-muted">
        <span>
          <span className="text-ink-faint">trailing high</span> {money(t.trailingHigh)}
        </span>
        <span>
          <span className="text-ink-faint">less</span> {TRAIL_ATR_MULTIPLE} ATR
        </span>
        <span>
          {/*
            The ATR in BOTH units is the argument for the whole panel: a reader
            seeing 13% here understands instantly why a 5% trail is noise.
          */}
          <span className="text-ink-faint">1 session</span> {money(t.atr)} ({t.atrPct.toFixed(1)}%)
        </span>
        <span>
          <span className="text-ink-faint">over</span> {t.lookback} sessions
        </span>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-muted">
        Measured in ATR rather than percent because a percentage trail is a different instrument on every name — at{" "}
        {t.atrPct.toFixed(1)}% daily range, a 5% trail on {t.symbol} would sit{" "}
        {t.atrPct > 5 ? "inside a single session's movement" : "well outside its normal range"}.
      </p>
      {/*
        The trailing high moves on closes only. Stated because a reader
        watching an intraday spike will otherwise expect the line to follow it.
      */}
      <p className="text-[10px] leading-relaxed text-ink-faint">
        The high is taken on closes, so an intraday spike does not move this line up — a wick that is not held into
        the bell would otherwise raise the exit to a price the position never had the chance to sell into. The 1.5
        multiple is declared, not fitted to this name.
      </p>
    </div>
  );
}
