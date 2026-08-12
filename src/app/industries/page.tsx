import Link from "next/link";
import { IndustryRead, breadthDivergence } from "@/lib/markets/industryIntelligence";
import { ROTATION_STATE_LABEL, RotationState } from "@/lib/markets/rotation";
import snapshot from "@/data/marketIntelligence.json";

/**
 * THE INDUSTRY BOARD — level three, and the level a portfolio manager
 * actually allocates at.
 *
 * A sector is too coarse to own and a company is too specific to start from.
 * Industries are where the decision "which part of Technology" gets made, and
 * this is the first surface in the platform that can answer it.
 *
 * ── The column that makes this page worth existing ────────────────────
 *
 * BREADTH. The ETF tells you the industry is up; breadth tells you whether
 * the industry is up or whether three names are. Those are different
 * positions with different risks, and no price chart distinguishes them.
 */

const data = snapshot as unknown as { generatedAt: number; industries: IndustryRead[] };

export const metadata = { title: "Industries — Leverage Terminal" };

const STATE_TONE: Record<RotationState, string> = {
  improving: "text-success",
  leading: "text-cyan",
  weakening: "text-amber",
  lagging: "text-ink-faint",
};

export default function IndustriesPage() {
  const { industries } = data;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1300px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Industries</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              Between sectors and companies · {industries.length} tracked
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/" className="hover:text-ink">
              ← Intelligence
            </Link>
            <Link href="/scanner" className="hover:text-ink">
              Scanner
            </Link>
          </nav>
        </div>

        {industries.length === 0 ? (
          <p className="rounded-xl border border-hairline bg-panel/60 px-5 py-6 text-[13px] leading-relaxed text-ink">
            No industry could be built. The proxy ETFs are not ingested — an outage, not an empty market.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-hairline bg-panel/60 shadow-glass backdrop-blur-xs">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-hairline text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                  <th className="px-4 py-3 font-medium">Industry</th>
                  <th className="px-3 py-3 font-medium">State</th>
                  <th className="px-3 py-3 text-right font-medium">1m vs SPY</th>
                  <th className="px-3 py-3 text-right font-medium">6m vs SPY</th>
                  <th className="px-3 py-3 font-medium">Breadth</th>
                  <th className="px-3 py-3 font-medium">Parent sector</th>
                  <th className="px-4 py-3 font-medium">Flag</th>
                </tr>
              </thead>
              <tbody>
                {industries.map((i) => {
                  const divergence = breadthDivergence(i);
                  return (
                    <tr key={i.slug} className="border-b border-hairline/60 transition-colors hover:bg-panel-hi/40">
                      <td className="px-4 py-3">
                        <Link href={`/industry/${i.slug}`} className="text-[13px] text-ink hover:text-cyan">
                          {i.name}
                        </Link>
                        <div className="mt-0.5 font-mono text-[10px] text-ink-faint">
                          {i.etf} · {i.measured} names
                        </div>
                      </td>
                      <td className={`px-3 py-3 text-[11px] font-semibold uppercase tracking-[0.1em] ${STATE_TONE[i.rotation.state]}`}>
                        {ROTATION_STATE_LABEL[i.rotation.state]}
                      </td>
                      <td className={`px-3 py-3 text-right font-mono text-[12px] ${i.rotation.shortRelPct >= 0 ? "text-success" : "text-danger"}`}>
                        {i.rotation.shortRelPct >= 0 ? "+" : ""}
                        {i.rotation.shortRelPct.toFixed(1)}
                      </td>
                      <td className={`px-3 py-3 text-right font-mono text-[12px] ${i.rotation.longRelPct >= 0 ? "text-success" : "text-danger"}`}>
                        {i.rotation.longRelPct >= 0 ? "+" : ""}
                        {i.rotation.longRelPct.toFixed(1)}
                      </td>
                      <td className="px-3 py-3">
                        {i.breadthPct === null ? (
                          <span className="text-[11px] text-ink-faint">too few names</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-void">
                              <span
                                className={`block h-full ${
                                  i.breadthPct >= 60 ? "bg-success" : i.breadthPct <= 35 ? "bg-danger" : "bg-ink-muted"
                                }`}
                                style={{ width: `${i.breadthPct}%` }}
                              />
                            </span>
                            <span className="font-mono text-[11px] text-ink-muted">{i.breadthPct}%</span>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-[11px] text-ink-muted">
                        {i.sectorName}
                        {i.sectorState && (
                          <span className={`ml-1.5 uppercase ${STATE_TONE[i.sectorState]}`}>
                            {i.sectorState}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[11px] leading-relaxed text-amber">
                        {divergence ?? <span className="text-ink-faint">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[10px] leading-relaxed text-ink-faint">
          Every number is the industry ETF&apos;s return minus the S&amp;P&apos;s over the same window,
          produced by the same <code>buildRotation</code> the sector board uses — sectors, industries and
          companies are one measurement applied at three levels. Breadth is the share of tracked
          constituents beating the index, counted once each rather than cap-weighted: the ETF already
          gives the cap-weighted answer, and the useful number is the one that disagrees with it.
          Constituent lists are declared membership, not rankings, and are not exhaustive. Daily closes
          through {new Date(data.generatedAt).toISOString().slice(0, 10)}.
        </p>
      </main>
    </div>
  );
}
