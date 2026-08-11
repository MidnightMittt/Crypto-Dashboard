/**
 * Does each adaptive component actually earn its place?
 *
 * Phase 4's brief is explicit that no component may be kept merely because
 * it is sophisticated (§25) or because it lifts in-sample returns (§20), and
 * that fixed behaviour should be preserved where it is more robust (§17).
 * This harness is how those rules get enforced rather than asserted: replay
 * the FULL production engine once per variant, then compare the variants on
 * the same purged walk-forward folds Phase 3 established.
 *
 * The control matters as much as the treatment. `regimeWeights.ts` has been
 * live since Phase 1 carrying its own admission that it is an "UNVALIDATED
 * HYPOTHESIS, not a backtested edge" whose numbers "must be checked against
 * a real backtest comparison (regime-adjusted vs. fixed weights)". Variant
 * A is that check, four phases late.
 *
 * Nothing here edits production logic. Variants are configuration passed to
 * the existing replay; the MTF selectivity variant is applied downstream of
 * `buildTradeRecommendation`, never inside it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord, ReplayConfig } from "./run";
import { computeTradeStats, TradeStats } from "./tradeStats";
import { buildWalkForward, WalkForwardTrade } from "./walkForward";
import { DEFAULT_SWING_CONFIG } from "../../src/lib/signals/swingThesis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

interface Variant {
  key: string;
  label: string;
  rationale: string;
  config: ReplayConfig;
}

/**
 * Deliberately a 2x2, not a menu of twenty. Two components, each on/off, so
 * every cell is interpretable and the interaction between them is visible.
 * Adding a third binary component would quadruple the comparison surface and
 * start manufacturing the multiple-comparisons problem this codebase spends
 * real effort controlling elsewhere.
 */
const VARIANTS: Variant[] = [
  {
    key: "fixed",
    label: "A. Fixed weights (control)",
    rationale: "CATEGORY_WEIGHTS applied unmodified. The true baseline — what the engine does with no regime adaptation at all.",
    config: { useRegimeWeights: false, requireMtfNotWeakening: false, swing: DEFAULT_SWING_CONFIG },
  },
  {
    key: "regime",
    label: "B. Regime weights (currently shipped)",
    rationale: "regimeAdjustedCategoryWeights active. This is production today, and has never been measured against A.",
    config: { useRegimeWeights: true, requireMtfNotWeakening: false, swing: DEFAULT_SWING_CONFIG },
  },
  {
    key: "fixed+mtf",
    label: "C. Fixed weights + MTF gate",
    rationale: "Selectivity alone: block ENTER when the 4H read weakens the thesis, no regime weighting.",
    config: { useRegimeWeights: false, requireMtfNotWeakening: true, swing: DEFAULT_SWING_CONFIG },
  },
  {
    key: "regime+mtf",
    label: "D. Regime weights + MTF gate",
    rationale: "Both components together — tests whether they compose or overlap.",
    config: { useRegimeWeights: true, requireMtfNotWeakening: true, swing: DEFAULT_SWING_CONFIG },
  },
];

interface VariantResult {
  key: string;
  label: string;
  rationale: string;
  tradeCount: number;
  pooled: TradeStats | null;
  foldExpectancies: number[];
  foldsPositive: number;
  worstFoldPct: number | null;
  meanFoldPct: number | null;
}

function toWalkForwardTrades(records: DayRecord[]): WalkForwardTrade[] {
  return records
    .filter((r) => r.trade !== null)
    .map((r) => ({
      t: r.t,
      side: r.trade!.side,
      exitT: r.t + r.trade!.hoursHeld * 3_600_000,
      outcome: r.trade!.outcome,
      grossReturnPct: r.trade!.grossReturnPct,
      netReturnPct: r.trade!.netReturnPct,
      mfePct: r.trade!.mfePct,
      maePct: r.trade!.maePct,
      hoursToTarget: r.trade!.hoursToTarget,
      hoursToStop: r.trade!.hoursToStop,
      hoursHeld: r.trade!.hoursHeld,
      tp2ReachedBeforeStop: r.trade!.tp2ReachedBeforeStop,
      ambiguousBar: r.trade!.ambiguousBar,
    }));
}

function pct(v: number | null | undefined, d = 3): string {
  return v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}
function num(v: number | null | undefined, d = 2): string {
  return v === null || v === undefined ? "—" : v.toFixed(d);
}

