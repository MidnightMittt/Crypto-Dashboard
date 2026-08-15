"use client";

import * as React from "react";
import Link from "next/link";
import { Star, X } from "lucide-react";
import { MAX_WATCHLIST } from "@/lib/watchlist/watchlist";
import { useWatchlist } from "./useWatchlist";

/**
 * THE WATCHLIST, as one line under the search box.
 *
 * Deliberately not a page. A watchlist of thirty tickers with no reads
 * attached is a bookmark bar, and giving a bookmark bar its own route implies
 * it answers a question. It does not — the DOSSIER answers questions, and
 * this exists to get you there in one click instead of eight keystrokes.
 *
 * It will grow into The Brief's fourth row, where each symbol arrives with
 * what changed on it overnight. That needs the ledger to have history, which
 * it does not yet; until then a link is an honest thing to offer and a
 * verdict beside each name would not be.
 *
 * Renders NOTHING when empty rather than an invitation to "add your first
 * ticker". An empty-state pitch on a tool the user just opened is noise; the
 * star on the dossier is where the feature introduces itself, in the place it
 * makes sense.
 */
export function WatchlistStrip({ activeSymbol }: { activeSymbol?: string }) {
  const { list, ready, remove } = useWatchlist();

  // `ready` guards the first paint: rendering an empty strip before
  // localStorage has been read would flash "no watchlist" at someone who has
  // thirty symbols saved.
  if (!ready || list.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        <Star className="h-3 w-3" aria-hidden />
        Watching
      </span>
      {list.map((symbol) => {
        const active = activeSymbol?.toUpperCase() === symbol;
        return (
          <span
            key={symbol}
            className={`group inline-flex items-center rounded-md border text-[11px] transition-colors ${
              active
                ? "border-cyan/40 bg-cyan/[0.06] text-ink"
                : "border-hairline bg-void/30 text-ink-muted hover:border-cyan/30 hover:text-ink"
            }`}
          >
            <Link href={`/asset/${encodeURIComponent(symbol)}`} className="py-1 pl-2 pr-1 font-mono">
              {symbol}
            </Link>
            <button
              type="button"
              onClick={() => remove(symbol)}
              aria-label={`Remove ${symbol} from watchlist`}
              /*
               * Always in the DOM, revealed on hover/focus. Rendering it
               * conditionally on hover would make it unreachable by keyboard,
               * and a remove control you can only reach with a mouse is a
               * list you cannot edit without one.
               */
              className="py-1 pr-1.5 pl-0.5 text-ink-faint opacity-0 transition-opacity hover:text-danger focus:opacity-100 focus:outline-none group-hover:opacity-100"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        );
      })}
      {list.length >= MAX_WATCHLIST && (
        <span className="text-[10px] text-ink-faint">full — remove one to add another</span>
      )}
    </div>
  );
}

/**
 * The star on a dossier. The only place the watchlist introduces itself.
 *
 * States it can be in, none of which may look alike: not saved, saved, and
 * refused-because-full. The third is why `isFull` is exported from the pure
 * module — a click that silently does nothing is how a user concludes a
 * feature is broken, so the control says what happened instead.
 */
export function WatchlistStar({ symbol }: { symbol: string }) {
  const { has, toggle, full, ready } = useWatchlist();
  const saved = has(symbol);
  const blocked = !saved && full;

  return (
    <button
      type="button"
      onClick={() => !blocked && toggle(symbol)}
      disabled={!ready || blocked}
      aria-pressed={saved}
      title={
        blocked
          ? `Watchlist is full at ${MAX_WATCHLIST} — remove one to add ${symbol}`
          : saved
            ? `Remove ${symbol} from watchlist`
            : `Add ${symbol} to watchlist`
      }
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] uppercase tracking-[0.14em] transition-colors ${
        saved
          ? "border-cyan/40 bg-cyan/[0.06] text-ink"
          : "border-hairline text-ink-muted hover:border-cyan/30 hover:text-ink"
      } disabled:opacity-40`}
    >
      <Star className={`h-3.5 w-3.5 ${saved ? "fill-current" : ""}`} aria-hidden />
      {saved ? "Watching" : blocked ? "List full" : "Watch"}
    </button>
  );
}
