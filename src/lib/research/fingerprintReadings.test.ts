import { describe, expect, it } from "vitest";
import { rawReadings, ReadingInputs } from "./fingerprintReadings";
import { MetricVerdict, Verdict } from "@/lib/signals/types";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";

const metric = (id: string, verdict: Verdict, confidence = 70): MetricVerdict => ({
  id,
  label: id,
  verdict,
  confidence,
  confidenceBasis: "",
  explanation: "",
  whyItMatters: "",
  asOf: 0,
  conflicts: [],
  nextTrigger: null,
});

const zone = (kind: "support" | "resistance", low: number, high: number): SupportResistanceZone =>
  ({
    priceLow: low,
    priceHigh: high,
    kind,
    strength: 60,
    reactionCount: 2,
    confluence: [],
    status: "inactive",
    mostRecentTouchBarsAgo: 5,
    source: "swing-cluster",
    timeframe: "1D",
  }) as SupportResistanceZone;

const inputs = (over: Partial<ReadingInputs> = {}): ReadingInputs => ({
  closes: Array.from({ length: 100 }, (_, i) => 100 + i * 0.1),
  volumes: Array.from({ length: 100 }, () => 1_000_000),
  metrics: [],
  zones: [],
  atrPct: 2,
  ...over,
});

describe("rawReadings", () => {
  /*
   * Every dimension is emitted only when its input exists. Zero would
   * standardise to "exactly average", which is a claim about something never
   * measured — and the distance function is built to exclude absences, so
   * there is no reason to invent one.
   */
  it("omits a dimension rather than defaulting it", () => {
    const r = rawReadings(inputs({ atrPct: null, closes: [100, 101], volumes: [1, 2] }));
    expect("volatility" in r).toBe(false);
    expect("trend" in r).toBe(false);
    expect("volumeProfile" in r).toBe(false);
    expect("technicalStructure" in r).toBe(false);
  });

  /*
   * Dividing the 60-session return by the daily range is what makes trend
   * comparable across instruments BEFORE standardisation. Two stocks with
   * the same percentage move but different daily ranges are not in the same
   * trend, and this is where that gets encoded.
   */
  it("expresses trend in daily-range units, so a calm stock and a wild one differ", () => {
    const rising = Array.from({ length: 100 }, (_, i) => 100 * 1.002 ** i);
    const calm = rawReadings(inputs({ closes: rising, atrPct: 1 }));
    const wild = rawReadings(inputs({ closes: rising, atrPct: 4 }));
    expect(calm.trend!).toBeCloseTo(wild.trend! * 4, 5);
    expect(calm.trend!).toBeGreaterThan(0);
  });

  it("signs trend negative for a falling series", () => {
    const falling = Array.from({ length: 100 }, (_, i) => 100 * 0.998 ** i);
    expect(rawReadings(inputs({ closes: falling })).trend!).toBeLessThan(0);
  });

  /*
   * Position in the range, 0 at support and 1 at resistance — not distance
   * travelled. A stock at the top of its range is in the same structural
   * situation however fast it got there.
   */
  it("places price between the nearest support and the nearest resistance", () => {
    const closes = [...Array.from({ length: 99 }, () => 100), 110];
    const r = rawReadings(
      inputs({ closes, zones: [zone("support", 95, 100), zone("resistance", 120, 125)] })
    );
    // 110 sits halfway between support top (100) and resistance bottom (120).
    expect(r.technicalStructure!).toBeCloseTo(0.5, 5);
  });

  it("skips structure when price is not bracketed by both sides", () => {
    const closes = [...Array.from({ length: 99 }, () => 100), 110];
    const onlySupport = rawReadings(inputs({ closes, zones: [zone("support", 95, 100)] }));
    expect("technicalStructure" in onlySupport).toBe(false);
  });

  /*
   * Verdict and confidence are one piece of information. A bullish read at
   * 20% and one at 90% describe different days, and standardising the
   * direction alone would call them identical.
   */
  it("combines direction and confidence into a signed magnitude", () => {
    const strong = rawReadings(inputs({ metrics: [metric("equityBreadth", "bullish", 90)] }));
    const weak = rawReadings(inputs({ metrics: [metric("equityBreadth", "bullish", 20)] }));
    const bear = rawReadings(inputs({ metrics: [metric("equityBreadth", "bearish", 90)] }));
    expect(strong.breadth).toBe(90);
    expect(weak.breadth).toBe(20);
    expect(bear.breadth).toBe(-90);
  });

  it("reads a neutral verdict as zero magnitude, not as absent", () => {
    const r = rawReadings(inputs({ metrics: [metric("equityRiskAppetite", "neutral", 80)] }));
    expect(r.riskRegime).toBe(0);
  });

  it("measures participation against the instrument's own trailing average", () => {
    const volumes = [...Array.from({ length: 99 }, () => 1_000_000), 3_000_000];
    expect(rawReadings(inputs({ volumes })).volumeProfile!).toBeCloseTo(3, 5);
  });

  /*
   * The two absent dimensions are absent for a mundane reason — the replay
   * loads price series, not the sector/industry membership map — and must
   * stay absent rather than be approximated from whatever is nearby.
   */
  it("emits nothing for sector or industry leadership", () => {
    const r = rawReadings(
      inputs({
        metrics: [metric("equityBreadth", "bullish"), metric("equityRelativeStrength", "bearish")],
        zones: [zone("support", 95, 100), zone("resistance", 120, 125)],
      })
    );
    expect("sectorLeadership" in r).toBe(false);
    expect("industryLeadership" in r).toBe(false);
  });

  it("produces the nine dimensions the replay can supply, and only those", () => {
    const closes = [...Array.from({ length: 99 }, (_, i) => 100 + i * 0.05), 110];
    const r = rawReadings(
      inputs({
        closes,
        volumes: [...Array.from({ length: 99 }, () => 1_000_000), 1_500_000],
        zones: [zone("support", 95, 100), zone("resistance", 120, 125)],
        metrics: [
          metric("equityRelativeStrength", "bullish"),
          metric("equityRiskAppetite", "bullish"),
          metric("equityBreadth", "bearish"),
          metric("equityVolatilityRegime", "neutral"),
          metric("harmonics", "bullish"),
        ],
      })
    );
    expect(Object.keys(r).sort()).toEqual([
      "breadth",
      "harmonics",
      "macroBackdrop",
      "relativeStrength",
      "riskRegime",
      "technicalStructure",
      "trend",
      "volatility",
      "volumeProfile",
    ]);
  });
});
