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
 * CRYPTO-TREASURY AND CRYPTO-FINANCIAL OPERATING COMPANIES.
 *
 * Held because they are in the book and were invisible to every surface this
 * site serves: two of three live positions had no dossier, no positioning row
 * and no stop grid, so quotes were pulled by hand roughly fifteen times in one
 * night and a SOL rotation was found by manually diffing a quote list.
 *
 * Declared apart from SCANNED rather than appended to it. SCANNED is the
 * datacenter/mining cohort and its mechanism is hosting economics; these
 * reprice on the coin they hold or the flow they intermediate. One list would
 * assert the two move for the same reason, which is the sort of quiet claim
 * this file exists to prevent.
 *
 * Every one verified as a US-listed EQUITY against the provider before being
 * declared here — not from memory.
 */
export const TREASURY_COHORT = [
  "MSTR",
  "COIN",
  "HOOD",
  "GLXY",
  "BMNR",
  "SBET",
  "PURR",
] as const;

/**
 * LEVERAGED AND DAILY-REBALANCED VEHICLES. Handle with care.
 *
 * These are ETFs, not companies, and the difference is not cosmetic:
 *
 *  - They reset exposure DAILY, so a multi-session return is path-dependent.
 *    A 2x fund does not deliver 2x the underlying's 20-day move, and in a
 *    choppy tape it can lose while the underlying is flat. Any percentile or
 *    momentum reading on them describes the decay as much as the direction.
 *  - They have no earnings, no filings and no fundamentals, so those sections
 *    are correctly empty rather than broken.
 *  - Several are young. PUR listed 2026-07-08 and has weeks of history, so
 *    the stop grid and return percentiles will refuse rather than answer —
 *    which is the honest outcome, not a gap to fill.
 *
 * They are here because they are traded and a stop on one must be watched.
 * `isLeveragedVehicle` exists so a consumer can gate a study rather than
 * discovering the hazard from a surprising number.
 */
export const LEVERAGED_VEHICLES = [
  "BITX",
  "BITU",
  "ETHU",
  "ETHT",
  "SOLT",
  "SOLZ",
  "MSTX",
  "MSTU",
  "CONL",
  "XXRP",
  "PUR",
] as const;

/** True for a daily-rebalanced fund, where multi-session returns are path-dependent. */
export function isLeveragedVehicle(symbol: string): boolean {
  return (LEVERAGED_VEHICLES as readonly string[]).includes(symbol);
}

/**
 * Everything the scanner and the recorders cover. Benchmarks last so a
 * truncated log or a partial failure loses the control group before it loses
 * a tradeable name.
 */
export const SCANNER_UNIVERSE: readonly string[] = [
  ...SCANNED,
  ...TREASURY_COHORT,
  ...LEVERAGED_VEHICLES,
  ...BENCHMARKS,
];

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
