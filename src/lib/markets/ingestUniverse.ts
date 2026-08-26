import { InstrumentConfig, instrumentsByProvider, usListing } from "../research/universe";
import { industryUniverse, INDUSTRIES } from "./industries";
import { resolveUniverse } from "./scannerUniverse";

/**
 * WHAT THE DAILY REFRESH ACTUALLY INGESTS — declared once, in src, so it can
 * be asserted on.
 *
 * This lived inside `main()` in scripts/ingest/yahoo.ts, which invokes itself
 * at module load and therefore cannot be imported by a test. The composition
 * was consequently unreachable from the suite: the only thing that ever
 * evaluated it was the 22:15 cron, and the only way to learn it was wrong was
 * to watch a job go red.
 *
 * That is not hypothetical. IBIT was added to the refresh on 2026-08-21 and
 * classified in equityPanel.ts by nobody. `loadEquityPanel` threw — correctly,
 * loudly, exactly as designed — and killed `daily-intelligence` on 08-24,
 * 08-25 and 08-26 before it reached the step that registers forward
 * predictions. Three sessions of predictions were never registered, and the
 * forward record cannot be backfilled.
 *
 * The throw was never the defect. The defect was that a check which fails
 * loudly ran in exactly one place, once a day, five hours after anyone was
 * looking. Moving the composition here lets the same check run in the suite,
 * on the commit that adds the instrument.
 *
 * ── The two sources, and why they stay separate ───────────────────────
 *
 * The research universe is an evidence decision documented in universe.ts;
 * the industry layer is a membership list in industries.ts. They answer
 * different questions, but both go through the identical fetch, validate and
 * refuse path, so an industry constituent is held to the same standard as a
 * backtested instrument.
 */

export interface RefreshScope {
  /**
   * The DAILY pipeline's scope, which is exactly WHAT THE SNAPSHOTS READ —
   * not literally the .US suffix. Those two were the same thing until the
   * industry layer declared external drivers: gold's driver is GLD.US and
   * already in scope, but bitcoin's is BTC-USD.SPOT, and a suffix test would
   * have left it to go stale while every other input refreshed daily.
   * Stale-by-omission is the worst failure shape here, because a driver
   * correlation computed against a frozen series still renders a
   * confident-looking number.
   *
   * Excluded, deliberately: the FX pairs, research-universe members with
   * long-standing validation findings that are a research problem rather than
   * a daily-freshness one. Without that exclusion a known-bad series would
   * fail the cron every day, and a pipeline that is always red alerts nobody.
   */
  onlyUs: boolean;
  /** Targeted re-fetch, for adding a name without re-pulling 120 series. */
  wanted?: ReadonlySet<string> | null;
}

export interface RefreshUniverse {
  configs: InstrumentConfig[];
  /** Counts by origin, for the ingest's own log line. */
  researchCount: number;
  industryCount: number;
  scannerCount: number;
}

export function refreshUniverse(scope: RefreshScope): RefreshUniverse {
  const research = instrumentsByProvider("yahoo");
  const industry = industryUniverse()
    .filter((sym) => !research.some((c) => c.meta.displaySymbol === sym))
    .map((sym) => usListing(sym, sym));

  /*
   * THE SCANNED NAMES, which belong here for a different reason than the rest.
   *
   * Research and industry instruments are ingested because they are members
   * of a declared research panel or a classified industry. These are here
   * simply because the scanner covers them, and that distinction is worth
   * keeping: IONQ is quantum computing and OKLO is nuclear fission, so filing
   * either under "datacenter-mining" to get it fetched would be a taxonomy
   * lie told for a plumbing reason. Panel composition is a claim, and this is
   * the honest claim — traded, therefore measured.
   */
  const known = new Set([...research, ...industry].map((c) => c.meta.displaySymbol ?? c.meta.id));
  const scanner = resolveUniverse()
    .filter((s) => !known.has(s))
    .map((s) => usListing(s, s));

  const snapshotDriverIds = new Set(
    INDUSTRIES.map((i) => i.driver?.seriesId).filter((id): id is string => id !== undefined)
  );

  const all = [...research, ...industry, ...scanner];
  let configs = scope.onlyUs
    ? all.filter((c) => c.meta.id.endsWith(".US") || snapshotDriverIds.has(c.meta.id))
    : all;
  if (scope.wanted) {
    const wanted = scope.wanted;
    configs = configs.filter((c) => wanted.has(c.meta.displaySymbol ?? c.meta.id));
  }

  return {
    configs,
    researchCount: research.length,
    industryCount: industry.length,
    scannerCount: scanner.length,
  };
}

/**
 * The bar file an instrument is written to. One function so the write side
 * (yahoo.ts) and the read side (loadPanel.ts) cannot drift: the id carries a
 * venue suffix (`NVDA.US`, `BTC-USD.SPOT`) and the classification lists are
 * keyed on the bare symbol, so the mapping between them is load-bearing and
 * was previously an unwritten convention repeated in two files.
 */
export function barFileName(instrumentId: string): string {
  return `${instrumentId}.json`;
}

/** The symbol a bar file classifies as. Inverse of `barFileName`. */
export function panelSymbolOfFile(fileName: string): string {
  return fileName.split(".")[0];
}

/**
 * Every symbol the given refresh scope will present to the classifier.
 *
 * This is the exact input `loadEquityPanel` hands to `unclassified`, derived
 * from the declared universe rather than from a directory listing — so it
 * answers the question on a machine that has never run the ingest.
 */
export function refreshPanelSymbols(scope: RefreshScope): string[] {
  return refreshUniverse(scope).configs.map((c) => panelSymbolOfFile(barFileName(c.meta.id)));
}
