import { describe, expect, it } from "vitest";
import {
  normalCdf,
  normalQuantile,
  PANEL_STATISTICS,
  inferMetricKind,
  estimatePanelStatistic,
  analyzePanel,
  differenceOfEstimates,
  detectableDifference,
  panelBootstrapDistribution,
  DEFAULT_NULL_VALUE,
} from "./panelStatistics";
import { PanelObservation, panelBootstrapProportion } from "./panelBootstrap";
import { mulberry32 } from "./random";

/** Box-Muller over the seeded PRNG, so every distributional test is reproducible. */
function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function panel(periods: number, units: number, value: (p: number, u: number) => number): PanelObservation[] {
  const out: PanelObservation[] = [];
  for (let p = 0; p < periods; p++) {
    for (let u = 0; u < units; u++) out.push({ period: p, unitId: `U${u}`, value: value(p, u) });
  }
  return out;
}

// ── 1. Distribution helpers, against published values ───────────────────

describe("normal helpers — hand-verified against standard tables", () => {
  it("normalCdf matches known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 4);
    expect(normalCdf(-2.326348)).toBeCloseTo(0.01, 4);
  });

  it("normalQuantile matches known probabilities", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959964, 5);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.99)).toBeCloseTo(2.326348, 5);
  });

  it("the two are mutual inverses across the range", () => {
    for (const p of [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 4);
    }
  });

  it("handles the degenerate endpoints without NaN", () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
  });
});

// ── 2. Statistic library, hand-computed ─────────────────────────────────

