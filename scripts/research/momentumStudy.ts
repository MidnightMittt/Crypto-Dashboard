import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assessEdge } from "../../src/lib/research/edgeGate";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";

/**
 * CROSS-SECTIONAL 12-1 MOMENTUM — the first equity Edge candidate.
 *
 * Every module that currently votes is a crypto module. Every equity module
 * is State, so the equity dossier cannot forecast at all — it describes
 * conditions. This is an attempt to change that, run through the roadmap's
 * own validation factory rather than shipped on reputation.
 *
 * ── The hypothesis, declared before the measurement ───────────────────
 *
 * H: Ranked cross-sectionally, US equities with the highest trailing 12-month
 *    return EXCLUDING the most recent month go on to outperform the lowest-
 *    ranked over the following month.
 *
 * Direction: long top decile, short bottom decile. Predicted spread > 0.
 * Horizon: 21 sessions. Rebalance: every 21 sessions, non-overlapping.
 *
 * WHY THE SKIPPED MONTH. Jegadeesh-Titman's construction, and it is not
 * cosmetic: the most recent month carries short-horizon REVERSAL, which
 * points the opposite way and partially cancels the momentum effect. A
 * 12-month window including it measures two anomalies fighting and reports
 * the residue. Declared here so it cannot be tuned later.
 *
 * KILL CRITERIA, also declared now: this ships as Edge only if the Wilson
 * lower bound on the spread's win rate clears 50% plus costs, AND it survives
 * FDR across every variant tested here. If it fails, it ships as a published
 * negative result and the equity engine stays honest about having no Edge.
 *
 * ── Why this panel rather than more crypto ────────────────────────────
 *
 * BTC and ETH move together at rho around 0.82, so adding crypto assets buys
 * almost no independent evidence — the binding constraint is correlation and
 * history, not instrument count. This panel is 139 names with a median 7,186
 * daily bars each, spanning 1980-2026. That is the first dataset here with
 * enough independent variation to detect an effect this size.
 *
 * ── Point-in-time discipline ──────────────────────────────────────────
 *
 * At each decision date the ranking uses ONLY closes at or before that date,
 * and the forward return is measured strictly after it. Instruments are
 * required to have the full 252-session lookback, so a name that listed
 * recently is absent from early ranks rather than silently ranked on a short
 * window. Survivorship is NOT corrected — see the caveat printed at the end.
 *
 *   npx tsx scripts/research/momentumStudy.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");

/** Trailing window, in sessions, over which momentum is measured. */
const LOOKBACK = 252;
/** Sessions skipped at the near end — the reversal window. See header. */
const SKIP = 21;
/** Holding period and rebalance interval. Equal, so periods never overlap. */
const HOLD = 21;
/** Fraction of the ranked panel taken at each end. */
const DECILE = 0.1;
/** Minimum names required to form a rank at all. */
const MIN_PANEL = 40;
/**
 * Round-trip costs charged to the spread, in percentage points of win rate.
 * A long-short monthly rebalance pays spread on four legs; 2pp is the same
 * conservative figure the crypto gate uses, kept identical so the two
 * verdicts mean the same thing.
 */
const COST_PP = 2;

interface Series {
  symbol: string;
  t: number[];
  close: number[];
}

function load(): Series[] {
  const out: Series[] = [];
  for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as {
      bars?: Array<{ t: number; close: number }>;
    };
    const bars = (raw.bars ?? []).filter((b) => Number.isFinite(b.close) && b.close > 0);
    if (bars.length < LOOKBACK + HOLD + 5) continue;
    out.push({
      symbol: f.split(".")[0],
      t: bars.map((b) => b.t),
      close: bars.map((b) => b.close),
    });
  }
  return out;
}

