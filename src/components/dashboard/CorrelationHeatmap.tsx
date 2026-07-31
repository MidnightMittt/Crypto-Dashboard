"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CorrelationMatrix } from "@/lib/sentiment/correlation";

/**
 * Pairwise return correlation across every asset this app tracks that
 * CoinGecko answered for this cycle — tells you whether "altseason" is a
 * genuine dispersion event or everything is just moving together, which
 * directly informs how much to trust any single-asset signal elsewhere on
 * this dashboard as idiosyncratic rather than market-wide noise.
 *
 * Coverage can be partial: CoinGecko's free tier is rate-limited and shared
 * with this app's other CoinGecko usage, so some polls may only return a
 * subset of the 10 tracked assets. Shown honestly as however many came
 * back, not padded or hidden.
 */
export function CorrelationHeatmap({ correlation }: { correlation: CorrelationMatrix | null }) {
  return (
    <Card>
      <CardHeader className="flex-wrap gap-2">
        <CardTitle>Cross-Asset Correlation</CardTitle>
        {correlation && (
          <span className="font-mono text-[11px] text-ink-faint">
            {correlation.windowDays}d returns · {correlation.assets.length} assets
          </span>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {!correlation || correlation.assets.length < 2 ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Still gathering enough price history across assets to compute correlation. No key needed —
            this reads CoinGecko&apos;s public price history and fills in on its own.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[10px]">
                <thead>
                  <tr>
                    <th className="p-1" />
                    {correlation.assets.map((a) => (
                      <th key={a} className="p-1 font-mono font-normal text-ink-faint">
                        {a}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {correlation.assets.map((rowAsset, i) => (
                    <tr key={rowAsset}>
                      <th className="p-1 text-right font-mono font-normal text-ink-faint">{rowAsset}</th>
                      {correlation.assets.map((colAsset, j) => {
                        const v = correlation.matrix[i][j];
                        return (
                          <td
                            key={colAsset}
                            className="p-1 text-center font-mono text-ink"
                            style={cellStyle(v)}
                            title={`${rowAsset} vs ${colAsset}: ${v === null ? "not enough overlapping data" : v.toFixed(3)}`}
                          >
                            {v === null ? "—" : v.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">{narrate(correlation)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function cellStyle(v: number | null): React.CSSProperties {
  if (v === null) return { backgroundColor: "rgba(255,255,255,0.03)" };
  if (v === 1) return { backgroundColor: "rgba(255,255,255,0.05)" }; // diagonal — trivially self-correlated, de-emphasized
  const intensity = Math.min(Math.abs(v), 1);
  const rgb = v >= 0 ? "34,197,94" : "239,68,68"; // success / danger
  return { backgroundColor: `rgba(${rgb}, ${(0.1 + intensity * 0.45).toFixed(2)})` };
}

function narrate(c: CorrelationMatrix): string {
  const offDiagonal: number[] = [];
  for (let i = 0; i < c.assets.length; i++) {
    for (let j = i + 1; j < c.assets.length; j++) {
      const v = c.matrix[i][j];
      if (v !== null) offDiagonal.push(v);
    }
  }
  if (offDiagonal.length === 0) return "Not enough overlapping data yet to read pairwise correlation.";

  const avg = offDiagonal.reduce((s, v) => s + v, 0) / offDiagonal.length;
  if (avg >= 0.8) {
    return `Average pairwise correlation is ${avg.toFixed(2)} — assets are moving almost as one. A single-asset signal elsewhere on this dashboard is more likely reflecting market-wide conditions than something specific to that asset.`;
  }
  if (avg <= 0.4) {
    return `Average pairwise correlation is ${avg.toFixed(2)} — genuine dispersion right now. Single-asset signals elsewhere are more likely to actually be about that asset.`;
  }
  return `Average pairwise correlation is ${avg.toFixed(2)} — moderate, typical crypto-wide co-movement.`;
}
