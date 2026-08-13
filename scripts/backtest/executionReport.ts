/**
 * The execution-layer report: what actually happened to the trades the
 * dashboard would have told you to take.
 *
 * Deliberately a separate script from report.ts rather than another section
 * inside it. report.ts answers "do these SIGNALS carry information"; this
 * answers "does the EXECUTION built on them make or lose money." They have
 * different units (occurrences vs trades), different sample sizes, and
 * different failure modes, and the existing file is already 40KB. Same
 * precedent as rolling.ts / combinations.ts / weightReview.ts, which are
 * also standalone entry points over the same results.json.
 *
 * Writes both a human-readable markdown section and the machine-readable
 * src/data/executionStats.json the UI reads. Nothing here is computed at
 * request time.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeTradeStats, TradeRecord, TradeStats } from "./tradeStats";
import { buildCalibration, CalibrationInput, CalibrationReport } from "./calibration";
import {
  buildPlannerStats,
  gateEffect,
  PlannerStats,
  PlannerTradeRow,
  GateEffect,
  VolRegime,
} from "./plannerStats";
import { buyAndHold, smaCrossover, randomEntry, BenchmarkResult, DailyBar } from "./benchmarks";
import { buildProvenance, BacktestProvenance } from "./version";
import {
  buildWalkForward,
  buildQuantileCalibration,
  marginalRegimeCells,
  summarizeDistribution,
  classifySample,
  WalkForwardReport,
  QuantileCalibration,
  RegimeCell,
  DistributionSummary,
  WalkForwardTrade,
} from "./walkForward";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const OUT_DIR = path.join(__dirname, "..", "..", "src", "data");
const MAX_HOLD_HOURS = 7 * 24;

interface DayRecord {
  asset: string;
  date: string;
  t: number;
  biasVerdict: string | null;
  biasConfidence: number | null;
  biasAgreement: number | null;
  regimeTags: string[];
  action: string | null;
  agreement4h: string | null;
  entryStars: number | null;
  riskRewardRatio: number | null;
  forwardReturn1d: number | null;
  forwardReturn7d: number | null;
  trade: {
    side: "long" | "short";
    outcome: string;
    grossReturnPct: number;
    netReturnPct: number;
    feeAndSlippagePct: number;
    fundingCostPct: number;
    mfePct: number;
    maePct: number;
    hoursToTarget: number | null;
    hoursToStop: number | null;
    hoursHeld: number;
    tp2ReachedBeforeStop: boolean;
    ambiguousBar: boolean;
  } | null;
}

/** A named slice of the trade population, so every segment is measured identically. */
export interface Segment {
  label: string;
  stats: TradeStats;
}

export interface ExecutionStats {
  provenance: BacktestProvenance;
  overall: TradeStats | null;
  byAsset: Segment[];
  bySide: Segment[];
  byRegime: Segment[];
  byConfidenceBucket: Segment[];
  byMtfAgreement: Segment[];
  calibration24h: CalibrationReport;
  calibration7d: CalibrationReport;
  benchmarks: BenchmarkResult[];
  walkForward: WalkForwardReport;
  quantileCalibration: QuantileCalibration;
  confidenceDistribution: DistributionSummary | null;
  confidenceByAction: Array<{ label: string; distribution: DistributionSummary }>;
  marginalRegimes: RegimeCell[];
  /**
   * Side × vol-regime excursion/EV statistics for the trade planner
   * (plannerStats.ts) — ALWAYS computed from the ungated replay, never from
   * gated trades; see that module's measurement-vs-policy note.
   */
  planner: PlannerStats;
  /** The live EV gate's analytic effect on this same ungated record. */
  plannerGateEffect: GateEffect;
  /** Segments whose net expectancy is materially worse than the overall base rate. */
  failureModes: Array<{ label: string; n: number; expectancyNetPct: number; stopHitRatePct: number; deltaVsBasePct: number }>;
}

function toTradeRecord(d: DayRecord): TradeRecord {
  return { t: d.t, ...d.trade! };
}

