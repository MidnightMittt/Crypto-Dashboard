import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";
import { Bar } from "../../src/lib/research/types";
import {
  Phi,
  TRAILING_VOL_SESSIONS,
  pTouchDown,
  pTouchUp,
  sigmaOfLogReturns,
} from "../../src/lib/research/gbmTouch";

/**
 * C3 — DOES THE SYMMETRIC (VOLATILITY) COMPONENT CLEAR ITS NOISE FLOOR
 * ANYWHERE ON A (HORIZON, BARRIER) GRID?
 *
 * The trading session measured reach-vs-implied at ONE cell (21 sessions,
 * ±10%) across 36 live chains and found: 86% of the variance is drift, the
 * symmetric component is a dead null (median -0.01pp), and every symbol sits
 * inside one standard error of zero at independent_n≈13. The open question
 * is whether that null is LOCAL to that cell or GENERAL.
 *
 * ── Why this study can answer it and a live-chain sweep cannot ────────
 *
 * A chain-based grid inherits independent_n≈13 in every cell — the
 * instrument cannot resolve a 5pp effect, so 16 more nulls would mean
 * nothing. The fix is to split the quantity being tested:
 *
 *   symmetric = [ measured_touch − GBM_touch(σ_realised) ]     PATH SHAPE
 *             + [ GBM_touch(σ_realised) − GBM_touch(σ_IV) ]    VOL PREMIUM
 *
 * PATH SHAPE asks: given the RIGHT volatility, is the reflection-principle
 * conversion from vol to touch probability biased? That needs no options
 * data, so it runs on the declared panel over 32 years with date-blocked
 * statistics — hundreds of independent periods per cell instead of 13.
 *
 * VOL PREMIUM asks: is implied vol itself mispriced? That needs live chains
 * and is exactly what the trading session measured (and refused).
 *
 * The split matters because PATH SHAPE is the term that contaminates
 * EVERY reach-vs-implied comparison this site makes, including the correct
 * per-contract one in /api/pretrade/check: if GBM systematically misprices
 * touch given correct vol, then converting a premium's IV into a touch
 * probability is biased before any mispricing question is asked.
 *
 * ── Design, declared before running ──────────────────────────────────
 *
 *  - Panel: declared EQUITY_PANEL only.
 *  - Grid: horizon 5/10/21/42 sessions x barrier 5/10/20/30 percent.
 *  - Entries: stride = horizon, so windows never overlap.
 *  - Statistic: per DATE, mean over names of (outcome − predicted); then a
 *    t-statistic over the time series of dates. Names are cross-correlated
 *    within a date (rho ~ 0.8 on this panel), so the date is the honest
 *    unit — never the (name, date) pair.
 *  - Two volatility inputs, both reported:
 *      TRAILING  sigma from the 60 sessions BEFORE entry. Knowable at
 *                entry; the honest analogue of what an IV quote is (a
 *                forecast), so this is the primary.
 *      IN-WINDOW sigma realised over the window itself. Not knowable at
 *                entry; isolates pure path shape from forecast error.
 *  - Barriers in LOG space, correctly asymmetric: b_up = ln(1+m) but
 *    b_down = -ln(1-m), which is the larger number. Using b_up for both
 *    (as the reproduction script does) makes the down barrier look nearer
 *    than it is.
 *  - Drift: mu = -sigma^2/2 (zero expected simple return, the option-pricing
 *    convention). For the DOWN side the reflection X -> -X flips the sign
 *    of mu; reusing the up-side formula understates down-touch, and at the
 *    volatilities this book actually trades (0.8-1.6) that error reaches
 *    3.5-6.6pp.
 *  - Power: every cell prints the minimum detectable effect at t=2 given
 *    its own realised block count. A cell whose MDE exceeds the effect
 *    sought prints that fact instead of a number (C4).
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "touchCalibration.json");

const HORIZONS = [5, 10, 21, 42];
const BARRIERS = [5, 10, 20, 30];
/** The effect worth finding: a volatility edge smaller than this is not tradeable after costs. */
const EFFECT_SOUGHT_PP = 5;

