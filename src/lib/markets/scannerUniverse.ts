/**
 * THE SCANNER UNIVERSE — declared, not hard-coded at a call site.
 *
 * buildMarketsSnapshot.ts held `MARKETS = ["SPY","QQQ","DIA","IWM"]` inline,
 * which made the scanner cover exactly the four instruments where the
 * overnight effect being traded is measurably ABSENT. Index ETFs are the
 * control group, not the sample: an index is a weighted average of hundreds
 * of names, so the idiosyncratic overnight premium that shows up in single
 * stocks is diversified away before it reaches SPY.
 *
 * They stay, explicitly labelled as benchmarks, because a control group you
 * keep is how you know an effect is real. What changes is that they are no
 * longer the whole universe.
 *
 * ── Why a module and not a constant in the script ─────────────────────
 *
 * Three jobs now need the same list — the markets snapshot, the spread
 * recorder and the pre-trade API — and a list that lives in one script is a
 * list the other two will drift from. The same reasoning that moved the
 * equity panel out of a scraped directory: a reference set is a claim, and a
 * claim belongs somewhere it can be read by everyone who depends on it.
 */

import { EQUITY_PANEL } from "./equityPanel";

/** Index and sector ETFs. Kept as the control group, never scanned for entries. */
export const BENCHMARKS = ["SPY", "QQQ", "DIA", "IWM"] as const;

/**
 * The names actually traded. Datacenter/mining and adjacent high-volatility
 * small and mid caps — the population where a per-share tick is a material
 * fraction of price and where the overnight premium is worth measuring.
 */
export const SCANNED = [
  "APLD",
  "RIOT",
  "CLSK",
  "IREN",
  "CORZ",
  "IONQ",
  "OKLO",
  "MARA",
  "WULF",
  "CIFR",
  "HUT",
  "BTDR",
] as const;

/**
 * Everything the scanner and the recorders cover. Benchmarks last so a
 * truncated log or a partial failure loses the control group before it loses
 * a tradeable name.
 */
export const SCANNER_UNIVERSE: readonly string[] = [...SCANNED, ...BENCHMARKS];

/** True for the instruments kept only as a reference point. */
export function isBenchmark(symbol: string): boolean {
  return (BENCHMARKS as readonly string[]).includes(symbol);
}

/**
 * Override for local work and one-off studies, e.g.
 *   SCANNER_SYMBOLS=APLD,RIOT npx tsx scripts/ingest/recordSpreads.ts
 *
 * Deliberately NOT how production is configured: an env var that silently
 * narrows the universe is how a job quietly stops covering what everyone
 * assumes it covers. Production reads the declared list above.
 */
export function resolveUniverse(env = process.env.SCANNER_SYMBOLS): readonly string[] {
  if (!env) return SCANNER_UNIVERSE;
  const parsed = env
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : SCANNER_UNIVERSE;
}

/**
 * Everything the positioning recorder covers: the declared equity panel plus
 * the scanner universe, deduplicated, sorted.
 *
 * Declared HERE because two jobs now depend on the same set — the daily
 * positioning recorder and the bars-panel builder — and the bars panel is
 * only useful if it covers exactly the symbols positioning is recorded for.
 * A cross-sectional test joins the two on (symbol, date); every symbol the
 * lists disagree on is a row silently dropped from the join, which is how a
 * 105-symbol hypothesis ended up tested on 10. Deriving both from one
 * function makes that disagreement impossible rather than unlikely.
 */
export function positioningUniverse(env = process.env.SCANNER_SYMBOLS): readonly string[] {
  return [...new Set([...EQUITY_PANEL, ...resolveUniverse(env)])].sort();
}