/** Index of the last bar at or before `time`, or -1. Binary search. */
function indexAsOf(t: number[], time: number): number {
  let lo = 0;
  let hi = t.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

interface PeriodResult {
  date: string;
  panel: number;
  topRet: number;
  bottomRet: number;
  spread: number;
  panelMean: number;
}

function run(series: Series[], lookback: number, skip: number): PeriodResult[] {
  // The calendar is the union of every instrument's dates, ascending.
  const all = [...new Set(series.flatMap((s) => s.t))].sort((a, b) => a - b);
  const results: PeriodResult[] = [];

  for (let i = lookback + skip; i + HOLD < all.length; i += HOLD) {
    const decisionTime = all[i];
    const exitTime = all[i + HOLD];

    const ranked: Array<{ symbol: string; mom: number; fwd: number }> = [];
    for (const s of series) {
      const now = indexAsOf(s.t, decisionTime);
      if (now < lookback + skip) continue;

      // Point-in-time: both legs are at or before the decision date.
      const past = s.close[now - lookback];
      const recent = s.close[now - skip];
      if (!(past > 0) || !(recent > 0)) continue;

      const exit = indexAsOf(s.t, exitTime);
      // The exit bar must genuinely exist after the decision, not be a
      // repeat of it — a delisted name must drop out, not report a 0% month.
      if (exit <= now) continue;

      ranked.push({
        symbol: s.symbol,
        mom: recent / past - 1,
        fwd: s.close[exit] / s.close[now] - 1,
      });
    }

    if (ranked.length < MIN_PANEL) continue;
    ranked.sort((a, b) => b.mom - a.mom);
    const k = Math.max(1, Math.floor(ranked.length * DECILE));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const topRet = mean(ranked.slice(0, k).map((r) => r.fwd));
    const bottomRet = mean(ranked.slice(-k).map((r) => r.fwd));
    results.push({
      date: new Date(decisionTime).toISOString().slice(0, 10),
      panel: ranked.length,
      topRet,
      bottomRet,
      spread: topRet - bottomRet,
      panelMean: mean(ranked.map((r) => r.fwd)),
    });
  }
  return results;
}

function summarise(label: string, rs: PeriodResult[]) {
  const n = rs.length;
  const wins = rs.filter((r) => r.spread > 0).length;
  const winRate = n > 0 ? wins / n : 0;
  const meanSpread = n > 0 ? rs.reduce((a, r) => a + r.spread, 0) / n : 0;

  /*
   * THE NULL IS 50%, and here that is correct rather than lazy. A long-short
   * spread is dollar-neutral: it does not inherit the market's drift the way
   * a long-only read does, so "beat a coin flip" is the honest bar. The
   * long-only leg below is judged against the panel's own mean instead.
   */
  const a = assessEdge(
    { winRate, baseRate: 0.5, effectiveN: n, holdingPeriod: `${HOLD}d` },
    COST_PP
  );

  const longOnlyWins = rs.filter((r) => r.topRet > r.panelMean).length;
  const longOnlyRate = n > 0 ? longOnlyWins / n : 0;

  console.log(
    `${label.padEnd(22)} n=${String(n).padStart(4)}  win=${(winRate * 100).toFixed(1)}%  ` +
      `LB=${a.lowerBound === null ? "--" : (a.lowerBound * 100).toFixed(1) + "%"}  ` +
      `meanSpread=${(meanSpread * 100).toFixed(2)}%  ` +
      `topVsPanel=${(longOnlyRate * 100).toFixed(1)}%  ${a.verdict}`
  );
  return { n, winRate, assessment: a, meanSpread };
}

function main(): void {
  const series = load();
  console.log(
    `Cross-sectional momentum — ${series.length} instruments, ` +
      `costs ${COST_PP}pp, ${HOLD}-session non-overlapping periods\n`
  );

  /*
   * VARIANTS ARE A FAMILY, and are corrected as one. Reporting only the
   * best of these would be the multiple-comparison the gate exists to catch;
   * the alternatives exist to show the result is not an artefact of one
   * arbitrary window, not to be shopped.
   */
  const variants: Array<{ label: string; lookback: number; skip: number }> = [
    { label: "12-1 (declared)", lookback: 252, skip: 21 },
    { label: "12-0 (no skip)", lookback: 252, skip: 1 },
    { label: "6-1", lookback: 126, skip: 21 },
    { label: "3-1", lookback: 63, skip: 21 },
  ];

  const rows = variants.map((v) => {
    const rs = run(series, v.lookback, v.skip);
    return { ...v, ...summarise(v.label, rs) };
  });

  /*
   * Two-sided sign-test p-value against a fair coin, normal approximation.
   * n here is in the hundreds, where the approximation is sound.
   */
  const pvals = rows.map((r) => {
    if (r.n === 0) return 1;
    const z = Math.abs(r.winRate - 0.5) / Math.sqrt(0.25 / r.n);
    return 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2)));
  });
  const fdr = benjaminiHochberg(pvals, 0.05);

  console.log(`\n${"─".repeat(72)}`);
  console.log(`FDR across ${rows.length} variants, q = 0.05`);
  rows.forEach((r, i) => {
    console.log(
      `  ${r.label.padEnd(22)} p=${pvals[i].toExponential(2).padStart(9)}  ` +
        `${fdr[i]?.significant ? "survives" : "does not survive"}`
    );
  });

  const declared = rows[0];
  const declaredSurvives = fdr[0]?.significant ?? false;
  const earns = declared.assessment.verdict === "edge" && declaredSurvives;

  console.log(`\n${"─".repeat(72)}`);
  console.log(`VERDICT on the declared 12-1 variant: ${earns ? "EARNS EDGE" : "DOES NOT EARN EDGE"}`);
  console.log(`  ${declared.assessment.sentence}`);
  console.log(
    `\nCaveats that bound this result:\n` +
      `  - SURVIVORSHIP. The panel is today's instrument list, so names that\n` +
      `    failed are absent. That biases a long-the-winners result UPWARD,\n` +
      `    i.e. against the honest direction. Treat the spread as a ceiling.\n` +
      `  - Equal-weighted deciles, no liquidity or price filter, so the\n` +
      `    bottom decile includes names that would be expensive to short.\n` +
      `  - Costs are charged as a flat ${COST_PP}pp of win rate, not modelled\n` +
      `    per leg. A real long-short book pays more.`
  );
}

/** Abramowitz-Stegun 7.1.26. Max error 1.5e-7, ample for a p-value here. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

main();
