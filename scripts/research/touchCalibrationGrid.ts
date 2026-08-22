import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EQUITY_PANEL } from "../../src/lib/markets/equityPanel";
import { Bar } from "../../src/lib/research/types";

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
const TRAILING_VOL_SESSIONS = 60;

// ── Normal CDF (Abramowitz-Stegun 7.1.26 via erf) ────────────────────
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  return s * (1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
}
const Phi = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** P(max of log-price with drift mu, vol sigma, over T, reaches +b). b > 0. */
function pTouchUp(b: number, sigma: number, T: number, mu: number): number {
  const sT = sigma * Math.sqrt(T);
  if (!(sT > 0)) return 0;
  const v = Phi((mu * T - b) / sT) + Math.exp((2 * mu * b) / (sigma * sigma)) * Phi((-b - mu * T) / sT);
  return Math.min(1, Math.max(0, v));
}
/** P(min reaches -b). Reflection X -> -X, which FLIPS the drift. */
const pTouchDown = (b: number, sigma: number, T: number, mu: number) => pTouchUp(b, sigma, T, -mu);

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

/** Annualised sigma from a slice of log returns. Null when degenerate. */
function sigmaOf(logRet: number[], from: number, to: number): number | null {
  const n = to - from;
  if (n < 5) return null;
  let s = 0;
  for (let i = from; i < to; i++) s += logRet[i];
  const m = s / n;
  let v = 0;
  for (let i = from; i < to; i++) v += (logRet[i] - m) ** 2;
  const sd = Math.sqrt(v / (n - 1));
  const ann = sd * Math.sqrt(252);
  return ann > 0.01 && ann < 6 ? ann : null;
}

interface CellResult {
  horizon_sessions: number;
  barrier_pct: number;
  blocks: number;
  names_per_block: number;
  trailing: Stat;
  in_window: Stat;
  antisymmetric_trailing_pp: number;
  resolves: boolean;
}
interface Stat { symmetric_pp: number; se_pp: number; t: number; mde_pp: number }

function summarise(diffs: number[]): Stat {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return {
    symmetric_pp: Number((mean * 100).toFixed(3)),
    se_pp: Number((se * 100).toFixed(3)),
    t: Number((mean / se).toFixed(2)),
    mde_pp: Number((2 * se * 100).toFixed(3)),
  };
}

const cells: CellResult[] = [];

for (const H of HORIZONS) {
  const T = H / 252;
  for (const MOVE of BARRIERS) {
    const bUp = Math.log(1 + MOVE / 100);
    const bDn = -Math.log(1 - MOVE / 100);

    const symTrail: number[] = [];
    const symWin: number[] = [];
    const antiTrail: number[] = [];
    let namesTotal = 0;

    for (let g = TRAILING_VOL_SESSIONS; g + H < grid.length; g += H) {
      const t0 = grid[g];
      const dSymT: number[] = [], dSymW: number[] = [], dAntiT: number[] = [];

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

        for (const [sig, symArr, antiArr] of [
          [sTrail, dSymT, dAntiT],
          [sWin, dSymW, null],
        ] as const) {
          const mu = -0.5 * sig * sig;
          const pUp = pTouchUp(bUp, sig, T, mu);
          const pDn = pTouchDown(bDn, sig, T, mu);
          const eUp = yUp - pUp;
          const eDn = yDn - pDn;
          symArr.push((eUp + eDn) / 2);
          if (antiArr) antiArr.push((eUp - eDn) / 2);
        }
      }

      if (dSymT.length < 20) continue;
      namesTotal += dSymT.length;
      symTrail.push(dSymT.reduce((a, b) => a + b, 0) / dSymT.length);
      symWin.push(dSymW.reduce((a, b) => a + b, 0) / dSymW.length);
      antiTrail.push(dAntiT.reduce((a, b) => a + b, 0) / dAntiT.length);
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
      resolves: trailing.mde_pp <= EFFECT_SOUGHT_PP,
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────
console.log(`panel: ${loaded.length} of ${EQUITY_PANEL.length} declared names loaded`);
console.log(`grid: ${HORIZONS.length} horizons x ${BARRIERS.length} barriers = ${cells.length} cells measured`);
console.log(`effect sought: ${EFFECT_SOUGHT_PP}pp symmetric (a smaller vol edge is not tradeable after costs)`);
console.log("");
console.log("  H  bar   blocks  names |  TRAILING-VOL sigma        |  IN-WINDOW sigma          | drift");
console.log("                          |   sym    se     t    MDE  |   sym    se     t    MDE  |  anti");
for (const c of cells) {
  const f = (s: Stat) =>
    `${s.symmetric_pp.toFixed(2).padStart(6)} ${s.se_pp.toFixed(2).padStart(5)} ${s.t.toFixed(2).padStart(6)} ${s.mde_pp.toFixed(2).padStart(5)}`;
  console.log(
    `${String(c.horizon_sessions).padStart(3)} ${String(c.barrier_pct).padStart(3)}%  ${String(c.blocks).padStart(6)} ${String(c.names_per_block).padStart(6)} | ${f(c.trailing)} | ${f(c.in_window)} | ${c.antisymmetric_trailing_pp.toFixed(2).padStart(6)}`
  );
}

const resolving = cells.filter((c) => c.resolves);
const clearing = cells.filter((c) => Math.abs(c.trailing.t) >= 2);
const clearingBoth = cells.filter((c) => Math.abs(c.trailing.t) >= 2 && Math.abs(c.in_window.t) >= 2);
console.log("");
console.log(`cells whose MDE resolves a ${EFFECT_SOUGHT_PP}pp effect: ${resolving.length} of ${cells.length}`);
console.log(`cells where |t| >= 2 on TRAILING vol:  ${clearing.length} of ${cells.length}`);
console.log(`cells where |t| >= 2 on BOTH vol inputs: ${clearingBoth.length} of ${cells.length}`);
if (clearing.length > 0) {
  console.log("");
  console.log("cells clearing on trailing vol:");
  for (const c of clearing) {
    console.log(
      `  ${c.horizon_sessions}d ${c.barrier_pct}%: symmetric ${c.trailing.symmetric_pp > 0 ? "+" : ""}${c.trailing.symmetric_pp}pp ` +
      `t=${c.trailing.t} (MDE ${c.trailing.mde_pp}pp, ${c.blocks} blocks) | in-window ${c.in_window.symmetric_pp > 0 ? "+" : ""}${c.in_window.symmetric_pp}pp t=${c.in_window.t}`
    );
  }
}

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
        statistic: "per-date mean of (outcome - GBM predicted), t over non-overlapping date blocks",
        barrierConvention: "b_up = ln(1+m); b_down = -ln(1-m); drift sign flips on the down side",
        note:
          "PATH-SHAPE half of the reach-vs-implied symmetric component. The VOL-PREMIUM half needs live chains and is measured separately.",
      },
      cells,
    },
    null,
    1
  )
);
console.log(`\nwrote ${path.relative(process.cwd(), OUT)}`);
