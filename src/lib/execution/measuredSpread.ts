import spreadHistoryJson from "@/data/spreadHistory.json";

/**
 * MEASURED ROUND-TRIP COST — both legs, or nothing.
 *
 * Extracted so the pre-trade auditor and the cost comparison read the same
 * number. Two implementations of "what does this cost to trade" could
 * disagree on one page, and this figure decides whether a trade is refused.
 *
 * Cost lives at the EXIT as much as the entry, so a one-sided figure
 * understates it by roughly half. Null unless BOTH windows have
 * observations for the symbol: a round trip priced from one leg is a
 * modelled number wearing a measured one's clothes.
 */

interface SpreadObservation {
  session: string;
  symbol: string;
  window: string;
  spreadBp: number;
}

const observations = (spreadHistoryJson as { observations: SpreadObservation[] }).observations;

export function measuredRoundTripBp(symbol: string): number | null {
  const forWindow = (w: string) => {
    const xs = observations
      .filter((o) => o.symbol === symbol && o.window === w)
      .map((o) => o.spreadBp);
    return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  };
  const entry = forWindow("entry");
  const exit = forWindow("exit");
  if (entry === null || exit === null) return null;
  return Number((entry + exit).toFixed(2));
}