/** Only emits a segment when it clears MIN_SAMPLE_N — an empty slot is more honest than a number from six trades. */
function segment(label: string, days: DayRecord[]): Segment | null {
  const stats = computeTradeStats(days.map(toTradeRecord));
  return stats ? { label, stats } : null;
}

function groupBy(days: DayRecord[], key: (d: DayRecord) => string | null): Segment[] {
  const groups = new Map<string, DayRecord[]>();
  for (const d of days) {
    const k = key(d);
    if (k === null) continue;
    const existing = groups.get(k);
    if (existing) existing.push(d);
    else groups.set(k, [d]);
  }
  return Array.from(groups.entries())
    .map(([label, rows]) => segment(label, rows))
    .filter((s): s is Segment => s !== null)
    .sort((a, b) => b.stats.n - a.stats.n);
}

function confidenceBucket(confidence: number | null): string | null {
  if (confidence === null) return null;
  const lower = Math.min(80, Math.floor(confidence / 20) * 20);
  return `${lower}-${lower + 20}`;
}

/** Daily closes per asset, for the benchmarks. Uses the same rolled-up series the replay evaluated. */
function dailyBars(records: DayRecord[], asset: string, priceByDate: Map<string, number>): DailyBar[] {
  return records
    .filter((r) => r.asset === asset)
    .map((r) => ({ t: r.t, close: priceByDate.get(`${asset}:${r.date}`) ?? NaN }))
    .filter((b) => Number.isFinite(b.close));
}

