/**
 * Does symbol_reach_pct carry reproducible information about the symbol, or is it
 * the shape of a coin flip at n_eff ~ 28?
 *
 * The column was added to /api/screen/contracts to separate rows the pooled bucket
 * table cannot tell apart. It does separate them — 37 distinct values inside a
 * 45-row tie. The question this script asks is whether that separation survives
 * being asked twice.
 *
 * A variance decomposition says the separation is ~94% sampling noise, but it gets
 * there by assuming the symbols' estimation errors are independent. They are not:
 * mean pairwise rho across this set is 0.229, and correlated errors cancel in
 * cross-sectional deviations, which understates the noise term and overstates the
 * real dispersion. Rather than argue the sign of that bias, split the history.
 *
 * Split-half reliability: compute each symbol's reach to its own breakeven on the
 * first half of its bars and again on the second half. If the column measures a
 * durable property of the symbol, the two halves agree across symbols. If it is
 * noise, they do not. The test is run WITHIN a single pooled bucket, because the
 * bucket has already absorbed target size — the only question is what the column
 * adds beyond what the ranking already knows.
 */
import panelJson from "../../src/data/barsPanel.json";
import { reachAt } from "../../src/lib/research/exitDesign";
import { survivalAt } from "../../src/lib/research/stopViability";
import type { Bar } from "../../src/lib/research/types";

const HORIZON = 10;
const SCREEN_URL = "http://localhost:3000/api/screen/contracts?budget=195";

interface SymbolPanel {
  bars: number[][];
  interpolated: number[];
}
const panel = panelJson as unknown as {
  sessions: string[];
  symbols: Record<string, SymbolPanel>;
};

function realBars(sp: SymbolPanel): Bar[] {
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < panel.sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({
      t: Date.parse(panel.sessions[i]),
      open: row[0],
      high: row[1],
      low: row[2],
      close: row[3],
      volume: row[4],
    });
  }
  return out;
}

/** The screen's own rule, so the halves answer the same question the column does. */
function symbolReach(bars: readonly Bar[], kind: string, movePct: number): number | null {
  const move = Math.abs(movePct);
  if (!(move > 0)) return null;
  if (kind === "call") {
    const c = reachAt(bars, move, HORIZON);
    return c === null ? null : c.reachPct;
  }
  const c = survivalAt(bars, move, HORIZON);
  return c === null ? null : 100 - c.survivalPct;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

async function main() {
  const res = await fetch(SCREEN_URL);
  const screen = (await res.json()) as {
    rows: {
      symbol: string;
      kind: string;
      reachPct: number;
      breakevenMovePct: number;
      breakevenAtr: number;
      symbolReachPct: number | null;
    }[];
  };

  // Group by pooled bucket; test inside the largest one, where the ranking is blind.
  const buckets = new Map<number, typeof screen.rows>();
  for (const r of screen.rows) {
    if (!buckets.has(r.reachPct)) buckets.set(r.reachPct, []);
    buckets.get(r.reachPct)!.push(r);
  }
  const [bucketReach, rows] = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)[0];

  // One row per symbol — repeats of the same name share bars and would count their
  // agreement twice. Keep the first, which is the highest-ranked of that name.
  const bySymbol = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, r);

  const h1: number[] = [];
  const h2: number[] = [];
  const full: number[] = [];
  const atr: number[] = [];
  const names: string[] = [];
  let dropped = 0;

  for (const [sym, r] of bySymbol) {
    const sp = panel.symbols[sym];
    if (!sp) { dropped++; continue; }
    const bars = realBars(sp);
    const mid = Math.floor(bars.length / 2);
    const a = symbolReach(bars.slice(0, mid), r.kind, r.breakevenMovePct);
    const b = symbolReach(bars.slice(mid), r.kind, r.breakevenMovePct);
    if (a === null || b === null) { dropped++; continue; }
    h1.push(a); h2.push(b);
    full.push(r.symbolReachPct!);
    atr.push(r.breakevenAtr);
    names.push(sym);
  }

  const sd = (xs: number[]) => {
    const m = xs.reduce((p, c) => p + c, 0) / xs.length;
    return Math.sqrt(xs.reduce((p, c) => p + (c - m) ** 2, 0) / (xs.length - 1));
  };

  console.log(`bucket: pooled reach ${bucketReach}%, ${rows.length} rows, ${bySymbol.size} distinct symbols`);
  console.log(`usable: ${h1.length} symbols (${dropped} dropped for missing bars or too-short halves)`);
  console.log(`bars per symbol: ${panel.sessions.length} sessions, halves ~${Math.floor(panel.sessions.length / 2)}`);
  console.log("");
  console.log(`full-history symbolReach : mean ${(full.reduce((a, b) => a + b, 0) / full.length).toFixed(1)}%  sd ${sd(full).toFixed(1)}pp  range ${Math.min(...full)}-${Math.max(...full)}`);
  console.log(`first half               : mean ${(h1.reduce((a, b) => a + b, 0) / h1.length).toFixed(1)}%  sd ${sd(h1).toFixed(1)}pp`);
  console.log(`second half              : mean ${(h2.reduce((a, b) => a + b, 0) / h2.length).toFixed(1)}%  sd ${sd(h2).toFixed(1)}pp`);
  console.log("");

  const r = pearson(h1, h2);
  // Spearman-Brown steps the half-length reliability up to full-length.
  const sb = (2 * r) / (1 + r);
  const n = h1.length;
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  console.log(`split-half correlation   : rho = ${r.toFixed(3)}  (t = ${t.toFixed(2)}, n = ${n})`);
  console.log(`Spearman-Brown corrected : ${sb.toFixed(3)}  <- reliability of the full-history column`);
  console.log("");

  // What the halves agree on could just be the residual target-size variation the
  // coarse bucket left behind. Check what each half shares with breakeven distance.
  console.log(`half1 vs breakevenAtr    : rho = ${pearson(h1, atr).toFixed(3)}`);
  console.log(`half2 vs breakevenAtr    : rho = ${pearson(h2, atr).toFixed(3)}`);
  console.log(`breakevenAtr in bucket   : ${Math.min(...atr).toFixed(2)} - ${Math.max(...atr).toFixed(2)} ATR`);
}

main();
