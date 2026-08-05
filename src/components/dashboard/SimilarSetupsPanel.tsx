"use client";

import { useState } from "react";
import { Collapsible } from "@/components/ui/Collapsible";
import { AggregateMarketData } from "@/types/market";
import { formatPct } from "@/lib/utils/format";
import { regimeTagLabel } from "@/lib/technicals/regimes";
import { SimilarSetupMatch } from "@/app/api/similar-setups/route";

/**
 * "The last N times this many signals lined up the same way, here's what
 * actually happened next" — the one genuinely new piece of evidence this
 * pass adds, versus everywhere else which surfaces stats that already
 * existed (see HistoricalPerformancePanel). Matches come from
 * lib/signals/similarity.ts's weighted-Hamming nearest-neighbor search over
 * ~2900 precomputed historical fingerprints, run server-side in
 * /api/similar-setups (the file is 873 KB — far too large to ever import
 * into a client component directly).
 *
 * No fabricated "probability of recurrence" — only what literally
 * happened, shown as forward 1d/7d returns verbatim, and match strength
 * framed as a plain count ("11 of 14 signals matched"), never a percentage
 * dressed up as odds.
 */
export function SimilarSetupsPanel({ aggregate }: { aggregate: AggregateMarketData }) {
  const [matches, setMatches] = useState<SimilarSetupMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  // Fetches once, the first time the section is opened — this is the one
  // card on the page genuinely optional to most visits, so it shouldn't add
  // a background request every poll cycle for something most people never
  // expand.
  async function load() {
    if (matches !== null || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/similar-setups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aggregate }),
      });
      const data = await res.json();
      setMatches(data.matches ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Collapsible
      title="Similar Historical Setups"
      summary={matches ? `${matches.length} found` : undefined}
      onOpen={load}
    >
      <div className="rounded-lg border border-hairline bg-surface-2 p-4">
        {loading && (
          <div className="space-y-2">
            <div className="h-8 w-full animate-pulse rounded bg-white/5" />
            <div className="h-8 w-full animate-pulse rounded bg-white/5" />
          </div>
        )}
        {error && (
          <p className="text-sm text-ink-faint">
            Could not load similar setups. Check that the app can reach /api/similar-setups.
          </p>
        )}
        {!loading && !error && matches?.length === 0 && (
          <p className="text-sm text-ink-faint">
            No comparable historical setup found — today&apos;s combination of signals hasn&apos;t
            recurred closely enough in {aggregate.asset}&apos;s recorded history to draw a
            comparison.
          </p>
        )}
        {!loading && !error && matches && matches.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] text-ink-faint">
              The {matches.length} closest historical days where {aggregate.asset}&apos;s signals
              lined up this closely, and what actually happened next. Not a prediction — only what
              literally occurred.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="pb-1.5 text-left font-medium">Date</th>
                  <th className="pb-1.5 text-left font-medium">Signals Matched</th>
                  <th className="pb-1.5 text-left font-medium">Regime</th>
                  <th className="pb-1.5 text-right font-medium">Return, next 1d</th>
                  <th className="pb-1.5 text-right font-medium">Return, next 7d</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((m) => (
                  <tr key={m.date} className="border-t border-hairline/60">
                    <td className="py-1.5 font-mono text-ink">{m.date}</td>
                    <td className="py-1.5 text-ink-muted">
                      {m.signalsMatched} of {m.signalsTotal}
                    </td>
                    <td className="py-1.5 text-ink-muted">
                      {m.regimeTags.map((t) => regimeTagLabel(t)).join(", ") || "—"}
                    </td>
                    <td
                      className={`py-1.5 text-right font-mono ${returnTone(m.forwardReturn1d)}`}
                    >
                      {m.forwardReturn1d === null ? "—" : formatPct(m.forwardReturn1d)}
                    </td>
                    <td
                      className={`py-1.5 text-right font-mono ${returnTone(m.forwardReturn7d)}`}
                    >
                      {m.forwardReturn7d === null ? "—" : formatPct(m.forwardReturn7d)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Collapsible>
  );
}

function returnTone(v: number | null): string {
  if (v === null) return "text-ink-faint";
  return v > 0 ? "text-success" : v < 0 ? "text-danger" : "text-ink-muted";
}
