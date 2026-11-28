import { Candle, atr, atrPctSeries } from "../technicals/indicators";
import { SupportResistanceZone, buildMultiTimeframeStructure, zoneTier } from "../technicals/marketStructure";
import { maTrendContext, assessConfluence, computeMovingAverages } from "../technicals/confluence";
import { fibFromLastLeg } from "../technicals/fibonacci";
import { buildTradePlan, TradeDirection } from "../signals/tradePlan";
import { resampleToWeekly, resampleToMonthly } from "../technicals/resample";
import { buildSwingTargets } from "./targets";
import { sizePosition, checkRiskConstraints, RiskState } from "./risk";
import { opportunityId, detectTrigger, derivePreEntryState, distanceInAtr } from "./lifecycle";
import { SwingOpportunity, RiskConfig, DEFAULT_RISK_CONFIG, SwingSetupQuality } from "./types";

/**
 * THE SWING SCANNER — the spine from market data to a risk-checked plan.
 *
 * ── IT DOES NOT INVENT A DIRECTIONAL OPINION ────────────────────────────
 *
 * Direction comes from the ZONE, not from a new score. A support zone yields a
 * long candidate and a resistance zone a short one — "if you were to trade
 * this level, which way would you be trading it." Trend context then CONFIRMS
 * or CHALLENGES that candidate; it never originates one.
 *
 * This matters because the project charter allows exactly one market thesis
 * (`marketBias.ts`), and the fastest way to violate it is to add a scanner
 * that quietly computes its own bullishness. Nothing here does.
 *
 * ── NO TRADE IS A RESULT ────────────────────────────────────────────────
 *
 * An asset with no qualifying zone returns nothing. A candidate that fails a
 * risk rule is RETURNED, with `riskRefusal` set, rather than hidden — the
 * refusal is information, and silently dropping it would make the scanner
 * look like it found nothing when it actually found something it declined.
 */

export interface ScanInput {
  asset: string;
  /** Live daily candles (the 300-bar series). */
  daily: Candle[];
  fourH?: Candle[];
  /** Deep daily history for weekly/monthly structure. Optional — degrades. */
  deepDaily?: Candle[];
  config?: RiskConfig;
  riskState?: RiskState;
}

const EMPTY_RISK_STATE: RiskState = { openPositions: [], realisedToday: 0, realisedThisWeek: 0 };

/**
 * Ranking score, 0-100.
 *
 * *** THIS IS NOT A WIN PROBABILITY. *** It has never been calibrated against
 * outcomes and must never be presented as odds. It is an ordering heuristic
 * whose only job is to put the most worked-out setups in front of a human
 * first. The components are weighted by how much INDEPENDENT information each
 * carries, not by any measured contribution to profit — this project has no
 * validated edge to weight against, and pretending otherwise is the exact
 * error its own research keeps catching.
 */
function rankScore(parts: {
  familyCount: number;
  htfAligned: boolean;
  trendAgrees: boolean;
  distanceAtr: number;
  riskReward: number;
  triggerSatisfied: boolean;
}): number {
  let s = 0;
  s += Math.min(parts.familyCount, 5) * 10;              // up to 50 — independent evidence
  /*
   * THE higherTimeframe TERM WAS REMOVED 2026-11-28, by pre-registered rule.
   *
   * It awarded +12. A BTC-only, post-hoc diagnostic suggested the factor was
   * strongly HARMFUL (11.1% win aligned vs 31.6% unaligned). A confirmatory
   * out-of-sample test on the 8 assets that generated no part of that claim —
   * BTC deliberately held out — did NOT replicate it:
   *
   *     aligned    n=117  win 20.5%
   *     unaligned  n=160  win 22.5%     gap 2.0pp, gate required 10pp
   *     3 of 8 assets agreed, gate required 6
   *
   * 277 deduplicated events, so this is a measured NO EFFECT rather than an
   * underpowered one. PREREG_htf_alignment.md's rule for that case: remove
   * the term, because a factor with no measured effect must not move a
   * ranking. It is removed rather than inverted — inverting it would be
   * acting on the BTC result the holdout just failed to confirm.
   */
  if (parts.trendAgrees) s += 10;                         // MA context not fighting the trade
  if (parts.triggerSatisfied) s += 15;                    // price has actually DONE something
  if (Number.isFinite(parts.distanceAtr)) s += Math.max(0, 8 - parts.distanceAtr * 2); // actionability
  s += Math.min(parts.riskReward, 5);                     // up to 5
  return Math.max(0, Math.min(100, Math.round(s)));
}