/*
 * ── SIGMA-BAND CONDITIONING, declared 2026-09-14 BEFORE the first run ──
 *
 * The pooled grid's stated weakness: the panel is thickest at sigma
 * 0.2-0.5 while every name the account trades prints trailing sigma
 * 0.8-1.25 (CLSK 0.88, WULF 0.82, RIOT 0.92, MARA 0.98, CIFR 1.06,
 * FRMI 1.09, PURR 1.25). The question is binary: does the conversion bias
 * hold, grow, or invert above sigma 0.8?
 *
 * Everything below was fixed before any banded outcome was computed. The
 * only thing examined first was OCCUPANCY — names per band per block,
 * which reveals feasibility and nothing about any bias direction (353 of
 * 840 ten-session blocks carry >=3 names above 0.8).
 *
 *  - Bands on TRAILING sigma at entry — the same estimate the GBM
 *    prediction consumes, knowable at entry. Banding on in-window sigma
 *    would condition on the outcome. Edges 0.5 and 0.8, giving
 *    <=0.5 / 0.5-0.8 / >0.8; membership is per (name, date), so a name
 *    moves bands as its own vol does.
 *  - A block contributes to a band when it has >= 3 names in that band.
 *    The block mean is unbiased at any occupancy and its extra noise
 *    flows into the block-series SD, where the SE over blocks charges it
 *    automatically; the floor only prevents a single name from
 *    masquerading as a cross-section. Occupancy is reported per cell.
 *  - Band series are drawn only from blocks the pooled grid accepted
 *    (>= 20 names total), so a band cell is always a slice of the
 *    published measurement, never a different sample.
 *  - PRIMARY: the 16 per-cell contrasts, high band MINUS low band,
 *    computed PAIRED on blocks where both bands clear the occupancy
 *    floor — the two bands share dates, and quadrature SEs on
 *    date-sharing subsets have already produced a fake t of -4.09 in
 *    this project (the paired bootstrap said -0.92). Holm at 0.05
 *    across the 16, family size fixed; a contrast without enough blocks
 *    enters at p = 1 rather than shrinking the family.
 *  - SECONDARY: the 16 high-band levels, own floors, own ar1 charge,
 *    Holm at 0.05, same p = 1 rule. Low and mid band levels are printed
 *    as context and carry no familywise claim.
 *  - A cell (band level or contrast) with fewer than 10 usable blocks
 *    reports its stats as null with the block count — "insufficient" is
 *    an answer, not a gap. Wherever the adjusted MDE exceeds the 5pp
 *    bar, the cell also reports how many blocks WOULD resolve it at the
 *    observed variance, so a data problem is distinguishable from a
 *    permanent one.
 *  - The 5pp economic bar and every other convention (barriers in log
 *    space, drift sign flip, ar1 charge) are inherited unchanged.
 */
const SIGMA_BAND_EDGES = [0.5, 0.8] as const;
const BAND_LABELS = ["<=0.5", "0.5-0.8", ">0.8"] as const;
const MIN_NAMES_PER_BAND_BLOCK = 3;
const MIN_BLOCKS_FOR_STATS = 10;

/*
 * The touch formulas and the sigma estimator live in src/lib/research/
 * gbmTouch.ts and are IMPORTED, not copied. This study measures the bias of
 * exactly the code production consumes; a local copy would let the two
 * drift and leave the artifact describing a formula nobody runs.
 */

interface Loaded { symbol: string; bars: Bar[]; byTime: Map<number, number>; logRet: number[] }

const loaded: Loaded[] = [];
for (const symbol of EQUITY_PANEL) {
  const f = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(f)) continue;
  const bars: Bar[] = (JSON.parse(fs.readFileSync(f, "utf8")).bars ?? []) as Bar[];
  if (bars.length < 400) continue;
  const logRet: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].close, b = bars[i].close;
    logRet.push(a > 0 && b > 0 ? Math.log(b / a) : 0);
  }
  loaded.push({ symbol, bars, byTime: new Map(bars.map((b, i) => [b.t, i])), logRet });
}

const spy = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "SPY.US.json"), "utf8")).bars as Bar[];
const grid = spy.map((b) => b.t);

const sigmaOf = sigmaOfLogReturns;

interface CellResult {
  horizon_sessions: number;
  barrier_pct: number;
  blocks: number;
  names_per_block: number;
  trailing: Stat;
  in_window: Stat;
  antisymmetric_trailing_pp: number;
  resolves: boolean;
  /** Family-wise verdict across all 16 cells. See the Holm block below. */
  family: { p: number; p_holm: number; clears: boolean };
}

