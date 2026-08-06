import { swr } from "../cache/swr";
import { timeoutSignal } from "../net/timeout";

/**
 * FRED macro liquidity regime — Dashboard v2 spec's macro liquidity engine
 * (Sub-phase B). Per the brief: "Do NOT build a macro dashboard... instead
 * feed macro conditions into the existing Market Thesis." This module has
 * NO UI card — it feeds evaluateMacroLiquidity in signals/evaluators.ts,
 * which surfaces through the existing marketStress category and
 * AiMarketSummary's narrative, same pattern as sectorBreadth.ts.
 *
 * ── Which 5 series, and why ─────────────────────────────────────────────
 *
 * All 9 candidate FRED series were spiked live before writing this file.
 * They split into two tiers by reporting cadence:
 *   - Fresh enough to drive a LIVE classification (used here): NFCI
 *     (Chicago Fed's own composite financial-conditions index, weekly),
 *     T10Y2Y (10y-2y Treasury spread, daily), RRPONTSYD (overnight reverse
 *     repo usage, daily), WTREGEN (Treasury General Account balance,
 *     weekly), EFFR (effective fed funds rate, daily).
 *   - Monthly with a 1-2 month reporting lag (CPIAUCSL, PPIACO, UNRATE,
 *     M2SL): too stale to drive a LIVE read — not fetched here. A future
 *     "context" pass could surface them as static text, not a scoring
 *     input; deliberately out of scope for this pass to avoid feature
 *     bloat the brief explicitly warned against.
 *
 * ── The two-axis classifier ─────────────────────────────────────────────
 *
 * No WALCL (total Fed balance sheet) series is in this set, so the
 * classic "Net Liquidity = WALCL - TGA - RRP" formula can't be computed
 * in full. What IS computable from RRP + TGA alone: whether money is
 * flowing INTO those two liquidity sinks (draining markets) or OUT of
 * them (returning to markets) — directionally the same signal, just
 * missing the balance-sheet term. See classifyLiquidityRegime.
 *
 * NFCI and T10Y2Y answer a different question — not "how much liquidity"
 * but "how tight/loose are financial conditions, and is the yield curve
 * flagging recession risk." See classifyRiskRegime.
 *
 * EFFR is deliberately NOT a classification input: it moves in discrete
 * FOMC-decision steps, not a continuous trend, so there's no clean
 * "expanding/contracting" threshold to apply to it day-to-day. It ships
 * as context text only (see macroLiquidityContext in evaluators.ts).
 */

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRESH_MS = 6 * 60 * 60_000; // none of these 5 series update intraday; matches macro.ts's TREASURY_FRESH_MS
const MAX_AGE_MS = 24 * 60 * 60_000;

/** ±$50B combined RRP+TGA move over the lookback window is a materially significant net-liquidity shift — these balances have ranged from under $100B to over $2T across recent cycles, so $50B is a real move, not noise. */
export const LIQUIDITY_CHANGE_THRESHOLD_BN = 50;
/** NFCI is a slow-moving weekly composite; a tight band around zero avoids flapping between regimes on noise. */
export const NFCI_NEUTRAL_BAND = 0.1;

export interface FredPoint {
  date: string;
  value: number;
}

export type LiquidityRegime = "expanding" | "neutral" | "contracting";
export type RiskRegime = "risk-on" | "neutral" | "risk-off";

export interface MacroLiquiditySnapshot {
  nfci: FredPoint | null;
  t10y2y: FredPoint | null;
  effr: FredPoint | null;
  rrpChangeBn: number | null;
  tgaChangeBn: number | null;
  liquidityRegime: LiquidityRegime | null;
  riskRegime: RiskRegime | null;
  updatedAt: number;
}

/** expanding = liquidity sinks (RRP+TGA) draining, i.e. flowing back into markets. contracting = sinks filling, draining markets. Pure — hand-verified in macroLiquidity.test.ts. */
export function classifyLiquidityRegime(combinedSinkChangeBn: number | null): LiquidityRegime | null {
  if (combinedSinkChangeBn === null) return null;
  if (combinedSinkChangeBn <= -LIQUIDITY_CHANGE_THRESHOLD_BN) return "expanding";
  if (combinedSinkChangeBn >= LIQUIDITY_CHANGE_THRESHOLD_BN) return "contracting";
  return "neutral";
}

