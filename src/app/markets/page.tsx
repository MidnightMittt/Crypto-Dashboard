import Link from "next/link";
import { Card, CardContent } from "@/components/ui/Card";
import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { intensityLabel } from "@/lib/signals/scoring";
import snapshot from "@/data/equityMarkets.json";

/**
 * MARKETS — the traditional-market counterpart to the crypto surface.
 *
 * Same decision engine, same MetricVerdict contract, same
 * `buildMarketBias`, same five-state `intensityLabel`. The ONLY difference is
 * which evidence modules were available to feed it, which is exactly the
 * capability split the architecture exists to express.
 *
 * The evidence-base disparity is stated on the page rather than left to be
 * inferred. An equity read is built on five modules against crypto's
 * eighteen, so its confidence is genuinely and correctly lower — and a user
 * comparing a 40%-confidence SPY to a 60%-confidence BTC must be able to see
 * that this reflects how much evidence exists, not how good the setup is.
 */

interface MarketDecision {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
}

const data = snapshot as unknown as { generatedAt: number; decisions: MarketDecision[] };

export const metadata = { title: "Markets — Leverage Terminal" };

export default function MarketsPage() {
  const { decisions } = data;
  const asOf = decisions.length > 0 ? Math.max(...decisions.map((d) => d.asOf)) : data.generatedAt;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="text-lg font-semibold tracking-tight text-ink">Markets</h1>
            <Link href="/crypto" className="text-[11px] uppercase tracking-[0.16em] text-ink-muted hover:text-ink">
              ← Crypto
            </Link>
          </div>
          <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">
            The same decision engine that scores crypto, reading equity evidence. Data through{" "}
            {new Date(asOf).toISOString().slice(0, 10)}, from daily closes.
          </p>
        </header>

        {/*
          The scope caveat is a first-class element, not fine print. Without
          it a 40%-confidence equity read looks like a weak setup rather than
          a thinly-evidenced one.
        */}
        <div className="rounded-md border border-hairline bg-white/[0.02] px-3 py-2.5 text-[11px] leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Evidence scope:</span> equities are scored on five modules —
          relative strength, breadth, risk appetite, volatility regime and trend quality — against
          crypto&apos;s eighteen. Confidence here is correspondingly and correctly lower. Derivatives and
          on-chain evidence have no equity analogue; ETF flows, earnings and options flow are not built
          because no provider for them is ingested.
        </div>

        {decisions.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No market decisions available. Run{" "}
            <code className="text-ink">npx tsx scripts/ingest/buildMarketsSnapshot.ts</code>.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {decisions.map((d) => (
              <MarketDecisionCard key={d.symbol} decision={d} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function MarketDecisionCard({ decision }: { decision: MarketDecision }) {
  const { bias } = decision;
  const tone =
    bias.verdict === "bullish" ? "text-success" : bias.verdict === "bearish" ? "text-danger" : "text-ink-muted";

  // Split against the DECISION, identically to the crypto panel: a bearish
  // metric is support when the decision is bearish.
  const leadSide = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  const againstSide = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Link
            href={`/markets/${decision.symbol.toLowerCase()}`}
            className="flex items-baseline gap-2.5 hover:underline"
          >
            <span className="font-mono text-sm font-semibold text-ink">{decision.symbol}</span>
            <span className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">{decision.name}</span>
          </Link>
          <span
            className={`font-mono text-[11px] ${
              decision.change24hPct > 0 ? "text-success" : decision.change24hPct < 0 ? "text-danger" : "text-ink-faint"
            }`}
          >
            {decision.change24hPct >= 0 ? "+" : ""}
            {decision.change24hPct.toFixed(2)}%
          </span>
        </div>

        {/* The decision leads, exactly as on the crypto panel. */}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`text-2xl font-bold uppercase leading-none tracking-[0.04em] ${tone}`}>
            {intensityLabel(bias.score)}
          </span>
          <span className="font-mono text-base leading-none text-ink">{bias.score}</span>
          <span className="text-[11px] text-ink-faint">/ 100 · Confidence {bias.confidence}%</span>
        </div>

        {/* The engine's own explanation — the same buildHeadline output. */}
        <p className="text-[13px] leading-relaxed text-ink">{bias.headline}</p>

        <div className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-hairline pt-3 sm:grid-cols-2">
          <EvidenceList title="Evidence for" mark="✓" markClass="text-success" items={leadSide} empty="None." />
          <EvidenceList
            title="Evidence against"
            mark="✕"
            markClass="text-danger"
            items={againstSide}
            empty="Nothing material argues the other way."
          />
        </div>
      </CardContent>
    </Card>
  );
}

function EvidenceList({
  title,
  mark,
  markClass,
  items,
  empty,
}: {
  title: string;
  mark: string;
  markClass: string;
  items: MetricVerdict[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-2 text-xs leading-relaxed">
              <span aria-hidden className={`shrink-0 ${markClass}`}>
                {mark}
              </span>
              <span className="text-ink">{m.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