interface BandCell {
  horizon_sessions: number;
  barrier_pct: number;
  band: string;
  /** Blocks clearing the occupancy floor for this band. */
  blocks: number;
  names_per_block: number | null;
  /** Null when blocks fall under MIN_BLOCKS_FOR_STATS — insufficient IS the answer. */
  trailing: Stat | null;
  in_window: Stat | null;
  antisymmetric_trailing_pp: number | null;
  resolves: boolean;
  insufficient: string | null;
  /** Blocks that WOULD resolve the 5pp bar at the observed variance. Null when it already does. */
  blocks_needed_for_bar: number | null;
  /** Present on the >0.8 band only — the declared secondary family. */
  family?: { p: number; p_holm: number; clears: boolean };
}

interface ContrastCell {
  horizon_sessions: number;
  barrier_pct: number;
  /** Blocks where BOTH the >0.8 and <=0.5 bands cleared the occupancy floor. */
  blocks: number;
  /** High minus low, paired per block. Null under MIN_BLOCKS_FOR_STATS. */
  stat: Stat | null;
  insufficient: string | null;
  blocks_needed_for_bar: number | null;
  /** The declared PRIMARY family: 16 contrasts, Holm at 0.05. */
  family: { p: number; p_holm: number; clears: boolean };
}
interface Stat {
  symmetric_pp: number;
  se_pp: number;
  t: number;
  mde_pp: number;
  /** Lag-1 autocorrelation of the block series. See below. */
  ar1: number;
  /** SE inflation applied for that autocorrelation; 1.00 when none was found. */
  ar1_inflation: number;
  /** MDE after the inflation. This is the figure to quote. */
  mde_pp_adjusted: number;
  /** t after the inflation. This is the figure that decides. */
  t_adjusted: number;
  /** Blocks divided by the variance inflation — how many the series is worth. */
  effective_blocks: number;
}

/**
 * BLOCK-TO-BLOCK SERIAL CORRELATION — the one thing the date-block design
 * does not absorb, measured rather than assumed.
 *
 * Taking the cross-sectional mean per date and a t over dates absorbs
 * arbitrary correlation BETWEEN NAMES within a date, however large, without
 * having to estimate it. That is why the panel's rho of ~0.8 does not touch
 * these MDEs. What it does not absorb is correlation between one block and
 * the next: if the model's calibration error persists across regimes, the
 * blocks are not independent draws either, and the SE is too small for the
 * same reason a naive cross-sectional SE would have been.
 *
 * The blocks are already non-overlapping by construction (the loop strides
 * by the horizon), so any autocorrelation here is genuine persistence rather
 * than a windowing artefact.
 *
 * For an AR(1) series the variance of the mean inflates by (1+r)/(1-r), so
 * the SE inflates by its square root. Negative autocorrelation would SHRINK
 * the SE, which is the flattering direction, so it is clamped at 1 — a
 * measurement is not licence to claim more precision than the naive estimate.
 */
function lag1(diffs: number[], mean: number): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i] - mean;
    den += d * d;
    if (i > 0) num += d * (diffs[i - 1] - mean);
  }
  return den > 0 ? num / den : 0;
}

function summarise(diffs: number[]): Stat {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const r = lag1(diffs, mean);
  const inflation = r > 0 && r < 1 ? Math.sqrt((1 + r) / (1 - r)) : 1;
  return {
    symmetric_pp: Number((mean * 100).toFixed(3)),
    se_pp: Number((se * 100).toFixed(3)),
    t: Number((mean / se).toFixed(2)),
    mde_pp: Number((2 * se * 100).toFixed(3)),
    ar1: Number(r.toFixed(3)),
    ar1_inflation: Number(inflation.toFixed(3)),
    mde_pp_adjusted: Number((2 * se * inflation * 100).toFixed(3)),
    t_adjusted: Number((mean / (se * inflation)).toFixed(2)),
    effective_blocks: Number((n / (inflation * inflation)).toFixed(1)),
  };
}

const cells: CellResult[] = [];
const bandCells: BandCell[] = [];
const contrastCells: ContrastCell[] = [];

