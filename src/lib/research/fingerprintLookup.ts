import { DEFAULT_SEARCH, MarketFingerprint, findNeighbours } from "./fingerprint";
import { NeighbourOutcome, NeighbourhoodStats, summariseNeighbourhood } from "./neighbourhood";

/**
 * THE RUNTIME LOOKUP — today's environment against the library.
 *
 * Kept separate from `fingerprint.ts` (the definition) and
 * `neighbourhood.ts` (the statistics) because this is the only piece that
 * knows about the on-disk artefact. The other two stay testable with
 * hand-built vectors and no fixture.
 */

/**
 * The on-disk shape: columnar, because repeating nine dimension names and a
 * symbol string across 50,000 rows was most of a 44.7MB file. Rows are
 * positional against `dimensions`; `null` marks a dimension that row never
 * measured, and must stay distinct from a measured zero.
 */
export interface FingerprintLibrary {
  version: number;
  horizonSessions: number;
  strideSessions: number;
  baselineReturnPct: number;
  instruments: number;
  symbols: string[];
  dimensions: string[];
  /** Per-instrument mean/spread as of the last ingested session. */
  moments: Record<string, Record<string, { mean: number; sd: number; n: number }>>;
  /** [symbolIndex, date, [z | null, ...], forwardReturnPct, maxAdversePct, maxFavourablePct] */
  rows: Array<[number, string, Array<number | null>, number, number, number]>;
  notes: string[];
}

/**
 * Correlation between instruments in the equity panel, used to charge for
 * the fact that forty names in one week are not forty observations.
 *
 * Measured, not assumed — see the crypto-correlation work that established
 * it for this universe. It is passed explicitly rather than hardcoded inside
 * `summariseIndependence` so that a panel with different correlation (a
 * future crypto library, say) cannot silently inherit an equity number.
 */
export const EQUITY_PANEL_RHO = 0.82;

export function lookupNeighbourhood(
  today: MarketFingerprint,
  library: FingerprintLibrary
): NeighbourhoodStats | null {
  /*
   * A library built under a different definition cannot be compared against
   * a vector built under this one. `fingerprintDistance` already returns
   * Infinity per pair, but failing fast here says WHY rather than silently
   * finding nothing similar.
   */
  if (library.version !== today.version) return null;

  const candidates = library.rows.map(([symbolIdx, date, zs, ret, mae, mfe]) => {
    const values: Record<string, number> = {};
    for (let i = 0; i < library.dimensions.length; i++) {
      const z = zs[i];
      // null means never measured. Writing it as 0 would assert "average".
      if (z !== null && z !== undefined) values[library.dimensions[i]] = z;
    }
    return {
      fingerprint: {
        symbol: library.symbols[symbolIdx],
        date,
        version: library.version,
        values,
      },
      outcome: {
        forwardReturnPct: ret,
        maxAdversePct: mae,
        maxFavourablePct: mfe,
        // The library measures a fixed window, so there is no resolution date
        // to report. Null rather than the horizon, which would imply every
        // environment took exactly that long to play out.
        sessionsHeld: null,
      } satisfies NeighbourOutcome,
    };
  });

  const neighbours = findNeighbours(today, candidates, DEFAULT_SEARCH);
  return summariseNeighbourhood(neighbours, {
    baselineReturnPct: library.baselineReturnPct,
    rho: EQUITY_PANEL_RHO,
    windowDays: DEFAULT_SEARCH.windowDays,
    forwardHorizonDays: library.horizonSessions,
  });
}
