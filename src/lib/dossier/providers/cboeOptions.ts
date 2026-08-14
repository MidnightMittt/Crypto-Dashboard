/**
 * OPTIONS & GAMMA — CBOE delayed chain, keyless.
 *
 * CBOE publishes the full delayed option chain with greeks already computed
 * per contract (gamma, delta, IV, open interest, volume). That makes it
 * strictly better for this purpose than crumb-gated retail endpoints: the
 * gamma exposure figure below is summed from exchange-published greeks, not
 * from our own Black-Scholes reimplementation.
 *
 * ── The one stated assumption ─────────────────────────────────────────
 *
 * Net gamma exposure uses the standard dealer-positioning convention:
 * dealers are assumed net LONG the calls customers bought and net SHORT the
 * puts. Under it, call gamma stabilises price (dealers sell rallies, buy
 * dips) and put gamma destabilises it. That convention is an industry
 * assumption, not an observation — nobody outside the clearing firms sees
 * true dealer inventory — so the summary carries the caveat everywhere the
 * number goes. Same discipline as the breadth proxy: useful, labelled.
 */

export interface CboeContract {
  option: string; // e.g. AAPL260814C00215000
  iv: number;
  gamma: number;
  delta: number;
  open_interest: number;
  volume: number;
}

export interface ParsedContract {
  expiry: string; // YYYY-MM-DD
  kind: "call" | "put";
  strike: number;
  iv: number;
  gamma: number;
  openInterest: number;
  volume: number;
}

/**
 * OCC-style symbol: ROOT + YYMMDD + C/P + strike*1000 padded to 8.
 * Parsed from the RIGHT, because the root symbol has variable length.
 */
export function parseContractSymbol(symbol: string): { expiry: string; kind: "call" | "put"; strike: number } | null {
  const m = symbol.match(/(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, date, cp, strikeRaw] = m;
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    expiry: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    kind: cp === "C" ? "call" : "put",
    strike,
  };
}

export interface OptionsSummary {
  spot: number;
  contractCount: number;
  /** Total open interest, calls and puts. */
  callOi: number;
  putOi: number;
  putCallOiRatio: number;
  /** Today's traded volume split the same way. */
  callVolume: number;
  putVolume: number;
  putCallVolumeRatio: number | null;
  /** IV of the contracts nearest the money on the nearest listed expiry, in percent. */
  atmIvPct: number | null;
  nearestExpiry: string | null;
  /**
   * Net gamma exposure in dollars per 1% move, under the stated dealer
   * convention: +call gamma, −put gamma, × OI × 100 shares × spot × 1%.
   * Positive = dealers dampen moves; negative = dealers amplify them.
   */
  netGexUsdPer1Pct: number | null;
  /** The largest open-interest strikes — where hedging pressure concentrates. */
  largestOiStrikes: Array<{ strike: number; kind: "call" | "put"; openInterest: number; expiry: string }>;
  /** The convention caveat, carried with the data rather than left to the UI. */
  gexCaveat: string;
  /** Today's flow read against the standing positions — the baseline that needs no history. */
  openingFlow: OpeningFlow;
}

/**
 * OPENING-FLOW DETECTION — the baseline a single snapshot can support.
 *
 * The one arithmetic certainty in an option chain: a contract that trades
 * MORE volume today than its entire standing open interest must include
 * opening trades — there are not enough existing positions for all of it to
 * be closing. That inequality is what makes "unusual options activity" a
 * measurement here rather than a vibe: no stored history, no threshold
 * someone picked against another symbol's norm.
 *
 * What it cannot say — stated, because the number will be read as more than
 * it is — is WHO opened or WHY: a hot call strike is new positioning, not
 * provably bullish positioning (it may be the short leg of a spread, or a
 * hedge). The direction claim stays at "new money chose this strike today."
 */
export interface OpeningFlow {
  /** Chain-wide: today's total volume as a share of total open interest. */
  chainVolumeOverOi: number | null;
  /** Strikes where volume ≥ 2× OI with an absolute floor — must-be-opening flow, sized. */
  hotStrikes: Array<{
    strike: number;
    kind: "call" | "put";
    expiry: string;
    volume: number;
    openInterest: number;
    volumeOverOi: number;
  }>;
  /** The read as a sentence. */
  signalLine: string;
}

/** A strike qualifies as hot only past BOTH bars: relative and absolute. */
const HOT_VOL_OVER_OI = 2;
/** Floor in contracts, so a 10-lot on 3 OI cannot masquerade as a signal. */
const HOT_MIN_VOLUME = 500;

