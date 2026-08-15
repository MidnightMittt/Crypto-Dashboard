"use client";

import * as React from "react";
import { add, contains, isFull, loadWatchlist, remove, saveWatchlist, toggle } from "@/lib/watchlist/watchlist";

/**
 * The watchlist, as React state.
 *
 * ── Hydration ────────────────────────────────────────────────────────
 *
 * Reads on mount, never during render. The server has no localStorage, so
 * seeding initial state from it would render one thing on the server and
 * another on the client — a hydration mismatch that React papers over in
 * production and screams about in development. `ready` exists so callers can
 * distinguish "the list is empty" from "the list has not loaded yet" and
 * avoid flashing an empty-state at a user who has thirty symbols saved.
 *
 * ── Every tab holds the same list ────────────────────────────────────
 *
 * Starring a ticker in one tab and having another tab silently disagree is
 * the kind of bug that makes a user distrust persistence entirely. The
 * `storage` event fires in every OTHER tab of the origin, so they follow
 * along; the writing tab already has the value.
 */
export function useWatchlist() {
  const [list, setList] = React.useState<string[]>([]);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setList(loadWatchlist());
    setReady(true);

    const sync = (e: StorageEvent) => {
      // Null key means the whole store was cleared.
      if (e.key === null || e.key.startsWith("leverage-terminal:watchlist")) {
        setList(loadWatchlist());
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  /** Applies a pure transform, persists, and returns the result to state. */
  const commit = React.useCallback((next: string[]) => {
    setList(next);
    saveWatchlist(next);
  }, []);

  return {
    list,
    ready,
    has: React.useCallback((symbol: string) => contains(list, symbol), [list]),
    full: isFull(list),
    add: React.useCallback((symbol: string) => commit(add(list, symbol)), [list, commit]),
    remove: React.useCallback((symbol: string) => commit(remove(list, symbol)), [list, commit]),
    toggle: React.useCallback((symbol: string) => commit(toggle(list, symbol)), [list, commit]),
  };
}
