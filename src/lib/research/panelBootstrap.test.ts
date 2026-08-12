import { describe, expect, it } from "vitest";
import {
  PanelObservation,
  panelBootstrapProportion,
  panelBlockBootstrap,
  panelDifference,
  summarizePanel,
  toPeriodSlices,
} from "./panelBootstrap";
import { mulberry32 } from "./random";

/** Panel with `units` assets over `periods` days; `outcome` decides each cell. */
function panel(
  periods: number,
  units: number,
  outcome: (period: number, unit: number) => number
): PanelObservation[] {
  const out: PanelObservation[] = [];
  for (let p = 0; p < periods; p++) {
    for (let u = 0; u < units; u++) {
      out.push({ period: p, unitId: `U${u}`, value: outcome(p, u) });
    }
  }
  return out;
}

describe("panel structure", () => {
  it("groups into chronologically ordered period slices regardless of input order", () => {
    const obs: PanelObservation[] = [
      { period: 2, unitId: "A", value: 1 },
      { period: 0, unitId: "B", value: 0 },
      { period: 2, unitId: "B", value: 1 },
      { period: 0, unitId: "A", value: 1 },
    ];
    const slices = toPeriodSlices(obs);
    expect(slices).toHaveLength(2);
    expect(slices[0].every((o) => o.period === 0)).toBe(true);
    expect(slices[1].every((o) => o.period === 2)).toBe(true);
  });

  it("summarises width and balance", () => {
    const balanced = summarizePanel(panel(50, 3, () => 1));
    expect(balanced).toMatchObject({ observations: 150, periods: 50, meanUnitsPerPeriod: 3, balanced: true });

    const unbalanced = summarizePanel([
      { period: 0, unitId: "A", value: 1 },
      { period: 1, unitId: "A", value: 1 },
      { period: 1, unitId: "B", value: 1 },
    ]);
    expect(unbalanced.balanced).toBe(false);
    expect(unbalanced.meanUnitsPerPeriod).toBeCloseTo(1.5, 10);
  });
});

describe("reduction to the 1-D case — the estimator must be a strict generalisation", () => {
  /*
   * With one unit per period there is no cross-sectional dimension, so the
   * panel bootstrap must behave like the existing moving block bootstrap.
   * If this fails, the new estimator is not a generalisation of the old one
   * and every previously validated result becomes suspect.
   */
  it("single-unit panel recovers the analytic binomial SE at blockPeriods=1", () => {
    const rng = mulberry32(7);
    const obs = panel(1000, 1, () => (rng() < 0.5 ? 1 : 0));
    const res = panelBootstrapProportion(obs, 1, 0.5, 4000, 5)!;
    const analytic = Math.sqrt((res.point * (1 - res.point)) / res.n);

    expect(res.bootstrapSe).toBeGreaterThan(analytic * 0.85);
    expect(res.bootstrapSe).toBeLessThan(analytic * 1.15);
    // Independent data must not be discounted: effective N is essentially n.
    expect(res.effectiveN).toBeGreaterThan(800);
  });
});

describe("cross-sectional dependence — the gap this closes", () => {
  /*
   * THE load-bearing test. Two units that move identically carry ONE fact
   * per period, not two. A 1-D estimator would report effective N near the
   * observation count; this must report it near the PERIOD count.
   */
  it("perfectly correlated units are counted once, not once per unit", () => {
    // 5 units, all identical within a period, outcome varies across periods.
    const rng = mulberry32(11);
    const perPeriod = Array.from({ length: 200 }, () => (rng() < 0.5 ? 1 : 0));
    const obs = panel(200, 5, (p) => perPeriod[p]);

    const res = panelBootstrapProportion(obs, 1, 0.5, 4000, 5)!;
    expect(res.n).toBe(1000);
    expect(res.periods).toBe(200);
    // 1000 observations, but only 200 independent facts.
    expect(res.effectiveN).toBeLessThan(280);
    expect(res.effectiveN).toBeGreaterThan(130);
    // The correction is large and visible.
    expect(res.bootstrapSe / res.naiveSe).toBeGreaterThan(1.8);
  });

  it("independent units within a period are NOT discounted", () => {
    // Same shape, but every cell drawn independently — 1000 real facts.
    const rng = mulberry32(13);
    const obs = panel(200, 5, () => (rng() < 0.5 ? 1 : 0));
    const res = panelBootstrapProportion(obs, 1, 0.5, 4000, 5)!;

    expect(res.n).toBe(1000);
    expect(res.effectiveN).toBeGreaterThan(700);
    // Barely any correction, because there is barely any dependence.
    expect(res.bootstrapSe / res.naiveSe).toBeLessThan(1.35);
  });

  it("partially correlated units land between the two extremes", () => {
    const rng = mulberry32(17);
    const common = Array.from({ length: 200 }, () => (rng() < 0.5 ? 1 : 0));
    // Each unit follows the common factor 80% of the time.
    const obs = panel(200, 5, (p) => (rng() < 0.8 ? common[p] : rng() < 0.5 ? 1 : 0));
    const res = panelBootstrapProportion(obs, 1, 0.5, 4000, 5)!;

    expect(res.effectiveN).toBeGreaterThan(200);
    expect(res.effectiveN).toBeLessThan(900);
  });
});

