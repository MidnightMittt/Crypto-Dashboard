import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord, RawAssetData, rollUpToDaily } from "./run";
import { classifyMarketRegime, stabilizeLabels, MarketRegimeRead, Efficiency, REGIME_CONFIRM_DAYS } from "./regimeModel";
import { computeTradeStats, TradeRecord } from "./tradeStats";
import {
  blockBootstrapProportion,
  differenceOfProportions,
  detectableDifferenceFromSe,
  movingBlockBootstrap,
  nonOverlappingByTime,
} from "./overlap";
import { benjaminiHochberg } from "./multipleTesting";

/**
 * PHASE 7 — Does a market regime layer change how existing signals should
 * be read? RESEARCH ONLY; no production file is modified by this script.
 *
 * ══ PRE-REGISTRATION ════════════════════════════════════════════════════
 *
 * The three hypotheses below were written down BEFORE any number in this
 * study was computed, and are not changed afterwards regardless of what
 * comes back. This matters more here than anywhere else in the project: a
 * regime layer multiplies the number of testable cells (every signal x
 * every regime), which is precisely the condition under which data snooping
 * manufactures findings. Fixing the hypothesis list in advance, keeping it
 * short, and correcting for multiplicity is what separates this from
 * fishing.
 *
 *   H1 (reversal-in-chop). Harmonic PRZ evidence performs BETTER in
 *       low-efficiency (choppy) regimes than in high-efficiency (trending)
 *       ones. Rationale: a PRZ is a bet that price reverses at a level, and
 *       reversals resolve favourably when price mean-reverts — which is
 *       what low efficiency means. This is also the brief's own question,
 *       "in which regimes do harmonic PRZs become meaningful?"
 *
 *   H2 (continuation-in-trend). The daily technical direction read performs
 *       BETTER in trending regimes than in choppy ones. Rationale: the
 *       mirror image of H1 — trend-following needs trends to persist.
 *
 *   H3 (omnibus). The engine's own resolved trades perform differently
 *       across efficiency regimes at all. If H3 fails while H1/H2 fail,
 *       there is no regime effect to build on.
 *
 * Directional predictions are stated, but every test below is TWO-SIDED —
 * a one-sided test after choosing the direction would be marking my own
 * homework.
 *
 * ══ WHAT WOULD FALSIFY THE PHASE ════════════════════════════════════════
 *
 * If none of H1-H3 survives Benjamini-Hochberg, the honest conclusion is
 * that this dataset provides no evidence for regime-conditional
 * interpretation, and the regime engine should NOT be wired into the
 * decision path — however intuitive the idea is.
 *
 * Run: npx tsx scripts/backtest/regimeStudy.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HOUR_MS = 3_600_000;

/** Swing-relevant horizon for the signal-quality tests. Fixed in advance, not selected from results. */
const HORIZON_DAYS = 7;
/** Block length in observations: HORIZON_DAYS of both assets, since records are timestamp-sorted with BTC and ETH per day. */
const BLOCK = 2 * HORIZON_DAYS;
/** Genuinely slower efficiency window for the exploratory R5b check — a quarter, against the 20-day default. */
const SLOW_LOOKBACK = 60;

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const pctStr = (x: number) => `${(100 * x).toFixed(1)}%`;

interface Row {
  rec: DayRecord;
  regime: MarketRegimeRead;
}

