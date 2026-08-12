import { Bar, CapabilityKey, InstrumentMeta, MarketDataSource, Timeframe } from "./types";

/**
 * A `MarketDataSource` over bar arrays already in memory.
 *
 * This is the reference implementation and the one every test and backtest
 * uses. A live/streaming source would implement the same interface over a
 * database or API; nothing downstream can tell the difference, which is the
 * property that lets the crypto engine migrate before any new market exists.
 *
 * ── The one rule it exists to enforce ───────────────────────────────────
 *
 * `bars()` truncates at `until`, always, with no way for a caller to opt
 * out. There is deliberately no `allBars()` escape hatch: the moment one
 * exists, some caller uses it "just for a moment" and look-ahead is back.
 * Every point-in-time bug this project has had came from a caller forgetting
 * to truncate, so the truncation lives here rather than in each caller.
 *
 * Capability series are truncated by the same rule, through the same code
 * path, for the same reason.
 */

export interface CapabilitySeries<T> {
  /** Observations with their KNOWABLE-AT timestamps. Not the timestamp the value describes — the instant it became available. */
  points: Array<{ knownAtT: number; value: T }>;
}

export interface InstrumentSeed {
  meta: InstrumentMeta;
  /** Bars per timeframe, oldest first. Must be sorted; the constructor checks. */
  bars: Partial<Record<Timeframe, Bar[]>>;
  capabilities?: Partial<Record<CapabilityKey, CapabilitySeries<unknown>>>;
}

export class InMemoryDataSource implements MarketDataSource {
  private readonly instruments = new Map<string, InstrumentSeed>();

  constructor(seeds: InstrumentSeed[]) {
    for (const seed of seeds) {
      for (const [tf, bars] of Object.entries(seed.bars)) {
        if (!bars) continue;
        for (let i = 1; i < bars.length; i++) {
          if (bars[i].t <= bars[i - 1].t) {
            // Fail loudly at construction. Unsorted bars would make the
            // binary-search truncation below silently wrong, and a silently
            // wrong point-in-time boundary is the worst failure mode here.
            throw new Error(
              `[InMemoryDataSource] ${seed.meta.id} ${tf} bars are not strictly ascending at index ${i}`
            );
          }
        }
      }
      this.instruments.set(seed.meta.id, seed);
    }
  }

  listInstruments(): InstrumentMeta[] {
    return [...this.instruments.values()].map((s) => s.meta);
  }

  meta(id: string): InstrumentMeta | null {
    return this.instruments.get(id)?.meta ?? null;
  }

  bars(id: string, timeframe: Timeframe, until: number): Bar[] {
    const series = this.instruments.get(id)?.bars[timeframe];
    if (!series || series.length === 0) return [];
    const cut = upperBound(series, until, (b) => b.t);
    return series.slice(0, cut);
  }

  hasCapability(id: string, key: CapabilityKey): boolean {
    const seed = this.instruments.get(id);
    if (!seed) return false;
    if (key === "ohlcv") return Object.values(seed.bars).some((b) => b && b.length > 0);
    return Boolean(seed.capabilities?.[key]);
  }

  capability<T>(id: string, key: CapabilityKey, until: number): T | null {
    const series = this.instruments.get(id)?.capabilities?.[key] as CapabilitySeries<T> | undefined;
    if (!series || series.points.length === 0) return null;
    const cut = upperBound(series.points, until, (p) => p.knownAtT);
    // The most recent observation that was already knowable. Not the nearest
    // in time — the nearest could be in the future.
    return cut > 0 ? series.points[cut - 1].value : null;
  }
}

/** Index of the first element whose key exceeds `until`, i.e. the length of the safe prefix. Binary search: these arrays reach tens of thousands of bars and this runs per feature per trade. */
function upperBound<T>(items: T[], until: number, keyOf: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keyOf(items[mid]) <= until) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
