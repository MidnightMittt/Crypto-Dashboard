import { SentimentBand } from "@/types/market";
// TYPE-ONLY on purpose: a runtime import here would put this module on a
// dependency edge it does not need. See fundingBandVerdict below.
import type { Verdict } from "@/lib/signals/types";

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

/**
 * LABELS NAME THE POSITIONING, NEVER THE PRICE IMPLICATION.
 *
 * The two middle bands were called "Bearish" and "Bullish", and that is a large
 * part of why funding's sign convention could be incoherent for so long without
 * looking incoherent. A band labelled "Bullish" reads as licence to emit a
 * bullish verdict on mildly positive funding — while the outer band on the SAME
 * side emitted bearish. One axis, two opposite conventions, the flip sitting at
 * 0.15%/8h. See `fundingBandVerdict` in signals/evaluators.ts for the
 * measurement that settled which one survives.
 *
 * Renamed to "Longs Paying" / "Shorts Paying": a statement about who pays to
 * hold, which is all a funding rate observes. What that implies for price is a
 * separate judgement, and it is now made in exactly one place.
 *
 * The band EDGES are unchanged and are known to be miscalibrated — +/-0.04%/8h
 * is roughly the 99th percentile of observed funding and +/-0.15%/8h is past the
 * range entirely. Recalibrating them is deliberately not bundled here; it would
 * move funding from speaking on ~1% of days to speaking on most of them, at the
 * largest weight in the table, which is a calibration decision needing its own
 * measurement. See ENGINE_VERSION 9.0.0's note.
 */
export const FUNDING_BANDS: SentimentBand[] = [
  { min: -100, max: -0.15, label: "Extreme Shorts", description: "Shorts are paying up heavily — crowded short positioning." },
  { min: -0.15, max: -0.04, label: "Shorts Paying", description: "Funding is negative; shorts are paying longs to hold." },
  { min: -0.04, max: 0.04, label: "Neutral", description: "Funding is balanced — no clear positioning skew." },
  { min: 0.04, max: 0.15, label: "Longs Paying", description: "Funding is positive; longs are paying shorts to hold." },
  { min: 0.15, max: 100, label: "Crowded Longs", description: "Longs are paying up heavily — crowded long positioning, squeeze risk from a downside shock rises." },
];