for (const H of HORIZONS) {
  const T = H / 252;
  for (const MOVE of BARRIERS) {
    const bUp = Math.log(1 + MOVE / 100);
    const bDn = -Math.log(1 - MOVE / 100);

    const symTrail: number[] = [];
    const symWin: number[] = [];
    const antiTrail: number[] = [];
    let namesTotal = 0;

    // Band series: [band][block]. Contrast is high minus low, paired per block.
    const bandSymT: number[][] = [[], [], []];
    const bandSymW: number[][] = [[], [], []];
    const bandAnti: number[][] = [[], [], []];
    const bandNames = [0, 0, 0];
    const contrast: number[] = [];

    for (let g = TRAILING_VOL_SESSIONS; g + H < grid.length; g += H) {
      const t0 = grid[g];
      const dSymT: number[] = [], dSymW: number[] = [], dAntiT: number[] = [];
      const dBandT: number[][] = [[], [], []];
      const dBandW: number[][] = [[], [], []];
      const dBandA: number[][] = [[], [], []];

      for (const { bars, byTime, logRet } of loaded) {
        const i = byTime.get(t0);
        if (i === undefined || i < TRAILING_VOL_SESSIONS || i + H >= bars.length) continue;
        const entry = bars[i].close;
        if (!(entry > 0)) continue;

        const sTrail = sigmaOf(logRet, i - TRAILING_VOL_SESSIONS + 1, i + 1);
        const sWin = sigmaOf(logRet, i + 1, i + H + 1);
        if (sTrail === null || sWin === null) continue;

        // Outcomes: did the path touch either barrier within the window?
        const upLevel = entry * (1 + MOVE / 100);
        const dnLevel = entry * (1 - MOVE / 100);
        let yUp = 0, yDn = 0;
        for (let j = i + 1; j <= i + H; j++) {
          if (bars[j].high >= upLevel) yUp = 1;
          if (bars[j].low <= dnLevel && bars[j].low > 0) yDn = 1;
          if (yUp && yDn) break;
        }

        const errorsAt = (sig: number) => {
          const mu = -0.5 * sig * sig;
          const eUp = yUp - pTouchUp(bUp, sig, T, mu);
          const eDn = yDn - pTouchDown(bDn, sig, T, mu);
          return { sym: (eUp + eDn) / 2, anti: (eUp - eDn) / 2 };
        };
        const eT = errorsAt(sTrail);
        const eW = errorsAt(sWin);
        dSymT.push(eT.sym);
        dAntiT.push(eT.anti);
        dSymW.push(eW.sym);

        // Banded on TRAILING sigma — the entry-time estimate, per the
        // declaration. Same numbers as the pooled series, sliced.
        const band = sTrail <= SIGMA_BAND_EDGES[0] ? 0 : sTrail <= SIGMA_BAND_EDGES[1] ? 1 : 2;
        dBandT[band].push(eT.sym);
        dBandW[band].push(eW.sym);
        dBandA[band].push(eT.anti);
      }

      if (dSymT.length < 20) continue;
      namesTotal += dSymT.length;
      symTrail.push(dSymT.reduce((a, b) => a + b, 0) / dSymT.length);
      symWin.push(dSymW.reduce((a, b) => a + b, 0) / dSymW.length);
      antiTrail.push(dAntiT.reduce((a, b) => a + b, 0) / dAntiT.length);

      const bandMeans: (number | null)[] = [null, null, null];
      for (let k = 0; k < 3; k++) {
        if (dBandT[k].length < MIN_NAMES_PER_BAND_BLOCK) continue;
        bandMeans[k] = dBandT[k].reduce((a, b) => a + b, 0) / dBandT[k].length;
        bandSymT[k].push(bandMeans[k]!);
        bandSymW[k].push(dBandW[k].reduce((a, b) => a + b, 0) / dBandW[k].length);
        bandAnti[k].push(dBandA[k].reduce((a, b) => a + b, 0) / dBandA[k].length);
        bandNames[k] += dBandT[k].length;
      }
      // Paired: only blocks where BOTH ends of the contrast exist.
      if (bandMeans[2] !== null && bandMeans[0] !== null) {
        contrast.push(bandMeans[2] - bandMeans[0]);
      }
    }

    if (symTrail.length < 10) continue;
    const trailing = summarise(symTrail);
    const inWindow = summarise(symWin);
    const anti = antiTrail.reduce((a, b) => a + b, 0) / antiTrail.length;

    cells.push({
      horizon_sessions: H,
      barrier_pct: MOVE,
      blocks: symTrail.length,
      names_per_block: Math.round(namesTotal / symTrail.length),
      trailing,
      in_window: inWindow,
      antisymmetric_trailing_pp: Number((anti * 100).toFixed(3)),
      /*
       * Judged on the ADJUSTED MDE. A cell that only resolves the effect
       * before the serial-correlation charge does not resolve it.
       */
      resolves: trailing.mde_pp_adjusted <= EFFECT_SOUGHT_PP,
      family: { p: 0, p_holm: 0, clears: false }, // filled after all cells exist
    });

    for (let k = 0; k < 3; k++) {
      const s = bandSymT[k];
      const enough = s.length >= MIN_BLOCKS_FOR_STATS;
      const st = enough ? summarise(s) : null;
      bandCells.push({
        horizon_sessions: H,
        barrier_pct: MOVE,
        band: BAND_LABELS[k],
        blocks: s.length,
        names_per_block: s.length > 0 ? Number((bandNames[k] / s.length).toFixed(1)) : null,
        trailing: st,
        in_window: enough ? summarise(bandSymW[k]) : null,
        antisymmetric_trailing_pp:
          s.length > 0
            ? Number(((bandAnti[k].reduce((a, b) => a + b, 0) / bandAnti[k].length) * 100).toFixed(3))
            : null,
        resolves: st !== null && st.mde_pp_adjusted <= EFFECT_SOUGHT_PP,
        insufficient: enough
          ? null
          : `${s.length} blocks carried >=${MIN_NAMES_PER_BAND_BLOCK} names in this band; ` +
            `no statistic is computed below ${MIN_BLOCKS_FOR_STATS}. Insufficient is the answer.`,
        // MDE scales as 1/sqrt(blocks), so the blocks needed grow with the
        // square of the shortfall. At the observed variance, not a promise.
        blocks_needed_for_bar:
          st !== null && st.mde_pp_adjusted > EFFECT_SOUGHT_PP
            ? Math.ceil(s.length * (st.mde_pp_adjusted / EFFECT_SOUGHT_PP) ** 2)
            : null,
      });
    }

    {
      const enough = contrast.length >= MIN_BLOCKS_FOR_STATS;
      const st = enough ? summarise(contrast) : null;
      contrastCells.push({
        horizon_sessions: H,
        barrier_pct: MOVE,
        blocks: contrast.length,
        stat: st,
        insufficient: enough
          ? null
          : `${contrast.length} blocks carried both bands at >=${MIN_NAMES_PER_BAND_BLOCK} names; ` +
            `no statistic is computed below ${MIN_BLOCKS_FOR_STATS}. Insufficient is the answer.`,
        blocks_needed_for_bar:
          st !== null && st.mde_pp_adjusted > EFFECT_SOUGHT_PP
            ? Math.ceil(contrast.length * (st.mde_pp_adjusted / EFFECT_SOUGHT_PP) ** 2)
            : null,
        family: { p: 1, p_holm: 1, clears: false }, // filled after all cells exist
      });
    }
  }
}

