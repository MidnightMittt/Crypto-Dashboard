/**
 * THE WATCHLIST — Roadmap Phase 2, and the prerequisite for The Brief.
 *
 * The Brief's job is "here is what changed on the things YOU care about
 * overnight". It cannot exist until the platform knows which things those
 * are, which is why the roadmap puts this first even though it is the least
 * interesting item in the phase.
 *
 * ── Why the browser, and why that is not a cop-out ────────────────────
 *
 * There is no account system and no per-user server state. A watchlist
 * persisted server-side would therefore be a GLOBAL watchlist wearing a
 * personal one's clothes — every visitor editing the same list. localStorage
 * is the honest representation of what this actually is: one operator's
 * terminal, on their machine.
 *
 * The consequence is stated rather than hidden: the list does not follow the
 * user across devices, and clearing site data clears it. When accounts exist
 * this module's shape does not change — only `load` and `save` do.
 *
 * ── Everything decision-shaped is pure ───────────────────────────────
 *
 * `add`, `remove`, `toggle` and `normalise` take a list and return a list.
 * The storage layer is four lines at the bottom and is the only part that
 * cannot be tested without a DOM. That split is deliberate: the rules about
 * what a valid watchlist IS should not be reachable only through a browser.
 */

/** Hard cap. A watchlist is a shortlist; past this it is a screener with extra steps. */
export const MAX_WATCHLIST = 30;

/** Storage key. Versioned, so a future shape change can migrate rather than corrupt. */
const STORAGE_KEY = "leverage-terminal:watchlist:v1";

/**
 * Canonical form of a typed symbol: upper-cased, trimmed, and stripped of the
 * decorations people paste from other terminals ($AAPL, AAPL.US, aapl).
 * Returns null for anything that cannot be a ticker, so callers never have to
 * decide what an empty string means.
 */
export function normaliseSymbol(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/^\$/, "")
    // Venue suffixes the ingest uses internally; a user typing AAPL.US means AAPL.
    .replace(/\.(US|SPOT)$/, "");

  // Letters, digits and the separators real tickers use: BRK.B, BTC-USD.
  if (!/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * The invariant every operation returns to: canonical, de-duplicated, capped,
 * insertion order preserved.
 *
 * Order is insertion rather than alphabetical because the list is a queue of
 * attention — what you added last is what you are thinking about. Sorting it
 * would destroy information the user put there for free.
 */
export function normalise(symbols: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of symbols) {
    const n = normaliseSymbol(s);
    if (n === null || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_WATCHLIST) break;
  }
  return out;
}

export function contains(list: readonly string[], symbol: string): boolean {
  const n = normaliseSymbol(symbol);
  return n !== null && list.includes(n);
}

/**
 * Adds to the FRONT, not the back.
 *
 * The thing just searched is the thing being thought about, and a list capped
 * at 30 that appended would eventually refuse new entries in favour of ones
 * added months ago. Front-insertion makes the cap evict the stalest interest
 * instead of the freshest.
 */
export function add(list: readonly string[], symbol: string): string[] {
  const n = normaliseSymbol(symbol);
  if (n === null) return normalise(list);
  return normalise([n, ...list]);
}

export function remove(list: readonly string[], symbol: string): string[] {
  const n = normaliseSymbol(symbol);
  if (n === null) return normalise(list);
  return normalise(list.filter((s) => s !== n));
}

export function toggle(list: readonly string[], symbol: string): string[] {
  return contains(list, symbol) ? remove(list, symbol) : add(list, symbol);
}

/**
 * True when adding one more would be refused. Exposed so a UI can disable the
 * control and say why, rather than letting a click silently do nothing —
 * which is how a user concludes the feature is broken.
 */
export function isFull(list: readonly string[]): boolean {
  return list.length >= MAX_WATCHLIST;
}

// ── Persistence. The only part that needs a browser. ───────────────────

export function loadWatchlist(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything could be under this key — another tool, a corrupted write, a
    // half-finished migration. Normalise rather than trust, and never throw:
    // a broken watchlist must not take the page down with it.
    return Array.isArray(parsed) ? normalise(parsed.filter((x): x is string => typeof x === "string")) : [];
  } catch {
    return [];
  }
}

export function saveWatchlist(list: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalise(list)));
  } catch {
    // Quota exceeded or storage disabled (private browsing). The in-memory
    // list still works for this session; silently degrading beats an error
    // dialog over a list of ticker symbols.
  }
}
