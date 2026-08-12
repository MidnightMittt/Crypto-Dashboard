import Link from "next/link";
import { Card, CardContent } from "@/components/ui/Card";
import { ScannerTable } from "@/components/scanner/ScannerTable";
import {
  rankOpportunities,
  explainRanking,
  ScannableMarket,
  SetupSummary,
  ACTIONABLE_OPPORTUNITY,
} from "@/lib/signals/opportunityRanking";
import { TopOpportunity } from "@/components/scanner/TopOpportunity";
import { getAssetComposites } from "@/lib/exchanges/assetComposites";
import { MarketBias } from "@/lib/signals/types";
import { TradePlan } from "@/lib/signals/tradePlan";
import snapshot from "@/data/equityMarkets.json";

/**
 * THE MARKET SCANNER — one ranked view of every market the engine covers.
 *
 * This is the answer to the question the single-asset surfaces cannot answer:
 * a swing thesis is active on roughly a quarter of days, so most visits to a
 * given asset end in "no setup", and the honest reply to that is not a longer
 * explanation — it is naming the market that DOES have one.
 *
 * ── One engine, two universes, no second opinion ───────────────────────
 *
 * Crypto rows come from `getAssetComposites`, which wraps the same
 * `getAggregateForAsset` the live asset page reads. Equity rows come from the
 * build-time snapshot, which is the same `buildMarketBias` output the Markets
 * pages render. Both are mapped onto `ScannableMarket` by field selection
 * alone — no adapter computes anything — and both then pass through the one
 * `rankOpportunities`.
 *
 * The two halves refresh at different rates and the page says so rather than
 * implying a uniform freshness it does not have. That asymmetry is real:
 * crypto trades continuously and equities close.
 */

interface EquitySnapshotRow {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
  plan: TradePlan | null;
}

const equity = snapshot as unknown as { generatedAt: number; decisions: EquitySnapshotRow[] };

/*
 * Crypto composites are behind a 5-minute swr cache; re-rendering this page
 * more often than that would produce identical output at real API cost. The
 * equity half only changes when the snapshot is rebuilt.
 */
export const revalidate = 300;

/**
 * An equity plan IS the setup — there is no separate thesis state machine for
 * equities, so its state is always "planned": geometry that exists and waits
 * for price. Labelling it "active" would claim a trigger the equity path has
 * no way to fire.
 */
function Tape({ label, value, tone = "text-ink" }: { label: string; value: string; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <span className={`font-mono ${tone}`}>{value}</span>
    </span>
  );
}

function equitySetup(row: EquitySnapshotRow): SetupSummary | null {
  if (!row.plan) return null;
  return {
    state: "planned",
    direction: row.bias.verdict === "bearish" ? "short" : "long",
    riskReward: row.plan.riskRewardRatio,
    stars: row.plan.stars,
    status: "waiting",
  };
}

/** Same selection the crypto composite makes, so both universes show the same kind of reason. */
function reasonsOf(bias: MarketBias, side: "for" | "against"): string[] {
  const agreeing = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  const opposing = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;
  return (side === "for" ? agreeing : opposing).slice(0, 3).map((m) => m.explanation);
}

export default async function ScannerPage() {
  const crypto = await getAssetComposites({}).catch(() => null);

  const cryptoRows: ScannableMarket[] = [
    ...(crypto?.btc ? [crypto.btc] : []),
    ...(crypto?.eth ? [crypto.eth] : []),
    ...(crypto?.altcoins?.assets ?? []),
  ].map((c) => ({ ...c, assetClass: "crypto" as const }));

  const equityRows: ScannableMarket[] = equity.decisions.map((d) => ({
    asset: d.symbol,
    name: d.name,
    assetClass: "equity" as const,
    score: d.bias.score,
    verdict: d.bias.verdict,
    confidence: d.bias.confidence,
    agreement: d.bias.agreement,
    riskLevel: d.bias.riskLevel,
    priceChange24hPct: d.change24hPct,
    headline: d.bias.headline,
    setup: equitySetup(d),
    reasonsFor: reasonsOf(d.bias, "for"),
    reasonsAgainst: reasonsOf(d.bias, "against"),
  }));

  const ranked = rankOpportunities([...cryptoRows, ...equityRows]);
  /* One-line state of the whole universe, so the tape has a shape before the table. */
  const withSetups = ranked.filter((r) => r.setup != null).length;
  const actionable = ranked.filter((r) => r.opportunity >= ACTIONABLE_OPPORTUNITY).length;
  const bullish = ranked.filter((r) => r.verdict === "bullish").length;
  const bearish = ranked.filter((r) => r.verdict === "bearish").length;

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-lg font-semibold text-ink">Scanner</h1>
          <div className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/crypto" className="hover:text-ink">
              Crypto
            </Link>
            <Link href="/markets" className="hover:text-ink">
              Markets
            </Link>
          </div>
        </div>

        {/*
          THE ANSWER FIRST, and in full. A scanner that opens on a table makes
          the reader redo the ranking the engine already did.
        */}
        {ranked.length === 0 ? (
          <Card>
            <CardContent className="py-5">
              <p className="text-[13px] leading-relaxed text-ink">
                No market could be scored right now. Every data source for the crypto universe failed
                this cycle, and the equity snapshot is empty — this is an outage, not a quiet tape.
              </p>
            </CardContent>
          </Card>
        ) : (
          <TopOpportunity
            lead={ranked[0]}
            runnerUp={ranked[1] ?? null}
            comparison={ranked[1] ? explainRanking(ranked[0], ranked[1]) : null}
            totalMarkets={ranked.length}
          />
        )}

        {ranked.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-[11px]">
            <Tape label="Tracked" value={`${ranked.length} markets`} />
            <Tape label="Clearing the bar" value={`${actionable}`} tone={actionable > 0 ? "text-cyan" : undefined} />
            <Tape label="With a plan" value={`${withSetups}`} />
            <Tape
              label="Direction"
              value={`${bullish} bullish · ${bearish} bearish · ${ranked.length - bullish - bearish} neutral`}
            />
          </div>
        )}

        <Card>
          <CardContent className="py-5">
            <ScannerTable rows={ranked} />
          </CardContent>
        </Card>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          <span className="text-ink-muted">Freshness differs by universe, deliberately.</span> Crypto rows
          are live, cached five minutes. Equity rows come from a daily-close snapshot built{" "}
          {new Date(equity.generatedAt).toISOString().slice(0, 10)} — equities close and crypto does not, so
          a single refresh rate would misrepresent one of them. Nothing on this page is computed here:
          every score, confidence and plan is the same engine output the per-market pages render.
        </p>
      </main>
    </div>
  );
}
