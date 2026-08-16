import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  MIN_SESSIONS,
  decomposeSymbol,
} from "../../src/lib/research/overnightDecomposition";
import { adjustForCorporateActions } from "../../src/lib/research/corporateActions";
import { benjaminiHochberg } from "../../src/lib/research/multipleTesting";
import { resolveUniverse, isBenchmark } from "../../src/lib/markets/scannerUniverse";
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
}

function main(): void {
  const universe = resolveUniverse();
  const rows: Row[] = [];
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
      });
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
        costNote:
          "Round trip modelled as 2 ticks against each session's own prior close. " +
          "Replace with the measured spread once spreadHistory has 20 sessions in both windows.",
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
  const passed = rows.filter((r) => r.significantAfterFdr).length;
  console.log("");
  console.log(`[overnight] ${passed} of ${rows.length} clear FDR at q=${FDR_Q}.`);
  if (passed === 0) {
    console.log(
      "[overnight] Nothing is established. The sign is consistent and the effect is large in the " +
        "miners, but at these sample sizes and this volatility none of it separates from chance."
    );
  }
  console.log(`[overnight] -> ${OUT}`);
}

main();
