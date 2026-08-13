import { PlanConstraints, TradeDirection } from "./tradePlan";

/**
 * Turns the execution replay's published planner statistics into the
 * per-plan constraints tradePlan.ts consumes — the policy half of the
 * measurement/policy split described in scripts/backtest/plannerStats.ts.
 *
 * Reads the SNAPSHOT shape as it appears in src/data/executionStats.json
 * (mirrored loosely here rather than importing backtest script types into
 * the client graph — same convention ExecutionStatsSnapshot already uses).
 * Only the LIVE crypto path calls this: the equity snapshot builder and the
 * backtest replay deliberately never do, the first because these excursions
 * were measured on BTC/ETH perp trades, the second because a gated replay
 * would starve the gate's own evidence.
 */

export interface PlannerCellSnapshot {
  n: number;
  evLowerPct: number;
  winners: {
    n: number;
    maeP50Pct: number;
    maeP80Pct: number;
    mfeP75Pct: number;
  } | null;
}

export interface PlannerStatsSnapshot {
  cells?: Record<string, PlannerCellSnapshot | undefined>;
}

/**
 * The volatility tag out of the live regime tags. Trend tags are ignored on
 * purpose: the planner cells were bucketed side × VOL only (see
 * plannerStats.ts for why that bucket was fixed a priori).
 */
function volTagOf(regimeTags: string[] | null): string | null {
  if (!regimeTags) return null;
  for (const v of ["high-vol", "normal-vol", "low-vol"]) {
    if (regimeTags.includes(v)) return v;
  }
  return null;
}

/**
 * Null whenever there is nothing defensible to constrain with — unknown
 * regime, missing planner section (older stats file), or a cell the stats
 * generator already refused to publish for thin sample. A null here means
 * the plan builds exactly as it did before this layer existed; absence of
 * evidence never becomes a gate.
 */
export function planConstraintsFor(
  direction: TradeDirection,
  regimeTags: string[] | null,
  planner: PlannerStatsSnapshot | undefined | null
): PlanConstraints | null {
  const vol = volTagOf(regimeTags);
  if (!vol || !planner?.cells) return null;
  const key = `${direction}:${vol}`;
  const cell = planner.cells[key];
  if (!cell) return null;

  return {
    cellKey: key,
    n: cell.n,
    evLowerPct: cell.evLowerPct,
    winnersMaeP50Pct: cell.winners?.maeP50Pct ?? null,
    winnersMaeP80Pct: cell.winners?.maeP80Pct ?? null,
    winnersMfeP75Pct: cell.winners?.mfeP75Pct ?? null,
  };
}