function main() {
  const marketWide: MarketWideData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "MARKET.json"), "utf8"));
  const assets: RawAssetData[] = ["BTC", "ETH"].map((a) =>
    JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${a}.json`), "utf8"))
  );

  const results: VariantResult[] = [];
  for (const variant of VARIANTS) {
    const records = assets.flatMap((data) => replayAsset(data, marketWide, undefined, undefined, variant.config));
    const trades = toWalkForwardTrades(records);
    const wf = buildWalkForward(trades, 5, 7);
    const foldExpectancies = wf.folds.filter((f) => f.stats).map((f) => f.stats!.expectancyNetPct);

    results.push({
      key: variant.key,
      label: variant.label,
      rationale: variant.rationale,
      tradeCount: trades.length,
      pooled: computeTradeStats(trades),
      foldExpectancies,
      foldsPositive: foldExpectancies.filter((e) => e > 0).length,
      worstFoldPct: foldExpectancies.length ? Math.min(...foldExpectancies) : null,
      meanFoldPct: foldExpectancies.length
        ? foldExpectancies.reduce((a, b) => a + b, 0) / foldExpectancies.length
        : null,
    });
    console.log(`[ablation] ${variant.key}: ${trades.length} trades, pooled ${pct(computeTradeStats(trades)?.expectancyNetPct)}`);
  }

  fs.writeFileSync(path.join(DATA_DIR, "..", "ablation.md"), render(results));
  fs.writeFileSync(path.join(DATA_DIR, "ablation.json"), JSON.stringify(results, null, 2));
  console.log(`[ablation] wrote scripts/backtest/ablation.md`);
}

function render(results: VariantResult[]): string {
  const lines: string[] = [];
  const control = results.find((r) => r.key === "fixed")!;

  lines.push(`# Adaptive component ablation`);
  lines.push("");
  lines.push(
    `Each variant is a full replay of the real production engine with one or both adaptive components switched off. Compared on the same 5 purged walk-forward folds (7-day embargo) used in Phase 3. Variant B is what ships today.`
  );
  lines.push("");
  lines.push(`| Variant | Trades | Win | Pooled expectancy | Profit factor | Med MAE | Med MFE | Folds positive | Mean fold | Worst fold |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const p = r.pooled;
    lines.push(
      `| ${r.label} | ${r.tradeCount} | ${p ? p.winRatePct.toFixed(0) + "%" : "—"} | ${pct(p?.expectancyNetPct)} | ${num(p?.profitFactor)} | ${pct(p?.mae?.median ?? null, 1)} | ${pct(p?.mfe?.median ?? null, 1)} | ${r.foldsPositive}/${r.foldExpectancies.length} | ${pct(r.meanFoldPct)} | ${pct(r.worstFoldPct)} |`
    );
  }
  lines.push("");

  lines.push(`## Delta vs the fixed-weight control`);
  lines.push("");
  lines.push(`| Variant | Δ pooled expectancy | Δ trades | Δ folds positive | Δ worst fold | Verdict |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const r of results.filter((x) => x.key !== "fixed")) {
    const dExp = (r.pooled?.expectancyNetPct ?? 0) - (control.pooled?.expectancyNetPct ?? 0);
    const dWorst = (r.worstFoldPct ?? 0) - (control.worstFoldPct ?? 0);
    const dFolds = r.foldsPositive - control.foldsPositive;
    /*
     * "Earns its keep" requires improving the pooled result AND not making
     * the worst fold worse. A component that lifts the average while
     * deepening the bad periods has traded robustness for return, which §23
     * explicitly says is not a win.
     */
    const earns = dExp > 0 && dWorst >= 0;
    lines.push(
      `| ${r.label} | ${pct(dExp)} | ${r.tradeCount - control.tradeCount} | ${dFolds >= 0 ? "+" : ""}${dFolds} | ${pct(dWorst)} | ${earns ? "**keeps its place**" : "does NOT earn its place"} |`
    );
  }
  lines.push("");
  lines.push(
    `A component "earns its place" only by improving pooled expectancy WITHOUT deepening the worst out-of-sample fold. Lifting the average while making bad periods worse is a robustness trade, not an improvement.`
  );
  lines.push("");

  lines.push(`## Per-fold detail`);
  lines.push("");
  lines.push(`| Variant | ${results[0].foldExpectancies.map((_, i) => `Fold ${i + 1}`).join(" | ")} |`);
  lines.push(`|---|${results[0].foldExpectancies.map(() => "---").join("|")}|`);
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.foldExpectancies.map((e) => pct(e)).join(" | ")} |`);
  }
  lines.push("");
  for (const r of results) lines.push(`- **${r.label}** — ${r.rationale}`);
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("ablation.ts")) {
  main();
}