/*
 * ── MULTIPLE-TESTING ACROSS THE FAMILY, Holm-Bonferroni at alpha 0.05 ──
 *
 * Sixteen cells produce roughly one |t|>=2 by chance, so a per-cell
 * threshold answers "does this cell clear?" while the question that matters
 * is "does anything clear the FAMILY?" — the Fibonacci study only became
 * decisive because it carried invented control levels, and the
 * harmonic-patterns study printed +4.6% on n=3. This grid does not get to
 * be the next of those.
 *
 * The family is the 16 TRAILING t_adjusted statistics. Trailing sigma is
 * the declared primary throughout (it is the only input knowable at entry);
 * the in-window column is mechanically coupled to its own outcome — a path
 * that touches tends to print higher realised vol — so it is a diagnostic
 * and does not get a familywise verdict it could not honestly carry.
 *
 * Timing, on the record: this correction was added 2026-09-14, three weeks
 * after the grid first ran. That is late, and it is also harmless HERE
 * specifically because every degree of freedom the correction protects
 * against was already fixed in the 2026-08-22 pre-declaration: the grid
 * (4x4, these exact edges), the primary column, the block statistic, and
 * the 5pp economic bar all predate the first run. Nothing was chosen after
 * seeing results, so applying Holm retroactively cannot have been steered
 * by them. Had any of those been picked post hoc, this block would be
 * laundering, not correction.
 *
 * p-values are two-sided normal on t_adjusted — effective blocks exceed 100
 * in every cell, where Student-t and normal differ past the third decimal.
 */
const FAMILY_ALPHA = 0.05;

/**
 * Holm step-down over a family of t statistics. A null t means "this member
 * produced no usable statistic" and enters at p = 1 — the family size stays
 * fixed at declaration rather than shrinking to whatever the data managed,
 * which would quietly relax the threshold on the survivors.
 */
