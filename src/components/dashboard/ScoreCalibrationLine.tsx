"use client";

import { lookupScoreCalibration, BacktestMetricStats } from "@/lib/sentiment/backtestStats";
import backtestMetricStatsJson from "@/data/backtestMetricStats.json";

const backtestMetricStats = backtestMetricStatsJson as unknown as BacktestMetricStats;

/**
 * THE CALIBRATED-PROBABILITY LINE (decision-engine redesign §9): what reads
 * LIKE THIS ONE — same direction, same score strength, same trend regime —
 * actually did over the next 24h, quoted against the regime-conditional
 * drift null they had to beat. The one sentence on a decision surface that
 * is allowed to sound like a probability, because it is one: an empirical
 * rate with its interval and effective sample attached.
 *
 * Renders the explicit "uncalibrated" state when the cell is too thin —
 * §9's rule is that a thin bucket says so rather than borrowing the global
 * rate — and nothing at all on a neutral read, which asserts no direction
 * to calibrate.
 *
 * ONLY the replayed universe may quote these cells: they were measured on
 * BTC and ETH history, and their nulls are those assets' drift rates.
 * Quoting them beside an equity or an unreplayed altcoin would attach one
 * market's record to another's read, so the component refuses any other
 * asset outright.
 */
export const CALIBRATED_ASSETS = new Set(["BTC", "ETH"]);

export function ScoreCalibrationLine({
  asset,
  score,
  verdict,
  regimeTags,
}: {
  asset: string;
  score: number;
  verdict: string;
  /** The live trend/vol tags for this asset (regimeTagsToStrings output). Null when unknown — the line stays silent rather than guessing a regime. */
  regimeTags: string[] | null;
}) {
  if (!CALIBRATED_ASSETS.has(asset.toUpperCase())) return null;
  if (verdict === "neutral" || regimeTags === null) return null;

  const cell = lookupScoreCalibration(backtestMetricStats, score, verdict, regimeTags);
  const strength = Math.abs(score - 50) >= 15 ? "clearly" : "leaning";
  const trend = regimeTags.includes("bull")
    ? "bull-trend"
    : regimeTags.includes("bear")
      ? "bear-trend"
      : "trendless";

  if (!cell) {
    return (
      <p className="max-w-4xl text-[12px] leading-relaxed text-ink-faint">
        Historically {strength} {verdict} reads during {trend} regimes are too rare in the
        backtested window to quote a rate — this setup is uncalibrated, which is itself worth
        knowing before sizing anything.
      </p>
    );
  }

  const edgeTone = cell.edgePP >= 1 ? "text-success" : cell.edgePP <= -1 ? "text-danger" : "text-ink-faint";
  return (
    <p className="max-w-4xl text-[12px] leading-relaxed text-ink-muted">
      Reads like this one ({strength} {verdict}, {trend} regime) moved with the read{" "}
      <span className="font-mono text-ink">{cell.hitRatePct.toFixed(0)}%</span> of the time over the
      next 24h (95% CI {(cell.interval.lower * 100).toFixed(0)}–{(cell.interval.upper * 100).toFixed(0)}
      %, {cell.n} occurrences ≈ {cell.effectiveN} independent) vs{" "}
      <span className="font-mono">{cell.nullRatePct.toFixed(0)}%</span> for blind {verdict} exposure
      in that regime —{" "}
      <span className={`font-mono ${edgeTone}`}>
        {cell.edgePP >= 0 ? "+" : ""}
        {cell.edgePP.toFixed(1)}pp
      </span>{" "}
      of measured edge.
    </p>
  );
}
