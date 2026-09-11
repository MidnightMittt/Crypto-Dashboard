import { Hypothesis, PeriodLeg } from "./signalLab";
import { BP, PaperDeclaration, PaperSession } from "./paperEngine";

/**
 * THE MOMENTUM PAPER LEG — the one validated equity signal, run as a position.
 *
 * `momentum-12-1-long-only-broad-up` is the only hypothesis in the register
 * that earns Edge on the clean panel with the long leg included. The lab
 * already measures it; what the lab does NOT do is express it as something a
 * trader holds, and the gap between those two is where this module lives.
 *
 * ── What the lab reports, and why it is not a paper line ──────────────
 *
 * `runHypothesis` reports a WIN RATE against a 50% null and charges `costPp`
 * — a fixed haircut in win-rate percentage points. That is a reasonable way
 * to gate a signal and a useless way to price one:
 *
 *   - it is in probability space, so it cannot be compounded, drawn down, or
 *     compared against the overnight leg's basis points;
 *   - it models NO TURNOVER. A strategy replacing its entire book every
 *     period and one replacing a third of it are charged identically, which
 *     is wrong by a factor of three in the direction that flatters the
 *     high-turnover case.
 *
 * So this module re-expresses the same periods — the same entries, the same
 * exits, the same gate, from the same `runHypothesis` call — in return space,
 * and charges cost against the decile overlap actually observed.
 *
 * ── One definition, not two ───────────────────────────────────────────
 *
 * Nothing here re-implements 12-1 momentum. The hypothesis is DATA in
 * `scripts/research/hypotheses.ts` and the ranking runs in `runHypothesis`; a
 * second implementation of a validated signal is a second definition of it,
 * and they drift silently because both look right. This module consumes
 * `PeriodLeg[]` and nothing else.
 *
 * ── What a positive record here would and would not mean ──────────────
 *
 * The `long-vs-panel` leg measures the held decile against the equal-weighted
 * panel over the same window. That is the comparison a single long position
 * faces, and it is NOT an absolute return: a trader holding the decile in a
 * falling market loses money while this line goes up. The declaration says
 * so, because the difference is exactly the overstatement a record like this
 * invites.
 */

/**
 * Share of the held book replaced at a rebalance.
 *
 * 1 − |previous ∩ current| / |current|. Measured against the names actually
 * held rather than assumed, which is the whole reason `topSymbols` is
 * emitted. Momentum deciles are stickier than they look — a name that led
 * over 12 months rarely drops out in one — so assuming full turnover would
 * overcharge this strategy by roughly the amount it earns.
 */
export function decileTurnover(
  previous: readonly string[] | null,
  current: readonly string[]
): number {
  if (!current.length) return 0;
  /*
   * A null predecessor is a FULL entry, not a free one. This is the first
   * period, or the first after the regime gate reopened — in both cases the
   * book was empty and every name had to be bought.
   */
  if (!previous) return 1;
  const prev = new Set(previous);
  const kept = current.filter((s) => prev.has(s)).length;
  return 1 - kept / current.length;
}

/**
 * Turn a hypothesis's periods into dated paper sessions.
 *
 * `leg` decides what the position's return IS. For `long-vs-panel` it is the
 * held decile minus the equal-weighted panel; for `long-short` it is the
 * spread, and `runHypothesis` has already folded the short leg into its own
 * reported spread — but this module is only wired for the long-only case,
 * and refuses rather than guessing at the cost of a short book.
 */
export function momentumSessions(
  periods: readonly PeriodLeg[],
  leg: Hypothesis["leg"]
): PaperSession[] {
  if (leg !== "long-vs-panel") {
    throw new Error(
      `momentumSessions is declared for the long-vs-panel leg and got "${leg}". A ` +
        `long-short paper line owes a borrow cost and a short-side spread, neither of ` +
        `which is measured here — so it must not be produced by defaulting.`
    );
  }

  const ordered = [...periods].sort((a, b) => a.entryTime - b.entryTime);
  const sessions: PaperSession[] = [];
  let previous: string[] | null = null;
  let previousExit: number | null = null;

  for (const p of ordered) {
    /*
     * A GAP MEANS THE BOOK WAS FLAT. The regime gate closes in bear-to-bull
     * reversals and `runHypothesis` simply omits those periods, so two
     * adjacent entries in this array can be months apart. Carrying the old
     * decile across that gap would credit the strategy with holding names it
     * had sold, and charge no turnover for buying them back.
     */
    const contiguous = previousExit !== null && previousExit === p.entryTime;
    const turnover = decileTurnover(contiguous ? previous : null, p.topSymbols);

    const grossBp = (p.top - p.universe) * BP;
    /*
     * Cost is charged in RETURN space and scaled by what was actually traded.
     * The benchmark leg is a COMPARISON, not a position — nobody buys the
     * equal-weighted panel to run this — so only the held decile is charged.
     */
    const costBp = turnover * p.topEntryCostBp;

    sessions.push({
      date: new Date(p.exitTime).toISOString().slice(0, 10),
      grossBp,
      costBp,
      netBp: grossBp - costBp,
      names: p.topSymbols.length,
      turnover,
    });

    previous = p.topSymbols;
    previousExit = p.exitTime;
  }
  return sessions;
}

/**
 * When the seven hypotheses were fixed as data.
 *
 *   2026-08-15 `cc29195` declared the register — "seven declared hypotheses,
 *              zero survive" — and `ef85fa0` the same day split out the
 *              long-only leg this line runs.
 *
 * Every period before it is in-sample: the panel, the warmup and the regime
 * gate were all chosen while looking at it. Passed explicitly rather than read
 * from the hypothesis, so a hypothesis declared later cannot inherit this date
 * by sitting in the same array.
 */
export const HYPOTHESES_DECLARED_ON = "2026-08-15";

export function momentumDeclaration(h: Hypothesis, declaredOn: string): PaperDeclaration {
  return {
    id: `${h.id}-paper`,
    statement:
      `${h.statement} Expressed as a held position: the top decile of the ranked ` +
      `panel against the equal-weighted panel over the same window. A RELATIVE ` +
      `return — the line can rise while the position loses money in a falling market.`,
    entry: `close of the decision session, ${h.hold}-session rebalance`,
    exit: `close ${h.hold} sessions later`,
    holdSessions: h.hold,
    declaredOn,
    costBasis: "modelled",
    costNote:
      "One tick against each held name's own entry price, multiplied by the decile " +
      "turnover actually observed at each rebalance. Replaces the hypothesis's flat " +
      "costPp, which is in win-rate space and models no turnover at all. The benchmark " +
      "leg is not charged: it is a comparison, not a position.",
    independenceBasis:
      `Periods step by the ${h.hold}-session hold, so no bar contributes to two ` +
      `observations and no overlap correction is owed. Periods the regime gate closed ` +
      `are absent rather than zero, which is why turnover resets to 1 across a gap.`,
    killCriteria: h.killCriteria,
  };
}