/**
 * THE ONE PLACE A FUNDING RATE BECOMES A DIRECTION. Fade the crowd, at every
 * magnitude. Whoever is paying to hold is the side exposed to an unwind.
 *
 * Shared by the aggregate CEX rate below, the Hyperliquid cross-check, and
 * marketThesis.ts's funding pillar — which used to hand-copy this mapping and
 * could therefore drift from it.
 *
 * ── It used to flip sign at 0.15%/8h, and the flip never ran ────────────
 *
 * The previous mapping faded the outer bands and TRENDED the middle two:
 * mildly positive funding read bullish, heavily positive funding read bearish.
 * Non-monotone on one axis, and the doc comment here described only the fade
 * half — "crowded longs are BEARISH evidence, not doubly bullish" — so the
 * declared convention and the shipped behaviour were opposites in the region
 * that actually occurs.
 *
 * Measured over the full 2,896-day replay (2022-08 to 2026-07):
 *
 *   Crowded Longs   (> +0.15%/8h)      0 days    <- the fade branch
 *   Longs Paying    (+0.04..+0.15)    30 days    <- trended, 100% of the
 *   Neutral         (-0.04..+0.04) 2,863 days       positive-side output
 *   Shorts Paying   (-0.15..-0.04)     2 days
 *   Extreme Shorts  (< -0.15%/8h)      1 day
 *
 * So the convention this comment advertised had executed once in four years,
 * on the short side, and every positive-funding verdict the engine ever
 * published came from the undeclared trend branch.
 *
 * ── Why fade won, and how weak the outcome evidence is ─────────────────
 *
 * Primarily coherence: squeezeRisk, marketThesis's own framing, and
 * FUNDING_BANDS' "Crowded Longs" description all fade. The engine now has one
 * convention on the leverage axis instead of two that fought each other
 * between 0.005% and 0.15%/8h — which is what made funding and squeezeRisk
 * disagree on 30 of the 30 replayed days where both spoke.
 *
 * The outcome evidence is consistent with fade and is NOT significant, stated
 * plainly because it would be easy to oversell: in the Longs Paying band
 * (n=30, ~15 independent dates once BTC/ETH same-day pairs collapse) price was
 * DOWN 66.7% of the time at 24h and the shipped trend reading won 33.3%,
 * mean -0.359%. Fade would have been right twice as often. At n_eff ~15 that
 * is p ~ 0.3. It points the right way and proves nothing; the argument is
 * coherence, and this is the tiebreak, not the case.
 *
 * ── The band EDGES are still wrong, and are deliberately still here ────
 *
 * +/-0.04%/8h is p98.96 of observed funding and +/-0.15%/8h is past the
 * maximum, so funding stays neutral on 98.9% of days while holding the largest
 * weight in METRIC_WEIGHTS (0.15, 24.2% of the crypto roster). A neutral metric
 * is not an absentee — computeWeightedScore adds its weight to `totalWeight`
 * and contributes 0 to `weightedSum` — so funding is a permanent 24% damper
 * toward 50 rather than a voter.
 *
 * 9.0.0 deferred the recalibration saying it "needs its own measurement".
 * That measurement now exists: scripts/audit/fundingBands.ts. IT CAME BACK
 * NULL, and the edges stay as they are because of the result, not the deferral.
 *
 * Fourteen specifications — seven symmetric percentile bands from p45/p55 out
 * to p5/p95, each evaluated on two different rank constructions — over 2,892
 * asset-days, block-bootstrapped over the date axis with BTC and ETH drawn
 * together and 10-day blocks absorbing the 7d overlap:
 *
 *   - Standalone bullish-minus-bearish forward 7d: no |t| above 1.25, and that
 *     one is the argmax of fourteen.
 *   - Conditional on squeezeRisk and basis (the 9 verdict cells): best t 1.25.
 *   - The SIGN is unstable. p45/p55 gives -0.131% on one rank and +0.255% on
 *     the other; p25/p75 gives +0.094% and -0.472%. BTC and ETH disagree in
 *     sign on every specification tested.
 *   - Only 2 of 9 conditional cells are usable at all. In three of them funding
 *     votes one way on every single row (0 bullish / 323 bearish; 93 / 0),
 *     because a percentile-banded funding IS very nearly a function of
 *     squeezeRisk and basis — squeezeRisk's largest component, 0.35 weight, is
 *     literally the funding percentile.
 *
 * So widening the bands would hand the composite a third reading of the
 * perp-vs-spot premium at 24% of the roster weight, with no measured
 * information of its own. Absence of evidence at ~144 independent 10-day
 * blocks is weak evidence of absence, which is exactly why this is a decision
 * to LEAVE ALONE rather than a licence to retire the metric.
 *
 * ── A caveat that outgrew this comment ─────────────────────────────────
 *
 * The replay's fundingPercentile and production's are not the same statistic.
 * The replay ranks a single-venue Binance 8-hourly series over an expanding
 * ~4-year window, 26.8% of which sits at exactly 0.010000%/8h — the Binance
 * baseline — which computeFundingPercentile ranks at p94 because it counts
 * ties as below. Production ranks an OI-weighted multi-venue average over a
 * rolling 30 days with no observed ties, and returned p65 when probed on
 * 2026-09-13. See section 8 of the audit script.
 */
export function fundingBandVerdict(pct: number): Verdict {
  // Monotone BY CONSTRUCTION rather than by a label chain: a sign convention
  // spelled out band-by-band is one edit away from flipping in the middle
  // again, and renaming a band should not be able to change a verdict.
  if (bandFor(pct, FUNDING_BANDS).label === "Neutral") return "neutral";
  return pct > 0 ? "bearish" : "bullish";
}

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
