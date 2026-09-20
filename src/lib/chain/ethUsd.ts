import { Stamp } from "./config";

/**
 * ETH/USD from Kraken's public ticker — keyless, and LABELLED.
 *
 * The position card prices PONS as ETH_usd / 1.0001^tick, so it needs an
 * ETH/USD number, and the build order is explicit that this source must be
 * named on the card. This returns the value WITH its stamp so the card can
 * never show a PONS price without saying which venue's ETH it was derived from
 * — an unlabelled price is a bug by the same rule the cross-venue board runs on.
 *
 * Returns null rather than a fallback: a stale or invented ETH price would
 * quietly move every PONS figure, so absence is reported as absence.
 */
export async function fetchEthUsd(nowIso: string): Promise<{ value: number; stamp: Stamp } | null> {
  try {
    const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", {
      headers: { "User-Agent": "leverage-terminal/1.0" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: Record<string, { c?: [string, string] }> };
    const pair = body.result && Object.values(body.result)[0];
    const last = pair?.c?.[0];
    const value = last === undefined ? NaN : Number(last);
    if (!(Number.isFinite(value) && value > 0)) return null;
    return { value, stamp: { ts: nowIso, source: "kraken.ETHUSD.last" } };
  } catch {
    return null;
  }
}
