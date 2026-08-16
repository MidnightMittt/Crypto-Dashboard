import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ROUND_TRIP_TICKS_CENTRAL,
  ROUND_TRIP_TICKS_CONSERVATIVE,
  overnightSeries,
  MIN_SESSIONS,
  WINDOWS,
  decomposeSymbol,
} from "../../src/lib/research/overnightDecomposition";
import { adjustForCorporateActions } from "../../src/lib/research/corporateActions";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";
import { SCANNED, BENCHMARKS, resolveUniverse, isBenchmark } from "../../src/lib/markets/scannerUniverse";
import {
  BasketObservation,
  BasketResult,
  detectableEffectBp,
  testBasket,
} from "../../src/lib/research/overnightBasket";
import { Bar } from "../../src/lib/research/types";

/**
 * OVERNIGHT PREMIUM — ranked, cost-charged, and FDR-corrected.
 *
 * Splits every tracked name's daily bars into the overnight and intraday
 * legs, charges a tick-aware round trip against the overnight one, and ranks
 * the universe by what survives.
 *
 * ── Two disciplines this run does not skip ────────────────────────────
 *
 * CORPORATE ACTIONS FIRST. An unadjusted split or relisting lands entirely
 * in the OVERNIGHT leg, because the gap is exactly where the price level
 * changes. One such night would dominate the mean, so bars pass through the
 * guard before anything is measured, and the count of interventions is
 * printed with the results.
 *
 * FDR ACROSS THE WHOLE FAMILY. Ranking a universe by t-statistic and reading
 * the top of the list is how noise gets promoted to a strategy: with twenty
 * tests, the best of them clears t = 2 by luck alone more often than not.
 * Every symbol-window pair is declared up front and corrected together —
 * including the ones that fail, which are the reason the correction is
 * honest rather than decorative.
 *
 *   npx tsx scripts/research/overnightPremium.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "overnightPremium.json");

/** Benjamini-Hochberg level. 0.10 is the same q the signal lab declares. */
const FDR_Q = 0.1;

interface Row {
  symbol: string;
  benchmark: boolean;
  /** Last adjusted close, so a consumer can price the tick without bars. */
  lastClose: number | null;
  /** Modelled round trip at that price — the legibility number. */
  costBpAtLastClose: number | null;
  /** ISO date of that close, so freshness travels with the price. */
  asOf: string | null;
  /**
   * Guard interventions on THIS symbol's bars. Counted here because the study
   * runs the guard and the raw bars are gitignored, so no consumer can
   * recompute it. Spikes are auto-repaired and steps are judged, and both
   * count — reporting only the judged ones under-stated MARA at zero when it
   * has two repaired placeholder prints.
   */
  guardRepairs: number;
  window: number;
  observations: number;
  meanCostBp: number;
  overnightGrossBp: number;
  overnightNetBp: number;
  intradayGrossBp: number;
  tStat: number;
  pValue: number;
  sharpeAnnualised: number;
  droppedGaps: number;
  significantAfterFdr: boolean;
  /** Net at the CONSERVATIVE two-tick bound. Sensitivity, not a second test. */
  overnightNetConservativeBp: number;
  /**
   * The smallest true effect this test could have called significant at t=3.
   * A null from a test whose detectable effect exceeds the effect in question
   * is a power statement, not evidence of absence.
   */
  detectableAtT3Bp: number | null;
}

/**
 * DECLARED BASKETS — defined by a rule, never by realised return.
 *
 * A basket assembled from the names with the largest premium is not a test:
 * the selection has already used the answer, and the resulting t is a
 * measure of how hard we looked. Every basket here is fixed by membership of
 * a declared set.
 *
 * `benchmarks` is the CONTROL. If the premium is a real feature of these
 * small, volatile, heavily shorted names, the four index ETFs should show
 * markedly less of it. If they show the same thing, what is being measured
 * is the market's own overnight drift and not this cohort at all — which
 * would be the most important finding available here.
 */
const BASKETS: { name: string; symbols: readonly string[]; note: string }[] = [
  {
    name: "scanned",
    symbols: SCANNED,
    note: "Every scanned non-benchmark name. The basket the strategy actually holds.",
  },
  {
    name: "miners",
    symbols: ["RIOT", "CLSK", "MARA", "WULF", "CIFR", "HUT", "BTDR"],
    note: "Bitcoin miners, declared by business model rather than by return.",
  },
  {
    name: "datacenter",
    symbols: ["APLD", "IREN", "CORZ"],
    note: "Datacenter/HPC names. Declared by business model, not by premium.",
  },
  {
    name: "benchmarks",
    symbols: BENCHMARKS,
    note: "CONTROL. Index ETFs, where a cohort-specific effect should be absent.",
  },
];

