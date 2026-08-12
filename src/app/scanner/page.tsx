import Link from "next/link";
import { Card, CardContent } from "@/components/ui/Card";
import { ScannerTable } from "@/components/scanner/ScannerTable";
import {
  rankOpportunities,
  ScannableMarket,
  SetupSummary,
  ACTIONABLE_OPPORTUNITY,
} from "@/lib/signals/opportunityRanking";
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
  }));

  const ranked = rankOpportunities([...cryptoRows, ...equityRows]);
  const withSetups = ranked.filter((r) => r.setup != null);
  const actionable = ranked.filter((r) => r.opportunity >= ACTIONABLE_OPPORTUNITY);
  const lead = ranked[0];

  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-lg font-semibold text-ink">Scanner</h1>
          <div className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/" className="hover:text-ink">
              Crypto
            </Link>
            <Link href="/markets" className="hover:text-ink">
              Markets
            </Link>
          </div>
        </div>

        {/*
          THE ANSWER FIRST. A scanner that opens on a table makes the reader do
          the ranking the engine already did.
        */}
        <Card>
          <CardContent className="flex flex-col gap-2 py-5">
            {ranked.length === 0 ? (
              <p className="text-[13px] leading-relaxed text-ink">
                No market could be scored right now. Every data source for the crypto universe failed this
                cycle, and the equity snapshot is empty — this is an outage, not a quiet tape.
              </p>
            ) : (
              <>
                <p className="text-[13px] leading-relaxed text-ink">
                  {actionable.length === 0 ? (
                    <>
                      Nothing in {ranked.length} tracked markets clears the bar for a ranked opportunity.
                      Every one is either near the fence or thinly evidenced — which is a reason to wait,
                      not a reason to look harder.
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">{lead.asset}</span> leads on conviction × confidence
                      at {lead.opportunity}/100. {actionable.length} of {ranked.length} markets clear the
                      bar for a ranked opportunity, and {withSetups.length}{" "}
                      {withSetups.length === 1 ? "has" : "have"} a trade plan the engine will stand behind.
                    </>
                  )}
                </p>
                {lead && <p className="text-[12px] leading-relaxed text-ink-muted">{lead.headline}</p>}
              </>
            )}
          </CardContent>
        </Card>

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