export function detectOpeningFlow(parsed: ParsedContract[]): OpeningFlow {
  let totalVolume = 0;
  let totalOi = 0;
  const hot: OpeningFlow["hotStrikes"] = [];

  for (const p of parsed) {
    totalVolume += p.volume;
    totalOi += p.openInterest;
    if (p.volume >= HOT_MIN_VOLUME && p.volume >= HOT_VOL_OVER_OI * Math.max(p.openInterest, 1)) {
      hot.push({
        strike: p.strike,
        kind: p.kind,
        expiry: p.expiry,
        volume: p.volume,
        openInterest: p.openInterest,
        volumeOverOi: p.volume / Math.max(p.openInterest, 1),
      });
    }
  }
  hot.sort((a, b) => b.volume - a.volume);

  const chainVolumeOverOi = totalOi > 0 ? totalVolume / totalOi : null;
  const top = hot[0];

  const signalLine =
    hot.length === 0
      ? "No strike traded more than its standing open interest today — the flow is running through existing positions, not opening new ones."
      : `New positioning is being opened: ${hot.length} strike${hot.length === 1 ? "" : "s"} traded well past their standing open interest today, led by the ${top.strike} ${top.kind}s (${top.volume.toLocaleString()} contracts against ${top.openInterest.toLocaleString()} open — ${top.volumeOverOi.toFixed(1)}× must-be-opening flow). New money chose these strikes today; whether it is outright or the leg of a spread is not knowable from the tape.`;

  return { chainVolumeOverOi, hotStrikes: hot.slice(0, 3), signalLine };
}

/** Contracts more than this far from spot are noise for ATM IV purposes. */
const ATM_BAND_PCT = 0.05;

export function summariseChain(contracts: CboeContract[], spot: number): OptionsSummary | null {
  if (!Number.isFinite(spot) || spot <= 0 || contracts.length === 0) return null;

  const parsed: ParsedContract[] = [];
  for (const c of contracts) {
    const p = parseContractSymbol(c.option);
    if (!p) continue;
    parsed.push({
      ...p,
      iv: c.iv,
      gamma: c.gamma,
      openInterest: c.open_interest ?? 0,
      volume: c.volume ?? 0,
    });
  }
  if (parsed.length === 0) return null;

  let callOi = 0, putOi = 0, callVolume = 0, putVolume = 0;
  let gex = 0;
  let sawGamma = false;

  for (const p of parsed) {
    if (p.kind === "call") {
      callOi += p.openInterest;
      callVolume += p.volume;
    } else {
      putOi += p.openInterest;
      putVolume += p.volume;
    }
    if (Number.isFinite(p.gamma) && p.gamma !== 0 && p.openInterest > 0) {
      sawGamma = true;
      const sign = p.kind === "call" ? 1 : -1;
      // gamma (per $1) × OI × 100 shares × spot × 1% of spot
      gex += sign * p.gamma * p.openInterest * 100 * spot * (spot * 0.01);
    }
  }

  // ATM IV: nearest expiry, contracts within the band, average of nonzero IVs.
  const expiries = [...new Set(parsed.map((p) => p.expiry))].sort();
  const nearestExpiry = expiries[0] ?? null;
  let atmIvPct: number | null = null;
  if (nearestExpiry) {
    const atm = parsed.filter(
      (p) => p.expiry === nearestExpiry && Math.abs(p.strike - spot) / spot <= ATM_BAND_PCT && p.iv > 0
    );
    if (atm.length >= 2) {
      const mean = atm.reduce((s, p) => s + p.iv, 0) / atm.length;
      // CBOE reports IV as a decimal (0.28) — normalise to percent.
      atmIvPct = mean < 3 ? mean * 100 : mean;
    }
  }

  const largestOiStrikes = [...parsed]
    .filter((p) => p.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 3)
    .map((p) => ({ strike: p.strike, kind: p.kind, openInterest: p.openInterest, expiry: p.expiry }));

  return {
    spot,
    contractCount: parsed.length,
    callOi,
    putOi,
    putCallOiRatio: callOi > 0 ? putOi / callOi : 0,
    callVolume,
    putVolume,
    putCallVolumeRatio: callVolume > 0 ? putVolume / callVolume : null,
    atmIvPct,
    nearestExpiry,
    netGexUsdPer1Pct: sawGamma ? gex : null,
    largestOiStrikes,
    openingFlow: detectOpeningFlow(parsed),
    gexCaveat:
      "Gamma exposure assumes the standard dealer convention (dealers long customer calls, short customer puts). That is an industry assumption, not an observation — true dealer inventory is not public.",
  };
}

// ── Fetch layer ─────────────────────────────────────────────────────────

interface CboeResponse {
  data?: { current_price?: number; options?: CboeContract[] };
}

export type OptionsResult = { ok: true; summary: OptionsSummary } | { ok: false; reason: string };

export async function fetchOptionsSummary(symbol: string): Promise<OptionsResult> {
  let res: Response;
  try {
    res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      // Delayed quotes update intraday; 15 minutes matches their own delay.
      next: { revalidate: 900 },
    });
  } catch {
    return { ok: false, reason: "CBOE could not be reached this request." };
  }
  if (res.status === 404) {
    return { ok: false, reason: `CBOE lists no options for ${symbol} — many small-caps and all crypto have no listed chain there.` };
  }
  if (!res.ok) return { ok: false, reason: `CBOE returned HTTP ${res.status} for ${symbol}.` };

  let json: CboeResponse;
  try {
    json = (await res.json()) as CboeResponse;
  } catch {
    return { ok: false, reason: "CBOE returned an unreadable chain." };
  }

  const spot = json.data?.current_price;
  const options = json.data?.options ?? [];
  const summary = spot !== undefined ? summariseChain(options, spot) : null;
  if (!summary) return { ok: false, reason: `CBOE returned no usable contracts for ${symbol}.` };
  return { ok: true, summary };
}
