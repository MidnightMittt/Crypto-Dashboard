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
   * Calendar days to that expiry. Carried WITH the figure because an
   * annualised vol is meaningless without its tenor — a three-day number and
   * a monthly one are different quantities wearing the same units.
   */
  atmIvDaysToExpiry: number | null;
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
  /**
   * Second-venue agreement, when a second options source is configured
   * (Tradier). Null when only CBOE answered — the chain is still fully
   * usable, it simply has not been corroborated. Attached after the fact by
   * the caller so this module stays venue-agnostic.
   */
  crossVenue?: CrossVenueRead | null;
}

/**
 * CROSS-VENUE CONFIRMATION — one venue's chain checked against another's.
 *
 * A single vendor's greeks are a model output, not a measurement: CBOE and
 * ORATS (Tradier's greeks source) run different implied-vol solvers on
 * different quote snapshots. Compared on the expiration BOTH venues list, so
 * the comparison is apples-to-apples rather than front-month against
 * full-chain.
 *
 * ── WHAT IS AND IS NOT INDEPENDENT ────────────────────────────────────
 *
 * Measured, not assumed: open interest is IDENTICAL across the two venues to
 * three decimals on every symbol checked (NVDA 0.673/0.673, AAPL
 * 0.518/0.518, IREN 0.800/0.800). It must be — open interest is published by
 * the OCC, one clearinghouse, and both venues redistribute it. So a
 * put/call-ratio "agreement" is a number agreeing with itself, and counting
 * it as corroboration would inflate the evidence. It is kept as a
 * DATA-INTEGRITY check (did both venues ingest the same OCC feed intact?)
 * and excluded from the agreement count.
 *
 * That leaves implied vol as the one genuinely independent check, and the
 * gamma SIGN as a coarse second one (each vendor's own gamma, weighted by
 * the shared open interest). The IV gap is reported in POINTS rather than as
 * a bare boolean, because magnitude is the information: the same measurement
 * pass found AAPL 6.1 points apart across venues while IREN agreed to 0.5.
 */
