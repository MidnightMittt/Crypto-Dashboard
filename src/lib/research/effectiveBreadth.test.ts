import { describe, expect, it } from "vitest";
import { mulberry32 } from "./random";
import {
  MIN_PAIR_OVERLAP,
  ReturnSeries,
  effectiveBreadth,
  logReturns,
  pairRho,
} from "./effectiveBreadth";

/**
 * Series with a KNOWN population correlation, so the estimator is checked
 * against a target rather than against itself.
 *
 *   x_i = sqrt(rho) * F + sqrt(1 - rho) * e_i
 *
 * gives every pair population correlation exactly rho when F and the e_i are
 * independent standard normals. Seeded, so a failure is reproducible.
 */
function factorPanel(
  names: number,
  rho: number,
  sessions: number,
  seed: number
): Map<string, ReturnSeries> {
  const rand = mulberry32(seed);
  const gauss = () => {
    // Box-Muller. The u1 guard keeps log(0) out.
    const u1 = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rand());
  };
  const a = Math.sqrt(rho);
  const b = Math.sqrt(1 - rho);
  const out = new Map<string, number[]>();
  for (let i = 0; i < names; i++) out.set(`N${i}`, []);
  for (let t = 0; t < sessions; t++) {
    const f = gauss();
    for (let i = 0; i < names; i++) out.get(`N${i}`)!.push(a * f + b * gauss());
  }
  return out as Map<string, ReturnSeries>;
}

describe("logReturns", () => {
  it("returns one fewer value than closes, and the right one", () => {
    const r = logReturns([100, 110, 121]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 10);
    expect(r[1]).toBeCloseTo(Math.log(1.1), 10);
  });

  /*
   * A gap must NOT be bridged. Carrying across a hole invents a return of
   * exactly the size of the hole and dates it to one session, which shows up
   * as a fat tail in one name and depresses every correlation it enters.
   */
  it("preserves gaps as null instead of bridging them", () => {
    const r = logReturns([100, null, 121]);
    expect(r).toEqual([null, null]);
  });

  it("refuses a non-positive close rather than producing NaN", () => {
    expect(logReturns([100, 0, 50])).toEqual([null, null]);
  });
});

describe("pairRho", () => {
  it("is 1 for a series against itself", () => {
    const a = [...factorPanel(1, 0, 200, 7).values()][0];
    expect(pairRho(a, a)).toBeCloseTo(1, 10);
  });

  it("is -1 for a series against its negation", () => {
    const a = [...factorPanel(1, 0, 200, 7).values()][0];
    const neg = a.map((v) => (v === null ? null : -v));
    expect(pairRho(a, neg)).toBeCloseTo(-1, 10);
  });

  /*
   * The refusal that matters. A pair with too little shared history returns
   * null, and the caller must not be able to mistake that for a measurement
   * of zero — zero would read as "measured, and independent", which is the
   * most flattering thing an unmeasured pair could possibly say.
   */
  it("returns null, never 0, below the overlap minimum", () => {
    const long = [...factorPanel(1, 0, 200, 3).values()][0];
    const short: ReturnSeries = long.map((v, i) => (i < MIN_PAIR_OVERLAP - 1 ? v : null));
    expect(pairRho(long, short)).toBeNull();
  });

  it("counts only sessions where BOTH series are present", () => {
    const [a, b] = [...factorPanel(2, 0.9, 200, 11).values()];
    const holed: ReturnSeries = b.map((v, i) => (i % 3 === 0 ? null : v));
    const rho = pairRho(a, holed);
    expect(rho).not.toBeNull();
    expect(rho!).toBeGreaterThan(0.8); // the holes cost sample, not signal
  });

  it("refuses a constant series, which has no correlation to have", () => {
    const a = [...factorPanel(1, 0, 200, 5).values()][0];
    const flat: ReturnSeries = a.map(() => 0);
    expect(pairRho(a, flat)).toBeNull();
  });
});