describe("temporal dependence still corrected, and not double-counted", () => {
  it("serially dependent periods inflate the SE via block length", () => {
    // Runs of 10 identical periods; a single unit, so cross-section is absent.
    const obs = panel(400, 1, (p) => (Math.floor(p / 10) % 2 === 0 ? 1 : 0));
    const noBlock = panelBootstrapProportion(obs, 1, 0.5, 4000, 5)!;
    const withBlock = panelBootstrapProportion(obs, 10, 0.5, 4000, 5)!;

    expect(withBlock.bootstrapSe).toBeGreaterThan(noBlock.bootstrapSe);
    expect(withBlock.effectiveN).toBeLessThan(noBlock.effectiveN);
  });

  /*
   * The double-discount guard the brief explicitly calls for.
   *
   * Existing 1-D code compensated for two assets by DOUBLING an
   * observation-denominated block length. Here block length counts periods
   * and cross-section is handled by clustering, so widening the panel must
   * not additionally shrink the per-period block accounting. Concretely: a
   * panel of k identical units should give the SAME effective-N-per-period
   * as a single-unit panel over the same periods — the extra units add no
   * information, but they must not subtract any either.
   */
  it("adding perfectly redundant units neither adds nor removes information", () => {
    const rng = mulberry32(23);
    const perPeriod = Array.from({ length: 300 }, () => (rng() < 0.5 ? 1 : 0));

    const one = panelBootstrapProportion(panel(300, 1, (p) => perPeriod[p]), 5, 0.5, 4000, 5)!;
    const five = panelBootstrapProportion(panel(300, 5, (p) => perPeriod[p]), 5, 0.5, 4000, 5)!;
    const twenty = panelBootstrapProportion(panel(300, 20, (p) => perPeriod[p]), 5, 0.5, 4000, 5)!;

    // Identical information content => near-identical standard errors,
    // regardless of how many redundant columns were added.
    expect(five.bootstrapSe).toBeCloseTo(one.bootstrapSe, 2);
    expect(twenty.bootstrapSe).toBeCloseTo(one.bootstrapSe, 2);
    // And therefore near-identical effective N, NOT 5x or 20x.
    expect(five.effectiveN).toBeCloseTo(one.effectiveN, 0);
    expect(twenty.effectiveN).toBeCloseTo(one.effectiveN, 0);
  });
});