function pct(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function num(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "—" : v.toFixed(digits);
}

function statsRow(label: string, s: TradeStats): string {
  return `| ${label} | ${s.n} | ${s.winRatePct.toFixed(0)}% | ${pct(s.expectancyNetPct, 3)} | ${num(s.profitFactor)} | ${s.targetHitRatePct.toFixed(0)}% | ${s.stopHitRatePct.toFixed(0)}% | ${s.timeoutRatePct.toFixed(0)}% | ${pct(s.mae?.median ?? null, 1)} | ${pct(s.mfe?.median ?? null, 1)} | ${pct(s.maxDrawdownPct, 1)} |`;
}

const STATS_HEADER = `| Segment | N | Win | Expectancy (net) | Profit factor | TP1 | Stop | Timeout | Median MAE | Median MFE | Max DD |
|---|---|---|---|---|---|---|---|---|---|---|`;

function main() {
  const resultsPath = path.join(DATA_DIR, "results.json");
  if (!fs.existsSync(resultsPath)) {
    console.error(`Missing ${resultsPath} — run "npm run backtest" first.`);
    process.exit(1);
  }
  const records: DayRecord[] = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  const traded = records.filter((r) => r.trade !== null);

  // Entry price per day doubles as the daily close for the benchmarks —
  // the same series the replay itself priced entries from, so the engine
  // and its baselines are measured against identical prices.
  const priceByDate = new Map<string, number>();
  for (const r of records) {
    const anyRecord = r as unknown as { entryPrice: number | null };
    if (anyRecord.entryPrice) priceByDate.set(`${r.asset}:${r.date}`, anyRecord.entryPrice);
  }

  const overall = computeTradeStats(traded.map(toTradeRecord));
  const assets = Array.from(new Set(records.map((r) => r.asset)));

  const byRegime = groupBy(traded, (d) => (d.regimeTags.length ? d.regimeTags.join(" + ") : null));
  const byConfidenceBucket = groupBy(traded, (d) => confidenceBucket(d.biasConfidence));
  const byMtfAgreement = groupBy(traded, (d) => d.agreement4h);

  const calInputs = (horizonKey: "forwardReturn1d" | "forwardReturn7d"): CalibrationInput[] =>
    records
      .filter((r) => r.biasConfidence !== null && r.biasVerdict !== null)
      .map((r) => ({ confidence: r.biasConfidence!, verdict: r.biasVerdict!, forwardReturnPct: r[horizonKey] }));

  // Benchmarks run per asset then are reported per asset — averaging a BTC
  // and an ETH equity curve would invent a portfolio that was never traded.
  const benchmarks: BenchmarkResult[] = [];
  const longShare = traded.length ? (traded.filter((t) => t.trade!.side === "long").length / traded.length) * 100 : 0;
  const medianHoldDays = Math.max(1, Math.round((overall?.medianHoursHeld ?? 24) / 24));
  for (const asset of assets) {
    const bars = dailyBars(records, asset, priceByDate);
    if (bars.length < 250) continue;
    const assetTrades = traded.filter((t) => t.asset === asset).length;
    for (const b of [
      buyAndHold(bars),
      smaCrossover(bars),
      randomEntry(bars, assetTrades, longShare, medianHoldDays),
    ]) {
      benchmarks.push({ ...b, name: `${asset} — ${b.name}` });
    }
  }

  const wfTrades: WalkForwardTrade[] = traded.map((d) => ({
    ...toTradeRecord(d),
    side: d.trade!.side,
    exitT: d.t + d.trade!.hoursHeld * 3_600_000,
  }));
  const walkForward = buildWalkForward(wfTrades, 5, 7);

  const quantileCalibration = buildQuantileCalibration(calInputs("forwardReturn1d"), 4);
  const confidenceDistribution = summarizeDistribution(
    records.filter((r) => r.biasConfidence !== null).map((r) => r.biasConfidence!)
  );
  const confidenceByAction = Array.from(
    new Set(records.map((r) => r.action).filter((a): a is string => a !== null))
  )
    .map((action) => ({
      label: action,
      distribution: summarizeDistribution(
        records.filter((r) => r.action === action && r.biasConfidence !== null).map((r) => r.biasConfidence!)
      )!,
    }))
    .filter((x) => x.distribution)
    .sort((a, b) => b.distribution.n - a.distribution.n);

  const marginalRegimes = marginalRegimeCells(
    traded.map((d) => ({ ...toTradeRecord(d), regimeTags: d.regimeTags }))
  );

  const volRegimeOf = (tags: string[]): VolRegime | null => {
    for (const v of ["high-vol", "normal-vol", "low-vol"] as const) {
      if (tags.includes(v)) return v;
    }
    return null;
  };
  const plannerRows: PlannerTradeRow[] = traded.map((d) => ({
    side: d.trade!.side,
    volRegime: volRegimeOf(d.regimeTags),
    netReturnPct: d.trade!.netReturnPct,
    maePct: d.trade!.maePct,
    mfePct: d.trade!.mfePct,
    hoursHeld: d.trade!.hoursHeld,
  }));
  const planner = buildPlannerStats(plannerRows);
  const plannerGateEffect = gateEffect(plannerRows, planner);

  const base = overall?.expectancyNetPct ?? 0;
  const failureModes = [...byRegime, ...byConfidenceBucket, ...byMtfAgreement, ...groupBy(traded, (d) => d.trade!.side)]
    .map((s) => ({
      label: s.label,
      n: s.stats.n,
      expectancyNetPct: s.stats.expectancyNetPct,
      stopHitRatePct: s.stats.stopHitRatePct,
      deltaVsBasePct: s.stats.expectancyNetPct - base,
    }))
    .filter((f) => f.deltaVsBasePct < 0)
    .sort((a, b) => a.deltaVsBasePct - b.deltaVsBasePct)
    .slice(0, 8);

  const dates = records.map((r) => r.date).sort();
  const stats: ExecutionStats = {
    provenance: buildProvenance({
      assets,
      coverageStart: dates[0] ?? null,
      coverageEnd: dates[dates.length - 1] ?? null,
      evaluatedDays: records.length,
      maxHoldHours: MAX_HOLD_HOURS,
    }),
    overall,
    byAsset: groupBy(traded, (d) => d.asset),
    bySide: groupBy(traded, (d) => d.trade!.side),
    byRegime,
    byConfidenceBucket,
    byMtfAgreement,
    calibration24h: buildCalibration(calInputs("forwardReturn1d"), "24h"),
    calibration7d: buildCalibration(calInputs("forwardReturn7d"), "7d"),
    benchmarks,
    walkForward,
    quantileCalibration,
    confidenceDistribution,
    confidenceByAction,
    marginalRegimes,
    planner,
    plannerGateEffect,
    failureModes,
  };

  fs.writeFileSync(path.join(OUT_DIR, "executionStats.json"), JSON.stringify(stats, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, "..", "executionReport.md"), renderMarkdown(stats));
  console.log(`[execution] ${traded.length} resolved trades from ${records.length} day-records`);
  console.log(`[execution] wrote src/data/executionStats.json`);
  console.log(`[execution] wrote scripts/backtest/executionReport.md`);
}

function renderMarkdown(s: ExecutionStats): string {
  const p = s.provenance;
  const lines: string[] = [];

  lines.push(`# Execution Backtest`);
  lines.push("");
  lines.push(
    `Engine \`${p.engineVersion}\`, features \`${p.featureVersion}\`, generated ${new Date(p.generatedAt).toISOString()}.`
  );
  lines.push(
    `${p.assets.join(" + ")}, ${p.coverageStart} to ${p.coverageEnd}, ${p.evaluatedDays} day-records. Max hold ${p.maxHoldHours}h. Costs: ${p.costConfig.takerFeeBpsPerLeg}bp fee + ${p.costConfig.slippageBpsPerLeg}bp slippage per leg, plus real historical funding.`
  );
  lines.push("");
  lines.push(`> ${p.costNotes}`);
  lines.push("");
  lines.push(
    `Exit rule: first touch of TP1 or the stop closes the trade, else it closes at market after ${p.maxHoldHours}h. A bar spanning both levels resolves as the stop (hourly bars cannot order intrabar events; the pessimistic assumption is the honest one).`
  );
  lines.push("");

  if (!s.overall) {
    lines.push(`_Not enough resolved trades (minimum ${MIN_SAMPLE_N}) to report._`);
    return lines.join("\n");
  }

  lines.push(`## Overall`);
  lines.push("");
  lines.push(STATS_HEADER);
  lines.push(statsRow("All trades", s.overall));
  lines.push("");
  lines.push(
    `Gross expectancy ${pct(s.overall.expectancyGrossPct, 3)} against net ${pct(s.overall.expectancyNetPct, 3)} — the gap is the entire cost of trading. Per-trade Sharpe ${num(s.overall.sharpePerTrade)}, Sortino ${num(s.overall.sortinoPerTrade)} (per-trade, NOT annualized). Calmar ${num(s.overall.calmar)}. Median hold ${num(s.overall.medianHoursHeld, 0)}h. ${s.overall.ambiguousRatePct.toFixed(1)}% of outcomes rest on the intrabar stop-wins assumption.`
  );
  lines.push("");

  for (const [title, segments] of [
    ["By asset", s.byAsset],
    ["By side", s.bySide],
    ["By multi-timeframe agreement", s.byMtfAgreement],
    ["By confidence bucket", s.byConfidenceBucket],
    ["By regime", s.byRegime],
  ] as Array<[string, Segment[]]>) {
    if (segments.length === 0) continue;
    lines.push(`## ${title}`);
    lines.push("");
    lines.push(STATS_HEADER);
    for (const seg of segments) lines.push(statsRow(seg.label, seg.stats));
    lines.push("");
  }

  for (const cal of [s.calibration24h, s.calibration7d]) {
    lines.push(`## Confidence calibration — ${cal.horizon}`);
    lines.push("");
    if (cal.buckets.length === 0) {
      lines.push(`_${cal.interpretation}_`);
      lines.push("");
      continue;
    }
    lines.push(`| Confidence | N | Observed favourable | 95% CI | Implied by score | Gap |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const b of cal.buckets) {
      lines.push(
        `| ${b.label} | ${b.n} | ${b.observedRatePct.toFixed(0)}% | ${(b.interval.lower * 100).toFixed(0)}-${(b.interval.upper * 100).toFixed(0)}% | ${b.impliedRatePct}% | ${b.calibrationErrorPct >= 0 ? "+" : ""}${b.calibrationErrorPct.toFixed(0)} |`
      );
    }
    lines.push("");
    lines.push(`**${cal.interpretation}**`);
    lines.push("");
  }

  lines.push(`## Benchmarks`);
  lines.push("");
  lines.push(`| Strategy | Trades | Total return | Annualized | Max DD | Exposure | Per trade |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const b of s.benchmarks) {
    lines.push(
      `| ${b.name} | ${b.n} | ${pct(b.totalReturnPct, 1)} | ${pct(b.annualizedPct, 1)} | ${pct(b.maxDrawdownPct, 1)} | ${b.exposurePct.toFixed(0)}% | ${pct(b.meanReturnPerTradePct, 3)} |`
    );
  }
  lines.push("");
  lines.push(
    `Benchmarks exclude funding on both sides so the comparison isolates strategy rather than instrument.`
  );
  lines.push("");
  lines.push(
    `**Read the last column, not the first.** Buy-and-hold and the SMA crossover are single compounding positions; their total return is not comparable to a per-trade expectancy, and the engine is flat most days besides. The only like-for-like comparison on this table is the engine's net expectancy of ${pct(s.overall.expectancyNetPct, 3)} against random entry's per-trade figure, which is matched to the engine's own trade count, long/short mix and hold length and measured on the identical constant-size basis.`
  );
  lines.push("");

  lines.push(`## Walk-forward validation (execution layer)`);
  lines.push("");
  lines.push(`> ${s.walkForward.methodology}`);
  lines.push("");
  lines.push(`${s.walkForward.foldCount} sequential validation windows, ${s.walkForward.embargoDays}-day purge/embargo.`);
  lines.push("");
  lines.push(`| Fold | Discovery ends | Discovery N | Validation window | N | Win | Expectancy (net) | Profit factor | Median MAE | Median MFE | Max DD | Side ranking held |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const f of s.walkForward.folds) {
    const st = f.stats;
    lines.push(
      `| ${f.index} | ${f.discoveryEnd} | ${f.discoveryN} | ${f.validationStart} → ${f.validationEnd} | ${f.validationN} | ${st ? st.winRatePct.toFixed(0) + "%" : "—"} | ${st ? pct(st.expectancyNetPct, 3) : "—"} | ${st ? num(st.profitFactor) : "—"} | ${st ? pct(st.mae?.median ?? null, 1) : "—"} | ${st ? pct(st.mfe?.median ?? null, 1) : "—"} | ${st ? pct(st.maxDrawdownPct, 1) : "—"} | ${f.sideRankingHeld === null ? "not testable" : f.sideRankingHeld ? "yes" : "NO"} |`
    );
  }
  lines.push("");
  lines.push(
    `Pooled (in-sample) net expectancy ${pct(s.walkForward.inSample?.expectancyNetPct ?? null, 3)} vs mean out-of-sample ${pct(s.walkForward.meanOutOfSampleExpectancyPct, 3)} (worst fold ${pct(s.walkForward.worstFoldExpectancyPct, 3)}, best ${pct(s.walkForward.bestFoldExpectancyPct, 3)}).`
  );
  lines.push("");
  lines.push(`**${s.walkForward.interpretation}**`);
  lines.push("");

  lines.push(`## Confidence distribution — why the high bands are empty`);
  lines.push("");
  if (s.confidenceDistribution) {
    const d = s.confidenceDistribution;
    lines.push(`| N | Min | p10 | p25 | Median | p75 | p90 | Max | Mean |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|`);
    lines.push(`| ${d.n} | ${d.min.toFixed(0)} | ${d.p10.toFixed(0)} | ${d.p25.toFixed(0)} | ${d.median.toFixed(0)} | ${d.p75.toFixed(0)} | ${d.p90.toFixed(0)} | ${d.max.toFixed(0)} | ${d.mean.toFixed(1)} |`);
    lines.push("");
    lines.push(
      `The score never leaves [${d.min.toFixed(0)}, ${d.max.toFixed(0)}]. This is a STRUCTURAL property of the scoring system, not a data artefact and not a bug: \`bias.confidence\` is a weight-weighted arithmetic MEAN of ~15 per-metric confidences (scoring.ts), and a mean over many bounded partially-independent components concentrates around its centre by construction. Reaching 80 would require nearly every metric to report >=80 simultaneously, which never occurs because several metrics are structurally mid-confidence. Cause: (A) an intentional property of the scoring system.`
    );
    lines.push("");
    lines.push(
      `Consequence for measurement: three of the five fixed 0-20/.../80-100 bands are PERMANENTLY unpopulated, so fixed-band calibration cannot test ordering within the range the score actually occupies. Calibration above ${d.max.toFixed(0)} confidence cannot currently be established due to insufficient historical observations — there are none. The quantile analysis below measures ordering inside the real range instead.`
    );
    lines.push("");
  }
  if (s.confidenceByAction.length > 0) {
    lines.push(`| Action state | N | Min | Median | Max |`);
    lines.push(`|---|---|---|---|---|`);
    for (const a of s.confidenceByAction) {
      lines.push(`| ${a.label} | ${a.distribution.n} | ${a.distribution.min.toFixed(0)} | ${a.distribution.median.toFixed(0)} | ${a.distribution.max.toFixed(0)} |`);
    }
    lines.push("");
  }

  lines.push(`## Confidence ordering — empirical quantiles`);
  lines.push("");
  if (s.quantileCalibration.buckets.length === 0) {
    lines.push(`_${s.quantileCalibration.interpretation}_`);
  } else {
    lines.push(`| Confidence quartile | N | Observed favourable (24h) | 95% CI |`);
    lines.push(`|---|---|---|---|`);
    for (const b of s.quantileCalibration.buckets) {
      lines.push(`| ${b.label} | ${b.n} | ${b.observedRatePct.toFixed(1)}% | ${(b.interval.lower * 100).toFixed(0)}-${(b.interval.upper * 100).toFixed(0)}% |`);
    }
    lines.push("");
    lines.push(`**${s.quantileCalibration.interpretation}**`);
    lines.push("");
    lines.push(`These are equal-population quantiles of the OBSERVED distribution, not probability bands. A quantile has no implied success rate, so nothing here can be read as "confidence N means N%".`);
  }
  lines.push("");

  lines.push(`## Regime analysis — marginal, with sample adequacy`);
  lines.push("");
  lines.push(`Thresholds: **adequate** N>=100, **thin** N>=30, **insufficient** N<30 (stats withheld entirely).`);
  lines.push("");
  lines.push(`| Regime tag | Dimension | N | Adequacy | Win | Expectancy (net) | Median outcome | Median MAE | Median MFE |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const c of s.marginalRegimes) {
    const st = c.stats;
    lines.push(
      `| ${c.label} | ${c.dimension} | ${c.n} | ${c.adequacy} | ${st ? st.winRatePct.toFixed(0) + "%" : "—"} | ${st ? pct(st.expectancyNetPct, 3) : "insufficient sample"} | ${st ? pct(st.medianNetPct, 2) : "—"} | ${st ? pct(st.mae?.median ?? null, 1) : "—"} | ${st ? pct(st.mfe?.median ?? null, 1) : "—"} |`
    );
  }
  lines.push("");
  lines.push(
    `Reported alongside the full cross-product above, not instead of it. The cross-product is where the sample problem lives — three dimensions multiply into 16 cells, several holding a dozen trades, and a -2.5% expectancy from twelve trades is noise wearing a conclusion's clothing. The marginal view answers the same practical questions at 5-10x the sample size. Cross-product cells below 30 trades should be read as descriptive only.`
  );
  lines.push("");

  lines.push(`## Failure modes`);
  lines.push("");
  if (s.failureModes.length === 0) {
    lines.push(`_No segment underperforms the overall base rate._`);
  } else {
    lines.push(`Segments with worse net expectancy than the ${pct(s.overall.expectancyNetPct, 3)} overall base rate.`);
    lines.push("");
    lines.push(`| Condition | N | Net expectancy | Stop rate | vs base |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of s.failureModes) {
      lines.push(
        `| ${f.label} | ${f.n} | ${pct(f.expectancyNetPct, 3)} | ${f.stopHitRatePct.toFixed(0)}% | ${pct(f.deltaVsBasePct, 3)} |`
      );
    }
  }
  lines.push("");

  lines.push(`## Planner statistics — excursions, EV bounds, and the time-stop verdict`);
  lines.push("");
  lines.push(
    `Side × vol-regime cells from the UNGATED replay (bucket fixed a priori — direction faces ` +
      `drift asymmetry, volatility scales excursions; see plannerStats.ts). Winners' MAE is the ` +
      `adverse move winning trades endured before working: a stop tighter than the p80 stops out ` +
      `winners. Winners' MFE is how far winners actually ran: a target beyond the p75 is priced ` +
      `on trades this strategy does not produce. EV@lower prices the win rate at its Wilson 95% ` +
      `lower bound — the number the live gate refuses at ≤ 0.`
  );
  lines.push("");
  lines.push(`| Cell | N | Win rate | Wilson low | Avg win | Avg loss | EV@point | EV@lower | Winners' MAE p80/p90 | Winners' MFE p50/p75 |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const key of Object.keys(s.planner.cells).sort()) {
    const c = s.planner.cells[key as keyof typeof s.planner.cells]!;
    const w = c.winners;
    lines.push(
      `| ${key} | ${c.n} | ${c.winRatePct.toFixed(1)}% | ${c.winRateWilsonLowPct.toFixed(1)}% | ` +
        `${pct(c.avgWinPct)} | ${pct(c.avgLossPct)} | ${pct(c.evPointPct)} | **${pct(c.evLowerPct)}** | ` +
        `${w ? `${w.maeP80Pct.toFixed(2)}% / ${w.maeP90Pct.toFixed(2)}%` : "thin"} | ` +
        `${w ? `${w.mfeP50Pct.toFixed(2)}% / ${w.mfeP75Pct.toFixed(2)}%` : "thin"} |`
    );
  }
  lines.push("");
  lines.push(`### Survival curve — should plans have a time stop?`);
  lines.push("");
  lines.push(`| Still open at hour | N | Eventual win rate |`);
  lines.push(`|---|---|---|`);
  for (const pt of s.planner.survival) {
    lines.push(`| ${pt.hours} | ${pt.n} | ${pt.eventualWinRatePct.toFixed(1)}% |`);
  }
  lines.push("");
  lines.push(s.planner.timeStopFinding);
  lines.push("");
  lines.push(`### The EV gate's measured effect on this record`);
  lines.push("");
  const g = s.plannerGateEffect;
  lines.push(
    `Applied to these same ${g.keptN + g.refusedN} ungated trades, the gate keeps ${g.keptN} ` +
      `(expectancy ${pct(g.keptExpectancyPct)}) and refuses ${g.refusedN} ` +
      `(expectancy ${pct(g.refusedExpectancyPct)}); ungated expectancy was ${pct(g.ungatedExpectancyPct)}. ` +
      `IN-SAMPLE: the gate was derived from this record, so this is the upper bound of its benefit, ` +
      `not a forecast. The gate re-earns itself every regeneration — a refused bucket whose ungated ` +
      `record turns positive re-opens automatically.`
  );
  lines.push("");
  lines.push(`## Unavailable inputs`);
  lines.push("");
  lines.push(`These decision inputs have no historical source and were null throughout the replay, so the engine measured here is a partial-information version of the live one:`);
  lines.push("");
  for (const u of p.unavailableInputs) lines.push(`- ${u}`);
  lines.push("");

  return lines.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("executionReport.ts")) {
  main();
}