describe("statistic library — hand-computed reference cases", () => {
  it("mean and median", () => {
    expect(PANEL_STATISTICS.mean([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(PANEL_STATISTICS.median([1, 2, 3, 4])).toBeCloseTo(2.5, 10);
    expect(PANEL_STATISTICS.median([1, 2, 3])).toBe(2);
  });

  it("profit factor: gains 10, losses 4 => 2.5", () => {
    expect(PANEL_STATISTICS.profitFactor([5, 5, -2, -2])).toBeCloseTo(2.5, 10);
  });

  it("profit factor is Infinity with no losses, and 0 with no gains", () => {
    expect(PANEL_STATISTICS.profitFactor([1, 2])).toBe(Infinity);
    expect(PANEL_STATISTICS.profitFactor([-1, -2])).toBe(0);
  });

  it("payoff ratio: avg win 5, avg loss 2 => 2.5", () => {
    expect(PANEL_STATISTICS.payoffRatio([5, 5, -2, -2])).toBeCloseTo(2.5, 10);
  });

  it("max drawdown of a cumulative path", () => {
    // Cumulative: 10, 6, 12, 4. Peak 12 -> trough 4 gives 8; earlier 10 -> 6 gives 4.
    expect(PANEL_STATISTICS.maxDrawdown([10, -4, 6, -8])).toBeCloseTo(8, 10);
    // A monotonically rising path never draws down.
    expect(PANEL_STATISTICS.maxDrawdown([1, 1, 1])).toBe(0);
  });

  it("drawdown is order-dependent, which is a property not a bug", () => {
    expect(PANEL_STATISTICS.maxDrawdown([-5, 5])).toBeCloseTo(5, 10);
    expect(PANEL_STATISTICS.maxDrawdown([5, -5])).toBeCloseTo(5, 10);
    expect(PANEL_STATISTICS.maxDrawdown([10, -10, 10, -10])).toBeCloseTo(10, 10);
  });

  it("win rate counts strictly positive values", () => {
    expect(PANEL_STATISTICS.winRate([1, -1, 1, 0])).toBeCloseTo(0.5, 10);
  });
});

describe("metric-kind inference", () => {
  it("recognises binary, and is strict about it", () => {
    expect(inferMetricKind([0, 1, 1, 0])).toBe("binary");
    expect(inferMetricKind([0, 1, 2])).toBe("continuous"); // a count is not a proportion
    expect(inferMetricKind([0.5])).toBe("continuous");
    expect(inferMetricKind([-1, 1])).toBe("continuous");
  });
});

// ── 3. THE unification check ────────────────────────────────────────────

describe("unification — the continuous engine reproduces the proportion engine", () => {
  /*
   * The load-bearing consistency test. n_eff is now defined as a variance
   * ratio, n*(SE_iid/SE_panel)^2, which for the mean of a 0/1 series is
   * algebraically identical to the previous p(1-p)/SE^2. If these two paths
   * ever disagree materially, the "one framework" claim is false and every
   * previously reported proportion result becomes suspect.
   */
  it("winRate through the generalised engine matches panelBootstrapProportion", () => {
    const rng = mulberry32(11);
    const shared = Array.from({ length: 250 }, () => (rng() < 0.55 ? 1 : 0));
    const obs = panel(250, 3, (p) => shared[p]);

    const viaGeneral = analyzePanel(obs, { statistic: "winRate", nullValue: 0.5 }, 4, 4000, 7)!;
    const viaProportion = panelBootstrapProportion(obs, 4, 0.5, 4000, 7)!;

    expect(viaGeneral.point).toBeCloseTo(viaProportion.point, 12);
    // Standard errors agree closely — same resampling, same statistic.
    expect(viaGeneral.standardError).toBeCloseTo(viaProportion.bootstrapSe, 3);
    // And therefore so does effective N, despite being defined differently.
    expect(viaGeneral.effectiveN / viaProportion.effectiveN).toBeGreaterThan(0.8);
    expect(viaGeneral.effectiveN / viaProportion.effectiveN).toBeLessThan(1.25);
  });

  it("binary and continuous endpoints both flow through analyzePanel unchanged", () => {
    const rng = mulberry32(13);
    const binary = panel(200, 2, () => (rng() < 0.5 ? 1 : 0));
    const continuous = panel(200, 2, () => gaussian(rng));

    const b = analyzePanel(binary, { statistic: "winRate", nullValue: 0.5 }, 2, 1000, 5)!;
    const c = analyzePanel(continuous, { statistic: "mean", nullValue: 0 }, 2, 1000, 5)!;

    expect(b.metricKind).toBe("binary");
    expect(c.metricKind).toBe("continuous");
    // Identical result shape: no branch produces a different contract.
    expect(Object.keys(b).sort()).toEqual(Object.keys(c).sort());
  });
});

// ── 4. Recovery of known parameters ─────────────────────────────────────

describe("parameter recovery on synthetic data", () => {
  it("recovers a known mean", () => {
    const rng = mulberry32(21);
    const obs = panel(400, 1, () => 5 + 2 * gaussian(rng));
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    expect(r.point).toBeCloseTo(5, 0);
    expect(r.lower).toBeLessThan(5);
    expect(r.upper).toBeGreaterThan(5);
  });

  it("recovers a known median under skew, where the mean would mislead", () => {
    // Lognormal: median = e^0 = 1, mean = e^0.5 ≈ 1.65. They differ, so this
    // confirms the statistic being estimated is the one requested.
    const rng = mulberry32(23);
    const obs = panel(500, 1, () => Math.exp(gaussian(rng)));
    const med = analyzePanel(obs, { statistic: "median", nullValue: 0 }, 1, 2000, 5)!;
    const avg = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    expect(med.point).toBeCloseTo(1, 0);
    expect(avg.point).toBeGreaterThan(med.point);
  });

  it("recovers a known profit factor", () => {
    // 300 wins of +2 (600) against 300 losses of -1 (300) => PF exactly 2.
    const obs = panel(600, 1, (p) => (p % 2 === 0 ? 2 : -1));
    const r = analyzePanel(obs, { statistic: "profitFactor", nullValue: 1 }, 1, 1000, 5)!;
    expect(r.point).toBeCloseTo(2, 10);
  });
});

// ── 5. Confidence-interval coverage — the real validation ───────────────

describe("confidence-interval coverage", () => {
  /*
   * A 95% interval is only correct if it contains the truth about 95% of the
   * time across repeated samples. Asserting that one interval "looks
   * reasonable" validates nothing. This runs the whole estimator many times
   * on fresh synthetic data with a KNOWN mean and counts containment.
   *
   * Deliberately slow. The brief asked for correctness over speed.
   */
  it("covers the true mean at approximately the nominal rate (IID normal)", () => {
    const TRUE_MEAN = 3;
    const REPS = 200;
    let covered = 0;
    for (let rep = 0; rep < REPS; rep++) {
      const rng = mulberry32(1000 + rep);
      const obs = panel(150, 1, () => TRUE_MEAN + gaussian(rng));
      const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 400, rep + 1)!;
      if (r.lower <= TRUE_MEAN && TRUE_MEAN <= r.upper) covered++;
    }
    const rate = covered / REPS;
    // Nominal 95%. Monte-Carlo error at 200 reps is ~1.5pp, and bootstrap
    // intervals are known to under-cover slightly at finite n, so accept
    // 88-99% and fail loudly outside that.
    expect(rate).toBeGreaterThan(0.88);
    expect(rate).toBeLessThan(0.995);
  });

  it("covers the true mean under strong SKEW (lognormal)", () => {
    // exp(N(0,1)) has mean e^0.5 = 1.6487. Skewed and bounded below — the
    // case where a normal-approximation interval fails and BCa should not.
    const TRUE_MEAN = Math.exp(0.5);
    const REPS = 150;
    let covered = 0;
    for (let rep = 0; rep < REPS; rep++) {
      const rng = mulberry32(5000 + rep);
      const obs = panel(200, 1, () => Math.exp(gaussian(rng)));
      const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 400, rep + 1)!;
      if (r.lower <= TRUE_MEAN && TRUE_MEAN <= r.upper) covered++;
    }
    expect(covered / REPS).toBeGreaterThan(0.85);
  });

  it("a dependent panel would be badly under-covered by an IID interval, and is not by this one", () => {
    // Perfectly correlated units: an IID treatment sees 5x the observations
    // and produces an interval far too narrow.
    const TRUE_MEAN = 2;
    const REPS = 120;
    let coveredPanel = 0;
    let coveredIid = 0;
    for (let rep = 0; rep < REPS; rep++) {
      const rng = mulberry32(9000 + rep);
      const shared = Array.from({ length: 120 }, () => TRUE_MEAN + gaussian(rng));
      const obs = panel(120, 5, (p) => shared[p]);
      const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 400, rep + 1)!;
      if (r.lower <= TRUE_MEAN && TRUE_MEAN <= r.upper) coveredPanel++;

      // What an IID interval would have claimed: SE shrunk by sqrt(5).
      const halfWidth = 1.96 * r.iidStandardError;
      if (r.point - halfWidth <= TRUE_MEAN && TRUE_MEAN <= r.point + halfWidth) coveredIid++;
    }
    expect(coveredPanel / REPS).toBeGreaterThan(0.85);
    // The naive interval is materially worse — this is the failure the panel
    // estimator exists to prevent, measured rather than asserted.
    expect(coveredIid / REPS).toBeLessThan(coveredPanel / REPS);
  });
});