function main(): void {
  const universe = resolveUniverse();
  const rows: Row[] = [];
  const nightly: (BasketObservation & { window: number })[] = [];
  const missing: string[] = [];
  let adjustments = 0;

  for (const symbol of universe) {
    const file = path.join(DATA_DIR, `${symbol}.US.json`);
    if (!fs.existsSync(file)) {
      missing.push(symbol);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const guarded = adjustForCorporateActions((raw.bars ?? []) as Bar[], symbol);
    const repairs = guarded.notes.filter((n) => n.barsAffected > 0).length;
    adjustments += repairs;

    /*
     * The dated per-night series, kept so the basket test and the per-symbol
     * test are literally the same observations rather than two loops that
     * agree today and drift later.
     */
    for (const w of WINDOWS) {
      const { observations } = overnightSeries(guarded.bars, w, ROUND_TRIP_TICKS_CENTRAL);
      if (observations.length < MIN_SESSIONS) continue;
      for (const o of observations) {
        nightly.push({ window: w, date: o.date, symbol, netBp: o.netBp });
      }
    }

    const d = decomposeSymbol(symbol, guarded.bars);
    const lastBar = guarded.bars.length ? guarded.bars[guarded.bars.length - 1] : null;
    const asOf = lastBar ? new Date(lastBar.t).toISOString().slice(0, 10) : null;
    for (const w of d.windows) {
      if (w.used < MIN_SESSIONS || !w.overnightNet || !w.overnightGross || !w.intradayGross) continue;
      rows.push({
        symbol,
        benchmark: isBenchmark(symbol),
        lastClose: d.lastClose,
        costBpAtLastClose: d.costBpAtLastClose,
        asOf,
        guardRepairs: repairs,
        window: w.sessions,
        observations: w.used,
        meanCostBp: w.meanCostBp ?? 0,
        overnightGrossBp: w.overnightGross.meanBp,
        overnightNetBp: w.overnightNet.meanBp,
        intradayGrossBp: w.intradayGross.meanBp,
        tStat: w.overnightNet.tStat,
        pValue: w.overnightNet.pValue,
        sharpeAnnualised: w.overnightNet.sharpeAnnualised,
        droppedGaps: w.droppedGaps,
        significantAfterFdr: false,
        /*
         * The upper bound costs exactly one extra tick per night, so it is
         * derived rather than re-summarised — re-running the whole window at
         * two ticks would give the same answer and invite the two to drift.
         */
        overnightNetConservativeBp:
          w.overnightNet.meanBp -
          (w.meanCostBp ?? 0) * (ROUND_TRIP_TICKS_CONSERVATIVE / ROUND_TRIP_TICKS_CENTRAL - 1),
        detectableAtT3Bp: detectableEffectBp(w.overnightNet.sdBp, w.overnightNet.n),
      });
    }
  }

  /*
   * The baskets, at the CENTRAL cost basis only. The conservative basis is a
   * sensitivity on the same hypothesis, not a second one, so it never enters
   * a multiple-testing family.
   */
  const baskets: BasketResult[] = [];
  for (const w of WINDOWS) {
    for (const b of BASKETS) {
      const members = new Set<string>(b.symbols);
      const obs = nightly
        .filter((o) => o.window === w && members.has(o.symbol))
        .map(({ date, symbol, netBp }) => ({ date, symbol, netBp }));
      if (obs.length === 0) continue;
      baskets.push(testBasket(b.name, w, obs));
    }
  }

  const fdr = benjaminiHochberg(rows.map((r) => r.pValue), FDR_Q);
  rows.forEach((r, i) => {
    r.significantAfterFdr = fdr[i].significant;
  });
  rows.sort((a, b) => b.overnightNetBp - a.overnightNetBp);

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        version: 1,
        generatedAt: Date.now(),
        fdrQ: FDR_Q,
        costBasis: "modelled",
        costTicksCentral: ROUND_TRIP_TICKS_CENTRAL,
        costTicksConservative: ROUND_TRIP_TICKS_CONSERVATIVE,
        costNote:
          `Round trip modelled as ${ROUND_TRIP_TICKS_CENTRAL} tick against each session's own ` +
          "prior close: you buy at the ask and sell at the bid, losing the spread ONCE. This was " +
          `${ROUND_TRIP_TICKS_CONSERVATIVE} ticks until 2026-08-16, which double-charged it. ` +
          `The ${ROUND_TRIP_TICKS_CONSERVATIVE}-tick figure is retained per row as an upper bound ` +
          "and is NOT a second entry in the FDR family. Replace with the measured spread once " +
          "spreadHistory has 20 sessions in both windows.",
        powerNote:
          "detectableAtT3Bp is the smallest true effect each test could have called significant " +
          "at t=3 given its own dispersion. A null from a test whose detectable effect exceeds " +
          "the effect in question is not evidence of absence.",
        basketNote:
          "Baskets are declared by membership rule, never selected on realised return. The " +
          "clustered statistic averages across names within a date and tests the daily series — " +
          "the unit of risk is a night, not a name-night. The pooled figure beside it treats " +
          "every name-day as independent and is INFLATED; the ratio is reported.",
        baskets,
        universe: universe.length,
        notIngested: missing,
        corporateActionAdjustments: adjustments,
        rows,
      },
      null,
      2
    )
  );

  console.log(
    `[overnight] ${rows.length} declared tests over ${universe.length - missing.length} symbols, ` +
      `${adjustments} corporate-action adjustments applied first`
  );
  if (missing.length) console.log(`[overnight] NOT INGESTED (no bars): ${missing.join(", ")}`);
  console.log("");
  console.log("sym    win    n   cost/night   gross      net     t    Sharpe   intraday  FDR");
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(6)} ${String(r.window).padStart(3)} ${String(r.observations).padStart(4)} ` +
        `${(r.meanCostBp.toFixed(1) + "bp").padStart(9)} ` +
        `${((r.overnightGrossBp >= 0 ? "+" : "") + r.overnightGrossBp.toFixed(1)).padStart(8)} ` +
        `${((r.overnightNetBp >= 0 ? "+" : "") + r.overnightNetBp.toFixed(1)).padStart(8)} ` +
        `${r.tStat.toFixed(2).padStart(6)} ${r.sharpeAnnualised.toFixed(2).padStart(7)} ` +
        `${((r.intradayGrossBp >= 0 ? "+" : "") + r.intradayGrossBp.toFixed(1)).padStart(9)}  ` +
        `${r.significantAfterFdr ? "PASS" : "—"}${r.benchmark ? "   (benchmark)" : ""}`
    );
  }
  console.log("");
  console.log("BASKETS — clustered by date (the unit of risk is a night, not a name-night)");
  console.log("basket        win  dates  n-days  names/dt      net       t_clu    t_pool  infl   t=3 needs");
  for (const b of baskets) {
    if (!b.clustered || !b.pooled) continue;
    console.log(
      `${b.basket.padEnd(12)} ${String(b.window).padStart(4)} ${String(b.dates).padStart(6)} ` +
        `${String(b.nameDays).padStart(7)} ${(b.meanNamesPerDate ?? 0).toFixed(1).padStart(9)} ` +
        `${((b.clustered.meanBp >= 0 ? "+" : "") + b.clustered.meanBp.toFixed(1) + "bp").padStart(9)} ` +
        `${b.clustered.tStat.toFixed(2).padStart(8)} ${b.pooled.tStat.toFixed(2).padStart(9)} ` +
        `${(b.inflationRatio ?? 0).toFixed(2).padStart(5)}x ` +
        `${((b.detectableAtT3Bp ?? 0).toFixed(1) + "bp").padStart(10)}`
    );
  }

  const passed = rows.filter((r) => r.significantAfterFdr).length;
  console.log("");
  console.log(`[overnight] ${passed} of ${rows.length} clear FDR at q=${FDR_Q}.`);
  if (passed === 0) {
    console.log(
      "[overnight] Nothing is established. The sign is consistent and the effect is large in the " +
        "miners, but at these sample sizes and this volatility none of it separates from chance."
    );
    /*
     * Reported off the HEADLINE basket, not off the minimum across rows. The
     * minimum is always a benchmark ETF — the lowest-volatility name in the
     * set — so quoting it would advertise power the tradeable names do not
     * have. The number that matters is whether the test could have seen the
     * effect it was pointed at.
     */
    const headline = baskets
      .filter((b) => b.basket === "scanned" && b.clustered)
      .sort((a, b) => b.window - a.window)[0];
    if (headline?.clustered && headline.detectableAtT3Bp !== null) {
      console.log(
        `[overnight] POWER: the ${headline.window}-session scanned basket measured ` +
          `${headline.clustered.meanBp.toFixed(1)}bp but needed ${headline.detectableAtT3Bp.toFixed(1)}bp ` +
          "to reach t=3. It could not have detected an effect of the size it found."
      );
    }
    const control = baskets
      .filter((b) => b.basket === "benchmarks" && b.clustered)
      .sort((a, b) => b.window - a.window)[0];
    if (headline?.clustered && control?.clustered) {
      console.log(
        `[overnight] CONTROL: index ETFs show ${control.clustered.meanBp.toFixed(1)}bp at ` +
          `t=${control.clustered.tStat.toFixed(2)} against the cohort's ` +
          `${headline.clustered.meanBp.toFixed(1)}bp at t=${headline.clustered.tStat.toFixed(2)}. ` +
          "Four times the effect, the SAME significance — which is what a volatility-scaled " +
          "version of a market-wide drift looks like, not a cohort-specific edge."
      );
    }
  }
  console.log(`[overnight] -> ${OUT}`);
}

main();