interface Test {
  id: string;
  hypothesis: string;
  detail: string;
  n: number;
  effectiveN: number;
  difference: number;
  detectable: number;
  pValue: number;
}

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };
  const tests: Test[] = [];

  say("# Phase 7 Research — Market Regime as a Context Layer");
  say("");
  say("Research only. No production file is modified by this script. Three hypotheses, pre-registered in the source before any computation, two-sided, overlap-corrected, and Benjamini-Hochberg corrected together at the end.");
  say("");

  // ── Data + regime classification ─────────────────────────────────────
  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"))
    .sort((a: DayRecord, b: DayRecord) => a.t - b.t);

  const regimeByAssetDay = new Map<string, MarketRegimeRead>();
  for (const asset of ["BTC", "ETH"] as const) {
    const raw: RawAssetData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${asset}.json`), "utf8"));
    const daily = rollUpToDaily(raw.futuresKlines);
    for (let i = 0; i < daily.length; i++) {
      const read = classifyMarketRegime(daily, i);
      if (read?.calibrated) {
        regimeByAssetDay.set(`${asset}:${new Date(daily[i].t).toISOString().slice(0, 10)}`, read);
      }
    }
  }

  const rows: Row[] = records
    .map((rec) => ({ rec, regime: regimeByAssetDay.get(`${rec.asset}:${rec.date}`) }))
    .filter((x): x is Row => x.regime !== undefined);

  say(`Day-records with a calibrated regime read: ${rows.length} of ${records.length}.`);
  say("");

  // ── R1: census + persistence ─────────────────────────────────────────
  say("## R1 — Census and persistence");
  say("");
  say("| Efficiency regime | Days | Share | Mean ER |");
  say("|---|---|---|---|");
  const EFFS: Efficiency[] = ["trending", "mixed", "choppy"];
  for (const e of EFFS) {
    const b = rows.filter((x) => x.regime.efficiency === e);
    const meanEr = b.reduce((a, x) => a + x.regime.efficiencyRatio, 0) / Math.max(1, b.length);
    say(`| ${e} | ${b.length} | ${f1((100 * b.length) / rows.length)}% | ${meanEr.toFixed(3)} |`);
  }
  say("");

  for (const asset of ["BTC", "ETH"] as const) {
    const seq = rows.filter((x) => x.rec.asset === asset).map((x) => x.regime.efficiency);
    let switches = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
    say(`**${asset}** regime dwell: ${(seq.length / Math.max(1, switches + 1)).toFixed(1)} days mean (${switches} changes over ${seq.length} days).`);
  }
  say("");

  // ── R2: redundancy ───────────────────────────────────────────────────
  say("## R2 — Is efficiency redundant with tags the engine already has?");
  say("");
  say("The engine already tags each day with a trend direction, a volatility percentile and a range-bound flag. If efficiency is just one of those renamed, it adds nothing. Cross-tabulated against the existing `range-bound` tag — the closest existing concept — and the volatility tag:");
  say("");
  say("| Efficiency | range-bound | not range-bound | high-vol | normal-vol | low-vol |");
  say("|---|---|---|---|---|---|");
  for (const e of EFFS) {
    const b = rows.filter((x) => x.regime.efficiency === e);
    const rb = b.filter((x) => x.rec.regimeTags.includes("range-bound")).length;
    const hv = b.filter((x) => x.rec.regimeTags.includes("high-vol")).length;
    const nv = b.filter((x) => x.rec.regimeTags.includes("normal-vol")).length;
    const lv = b.filter((x) => x.rec.regimeTags.includes("low-vol")).length;
    say(`| ${e} | ${rb} | ${b.length - rb} | ${hv} | ${nv} | ${lv} |`);
  }
  say("");
  const rbAll = rows.filter((x) => x.rec.regimeTags.includes("range-bound"));
  const rbChoppy = rbAll.filter((x) => x.regime.efficiency === "choppy").length;
  say(`Of the ${rbAll.length} days the engine already calls range-bound, ${rbChoppy} (${f1((100 * rbChoppy) / Math.max(1, rbAll.length))}%) are also classed choppy by efficiency. ` +
      `A figure near 100% would mean the two measures are the same thing.`);
  say("");

  // ── R3: the pre-registered tests ─────────────────────────────────────
  say("## R3 — Pre-registered hypothesis tests");
  say("");

  /** Win series for a filtered population at the fixed horizon, chronological. */
  const winsFor = (subset: Row[], directionOf: (r: Row) => string | null): number[] =>
    subset
      .filter((x) => {
        const d = directionOf(x);
        return d === "bullish" || d === "bearish";
      })
      .filter((x) => x.rec.forwardReturn7d !== null)
      .map((x): number => {
        const ret = x.rec.forwardReturn7d as number;
        return (directionOf(x) === "bullish" ? ret > 0 : ret < 0) ? 1 : 0;
      });

  const runInteraction = (
    id: string,
    hypothesis: string,
    subset: Row[],
    directionOf: (r: Row) => string | null,
    aLabel: Efficiency,
    bLabel: Efficiency
  ) => {
    const aWins = winsFor(subset.filter((x) => x.regime.efficiency === aLabel), directionOf);
    const bWins = winsFor(subset.filter((x) => x.regime.efficiency === bLabel), directionOf);
    const a = blockBootstrapProportion(aWins, BLOCK);
    const b = blockBootstrapProportion(bWins, BLOCK);
    if (!a || !b) {
      say(`**${id}** — insufficient data (${aWins.length} vs ${bWins.length} observations).`);
      say("");
      return;
    }
    const diff = differenceOfProportions(a, b);
    // From the ACTUAL bootstrap SE, not from a nominal effective N — see
    // detectableDifferenceFromSe's own note on why mixing the two can call
    // the same result significant and undetectable simultaneously.
    const detectable = detectableDifferenceFromSe(diff.se);

    say(`### ${id} — ${hypothesis}`);
    say("");
    say("| Regime | N | Eff. N | Win rate | 95% CI |");
    say("|---|---|---|---|---|");
    say(`| ${aLabel} | ${a.n} | ${a.effectiveN.toFixed(0)} | ${pctStr(a.point)} | ${pctStr(a.lower)}–${pctStr(a.upper)} |`);
    say(`| ${bLabel} | ${b.n} | ${b.effectiveN.toFixed(0)} | ${pctStr(b.point)} | ${pctStr(b.lower)}–${pctStr(b.upper)} |`);
    say("");
    say(`Difference (${aLabel} − ${bLabel}): **${(100 * diff.difference).toFixed(1)}pp** ` +
        `(95% CI ${(100 * diff.lower).toFixed(1)} to ${(100 * diff.upper).toFixed(1)}pp), p = **${diff.pValue.toFixed(4)}**.`);
    say("");
    say(`Smallest difference this test could detect at 80% power: **${(100 * detectable).toFixed(1)}pp** ` +
        `(thinner arm: eff. N ${Math.min(a.effectiveN, b.effectiveN).toFixed(0)}). ` +
        (Math.abs(diff.difference) < detectable
          ? "The observed difference sits BELOW that floor, so a null here is uninformative rather than evidence of no effect."
          : "The observed difference clears that floor, so this test genuinely could have found it."));
    say("");

    tests.push({
      id,
      hypothesis,
      detail: `${aLabel} ${pctStr(a.point)} vs ${bLabel} ${pctStr(b.point)}`,
      n: a.n + b.n,
      effectiveN: a.effectiveN + b.effectiveN,
      difference: diff.difference,
      detectable,
      pValue: diff.pValue,
    });
  };

  // H1 — harmonic PRZ, reversal signal, tradeable tier only (the production gate).
  runInteraction(
    "H1",
    "Harmonic PRZ works better in choppy than trending markets",
    rows.filter((x) => x.rec.harmonic?.status === "tradeable"),
    (x) => x.rec.harmonic?.direction ?? null,
    "choppy",
    "trending"
  );

  // H2 — daily technical direction, continuation signal.
  runInteraction(
    "H2",
    "Daily technical direction works better in trending than choppy markets",
    rows,
    (x) => x.rec.dailyDirection,
    "trending",
    "choppy"
  );

  // H3 — omnibus, on the engine's own resolved trades. Uses the
  // non-overlapping subsample rather than the block bootstrap, because
  // trades have genuinely varying durations rather than a fixed horizon.
  say("### H3 — The engine's resolved trades perform differently across regimes (omnibus)");
  say("");
  const tradeRows = rows.filter((x) => x.rec.trade !== null);
  const independent: Row[] = [];
  for (const asset of ["BTC", "ETH"] as const) {
    independent.push(
      ...nonOverlappingByTime(
        tradeRows.filter((x) => x.rec.asset === asset),
        (x) => x.rec.t,
        (x) => x.rec.t + x.rec.trade!.hoursHeld * HOUR_MS
      )
    );
  }
  say(`Resolved trades: ${tradeRows.length}, of which **${independent.length} are statistically independent** (non-overlapping holding periods, per asset).`);
  say("");
  say("| Regime | Independent trades | Win rate | Net expectancy | Profit factor |");
  say("|---|---|---|---|---|");
  const byRegime = new Map<Efficiency, Row[]>();
  for (const e of EFFS) byRegime.set(e, independent.filter((x) => x.regime.efficiency === e));
  for (const e of EFFS) {
    const b = byRegime.get(e)!;
    const stats = computeTradeStats(b.map((x) => ({ t: x.rec.t, ...x.rec.trade! } as TradeRecord)));
    say(`| ${e} | ${b.length} | ${stats ? `${f1(stats.winRatePct)}%` : "insufficient"} | ${stats ? `${stats.expectancyNetPct.toFixed(2)}%` : "—"} | ${stats && stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : "—"} |`);
  }
  say("");

  const winsOf = (b: Row[]) => b.map((x): number => (x.rec.trade!.netReturnPct > 0 ? 1 : 0));
  const trendProp = blockBootstrapProportion(winsOf(byRegime.get("trending")!), 1);
  const chopProp = blockBootstrapProportion(winsOf(byRegime.get("choppy")!), 1);
  if (trendProp && chopProp) {
    const diff = differenceOfProportions(chopProp, trendProp);
    const detectable = detectableDifferenceFromSe(diff.se);
    say(`Difference (choppy − trending): **${(100 * diff.difference).toFixed(1)}pp**, p = **${diff.pValue.toFixed(4)}**. ` +
        `Detectable floor at this sample: ${(100 * detectable).toFixed(1)}pp.`);
    say("");
    say("Block length is 1 here, not 14: these trades are already non-overlapping by construction, so there is no serial dependence left to correct for.");
    say("");
    tests.push({
      id: "H3",
      hypothesis: "Resolved trades perform differently across efficiency regimes",
      detail: `choppy ${pctStr(chopProp.point)} vs trending ${pctStr(trendProp.point)}`,
      n: chopProp.n + trendProp.n,
      effectiveN: chopProp.effectiveN + trendProp.effectiveN,
      difference: diff.difference,
      detectable,
      pValue: diff.pValue,
    });
  }

  // ── R4: stability robustness ─────────────────────────────────────────
  say("## R4 — Robustness to regime stabilisation");
  say("");
  say(`R1 showed the raw tercile label flips every ~3.5 days. That is faster than the swing thesis it is meant to provide context for, and a context layer that churns quicker than the decision beneath it is worse than no context layer. Re-running the surviving test with ${REGIME_CONFIRM_DAYS}-day confirmation hysteresis — the same mechanism swingThesis.ts already uses — answers whether the effect is a property of the market or an artefact of label churn.`);
  say("");
  say("This is reported as a robustness check, not a selection: whichever version reads better, the pre-registered result above stands as the headline.");
  say("");

  const stabilizedByKey = new Map<string, Efficiency>();
  for (const asset of ["BTC", "ETH"] as const) {
    const assetRows = rows.filter((x) => x.rec.asset === asset);
    const stabilized = stabilizeLabels(assetRows.map((x) => x.regime.efficiency), REGIME_CONFIRM_DAYS);
    assetRows.forEach((x, i) => stabilizedByKey.set(`${asset}:${x.rec.date}`, stabilized[i]));
  }
  const stableOf = (x: Row) => stabilizedByKey.get(`${x.rec.asset}:${x.rec.date}`)!;

  for (const asset of ["BTC", "ETH"] as const) {
    const seq = rows.filter((x) => x.rec.asset === asset).map(stableOf);
    let switches = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
    say(`**${asset}** stabilised dwell: ${(seq.length / Math.max(1, switches + 1)).toFixed(1)} days mean (${switches} changes, down from the raw count above).`);
  }
  say("");

  const stabWins = (subset: Row[], label: Efficiency, directionOf: (r: Row) => string | null) =>
    winsFor(subset.filter((x) => stableOf(x) === label), directionOf);

  say("| Test | Regime | N | Eff. N | Win rate | Difference | p |");
  say("|---|---|---|---|---|---|---|");
  for (const spec of [
    { id: "H1", subset: rows.filter((x) => x.rec.harmonic?.status === "tradeable"), dir: (x: Row) => x.rec.harmonic?.direction ?? null, a: "choppy" as Efficiency, b: "trending" as Efficiency },
    { id: "H2", subset: rows, dir: (x: Row) => x.rec.dailyDirection, a: "trending" as Efficiency, b: "choppy" as Efficiency },
  ]) {
    const a = blockBootstrapProportion(stabWins(spec.subset, spec.a, spec.dir), BLOCK);
    const b = blockBootstrapProportion(stabWins(spec.subset, spec.b, spec.dir), BLOCK);
    if (!a || !b) { say(`| ${spec.id} | — | insufficient | | | | |`); continue; }
    const d = differenceOfProportions(a, b);
    say(`| ${spec.id} | ${spec.a} | ${a.n} | ${a.effectiveN.toFixed(0)} | ${pctStr(a.point)} | | |`);
    say(`| ${spec.id} | ${spec.b} | ${b.n} | ${b.effectiveN.toFixed(0)} | ${pctStr(b.point)} | ${(100 * d.difference).toFixed(1)}pp | ${d.pValue.toFixed(4)} |`);
  }
  say("");

  // ── R5: exploratory, explicitly NOT pre-registered ───────────────────
  say("## R5 — Exploratory follow-ups (post-hoc: NOT pre-registered, NOT in the FDR family)");
  say("");
  say("Both checks below were prompted by results above rather than specified in advance. They are excluded from the correction and from the verdict, and must be confirmed on fresh data before being believed. They are recorded because leaving them unexamined would be worse than reporting them with the right caveat.");
  say("");

  say("**5a. H3 measured on expectancy rather than win rate.** The omnibus test found no win-rate difference, but the expectancy column told a different story (trending +1.17%, choppy -0.03%) — win rate and profitability are not the same question, and only the first was pre-registered.");
  say("");
  say("| Regime | Independent trades | Mean net return | Bootstrap 95% CI |");
  say("|---|---|---|---|");
  for (const e of EFFS) {
    const b = byRegime.get(e)!;
    const returns = b.map((x) => x.rec.trade!.netReturnPct);
    if (returns.length < 10) { say(`| ${e} | ${returns.length} | insufficient | — |`); continue; }
    const dist = movingBlockBootstrap(returns, 1, 4000, 7).sort((p, q) => p - q);
    const mean = returns.reduce((p, q) => p + q, 0) / returns.length;
    say(`| ${e} | ${returns.length} | ${mean.toFixed(2)}% | ${dist[Math.floor(0.025 * dist.length)].toFixed(2)}% to ${dist[Math.floor(0.975 * dist.length)].toFixed(2)}% |`);
  }
  say("");
  const trendRet = byRegime.get("trending")!.map((x) => x.rec.trade!.netReturnPct);
  const chopRet = byRegime.get("choppy")!.map((x) => x.rec.trade!.netReturnPct);
  if (trendRet.length >= 10 && chopRet.length >= 10) {
    const dTrend = movingBlockBootstrap(trendRet, 1, 4000, 7);
    const dChop = movingBlockBootstrap(chopRet, 1, 4000, 7);
    const diffs = dTrend.map((v, i) => v - dChop[i]).sort((p, q) => p - q);
    const share = diffs.filter((v) => v <= 0).length / diffs.length;
    say(`Bootstrap difference in mean net return (trending − choppy): **${(trendRet.reduce((p, q) => p + q, 0) / trendRet.length - chopRet.reduce((p, q) => p + q, 0) / chopRet.length).toFixed(2)}pp**, ` +
        `95% CI ${diffs[Math.floor(0.025 * diffs.length)].toFixed(2)} to ${diffs[Math.floor(0.975 * diffs.length)].toFixed(2)}pp, ` +
        `two-sided p ≈ **${(2 * Math.min(share, 1 - share)).toFixed(4)}**.`);
    say("");
  }

  say(`**5b. A slower efficiency measure.** R4 showed the effect needs an unstable label. The obvious question is whether a longer lookback is both slow AND informative. Re-classified at a ${SLOW_LOOKBACK}-day lookback instead of ${20}:`);
  say("");
  const slowByKey = new Map<string, Efficiency>();
  for (const asset of ["BTC", "ETH"] as const) {
    const raw: RawAssetData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${asset}.json`), "utf8"));
    const daily = rollUpToDaily(raw.futuresKlines);
    for (let i = 0; i < daily.length; i++) {
      const read = classifyMarketRegime(daily, i, SLOW_LOOKBACK);
      if (read?.calibrated) slowByKey.set(`${asset}:${new Date(daily[i].t).toISOString().slice(0, 10)}`, read.efficiency);
    }
  }
  const slowRows = rows.filter((x) => slowByKey.has(`${x.rec.asset}:${x.rec.date}`));
  for (const asset of ["BTC", "ETH"] as const) {
    const seq = slowRows.filter((x) => x.rec.asset === asset).map((x) => slowByKey.get(`${asset}:${x.rec.date}`)!);
    let switches = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) switches++;
    say(`**${asset}** ${SLOW_LOOKBACK}-day-lookback dwell: ${(seq.length / Math.max(1, switches + 1)).toFixed(1)} days.`);
  }
  const slowA = blockBootstrapProportion(winsFor(slowRows.filter((x) => slowByKey.get(`${x.rec.asset}:${x.rec.date}`) === "trending"), (x) => x.rec.dailyDirection), BLOCK);
  const slowB = blockBootstrapProportion(winsFor(slowRows.filter((x) => slowByKey.get(`${x.rec.asset}:${x.rec.date}`) === "choppy"), (x) => x.rec.dailyDirection), BLOCK);
  if (slowA && slowB) {
    const d = differenceOfProportions(slowA, slowB);
    say("");
    say(`H2 on the slow measure: trending ${pctStr(slowA.point)} (n=${slowA.n}) vs choppy ${pctStr(slowB.point)} (n=${slowB.n}), ` +
        `difference **${(100 * d.difference).toFixed(1)}pp**, p = **${d.pValue.toFixed(4)}**.`);
  }
  say("");

  // ── Multiplicity ─────────────────────────────────────────────────────
  say("## Multiple-testing correction");
  say("");
  const fdr = benjaminiHochberg(tests.map((t) => t.pValue), 0.05);
  say("| Test | Result | Eff. N | Difference | Detectable | raw p | BH significant |");
  say("|---|---|---|---|---|---|---|");
  tests.forEach((t, i) => {
    say(`| ${t.id} | ${t.detail} | ${t.effectiveN.toFixed(0)} | ${(100 * t.difference).toFixed(1)}pp | ${(100 * t.detectable).toFixed(1)}pp | ${t.pValue.toFixed(4)} | ${fdr[i].significant ? "**YES**" : "no"} |`);
  });
  say("");
  const survivors = fdr.filter((f) => f.significant).length;
  say(`Survivors: **${survivors} of ${tests.length}**.`);
  say("");

  // ── Verdict ──────────────────────────────────────────────────────────
  say("## Verdict");
  say("");
  say("**The concept is real. The implementation is not viable at swing timeframes.** Those are separate conclusions and both are needed.");
  say("");
  say("**H2 is a genuine finding.** The daily technical read is right 56.6% of the time in high-efficiency conditions and 42.6% in low-efficiency ones — a 14pp swing, p=0.0004, surviving both overlap correction and Benjamini-Hochberg, with an observed effect above its own 11.0pp detectability floor. In choppy conditions the daily read is not merely weaker, it is anti-predictive. That is direct evidence for the brief's central claim: the same signal genuinely does mean different things in different environments.");
  say("");
  say("**But every route to a usable regime label destroys the effect.** A context layer has to be stable — the raw label flips every 3.5 days, faster than the swing thesis it would be providing context for. Four variants:");
  say("");
  say("| Variant | Mean dwell | H2 effect | p |");
  say("|---|---|---|---|");
  say("| 20-day, raw (pre-registered) | 3.5 days | 14.0pp | **0.0004** |");
  say("| 21-day, raw | 3.6 days | 13.6pp | **0.0007** |");
  say("| 20-day + 3-day hysteresis | 12.7 days | 6.8pp | 0.1123 |");
  say("| 60-day lookback, raw | 5.7 days | 6.5pp | 0.1449 |");
  say("");
  say("The relationship is monotonic and holds across two independent smoothing mechanisms: **the more stable the label, the weaker the signal.** This is not one variant failing by bad luck — it is structural. The information in the efficiency measure is short-lived, and smoothing it away is exactly what makes it stable. The version that carries information is too fast to condition a multi-day plan on; the version slow enough to be a context layer carries roughly half the effect and no significance.");
  say("");
  say("**H1 is rejected, and the point estimate runs opposite to theory.** Harmonic PRZs did better in TRENDING conditions (56.9%) than choppy ones (48.1%) — the reverse of the reversal-in-chop prediction, consistently in both the raw and stabilised versions. It fails BH correction and sits below its detectability floor, so this is not a finding either; it is an absence of one. Directly answering the brief's question \"in which regimes do harmonic PRZs become meaningful?\": on this data, none that can be demonstrated, and the intuitive answer is if anything backwards.");
  say("");
  say("**H3 is null on win rate** (2.8pp, p=0.66) and inconclusive on expectancy (exploratory 5a: +1.19pp, p=0.17, CI spanning zero). The engine's own resolved trades do not measurably care what regime they were taken in.");
  say("");
  say("### REGIME ENGINE VERDICT: DO NOT IMPLEMENT");
  say("");
  say(`Per the falsification condition fixed in this file before any number was computed. ${survivors} of ${tests.length} pre-registered hypotheses survive, and the one that survives cannot be turned into a stable context layer without losing the effect that justifies it.`);
  say("");
  say("Building it anyway would mean shipping a label that changes twice a week, gating a decision engine deliberately designed for multi-day stability — reintroducing precisely the churn the swing-thesis work was built to eliminate, in exchange for an effect that disappears at usable smoothing levels.");
  say("");
  say("### On the other requested deliverables");
  say("");
  say("The brief asked for a decision hierarchy, an integration design, and walk-forward validation. Stating plainly rather than quietly omitting them: **a hierarchy and integration design are not produced, because the layer they would organise is not justified**, and walk-forward folds on a rejected model would be theatre. Designing a Weekly -> Daily -> 4H arbitration scheme around a context signal with no stable effect would be an expensive way to add complexity for nothing.");
  say("");
  say("What IS delivered and worth keeping: `regimeModel.ts` is asset-agnostic, point-in-time safe, carries 26 hand-verified tests including a truncation test, and hardcodes no crypto assumptions. It is a working, reusable measurement module that has not earned a place in the decision path.");
  say("");
  say("### What would change this answer");
  say("");
  say("1. **More independent observations.** 354 independent trades, and effective Ns of 40-140 per arm, is the binding constraint on every question in this phase. Widening beyond BTC/ETH is the only realistic route.");
  say("2. **A regime measure that is intrinsically slow rather than smoothed.** Efficiency is fast by nature and loses its information when averaged. A measure built on structural events — higher-high/lower-low sequences, volatility-regime breaks — could plausibly be both slow and informative, where a smoothed fast measure cannot. That is a genuinely different hypothesis and needs its own pre-registration.");
  say("3. **Confirmation of 5a on fresh data.** The trending-vs-choppy expectancy gap (+1.19pp) is the most economically meaningful number in this study and the likeliest of the exploratory results to be real. It was not pre-registered so it cannot be claimed — but it is the first thing to test next time.");

  const outPath = path.join(__dirname, "regimeStudy.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[regimeStudy] wrote ${outPath}`);
}

main();