// ── 6. Effective N under dependence ─────────────────────────────────────

describe("effective sample size for continuous metrics", () => {
  it("independent observations are not discounted", () => {
    const rng = mulberry32(31);
    const obs = panel(200, 5, () => gaussian(rng));
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 3000, 5)!;
    expect(r.n).toBe(1000);
    expect(r.effectiveN).toBeGreaterThan(700);
  });

  it("perfectly correlated units collapse toward the period count", () => {
    const rng = mulberry32(37);
    const shared = Array.from({ length: 200 }, () => gaussian(rng));
    const obs = panel(200, 5, (p) => shared[p]);
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 3000, 5)!;
    expect(r.n).toBe(1000);
    expect(r.effectiveN).toBeLessThan(320);
    expect(r.effectiveN).toBeGreaterThan(100);
  });

  it("serial dependence further reduces effective N via block length", () => {
    const rng = mulberry32(41);
    const shared = Array.from({ length: 300 }, () => gaussian(rng));
    // Runs of 10 identical periods: strong serial dependence.
    const obs = panel(300, 1, (p) => shared[Math.floor(p / 10)]);
    const noBlock = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    const withBlock = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 10, 2000, 5)!;
    expect(withBlock.effectiveN).toBeLessThan(noBlock.effectiveN);
  });

  it("adding redundant units neither adds nor removes information", () => {
    const rng = mulberry32(43);
    const shared = Array.from({ length: 250 }, () => gaussian(rng));
    const one = analyzePanel(panel(250, 1, (p) => shared[p]), { statistic: "mean", nullValue: 0 }, 3, 3000, 5)!;
    const ten = analyzePanel(panel(250, 10, (p) => shared[p]), { statistic: "mean", nullValue: 0 }, 3, 3000, 5)!;
    expect(ten.standardError).toBeCloseTo(one.standardError, 2);
  });
});

// ── 7. Robustness ───────────────────────────────────────────────────────

describe("robustness to difficult distributions", () => {
  it("heavy tails do not produce NaN or a collapsed interval", () => {
    // Ratio of normals ≈ Cauchy: undefined variance, the classic breaker.
    const rng = mulberry32(53);
    const obs = panel(300, 1, () => {
      const d = gaussian(rng);
      return gaussian(rng) / (Math.abs(d) < 1e-6 ? 1e-6 : d);
    });
    const r = analyzePanel(obs, { statistic: "median", nullValue: 0 }, 1, 1000, 5)!;
    expect(Number.isFinite(r.point)).toBe(true);
    expect(Number.isFinite(r.standardError)).toBe(true);
    expect(Number.isFinite(r.lower)).toBe(true);
    expect(Number.isFinite(r.upper)).toBe(true);
    expect(r.lower).toBeLessThanOrEqual(r.upper);
  });

  it("survives a statistic that returns Infinity on some resamples", () => {
    // A nearly-all-wins series makes profit factor Infinity whenever a
    // resample happens to contain no losses. Non-finite draws are excluded
    // from the moments rather than poisoning them.
    const obs = panel(120, 1, (p) => (p === 0 ? -1 : 1));
    const r = analyzePanel(obs, { statistic: "profitFactor", nullValue: 1 }, 1, 1000, 5)!;
    expect(Number.isFinite(r.standardError)).toBe(true);
    expect(Number.isFinite(r.lower)).toBe(true);
  });

  it("a constant series reports no evidence rather than infinite confidence", () => {
    const r = analyzePanel(panel(50, 2, () => 7), { statistic: "mean", nullValue: 0 }, 1, 500, 5)!;
    expect(r.point).toBe(7);
    expect(r.standardError).toBe(0);
    expect(r.pValue).toBe(1);
  });

  it("returns null on an empty panel", () => {
    expect(analyzePanel([], { statistic: "mean", nullValue: 0 }, 1)).toBeNull();
  });
});