function holmVerdicts(ts: (number | null)[]): { p: number; p_holm: number; clears: boolean }[] {
  const pOf = (t: number | null) => (t === null ? 1 : Math.min(1, 2 * (1 - Phi(Math.abs(t)))));
  const order = ts.map((t, i) => ({ i, p: pOf(t) })).sort((a, b) => a.p - b.p);
  const out: { p: number; p_holm: number; clears: boolean }[] = new Array(ts.length);
  let running = 0;
  order.forEach((o, rank) => {
    // Adjusted p is the running max of (m - rank) * p.
    running = Math.max(running, Math.min(1, (ts.length - rank) * o.p));
    // Three significant figures — tiny p-values stay legible without
    // pretending to more precision than a normal tail carries out there.
    out[o.i] = {
      p: Number(o.p.toExponential(2)),
      p_holm: Number(running.toExponential(2)),
      clears: running <= FAMILY_ALPHA,
    };
  });
  return out;
}

holmVerdicts(cells.map((c) => c.trailing.t_adjusted)).forEach((v, i) => {
  cells[i].family = v;
});

// PRIMARY declared family: the 16 high-minus-low contrasts.
holmVerdicts(contrastCells.map((c) => c.stat?.t_adjusted ?? null)).forEach((v, i) => {
  contrastCells[i].family = v;
});

// SECONDARY declared family: the 16 high-band levels.
const highCells = bandCells.filter((c) => c.band === ">0.8");
holmVerdicts(highCells.map((c) => c.trailing?.t_adjusted ?? null)).forEach((v, i) => {
  highCells[i].family = v;
});

// ── Report ───────────────────────────────────────────────────────────
console.log(`panel: ${loaded.length} of ${EQUITY_PANEL.length} declared names loaded`);
console.log(`grid: ${HORIZONS.length} horizons x ${BARRIERS.length} barriers = ${cells.length} cells measured`);
console.log(`effect sought: ${EFFECT_SOUGHT_PP}pp symmetric (a smaller vol edge is not tradeable after costs)`);
console.log("");
console.log("  H  bar   blocks  names |  TRAILING-VOL sigma                    |  IN-WINDOW sigma          | drift");
console.log("                          |   sym    se     t    MDE   ar1   MDE* |   sym    se     t    MDE  |  anti");
for (const c of cells) {
  const f = (s: Stat) =>
    `${s.symmetric_pp.toFixed(2).padStart(6)} ${s.se_pp.toFixed(2).padStart(5)} ${s.t.toFixed(2).padStart(6)} ${s.mde_pp.toFixed(2).padStart(5)}`;
  console.log(
    `${String(c.horizon_sessions).padStart(3)} ${String(c.barrier_pct).padStart(3)}%  ${String(c.blocks).padStart(6)} ${String(c.names_per_block).padStart(6)} | ${f(c.trailing)} ${c.trailing.ar1.toFixed(2).padStart(5)} ${c.trailing.mde_pp_adjusted.toFixed(2).padStart(5)} | ${f(c.in_window)} | ${c.antisymmetric_trailing_pp.toFixed(2).padStart(6)}`
  );
}

/*
 * MDE* is the number that governs. The unadjusted MDE beside it is kept so
 * the size of the charge is visible rather than described.
 */
const ar1s = cells.map((c) => c.trailing.ar1);
const worst = cells.reduce((a, b) => (b.trailing.ar1 > a.trailing.ar1 ? b : a));
console.log("");
console.log(
  `block-to-block ar1 on trailing vol: min ${Math.min(...ar1s).toFixed(3)}, ` +
  `max ${Math.max(...ar1s).toFixed(3)} (${worst.horizon_sessions}d ${worst.barrier_pct}%), ` +
  `mean ${(ars(ar1s)).toFixed(3)}`
);
console.log(
  `worst SE inflation: ${Math.max(...cells.map((c) => c.trailing.ar1_inflation)).toFixed(2)}x — ` +
  `MDE range ${Math.min(...cells.map((c) => c.trailing.mde_pp)).toFixed(2)}-${Math.max(...cells.map((c) => c.trailing.mde_pp)).toFixed(2)}pp ` +
  `becomes ${Math.min(...cells.map((c) => c.trailing.mde_pp_adjusted)).toFixed(2)}-${Math.max(...cells.map((c) => c.trailing.mde_pp_adjusted)).toFixed(2)}pp`
);
function ars(v: number[]) { return v.reduce((a, b) => a + b, 0) / v.length; }