/** risk-off if EITHER financial conditions are tight OR the curve is inverted (either alone is a real warning). risk-on only if BOTH read calm. Pure — hand-verified in macroLiquidity.test.ts. */
export function classifyRiskRegime(nfci: number | null, t10y2y: number | null): RiskRegime | null {
  if (nfci === null && t10y2y === null) return null;
  const curveInverted = t10y2y !== null && t10y2y < 0;
  const conditionsTight = nfci !== null && nfci > NFCI_NEUTRAL_BAND;
  const conditionsLoose = nfci !== null && nfci < -NFCI_NEUTRAL_BAND;
  if (curveInverted || conditionsTight) return "risk-off";
  if (conditionsLoose) return "risk-on";
  return "neutral";
}

function parseObservations(json: unknown): FredPoint[] {
  const obs = (json as { observations?: Array<{ date?: string; value?: string }> })?.observations ?? [];
  const points: FredPoint[] = [];
  for (const o of obs) {
    if (!o.date) continue;
    const value = Number(o.value);
    if (!Number.isFinite(value)) continue; // FRED uses "." for withheld/missing observations
    points.push({ date: o.date, value });
  }
  return points;
}

async function fetchSeries(seriesId: string, limit: number): Promise<FredPoint[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];

  return swr(
    `fred:${seriesId}`,
    async () => {
      const res = await fetch(
        `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`,
        { signal: timeoutSignal(), cache: "no-store" }
      );
      if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
      const points = parseObservations(await res.json());
      if (points.length === 0) throw new Error(`FRED returned no usable observations for ${seriesId}`);
      return points;
    },
    { freshMs: FRESH_MS, maxAgeMs: MAX_AGE_MS }
  ).catch((err) => {
    console.warn(`[macroLiquidity] fetch failed for ${seriesId}:`, err);
    return [];
  });
}

/** Change from the latest observation to the one closest to `lookbackIndex` positions back in the desc-sorted series (a daily series needs more positions than a weekly one to span the same ~2 calendar weeks). */
function changeOverLookback(points: FredPoint[], lookbackIndex: number): number | null {
  if (points.length === 0) return null;
  const latest = points[0];
  const prior = points[Math.min(lookbackIndex, points.length - 1)];
  if (!prior) return null;
  return latest.value - prior.value;
}

export async function fetchMacroLiquidity(): Promise<MacroLiquiditySnapshot> {
  const [nfciPoints, t10y2yPoints, effrPoints, rrpPoints, tgaPoints] = await Promise.all([
    fetchSeries("NFCI", 3),
    fetchSeries("T10Y2Y", 3),
    fetchSeries("EFFR", 3),
    fetchSeries("RRPONTSYD", 15), // daily; ~10 trading days spans ~2 calendar weeks
    fetchSeries("WTREGEN", 4), // weekly; 2 positions back spans ~2 weeks
  ]);

  const rrpChangeBn = changeOverLookback(rrpPoints, 9); // RRPONTSYD is already in $B
  const tgaChangeMillions = changeOverLookback(tgaPoints, 2);
  const tgaChangeBn = tgaChangeMillions === null ? null : tgaChangeMillions / 1000; // WTREGEN is in $M

  const combinedSinkChangeBn = rrpChangeBn === null && tgaChangeBn === null ? null : (rrpChangeBn ?? 0) + (tgaChangeBn ?? 0);

  const nfci = nfciPoints[0] ?? null;
  const t10y2y = t10y2yPoints[0] ?? null;

  return {
    nfci,
    t10y2y,
    effr: effrPoints[0] ?? null,
    rrpChangeBn,
    tgaChangeBn,
    liquidityRegime: classifyLiquidityRegime(combinedSinkChangeBn),
    riskRegime: classifyRiskRegime(nfci?.value ?? null, t10y2y?.value ?? null),
    updatedAt: Date.now(),
  };
}