describe("scaling and heterogeneity", () => {
  it("handles a wide panel of 100 units without special-casing", () => {
    const rng = mulberry32(29);
    const obs = panel(120, 100, () => (rng() < 0.5 ? 1 : 0));
    const res = panelBootstrapProportion(obs, 3, 0.5, 500, 5)!;
    expect(res.n).toBe(12000);
    expect(res.periods).toBe(120);
    expect(res.effectiveN).toBeGreaterThan(0);
    expect(Number.isFinite(res.bootstrapSe)).toBe(true);
  });

  it("handles an unbalanced panel where units enter and leave", () => {
    // U1 exists throughout; U2 only in the second half — a listing/delisting.
    const obs: PanelObservation[] = [];
    for (let p = 0; p < 200; p++) {
      obs.push({ period: p, unitId: "U1", value: p % 2 });
      if (p >= 100) obs.push({ period: p, unitId: "U2", value: p % 2 });
    }
    const res = panelBootstrapProportion(obs, 2, 0.5, 2000, 5)!;
    expect(res.panel.balanced).toBe(false);
    expect(res.periods).toBe(200);
    expect(Number.isFinite(res.bootstrapSe)).toBe(true);
  });

  it("caps effective N at the raw observation count", () => {
    // Negatively correlated units could in principle imply n_eff > n; that
    // is real but must not be credited as extra evidence.
    const obs = panel(200, 2, (p, u) => (u === 0 ? p % 2 : 1 - (p % 2)));
    const res = panelBootstrapProportion(obs, 1, 0.5, 2000, 5)!;
    expect(res.effectiveN).toBeLessThanOrEqual(res.n);
  });
});

describe("determinism and edges", () => {
  it("is reproducible under a fixed seed", () => {
    const obs = panel(100, 3, (p, u) => (p + u) % 2);
    const a = panelBootstrapProportion(obs, 2, 0.5, 1000, 99)!;
    const b = panelBootstrapProportion(obs, 2, 0.5, 1000, 99)!;
    expect(a.bootstrapSe).toBe(b.bootstrapSe);
    expect(a.pValue).toBe(b.pValue);
  });

  it("is invariant to the ORDER observations are supplied in", () => {
    // Ordering is carried by `period`, not array position — this removes a
    // class of caller error the 1-D estimator is vulnerable to.
    const obs = panel(100, 3, (p, u) => (p + u) % 2);
    const shuffled = [...obs].reverse();
    const a = panelBootstrapProportion(obs, 2, 0.5, 1000, 7)!;
    const b = panelBootstrapProportion(shuffled, 2, 0.5, 1000, 7)!;
    expect(a.bootstrapSe).toBe(b.bootstrapSe);
    expect(a.point).toBeCloseTo(b.point, 12);
  });

  it("returns null on an empty panel and no-evidence on a degenerate one", () => {
    expect(panelBootstrapProportion([], 1)).toBeNull();
    const flat = panelBootstrapProportion(panel(20, 2, () => 1), 1, 0.5, 500, 5)!;
    expect(flat.point).toBe(1);
    expect(flat.bootstrapSe).toBe(0);
    expect(flat.pValue).toBe(1);
  });

  it("clamps blockPeriods to the available periods", () => {
    const res = panelBootstrapProportion(panel(10, 2, () => 1), 500, 0.5, 100, 5)!;
    expect(res.blockPeriods).toBe(10);
  });

  it("panelBlockBootstrap returns the requested number of draws", () => {
    expect(panelBlockBootstrap(panel(50, 2, () => 1), 5, 250, 3)).toHaveLength(250);
  });
});

describe("panelDifference", () => {
  it("finds a real gap between disjoint panels and adds variances", () => {
    const rng = mulberry32(31);
    const high = panelBootstrapProportion(panel(200, 2, () => (rng() < 0.75 ? 1 : 0)), 1, 0.5, 2000, 5)!;
    const low = panelBootstrapProportion(panel(200, 2, () => (rng() < 0.35 ? 1 : 0)), 1, 0.5, 2000, 5)!;
    const d = panelDifference(high, low);

    expect(d.difference).toBeGreaterThan(0.2);
    expect(d.se).toBeCloseTo(Math.sqrt(high.bootstrapSe ** 2 + low.bootstrapSe ** 2), 12);
    expect(d.pValue).toBeLessThan(0.01);
    expect(d.lower).toBeGreaterThan(0);
  });

  it("reports no difference between two panels drawn the same way", () => {
    const rng = mulberry32(37);
    const a = panelBootstrapProportion(panel(200, 2, () => (rng() < 0.5 ? 1 : 0)), 1, 0.5, 2000, 5)!;
    const b = panelBootstrapProportion(panel(200, 2, () => (rng() < 0.5 ? 1 : 0)), 1, 0.5, 2000, 5)!;
    expect(panelDifference(a, b).pValue).toBeGreaterThan(0.05);
  });
});