/*
 * Every count below is on the ADJUSTED t. Reporting `resolves` on the
 * charged MDE while counting significance on the uncharged t would apply the
 * correction to whichever number it flatters least, which is worse than not
 * measuring it at all.
 */
const resolving = cells.filter((c) => c.resolves);
const clearing = cells.filter((c) => Math.abs(c.trailing.t_adjusted) >= 2);
const wouldHaveCleared = cells.filter(
  (c) => Math.abs(c.trailing.t) >= 2 && Math.abs(c.trailing.t_adjusted) < 2
);
const clearingBoth = cells.filter(
  (c) => Math.abs(c.trailing.t_adjusted) >= 2 && Math.abs(c.in_window.t_adjusted) >= 2
);
console.log("");
console.log(`cells whose adjusted MDE resolves a ${EFFECT_SOUGHT_PP}pp effect: ${resolving.length} of ${cells.length}`);
console.log(`cells where |t| >= 2 on TRAILING vol, after the serial-correlation charge:  ${clearing.length} of ${cells.length}`);
console.log(`cells where |t| >= 2 on BOTH vol inputs: ${clearingBoth.length} of ${cells.length}`);
const familyClearing = cells.filter((c) => c.family.clears);
console.log(
  `cells clearing the 16-cell FAMILY (Holm at ${FAMILY_ALPHA}): ${familyClearing.length} of ${cells.length}` +
  (familyClearing.length > 0
    ? ` — ${familyClearing.map((c) => `${c.horizon_sessions}d/${c.barrier_pct}% (p_holm ${c.family.p_holm})`).join(", ")}`
    : "")
);
console.log(
  `largest family-cleared |symmetric|: ` +
  (familyClearing.length > 0
    ? `${Math.max(...familyClearing.map((c) => Math.abs(c.trailing.symmetric_pp))).toFixed(2)}pp, ` +
      `against the ${EFFECT_SOUGHT_PP}pp declared tradeable bar`
    : "none")
);
if (wouldHaveCleared.length > 0) {
  console.log("");
  console.log(`${wouldHaveCleared.length} cells cleared on the UNCHARGED t and do not survive the charge:`);
  for (const c of wouldHaveCleared) {
    console.log(
      `  ${c.horizon_sessions}d ${c.barrier_pct}%: t ${c.trailing.t} -> ${c.trailing.t_adjusted} ` +
      `(ar1 ${c.trailing.ar1}, ${c.blocks} blocks worth ${c.trailing.effective_blocks})`
    );
  }
}
if (clearing.length > 0) {
  console.log("");
  console.log("cells clearing on trailing vol:");
  for (const c of clearing) {
    console.log(
      `  ${c.horizon_sessions}d ${c.barrier_pct}%: symmetric ${c.trailing.symmetric_pp > 0 ? "+" : ""}${c.trailing.symmetric_pp}pp ` +
      `t=${c.trailing.t_adjusted} (MDE ${c.trailing.mde_pp_adjusted}pp, ${c.blocks} blocks worth ${c.trailing.effective_blocks}) | ` +
      `in-window ${c.in_window.symmetric_pp > 0 ? "+" : ""}${c.in_window.symmetric_pp}pp t=${c.in_window.t_adjusted}`
    );
  }
}