describe("effectiveBreadth", () => {
  it("recovers n independent bets from n independent names", () => {
    const b = effectiveBreadth(factorPanel(6, 0, 4000, 21), 4000);
    expect(b.mean_pairwise_rho!).toBeCloseTo(0, 1);
    expect(b.effective_bets!).toBeGreaterThan(5.4);
    expect(b.breadth_pct!).toBeGreaterThan(90);
  });

  /*
   * THE CASE THE MODULE EXISTS FOR. Six names that are one name observed six
   * times must not be able to present as six pieces of evidence.
   */
  it("collapses a single common factor to about one bet", () => {
    const b = effectiveBreadth(factorPanel(6, 0.99, 2000, 22), 2000);
    expect(b.effective_bets!).toBeLessThan(1.1);
    expect(b.breadth_pct!).toBeLessThan(20);
    expect(b.sentence).toContain("ONE exposure written 6 ways");
    expect(b.ranking_caution).toContain("close to choosing nothing");
  });

  /*
   * The caution must SCALE. The first real run of this module put 122 names
   * at 5.6 bets and 13 directions, and the sentence called that "one
   * exposure" — an overclaim in the cautious direction, which teaches a
   * reader to discount the warning in the cases where it is true.
   */
  it("does not cry wolf at a breadth that is genuinely wide", () => {
    const wide = effectiveBreadth(factorPanel(8, 0.02, 3000, 30), 3000);
    expect(wide.sentence).toContain("not badly misleading");
    expect(wide.ranking_caution).toContain("carries most of the information");
    expect(wide.sentence).not.toContain("ONE exposure");

    const middling = effectiveBreadth(factorPanel(40, 0.2, 3000, 31), 3000);
    expect(middling.effective_bets!).toBeGreaterThan(1.5);
    expect(middling.sentence).toContain("genuinely different bets");
    expect(middling.sentence).not.toContain("ONE exposure");
  });

  /*
   * PR above N_eff means unequal weighting could reach structure a top-down
   * read cannot. That is the informative half of carrying two numbers, so
   * the sentence has to say which case it is in rather than printing both
   * and leaving the reader to compare them.
   */
  it("names the gap between the two measures rather than just printing both", () => {
    const dispersed = effectiveBreadth(factorPanel(40, 0.5, 3000, 32), 3000);
    expect(dispersed.sentence).toContain("unequal weighting could reach");

    const tight = effectiveBreadth(factorPanel(6, 0.98, 2000, 33), 2000);
    expect(tight.sentence).toContain("little structure here beyond the common factor");
  });

  /*
   * Mitchell's own book: CIFR/RIOT/BTDR/MARA, mean pairwise rho 0.682 over
   * 139 daily bars, which he computed independently as 1.31 of 4 effective
   * bets. Same arithmetic, so this pins the estimator to a number produced
   * outside this codebase.
   */
  it("reproduces the four-miner book at 1.31 of 4", () => {
    const b = effectiveBreadth(factorPanel(4, 0.682, 6000, 23), 6000);
    /*
     * Tolerance is 0.05, not 0.005, and that is the honest bound rather than
     * a loosened one: six pairs driven by ONE common factor are themselves
     * correlated, so the mean does not converge at 1/sqrt(pairs). A single
     * pair's SE here is about (1-rho^2)/sqrt(6000) = 0.007, and the six
     * share most of their error. Picking a seed that landed inside 0.005
     * would have hidden that.
     */
    expect(b.mean_pairwise_rho!).toBeCloseTo(0.682, 1);
    expect(b.effective_bets!).toBeCloseTo(1.31, 1);
  });

  /*
   * The corrected relation. rho^2 <= rho for non-negative rho, so PR can
   * never sit below N_eff — an earlier draft of this module claimed the
   * opposite in prose, and prose does not run.
   */
  it("keeps the participation ratio at or above effective bets", () => {
    for (const rho of [0.0, 0.2, 0.5, 0.68, 0.9]) {
      const b = effectiveBreadth(factorPanel(8, rho, 3000, 24), 3000);
      expect(b.participation_ratio!).toBeGreaterThanOrEqual(b.effective_bets! - 0.05);
    }
  });

  it("separates the two measures where dispersion is real", () => {
    const b = effectiveBreadth(factorPanel(40, 0.5, 3000, 25), 3000);
    // 40 names at rho 0.5: N_eff = 40/20.5 = 1.95, PR = 40/10.75 = 3.72.
    expect(b.effective_bets!).toBeCloseTo(1.95, 1);
    expect(b.participation_ratio!).toBeCloseTo(3.72, 0);
  });

  it("says so rather than guessing when there is nothing to compare", () => {
    const b = effectiveBreadth(new Map([["ONLY", [0.1, 0.2]]]), 2);
    expect(b.effective_bets).toBeNull();
    expect(b.sentence).toContain("at least two names");
  });

  /*
   * A panel where most pairs cannot be measured has no breadth figure. The
   * temptation is to report the mean of whatever pairs DID clear, but that
   * number describes a sub-panel while wearing the whole panel's headcount.
   */
  it("refuses a figure when most pairs are unmeasurable", () => {
    const full = factorPanel(6, 0.7, 200, 26);
    const stubbed = new Map<string, ReturnSeries>();
    let i = 0;
    for (const [k, v] of full) {
      // Four of six names get disjoint history, so almost no pair overlaps.
      stubbed.set(k, i < 4 ? v.map((x, t) => (t % 4 === i ? x : null)) : v);
      i++;
    }
    const b = effectiveBreadth(stubbed, 200);
    expect(b.effective_bets).toBeNull();
    expect(b.sentence).toContain("too few to describe the panel's breadth");
  });

  /*
   * A self-hedging panel does not have "lots of breadth"; the ratio simply
   * stops meaning anything, because the variance it divides into has gone
   * through zero. Reporting a huge number there would be the single most
   * misleading output this module could produce.
   */
  it("refuses the ratio when the average pair is negatively correlated", () => {
    const base = [...factorPanel(1, 0, 300, 27).values()][0];
    const series = new Map<string, ReturnSeries>([
      ["LONG", base],
      ["SHORT", base.map((v) => (v === null ? null : -v))],
    ]);
    const b = effectiveBreadth(series, 300);
    expect(b.mean_pairwise_rho!).toBeCloseTo(-1, 2);
    expect(b.effective_bets).toBeNull();
    expect(b.sentence).toContain("partly hedges itself");
  });

  /*
   * NAMING THE DUPLICATES. On the committed panel this found seven pairs at
   * 0.95+ — ETHU/ETHT and BITX/BITU at 1.000, MSTU/MSTX, CONL/COIN and
   * SOLT/SOLZ at 0.999 — which are competing issuers' wrappers on the same
   * underlying. An aggregate breadth number is true but abstract; the pair
   * list is the part a reader can act on.
   */
  describe("near duplicates", () => {
    const withDupe = () => {
      const base = factorPanel(3, 0.3, 400, 40);
      const [a] = [...base.values()];
      const wrapped: ReturnSeries = a.map((v) => (v === null ? null : v * 2 + 1e-6));
      return new Map<string, ReturnSeries>([...base, ["WRAPPER", wrapped]]);
    };

    it("names the pair rather than only counting it", () => {
      const b = effectiveBreadth(withDupe(), 400);
      expect(b.near_duplicates_total).toBe(1);
      expect(b.near_duplicates[0].rho).toBeGreaterThanOrEqual(0.95);
      expect([b.near_duplicates[0].a, b.near_duplicates[0].b]).toContain("WRAPPER");
      expect(b.sentence).toContain("the same position listed twice");
    });

    /*
     * A leverage factor changes the SIZE of a bet, never its identity. If
     * scaling could hide a duplicate, every 2x wrapper on the panel would
     * pass as a separate name — which is exactly the failure being caught.
     */
    it("is not fooled by a leverage factor", () => {
      const b = effectiveBreadth(withDupe(), 400);
      expect(b.near_duplicates[0].rho).toBeCloseTo(1, 3);
    });

    it("prints three decimals, because every duplicate rounds to 1.00 at two", () => {
      const b = effectiveBreadth(withDupe(), 400);
      expect(b.sentence).not.toContain("at 1.00 ");
      expect(b.sentence).toMatch(/at \d\.\d{3}/);
    });

    it("says nothing at all when there are no duplicates", () => {
      const b = effectiveBreadth(factorPanel(5, 0.3, 400, 41), 400);
      expect(b.near_duplicates_total).toBe(0);
      expect(b.sentence).not.toContain("same position listed twice");
    });

    it("agrees in number and grammar with what it found", () => {
      expect(effectiveBreadth(withDupe(), 400).sentence).toContain("1 pair correlates at");
    });
  });

  it("reports how many pairs it actually measured", () => {
    const b = effectiveBreadth(factorPanel(10, 0.4, 300, 28), 300);
    expect(b.pairs_measured).toBe(45); // 10 choose 2, all clearing the minimum
    expect(b.n).toBe(10);
    expect(b.sessions).toBe(300);
  });

  /*
   * The sentence is the deliverable — it is what a reader sees beside a
   * sorted table — so its claims are tested, not just its existence.
   */
  it("states the caution without calling the ranking wrong", () => {
    const b = effectiveBreadth(factorPanel(12, 0.7, 1000, 29), 1000);
    expect(b.sentence).toContain("1000 sessions");
    expect(b.ranking_caution).toContain("WRONG");
    expect(b.ranking_caution).toContain("does not bias the individual estimates");
    expect(b.ranking_caution).toContain("actively helps");

    /*
     * The two fields must stay separated. `sentence` goes to consumers that
     * have no ordering at all — the rule ledger's null model, for one — and
     * splicing "names near each other in the ordering" into a set with no
     * order is how a caution stops being read.
     */
    expect(b.sentence).not.toContain("ranking");
    expect(b.sentence).not.toContain("ordering");
    expect(b.sentence).not.toContain("row");
  });
});
