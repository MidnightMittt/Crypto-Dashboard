import { SentimentBand } from "@/types/market";

export function bandFor(value: number, bands: SentimentBand[]): SentimentBand {
  return bands.find((b) => value >= b.min && value <= b.max) ?? bands[bands.length - 1];
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

export const COMPOSITE_BANDS: SentimentBand[] = [
  { min: 0, max: 10, label: "Maximum Fear", description: "Capitulation-grade conditions — deleveraging is likely near exhaustion." },
  { min: 10, max: 25, label: "Bearish", description: "Sentiment and positioning both lean defensive." },
  { min: 25, max: 45, label: "Neutral Bearish", description: "Slight bearish tilt, nothing extreme." },
  { min: 45, max: 55, label: "Neutral", description: "No meaningful skew in either direction." },
  { min: 55, max: 75, label: "Bullish", description: "Sentiment and positioning both lean constructive." },
  { min: 75, max: 90, label: "Greedy", description: "Optimism is running hot — watch for overextension." },
  { min: 90, max: 100, label: "Extreme Leverage", description: "Euphoric positioning — historically a fragile regime." },
];
