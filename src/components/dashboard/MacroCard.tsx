"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { MacroSnapshot, MacroInstrumentQuote } from "@/lib/providers/macro";

/**
 * TradFi context — the Dashboard v2 spec's Macro browsing section.
 * Market-wide and read-only, same category of card as NetworkHealth.tsx:
 * genuinely NOT a scoring input (per the taxonomy decision confirmed with
 * the user — see [[dashboard-v2-roadmap]] memory), so it carries no lean/
 * gauge and never touches bias.score.
 *
 * DXY, Nasdaq, and S&P are ETF proxies (UUP/QQQ/SPY); Gold is a real spot
 * price (XAU/USD); VIX is an unleveraged short-term-futures ETF (VIXY),
 * not the raw index level — see providers/macro.ts's doc comment for the
 * full reachability spike this was built against and why each instrument
 * is what it is.
 */
export function MacroCard({ macro }: { macro: MacroSnapshot | null | undefined }) {
  if (!macro) return null;
  const hasAnyData =
    macro.dollarIndex || macro.gold || macro.nasdaq || macro.sp500 || macro.vix || macro.treasury10yPct !== null;
  if (!hasAnyData) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>Macro</CardTitle>
          <InfoTooltip
            measures="Traditional-finance context: dollar strength, equities, gold, volatility, and the 10-year Treasury yield."
            whyItMatters="Crypto doesn't trade in isolation from the rest of the financial system — a risk-off move in equities or a spiking dollar often shows up in crypto too. Context for the rest of the read, not a bullish/bearish signal of its own."
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <InstrumentStat label="Dollar Index" quote={macro.dollarIndex} />
          <InstrumentStat label="Gold" quote={macro.gold} />
          <InstrumentStat label="Nasdaq" quote={macro.nasdaq} />
          <InstrumentStat label="S&P 500" quote={macro.sp500} />
          <InstrumentStat label="VIX" quote={macro.vix} />
          {macro.treasury10yPct !== null && (
            <div>
              <div className="font-mono text-sm text-ink">{macro.treasury10yPct.toFixed(2)}%</div>
              <div className="text-[11px] uppercase tracking-widest text-ink-faint">10Y Treasury</div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function InstrumentStat({ label, quote }: { label: string; quote: MacroInstrumentQuote | null }) {
  if (!quote) return null;
  const toneClass = quote.changePct > 0 ? "text-success" : quote.changePct < 0 ? "text-danger" : "text-ink";
  return (
    <div>
      <div className="font-mono text-sm text-ink">{quote.price.toFixed(2)}</div>
      <div className={`font-mono text-[11px] ${toneClass}`}>
        {quote.changePct >= 0 ? "+" : ""}
        {quote.changePct.toFixed(2)}%
      </div>
      <div className="text-[11px] uppercase tracking-widest text-ink-faint">{label}</div>
    </div>
  );
}
