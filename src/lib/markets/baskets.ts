import { BENCHMARKS, SCANNED } from "./scannerUniverse";

/**
 * DECLARED BASKETS — defined by a rule, never by realised return.
 *
 * A basket assembled from the names with the largest premium is not a test:
 * the selection has already used the answer, and the resulting statistic
 * measures how hard somebody looked. Every basket here is fixed by membership
 * of a declared set — an industry, or the whole scanned universe.
 *
 * `benchmarks` is the CONTROL, and carrying it earned its keep. Over 250
 * sessions the four index ETFs returned +7.0bp a night at t=1.80 against the
 * scanned cohort's +32.2bp at t=1.88: four and a half times the effect at the
 * SAME significance, which is the same Sharpe. That is what a volatility-
 * scaled market drift looks like rather than a cohort-specific edge, and
 * without the control it would have read as a discovery about miners.
 *
 * ── Why this lives here and not in the research script ────────────────
 *
 * The overnight study and the portfolio endpoint both need these lists. Two
 * copies of a reference set is how the last panel drift happened, and a
 * portfolio concentration report that disagreed with the study's own basket
 * definitions would be worse than no report.
 */

export interface BasketDef {
  name: string;
  symbols: readonly string[];
  /** What the membership rule IS, so a reader can check it was not fitted. */
  note: string;
}

export const BASKETS: readonly BasketDef[] = [
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
] as const;

/**
 * The baskets a symbol belongs to. A name can sit in several — "scanned" and
 * "miners" overlap by construction — so this returns all of them rather than
 * pretending membership is exclusive.
 */
export function basketsOf(symbol: string): string[] {
  return BASKETS.filter((b) => (b.symbols as readonly string[]).includes(symbol)).map((b) => b.name);
}