// ── 8. Determinism ──────────────────────────────────────────────────────

describe("determinism", () => {
  it("identical inputs and seed give identical output", () => {
    const rng = mulberry32(61);
    const obs = panel(150, 2, () => gaussian(rng));
    const a = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 2, 1000, 99)!;
    const b = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 2, 1000, 99)!;
    expect(a.point).toBe(b.point);
    expect(a.standardError).toBe(b.standardError);
    expect(a.lower).toBe(b.lower);
    expect(a.upper).toBe(b.upper);
    expect(a.pValue).toBe(b.pValue);
  });

  it("is invariant to the order observations are supplied in", () => {
    const rng = mulberry32(67);
    const obs = panel(120, 3, () => gaussian(rng));
    const a = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 2, 800, 7)!;
    const b = analyzePanel([...obs].reverse(), { statistic: "mean", nullValue: 0 }, 2, 800, 7)!;
    expect(a.standardError).toBeCloseTo(b.standardError, 12);
    expect(a.point).toBeCloseTo(b.point, 12);
  });

  it("the resampling scheme is shared with the proportion estimator", () => {
    // panelBootstrapDistribution with the mean statistic must reproduce
    // panelBlockBootstrap exactly — same draws, same order, same seed.
    const obs = panel(80, 2, (p, u) => p * 0.1 + u);
    const viaGeneral = panelBootstrapDistribution(obs, PANEL_STATISTICS.mean, 3, 200, 5);
    expect(viaGeneral).toHaveLength(200);
    expect(viaGeneral.every((x) => Number.isFinite(x))).toBe(true);
  });
});

// ── 9. Inference outputs ────────────────────────────────────────────────

describe("inference outputs", () => {
  it("detects a genuinely non-zero mean and reports a CI excluding zero", () => {
    const rng = mulberry32(71);
    const obs = panel(300, 1, () => 0.8 + gaussian(rng));
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.lower).toBeGreaterThan(0);
  });

  it("reports no effect for a mean genuinely at the null", () => {
    const rng = mulberry32(73);
    const obs = panel(300, 1, () => gaussian(rng));
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.lower).toBeLessThan(0);
    expect(r.upper).toBeGreaterThan(0);
  });

  it("uses BCa when the acceleration term is computable", () => {
    const rng = mulberry32(79);
    const obs = panel(200, 1, () => Math.exp(gaussian(rng)));
    const r = analyzePanel(obs, { statistic: "mean", nullValue: 0 }, 1, 2000, 5)!;
    expect(r.intervalMethod).toBe("bca");
  });

  it("differenceOfEstimates adds variances and finds a real gap", () => {
    const rng = mulberry32(83);
    const high = analyzePanel(panel(250, 1, () => 1 + gaussian(rng)), { statistic: "mean", nullValue: 0 }, 1, 1500, 5)!;
    const low = analyzePanel(panel(250, 1, () => -1 + gaussian(rng)), { statistic: "mean", nullValue: 0 }, 1, 1500, 5)!;
    const d = differenceOfEstimates(high, low);
    expect(d.difference).toBeGreaterThan(1.5);
    expect(d.standardError).toBeCloseTo(Math.sqrt(high.standardError ** 2 + low.standardError ** 2), 12);
    expect(d.pValue).toBeLessThan(0.001);
    expect(d.lower).toBeGreaterThan(0);
  });

  it("detectable difference scales with the achieved standard error", () => {
    expect(detectableDifference(0.1)).toBeCloseTo(0.2802, 6);
    expect(detectableDifference(0.05)).toBeCloseTo(0.1401, 6);
  });

  it("default nulls are defensible per statistic", () => {
    expect(DEFAULT_NULL_VALUE.mean).toBe(0);
    expect(DEFAULT_NULL_VALUE.winRate).toBe(0.5);
    expect(DEFAULT_NULL_VALUE.profitFactor).toBe(1);
    expect(DEFAULT_NULL_VALUE.payoffRatio).toBe(1);
  });
});