export function scanAsset(input: ScanInput): SwingOpportunity[] {
  const { asset, daily, fourH, deepDaily } = input;
  const config = input.config ?? DEFAULT_RISK_CONFIG;
  const riskState = input.riskState ?? EMPTY_RISK_STATE;
  if (daily.length < 60) return [];

  const price = daily[daily.length - 1].close;
  const a = atr(daily);
  if (!a || a <= 0) return [];
  const atrSeries = atrPctSeries(daily);
  const atrPct = atrSeries.length ? atrSeries[atrSeries.length - 1] : null;

  // Structure across every timeframe we can build.
  const deep = deepDaily && deepDaily.length > daily.length ? deepDaily : null;
  const weekly = deep ? resampleToWeekly(deep).candles : undefined;
  const monthly = deep ? resampleToMonthly(deep).candles : undefined;
  const { zones } = buildMultiTimeframeStructure({ daily, fourH, weekly, monthly });
  if (!zones.length) return [];

  const trendSeries = deep ?? daily;
  const trend = maTrendContext(trendSeries);
  const mas = computeMovingAverages(trendSeries);
  const fib = fibFromLastLeg(trendSeries);
  const higherZones = zones.filter((z) => z.timeframe === "1W" || z.timeframe === "1M");

  const out: SwingOpportunity[] = [];

  for (const direction of ["long", "short"] as TradeDirection[]) {
    const wantKind = direction === "long" ? "support" : "resistance";
    /*
     * The candidate is the NEAREST qualifying zone on the correct side — the
     * one price would actually reach first. A more "impressive" zone further
     * away is not the setup in front of us.
     */
    const candidate = zones
      .filter((z) => z.kind === wantKind && z.reactionCount >= 2)
      .filter((z) => (direction === "long" ? z.priceLow <= price : z.priceHigh >= price))
      .sort((x, y) => {
        const dx = direction === "long" ? price - x.priceHigh : x.priceLow - price;
        const dy = direction === "long" ? price - y.priceHigh : y.priceLow - price;
        return Math.abs(dx) - Math.abs(dy);
      })[0];
    if (!candidate) continue;

    const confluence = assessConfluence({ zone: candidate, candles: daily, higherZones, mas, fib });

    const plan = buildTradePlan({
      direction,
      anchorPrice: price,
      atrPct,
      zones,
      quality: {
        confidence: Math.min(100, confluence.familyCount * 20),
        agreement: Math.min(100, confluence.familyCount * 20),
        // No calibrated win rate exists for these setups. Passing null is the
        // honest input; inventing one would propagate into a star rating that
        // looks measured and is not.
        historicalWinRatePct: null,
        historicalWinRateN: null,
      },
    });
    if (!plan) continue;

    const { targets, note } = buildSwingTargets({ plan, direction, zones, fib, config });
    if (!targets.length) continue;

    const trigger = detectTrigger({ direction, zone: candidate, candles: daily });
    const state = derivePreEntryState({
      price, entryLow: plan.entryLow, entryHigh: plan.entryHigh, stopPrice: plan.stopPrice,
      direction, trigger, candles: daily,
    });
    const distanceAtr = distanceInAtr(price, plan.entryLow, plan.entryHigh, daily);

    const sizing = sizePosition(plan.entryRef, plan.stopPrice, direction, config);
    const riskRefusal = checkRiskConstraints({
      asset, direction, riskReward: plan.riskRewardRatio, sizing, state: riskState, config,
    });

    const htfAligned = confluence.factors.some((f) => f.family === "higher-timeframe");
    const trendAgrees =
      (direction === "long" && trend.direction === "up") || (direction === "short" && trend.direction === "down");

    const reasons: string[] = confluence.factors.map((f) => f.detail);
    if (htfAligned) reasons.push(`confirmed on a higher timeframe (${zoneTier(candidate.timeframe)} ${candidate.timeframe})`);
    if (trendAgrees) reasons.push(`moving-average trend (${trend.direction}) agrees with a ${direction}`);
    if (trend.pullbackInTrend) reasons.push("price is pulling back toward its fast EMA inside an established trend");

    const missing: string[] = [];
    if (!trigger.satisfied) missing.push(trigger.description);
    if (!trendAgrees && trend.direction !== "unknown") {
      missing.push(`moving-average trend reads ${trend.direction}, which does not support a ${direction}`);
    }
    if (distanceAtr > 1) missing.push(`price is ${distanceAtr.toFixed(1)} ATR from the entry zone`);
    if (note) missing.push(note);
    if (riskRefusal) missing.push(riskRefusal);

    const quality: SwingSetupQuality = {
      familyCount: confluence.familyCount,
      quality: confluence.quality,
      htfAligned,
      score: rankScore({
        familyCount: confluence.familyCount, htfAligned, trendAgrees,
        distanceAtr, riskReward: plan.riskRewardRatio, triggerSatisfied: trigger.satisfied,
      }),
      reasons,
      missing,
    };

    out.push({
      id: opportunityId(asset, direction, candidate),
      asset, direction, state, price, plan, targets, trigger, quality,
      zone: candidate, confluence, trend, fib, distanceAtr,
      sizing, riskRefusal,
      conflictsWith: null,
      builtAt: daily[daily.length - 1].t,
    });
  }

  /*
   * BOTH SIDES CONFIRMED IS A NO-TRADE, NOT TWO TRADES.
   *
   * Seen live on XRP the day this shipped: a confirmed short at 0.98-1.03 and
   * a confirmed long at 0.89-0.94 with price at 0.95, both rendered as
   * actionable. The engine would have refused the second entry, but only
   * after a click — the UI had already presented contradictory advice.
   */
  const confirmed = out.filter((o) => o.state === "ENTRY_CONFIRMED");
  if (confirmed.length > 1) {
    for (const o of confirmed) {
      const other = confirmed.find((x) => x.direction !== o.direction);
      if (!other) continue;
      o.conflictsWith = other.direction;
      o.quality.missing = [
        `the opposite (${other.direction}) setup is ALSO confirmed on ${asset} — price sits between two levels and the direction is genuinely unclear`,
        ...o.quality.missing,
      ];
    }
  }

  return out;
}

/**
 * Rank across assets. Invalidated setups sort last regardless of score — a
 * dead thesis is not an opportunity however good its geometry was.
 */
export function rankOpportunities(all: SwingOpportunity[]): SwingOpportunity[] {
  const stateRank = (s: SwingOpportunity["state"]) =>
    s === "ENTRY_CONFIRMED" ? 0 : s === "WAITING_CONFIRMATION" ? 1 : s === "APPROACHING" ? 2 : s === "WATCHING" ? 3 : 9;
  return [...all].sort((x, y) => {
    const d = stateRank(x.state) - stateRank(y.state);
    if (d !== 0) return d;
    return y.quality.score - x.quality.score;
  });
}