// ── Sigma-band report ────────────────────────────────────────────────
console.log("");
console.log("SIGMA BANDS (trailing, at entry) — the pooled grid sliced where the book lives");
for (const label of BAND_LABELS) {
  const bc = bandCells.filter((c) => c.band === label);
  console.log(`  band ${label}:`);
  for (const c of bc) {
    if (c.trailing === null) {
      console.log(
        `    ${String(c.horizon_sessions).padStart(3)}d ${String(c.barrier_pct).padStart(3)}%: ` +
        `INSUFFICIENT (${c.blocks} blocks)`
      );
      continue;
    }
    console.log(
      `    ${String(c.horizon_sessions).padStart(3)}d ${String(c.barrier_pct).padStart(3)}%: ` +
      `sym ${c.trailing.symmetric_pp.toFixed(2).padStart(6)}pp t_adj ${c.trailing.t_adjusted.toFixed(2).padStart(6)} ` +
      `MDE* ${c.trailing.mde_pp_adjusted.toFixed(2).padStart(5)} | ${c.blocks} blocks x ~${c.names_per_block} names | ` +
      `in-window ${c.in_window!.symmetric_pp.toFixed(2).padStart(6)}pp` +
      (c.family ? ` | family ${c.family.clears ? "CLEARS" : "-"} (p_holm ${c.family.p_holm})` : "") +
      (c.blocks_needed_for_bar !== null ? ` | needs ${c.blocks_needed_for_bar} blocks for the 5pp bar` : "")
    );
  }
}
console.log("");
console.log("CONTRASTS — >0.8 minus <=0.5, paired per block (the PRIMARY family)");
for (const c of contrastCells) {
  if (c.stat === null) {
    console.log(`  ${c.horizon_sessions}d ${c.barrier_pct}%: INSUFFICIENT (${c.blocks} paired blocks)`);
    continue;
  }
  console.log(
    `  ${String(c.horizon_sessions).padStart(3)}d ${String(c.barrier_pct).padStart(3)}%: ` +
    `${c.stat.symmetric_pp > 0 ? "+" : ""}${c.stat.symmetric_pp.toFixed(2)}pp t_adj ${c.stat.t_adjusted.toFixed(2)} ` +
    `MDE* ${c.stat.mde_pp_adjusted.toFixed(2)} over ${c.blocks} paired blocks | ` +
    `family ${c.family.clears ? "CLEARS" : "-"} (p_holm ${c.family.p_holm})`
  );
}
const contrastsClearing = contrastCells.filter((c) => c.family.clears);
const highClearing = highCells.filter((c) => c.family?.clears);
console.log("");
console.log(`contrasts clearing the family: ${contrastsClearing.length} of ${contrastCells.length}`);
console.log(`high-band levels clearing their family: ${highClearing.length} of ${highCells.length}`);

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: Date.now(),
      method: {
        panel: "declared EQUITY_PANEL",
        names: loaded.length,
        horizons: HORIZONS,
        barriers: BARRIERS,
        effectSoughtPp: EFFECT_SOUGHT_PP,
        trailingVolSessions: TRAILING_VOL_SESSIONS,
        statistic:
          "per-date mean of (outcome - GBM predicted), t over non-overlapping date blocks. " +
          "Cross-sectional correlation between names is absorbed by construction — the date is " +
          "the unit, so no rho needs estimating. Serial correlation BETWEEN blocks is not " +
          "absorbed, so it is measured per cell (ar1) and charged to the SE by sqrt((1+r)/(1-r)); " +
          "mde_pp_adjusted is the figure that governs, and `resolves` is judged on it.",
        barrierConvention: "b_up = ln(1+m); b_down = -ln(1-m); drift sign flips on the down side",
        familyCorrection:
          "Holm-Bonferroni at alpha 0.05 across the 16 trailing t_adjusted statistics — the " +
          "declared primary column. In-window sigma is mechanically coupled to its own outcome " +
          "and carries no familywise verdict. The correction was added 2026-09-14, after the " +
          "first run, but every degree of freedom it protects against (grid edges, primary " +
          "column, block statistic, 5pp economic bar) was fixed in the 2026-08-22 " +
          "pre-declaration, so its application could not be steered by results.",
        note:
          "PATH-SHAPE half of the reach-vs-implied symmetric component. The VOL-PREMIUM half needs live chains and is measured separately.",
      },
      cells,
      sigma_bands: {
        declaration: {
          declared: "2026-09-14, before the first banded run",
          bandedOn: `trailing ${TRAILING_VOL_SESSIONS}-session sigma at entry — the same estimate the GBM prediction consumes`,
          edges: SIGMA_BAND_EDGES,
          minNamesPerBlock: MIN_NAMES_PER_BAND_BLOCK,
          minBlocksForStats: MIN_BLOCKS_FOR_STATS,
          primaryFamily:
            "the 16 per-cell (>0.8 minus <=0.5) contrasts, paired on blocks where both bands " +
            "clear the occupancy floor, Holm at 0.05 with family size fixed at 16 — a member " +
            "without a usable statistic enters at p=1 rather than shrinking the family",
          secondaryFamily: "the 16 >0.8-band levels, same rules",
          examinedBeforeDeclaring:
            "band OCCUPANCY only (names per band per block), which determines feasibility and " +
            "cannot reveal any bias direction. No banded outcome was computed before the " +
            "declaration was committed.",
        },
        bands: bandCells,
        contrasts: contrastCells,
      },
    },
    null,
    1
  )
);
console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