export interface CrossVenueRead {
  /** The shared expiration the comparison is computed on. */
  expiry: string;
  atmIvPctPrimary: number | null;
  atmIvPctSecondary: number | null;
  /** The gap itself — the number worth reading, in vol points. */
  ivGapPoints: number | null;
  ivAgree: boolean | null;
  /**
   * Shared-source integrity, NOT independent confirmation: both venues
   * redistribute OCC open interest, so these should match exactly.
   */
  putCallOiPrimary: number | null;
  putCallOiSecondary: number | null;
  openInterestIdentical: boolean | null;
  gexSignPrimary: number | null;
  gexSignSecondary: number | null;
  gexAgree: boolean | null;
  /**
   * Counts over the INDEPENDENT checks only (implied vol, gamma sign) —
   * deliberately excluding the shared-source put/call ratio.
   */
  agreements: number;
  comparisons: number;
  /** The read as a sentence. */
  line: string;
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

/** Map a venue's raw rows onto the shared ParsedContract shape. */
export function parseCboeContracts(contracts: CboeContract[]): ParsedContract[] {
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
  return parsed;
}

export function summariseChain(
  contracts: CboeContract[],
  spot: number,
  now: number = Date.now()
): OptionsSummary | null {
  return summariseParsed(parseCboeContracts(contracts), spot, now);
}

/**
 * The chain summary, computed from already-parsed contracts. Split out from
 * `summariseChain` so any venue — CBOE, Tradier — reaches the SAME summary
 * through the same arithmetic, and so the cross-venue comparison can
 * re-summarise a filtered subset (one shared expiry) without a second copy
 * of this logic.
 */
/**
 * Expiries closer than this are excluded from the ATM implied-vol read.
 * Mirrors `MIN_DAYS_TO_EXPIRY` in optionsIntelligence.ts deliberately — the
 * two venues must not disagree about what counts as a measurable tenor.
 */
const MIN_DAYS_TO_EXPIRY = 1;

/** `now` is injectable so the 0DTE rule is testable rather than clock-dependent. */
export function summariseParsed(
  parsed: ParsedContract[],
  spot: number,
  now: number = Date.now()
): OptionsSummary | null {
  if (!Number.isFinite(spot) || spot <= 0 || parsed.length === 0) return null;

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

  /*
   * ATM IV: nearest expiry, contracts within the band, average of nonzero
   * IVs.
   *
   * ── The unit is known, so it is not inferred ──────────────────────────
   *
   * This used to read `mean < 3 ? mean * 100 : mean`, guessing whether the
   * figure had already been scaled. Every source feeding `ParsedContract`
   * delivers a decimal — CBOE's own rows and Tradier's `toParsedContract`
   * alike — so the guess bought nothing and cost correctness above 300%.
   *
   * It was not hypothetical. HUT's nearest-expiry ATM IV is 3.345 today:
   * over the threshold, so the page reported "3%" for a stock implying 335%.
   * CIFR sits at 2.996 — four thousandths from the same failure. These are
   * exactly the names where implied vol is the number a reader most needs,
   * and the error is a factor of a hundred in the direction that makes
   * options look free.
   */
  /*
   * SAME 0DTE EXCLUSION THE TRADIER PATH ALREADY APPLIES, and for the same
   * reason — this is the module that actually renders on the equity dossier,
   * so the rule was only half-enforced.
   *
   * Annualising a contract with hours left divides a small move by a
   * near-zero sqrt(T), and the quotient pins high regardless of what the
   * market thinks. On 2026-08-14 every symbol checked sat on an expiring
   * -today chain and reported 216-300%: CIFR 300, HUT 299, IREN 272, WULF
   * 216, against realised vol nearer 90-120%. The clustering is the tell —
   * that is the annualisation, not four independent opinions about risk.
   *
   * "Options are implying a 300% move" is a conclusion a reader would act
   * on, and it would be wrong. When the whole chain is 0DTE we report null
   * rather than fall back to it: no number beats a fabricated one.
   */
  const daysOut = (expiry: string) =>
    (Date.parse(`${expiry}T00:00:00Z`) - now) / 86_400_000;

  const expiries = [...new Set(parsed.map((p) => p.expiry))].sort();
  const nearestExpiry = expiries.find((e) => daysOut(e) >= MIN_DAYS_TO_EXPIRY) ?? null;
  let atmIvPct: number | null = null;
  if (nearestExpiry) {
    const atm = parsed.filter(
      (p) => p.expiry === nearestExpiry && Math.abs(p.strike - spot) / spot <= ATM_BAND_PCT && p.iv > 0
    );
    if (atm.length >= 2) {
      atmIvPct = (atm.reduce((s, p) => s + p.iv, 0) / atm.length) * 100;
    }
  }

  /*
   * HOW FAR OUT THAT EXPIRY IS — the missing half of the number above.
   *
   * "Implied move 272%" is not usable without a horizon: annualised vol on a
   * three-day option is a different quantity from the same figure on a
   * monthly, and short-dated vol on a volatile name runs far above the term
   * structure's long end. The page carried the figure without its tenor
   * while ALSO showing a monthly expected move a few cards below — two IV
   * numbers with no way to tell why they disagreed.
   *
   * Computed here rather than in the component because this module already
   * runs per request on the server; deriving it at render time would make
   * the same summary produce different output depending on when it was
   * displayed.
   */
  const atmIvDaysToExpiry =
    nearestExpiry === null
      ? null
      : Math.max(0, Math.round(daysOut(nearestExpiry)));

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
    atmIvDaysToExpiry,
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

export type OptionsResult =
  | { ok: true; summary: OptionsSummary; spot: number; contracts: ParsedContract[] }
  | { ok: false; reason: string };

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
  if (spot === undefined) return { ok: false, reason: `CBOE returned no price for ${symbol}.` };
  const contracts = parseCboeContracts(options);
  const summary = summariseParsed(contracts, spot);
  if (!summary) return { ok: false, reason: `CBOE returned no usable contracts for ${symbol}.` };
  return { ok: true, summary, spot, contracts };
}
