"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { normaliseInput } from "@/lib/search/resolveTicker";

/**
 * THE SEARCH BOX — one ticker, the full engine.
 *
 * Deliberately a plain form that navigates, rather than an
 * autocomplete-as-you-type widget. Two reasons:
 *
 *  1. Every analysis costs a real upstream fetch. Firing one per keystroke
 *     would hammer the provider to answer questions nobody asked.
 *  2. The result is a PAGE, not a dropdown row — it has a verdict, a plan and
 *     levels. A suggestion list would imply the answer is a name, when the
 *     answer is the analysis.
 *
 * Resolution happens on the server; this only normalises enough to build the
 * URL, so the client and server can never disagree about which symbol was
 * requested.
 */
export function TickerSearch({
  autoFocus = false,
  showHelp = true,
}: {
  autoFocus?: boolean;
  /**
   * The explanatory line below the box. Worth its space where search IS the
   * screen (the scanner, the no-read page), and pure noise at the top of a
   * dossier the reader is already looking at — where four lines of "here is
   * what this engine does" push the verdict below the fold and cost exactly
   * the first-screen attention the answer is supposed to own.
   */
  showHelp?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState("");
  const [pending, setPending] = React.useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const { symbol } = normaliseInput(value);
    if (!symbol) return;
    setPending(true);
    router.push(`/asset/${encodeURIComponent(symbol)}`);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline bg-void/40 px-3 py-2.5 focus-within:border-cyan/40">
        <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="characters"
          autoComplete="off"
          aria-label="Search any ticker"
          placeholder="Search any ticker — AAPL, NVDA, IREN, BTC…"
          className="w-full bg-transparent font-mono text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="submit"
          disabled={pending || value.trim().length === 0}
          className="shrink-0 rounded-md border border-hairline px-3 py-1 text-[11px] uppercase tracking-[0.14em] text-ink-muted transition-colors hover:border-cyan/40 hover:text-ink disabled:opacity-40"
        >
          {pending ? "Reading…" : "Analyse"}
        </button>
      </div>
      {showHelp && (
        <p className="text-[11px] leading-relaxed text-ink-faint">
          Any US-listed stock or major crypto. The full engine runs on it — trend, volatility, support and
          resistance, strength against the market, and a trade plan when the geometry supports one. Coverage
          differs by asset, and the page says which parts were available.
        </p>
      )}
    </form>
  );
}
