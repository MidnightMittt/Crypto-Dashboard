import { SentimentBand } from "@/types/market";

export function bandFor(value: number, bands: SentimentBand[]): SentimentBand {
  return bands.find((b) => value >= b.min && value <= b.max) ?? bands[bands.length - 1];
}

/** A boundary a value could cross, and the band waiting on the other side. */
export interface BandEdge {
  threshold: number;
  label: string;
  /** Absolute distance from the current value to this boundary. */
  distance: number;
}

export interface BandTrigger {
  current: SentimentBand;
  /** Next boundary above. Null when already in the top band. */
  above: BandEdge | null;
  /** Next boundary below. Null when already in the bottom band. */
  below: BandEdge | null;
}

/**
 * The levels at which a reading would change its own classification.
 *
 * This is the mechanism behind the dashboard's "what to watch next": the
 * thresholds returned here are the SAME constants `bandFor` uses to produce
 * the verdict, so a stated trigger can never drift from the logic it
 * describes. Hard-coding "watch 0.04%" in a sentence somewhere would drift
 * the moment a band moved; reading it back out of the band table cannot.
 *
 * The outermost bounds (the first band's `min`, the last band's `max`) are
 * sentinels like -100/100 rather than meaningful levels, so a value in an
 * outer band reports `null` on that side instead of quoting a number no
 * market will ever reach.
 */
export function bandTrigger(value: number, bands: SentimentBand[]): BandTrigger {
  const index = bands.findIndex((b) => value >= b.min && value <= b.max);
  const i = index === -1 ? bands.length - 1 : index;
  const current = bands[i];

  const above =
    i < bands.length - 1
      ? { threshold: current.max, label: bands[i + 1].label, distance: Math.abs(current.max - value) }
      : null;

  const below =
    i > 0
      ? { threshold: current.min, label: bands[i - 1].label, distance: Math.abs(value - current.min) }
      : null;

  return { current, above, below };
}

/**
 * Which band a value falls in, plus where that band sits on a 0-100 axis —
 * the position a small BandGauge marker renders at. Position is by BAND
 * INDEX, not by where the value falls within its band's own min/max range:
 * a discrete "which of these N tiers" position is what "simple to look at
 * and take action on" calls for, not a continuous slider a user would have
 * to read precisely to interpret.
 */
export function bandPosition(
  value: number,
  bands: SentimentBand[]
): { index: number; position: number; label: string } {
  const found = bands.findIndex((b) => value >= b.min && value <= b.max);
  const index = found === -1 ? bands.length - 1 : found;
  const position = bands.length > 1 ? (index / (bands.length - 1)) * 100 : 50;
  return { index, position, label: bands[index]?.label ?? "" };
}

export const FUNDING_BANDS: SentimentBand[] = [
  { min: -100, max: -0.15, label: "Extreme Shorts", description: "Shorts are paying up heavily — crowded short positioning." },
  { min: -0.15, max: -0.04, label: "Bearish", description: "Funding leans negative; shorts hold a mild edge." },
  { min: -0.04, max: 0.04, label: "Neutral", description: "Funding is balanced — no clear positioning skew." },
  { min: 0.04, max: 0.15, label: "Bullish", description: "Funding leans positive; longs hold a mild edge." },
  { min: 0.15, max: 100, label: "Crowded Longs", description: "Longs are paying up heavily — crowded long positioning, squeeze risk from a downside shock rises." },
];

export const OI_BANDS: SentimentBand[] = [
  { min: 0, max: 15, label: "Very Low", description: "Open interest is thin relative to its recent range." },
  { min: 15, max: 40, label: "Low", description: "Below-average leverage participation." },
  { min: 40, max: 65, label: "Normal", description: "Open interest sits within its typical range." },
  { min: 65, max: 88, label: "High", description: "Elevated leverage participation building up." },
  { min: 88, max: 100, label: "Extremely High", description: "Open interest near recent extremes — a lot of leverage is on the table." },
];

export const LEVERAGE_HEAT_BANDS: SentimentBand[] = [
  { min: 0, max: 20, label: "Very Cold", description: "Leverage is light; the market has room to build a move." },
  { min: 20, max: 42, label: "Cold", description: "Below-average leverage stress." },
  { min: 42, max: 60, label: "Balanced", description: "Leverage is roughly in line with price action." },
  { min: 60, max: 82, label: "Hot", description: "Leverage is running ahead of price — conditions ripe for a flush." },
  { min: 82, max: 100, label: "Extreme Leverage", description: "Leverage is stretched thin against price — high squeeze/liquidation risk." },
];

export const LONG_SHORT_BANDS: SentimentBand[] = [
  { min: 0, max: 35, label: "Mostly Shorts", description: "Positioning skews heavily short." },
  { min: 35, max: 65, label: "Balanced", description: "Longs and shorts are roughly even." },
  { min: 65, max: 100, label: "Mostly Longs", description: "Positioning skews heavily long." },
];

/**
 * 25/75 split matches blockchaincenter.net's original Altcoin Season Index
 * definition (the index this app's altseasonIndex is a 30-day-window
 * variant of — see providers/globalMarket.ts) directly: Bitcoin Season at
 * or below 25, Altcoin Season at or above 75. Not an invented threshold.
 */
export const DOMINANCE_ROTATION_BANDS: SentimentBand[] = [
  { min: 0, max: 25, label: "BTC Season", description: "Capital is consolidating into BTC — few alts are outperforming it." },
  { min: 25, max: 75, label: "No Clear Rotation", description: "Neither BTC nor alts are dominating capital flows right now." },
  { min: 75, max: 100, label: "Altcoin Season", description: "Capital is rotating into alts — most are outperforming BTC." },
];

export const COMPOSITE_BANDS: SentimentBand[] = [
  { min: 0, max: 10, label: "Maximum Fear", description: "Capitulation-grade conditions — deleveraging is likely near exhaustion." },
  { min: 10, max: 25, label: "Bearish", description: "Sentiment and positioning both lean defensive." },
  { min: 25, max: 45, label: "Neutral Bearish", description: "Slight bearish tilt, nothing extreme." },
  { min: 45, max: 55, label: "Neutral", description: "No meaningful skew in either direction." },
  { min: 55, max: 75, label: "Bullish", description: "Sentiment and positioning both lean constructive." },
  { min: 75, max: 90, label: "Greedy", description: "Optimism is running hot — watch for overextension." },
  { min: 90, max: 100, label: "Extreme Leverage", description: "Euphoric positioning — historically a fragile regime." },
];
