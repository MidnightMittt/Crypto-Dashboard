/**
 * Bullish/bearish lean for the Price × Funding chart's currently visible
 * window — direction of price, cross-checked against the LEVEL of funding
 * over that same window. Neither number means much alone; this exists
 * because price direction and funding level only become a genuine read once
 * you look at both together (see the framework this implements in full in
 * the chat history, or just read the narration this produces on-screen).
 *
 * Pure computation, split from HistoricalChart.tsx for the same reason
 * every other derived signal in sentiment/ is: testable with fixed input,
 * no chart library, no DOM.
 */

export type PriceDirection = "up" | "down" | "flat";
export type FundingSign = "positive" | "negative" | "neutral";
export type ChartLean = "bullish" | "bearish" | "coiling" | "neutral";

export interface ChartLeanResult {
  lean: ChartLean;
  priceDirection: PriceDirection;
  fundingSign: FundingSign;
  /** Net % change from the first to the last point in the window. */
  priceChangePct: number;
  /** Mean of the per-8h-normalized funding readings across the window. */
  avgFundingPct: number;
}

/**
 * Funding's neutral zone, reused from FUNDING_BANDS (bands.ts) rather than
 * invented separately — the Funding gauge already draws the line between
 * "balanced" and "leaning" at ±0.04%, and this should agree with that
 * gauge rather than disagree on what counts as neutral.
 */
const FUNDING_NEUTRAL_LOW = -0.04;
const FUNDING_NEUTRAL_HIGH = 0.04;

/**
 * Classifies the visible window. `flatThresholdPct` is supplied by the
 * caller because "flat" means something different on a 15m chart than a
 * 1W one — this function doesn't know which timeframe it's looking at, it
 * just applies whatever boundary it's given.
 *
 * Returns null when there isn't enough data to say anything: fewer than 2
 * price points, or no funding reading anywhere in the window. A missing
 * lean is the honest answer in both cases, not a guess.
 */
export function classifyChartLean(
  points: Array<{ price: number; funding: number | null }>,
  flatThresholdPct: number
): ChartLeanResult | null {
  if (points.length < 2) return null;

  const first = points[0].price;
  const last = points[points.length - 1].price;
  if (!(first > 0)) return null;

  const priceChangePct = ((last - first) / first) * 100;

  const fundingValues = points
    .map((p) => p.funding)
    .filter((f): f is number => f !== null && Number.isFinite(f));
  if (fundingValues.length === 0) return null;

  const avgFundingPct = fundingValues.reduce((s, v) => s + v, 0) / fundingValues.length;

  const priceDirection: PriceDirection =
    priceChangePct > flatThresholdPct ? "up" : priceChangePct < -flatThresholdPct ? "down" : "flat";

  const fundingSign: FundingSign =
    avgFundingPct > FUNDING_NEUTRAL_HIGH
      ? "positive"
      : avgFundingPct < FUNDING_NEUTRAL_LOW
        ? "negative"
        : "neutral";

  let lean: ChartLean;
  if (priceDirection === "flat") {
    // Coiling only means something when funding ISN'T neutral: a flat price
    // with flat funding is just a quiet market, not leverage building.
    lean = fundingSign === "neutral" ? "neutral" : "coiling";
  } else {
    lean = priceDirection === "up" ? "bullish" : "bearish";
  }

  return { lean, priceDirection, fundingSign, priceChangePct, avgFundingPct };
}
