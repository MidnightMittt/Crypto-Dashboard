import { MetricVerdict } from "@/lib/signals/types";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { RawReadings } from "./fingerprintInputs";

/**
 * THE RAW READINGS, from state the replay already holds.
 *
 * Pure, and deliberately so: the replay walks 4,500 sessions × 120
 * instruments with carefully truncated inputs, and re-deriving any of this
 * from a second source would be a second chance to get the truncation wrong.
 * Everything below is read from the point-in-time analysis the replay just
 * produced for that (symbol, date) — the same object the live page builds.
 *
 * ── Nine of eleven ────────────────────────────────────────────────────
 *
 * `sectorLeadership` and `industryLeadership` are absent, and the reason is
 * mundane rather than principled: the replay loads price series, not the
 * sector and industry membership map the live page inherits from the daily
 * intelligence snapshot. Wiring that in is a real change to the ingest, not
 * a line here, so they are left out rather than approximated from something
 * that happens to be lying around.
 *
 * That is safe by construction. `fingerprintDistance` compares the
 * intersection of dimensions and requires a minimum overlap, so a vector
 * without those two is simply compared on the nine it has. Nothing is
 * scored as "average" that was never measured.
 */

/** A dimension is emitted only when its input actually exists. */
const put = (out: RawReadings, id: string, v: number | null | undefined): void => {
  if (typeof v === "number" && Number.isFinite(v)) out[id] = v;
};

const metric = (metrics: MetricVerdict[], id: string): MetricVerdict | undefined =>
  metrics.find((m) => m.id === id);

/**
 * A directional reading as a signed magnitude.
 *
 * Verdict and confidence are combined rather than used separately because
 * the pair is one piece of information: a bullish read at 20% confidence and
 * a bullish read at 90% confidence describe genuinely different days, and
 * standardising the verdict alone would call them identical.
 */
const signed = (m: MetricVerdict | undefined): number | null => {
  if (!m) return null;
  const sign = m.verdict === "bullish" ? 1 : m.verdict === "bearish" ? -1 : 0;
  return sign * m.confidence;
};

export interface ReadingInputs {
  /** Closes for the trailing window, oldest first, ending at the fingerprint date. */
  closes: number[];
  /** Volumes over the same window, same ordering. */
  volumes: number[];
  /** Every metric the engine produced for this instrument on this date. */
  metrics: MetricVerdict[];
  /** Support/resistance as the engine saw it at this date. */
  zones: SupportResistanceZone[];
  /** Average true range as a percent of price, at this date. */
  atrPct: number | null;
}

/**
 * Nine raw dimension values for one instrument on one date.
 *
 * Returns raw, UNSTANDARDISED numbers on purpose — standardisation is the
 * leak-sensitive step and belongs in `RollingStandardiser`, which enforces
 * read-before-write. Splitting them keeps this function trivially testable
 * with no notion of history at all.
 */
export function rawReadings(inputs: ReadingInputs): RawReadings {
  const { closes, volumes, metrics, zones, atrPct } = inputs;
  const out: RawReadings = {};
  const last = closes[closes.length - 1];

  /*
   * TREND — the 60-session log return, expressed in daily-range units.
   * Dividing by ATR is what makes it comparable across instruments before
   * any standardisation: a 10% move means something different for a utility
   * than for a biotech, and the daily range is the natural unit of "how far
   * is that, for this instrument".
   */
  if (closes.length >= 61 && atrPct && atrPct > 0) {
    const prior = closes[closes.length - 61];
    if (prior > 0) put(out, "trend", (Math.log(last / prior) * 100) / atrPct);
  }

  // VOLATILITY — the daily range itself, standardised later against its own past.
  put(out, "volatility", atrPct);

  /*
   * TECHNICAL STRUCTURE — where price sits between the nearest support and
   * the nearest resistance, 0 at support and 1 at resistance. Position in
   * the range, not distance travelled: a stock at the top of its range is in
   * the same structural situation whether it got there quickly or slowly.
   */
  const supports = zones.filter((z) => z.kind === "support" && z.priceHigh <= last);
  const resistances = zones.filter((z) => z.kind === "resistance" && z.priceLow >= last);
  const nearestSupport = supports.length > 0 ? Math.max(...supports.map((z) => z.priceHigh)) : null;
  const nearestResistance = resistances.length > 0 ? Math.min(...resistances.map((z) => z.priceLow)) : null;
  if (nearestSupport !== null && nearestResistance !== null && nearestResistance > nearestSupport) {
    put(out, "technicalStructure", (last - nearestSupport) / (nearestResistance - nearestSupport));
  }

  // The market-wide and instrument-level reads the engine already scored.
  put(out, "relativeStrength", signed(metric(metrics, "equityRelativeStrength")));
  put(out, "riskRegime", signed(metric(metrics, "equityRiskAppetite")));
  put(out, "breadth", signed(metric(metrics, "equityBreadth")));
  put(out, "harmonics", signed(metric(metrics, "harmonics")));

  /*
   * MACRO BACKDROP — carried by the risk-appetite reading's own inputs
   * (credit versus duration), which is the only macro series the replay
   * loads. Narrower than the live page's volatility/rates/dollar/credit
   * backdrop, and labelled as such in the ingest notes rather than presented
   * as the full thing.
   */
  put(out, "macroBackdrop", signed(metric(metrics, "equityVolatilityRegime")));

  /*
   * VOLUME PROFILE — today's participation against the trailing 60 sessions.
   * A ratio rather than a difference, so it is already scale-free before
   * standardisation.
   */
  if (volumes.length >= 61) {
    const recent = volumes.slice(-61, -1);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avg > 0) put(out, "volumeProfile", volumes[volumes.length - 1] / avg);
  }

  return out;
}
