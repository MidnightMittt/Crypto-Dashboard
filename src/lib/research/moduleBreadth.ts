/**
 * HOW MANY IDEAS DO THE CRYPTO MODULES TEST?
 *
 * The same question `familyBreadth.ts` asks of the equity hypotheses, asked of
 * the module family that `gradeModules` corrects across. The answer is almost
 * the opposite, and the way it differs is the reason this file exists rather
 * than a second call to the same helper.
 *
 * ── What the measurement found ────────────────────────────────────────
 *
 * The equity family was twelve names worth two ideas. The crypto family is
 * twelve modules whose average pair correlates at 0.037 — genuinely broad,
 * and 8.5 effective bets by the equity module's own formula. Publishing that
 * would be wrong, because two of the pairs are exact:
 *
 *   technicals / spotPerpVolume    +1.000 over 1648 shared observations
 *   squeezeRisk / longShort        -1.000 over 1181 shared observations
 *
 * The second one is the interesting failure. `squeezeRisk` and `longShort`
 * read overlapping positioning data and interpret it in deliberately opposite
 * directions — one fades a crowded side, the other trends it — so on every
 * observation where both take a position, they take opposite ones. 1181 of
 * 1181, no exceptions.
 *
 * ── Why the standard breadth figure gets this wrong ───────────────────
 *
 * `effective_bets` is n/(1+(n-1)rho) with SIGNED rho, which is exact for the
 * variance of an equal-weighted basket. An inversely-related pair really does
 * damp that variance, so the formula credits it as diversification, and it is
 * right to: if you held both you would be hedged.
 *
 * But nobody is holding these. They are TESTS, and the question is how many
 * distinct things were tried before something survived. A signal and its own
 * negation are one idea, not two, and certainly not two-and-a-bit. Scored on
 * mean |rho| instead, the family is worth about 3.0 distinct ideas, not 8.5.
 *
 * Both numbers are reported. Neither is a correction of the other — they
 * answer different questions and the gap between them IS the finding.
 *
 * ── Direction calls, not realised P&L ─────────────────────────────────
 *
 * The series correlated here is each module's direction call, not what the
 * call earned. Two reasons, and the second is the one that decided it:
 *
 *  1. Every module shares the same forward return on a given observation, so
 *     a P&L series carries a term none of them chose. Measured directly: eight
 *     independent coin-flip direction series, multiplied by the REAL returns,
 *     correlate at 0.009 and read 7.51 of 8 effective bets. So the shared
 *     return does not by itself manufacture correlation — the trap was
 *     checked for rather than assumed away, and it is not there.
 *
 *  2. Modules are graded at whichever horizon suits them best — 1h, 4h or
 *     24h. `technicals` and `spotPerpVolume` emit IDENTICAL direction calls
 *     and are graded at 4h and 1h respectively, so their P&L series correlate
 *     at only 0.4 while the ideas behind them are the same idea. Correlating
 *     P&L would let a horizon choice disguise a duplicate.
 */

import { FamilySeries } from "./familyBreadth";

/** One replayed observation, reduced to what breadth needs. */
export interface ModuleDay {
  asset: string;
  /** Observation timestamp, shared across every module on this row. */
  t: number;
  metrics: readonly { id: string; verdict: string }[];
}

/**
 * Builds one series per module, aligned across every (asset, observation) cell.
 *
 * `neutral` becomes an ABSENT period rather than a zero, matching the
 * treatment of a gated-out equity variant: a module declining to call a
 * direction has taken no position, and scoring that as a flat reading would
 * let two modules correlate purely by being quiet at the same time.
 */
export function moduleFamilySeries(
  days: readonly ModuleDay[],
  moduleIds: readonly string[]
): FamilySeries[] {
  /*
   * Two assets share one timestamp, so the raw `t` would collide and the
   * alignment map would keep whichever row it saw last — silently halving the
   * sample. The asset's ordinal is added as a sub-millisecond offset: unique
   * per cell, stable across runs, and still ordered by time. It is an
   * alignment key here, not an instant anything happened at.
   */
  const assetOrdinal = new Map<string, number>();
  for (const d of days) if (!assetOrdinal.has(d.asset)) assetOrdinal.set(d.asset, assetOrdinal.size);

  return moduleIds.map((id) => ({
    id,
    periods: days.flatMap((d) => {
      const hit = d.metrics.find((m) => m.id === id);
      if (!hit || hit.verdict === "neutral") return [];
      const dir = hit.verdict === "bullish" ? 1 : hit.verdict === "bearish" ? -1 : null;
      if (dir === null) return [];
      return [{ entryTime: d.t + assetOrdinal.get(d.asset)!, spread: dir }];
    }),
  }));
}
