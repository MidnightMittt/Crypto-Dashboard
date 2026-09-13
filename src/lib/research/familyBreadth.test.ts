import { describe, expect, it } from "vitest";
import { FamilySeries, familyBreadth } from "./familyBreadth";

/**
 * The case that motivated the module is the first test: a regime gate splits
 * one series into two "hypotheses" whose numbers are the parent's own. If the
 * measurement cannot see that, it cannot see anything, because that is the
 * arrangement three of the twelve real hypotheses are in.
 */

/** Deterministic pseudo-noise, so a correlation figure is reproducible. */
function noise(seed: number, count: number): number[] {
  let s = seed;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    out.push(s / 4294967296 - 0.5);
  }
  return out;
}

const series = (id: string, spreads: number[], step = 1, from = 0): FamilySeries => ({
  id,
  periods: spreads.map((spread, i) => ({ entryTime: from + i * step, spread })),
});

describe("familyBreadth", () => {
  it("counts a regime-gated partition as one idea, not three", () => {
    const parent = noise(1, 200);
    /*
     * Exactly the real arrangement: the two gates partition the parent's
     * dates and carry its spreads unchanged. Nothing here is approximate —
     * broad-up ∪ broad-down = the parent, bit for bit.
     */
    const up = series(
      "up",
      parent.filter((_, i) => i % 2 === 0),
      2,
      0
    );
    const down = series(
      "down",
      parent.filter((_, i) => i % 2 === 1),
      2,
      1
    );
    const r = familyBreadth([series("parent", parent), up, down]);

    expect(r.declared).toBe(3);
    // Each gate is the parent on its own dates, so both pair at 1.000.
    expect(r.breadth.near_duplicates_total).toBeGreaterThanOrEqual(2);
    expect(r.breadth.near_duplicates.every((d) => d.rho >= 0.999)).toBe(true);
    // Three names, nothing like three bets.
    expect(r.breadth.effective_bets).not.toBeNull();
    expect(r.breadth.effective_bets!).toBeLessThan(2);
    expect(r.duplicateSentence).toContain("one series and a subset of itself");
  });

  /*
   * The pairs are named in exactly one place. A page that renders the
   * sentence AND a list of the pairs underneath would otherwise print each
   * pair twice — the same duplication the trade desk shipped once already.
   */
  it("keeps the named pairs out of the main sentence so a list can carry them", () => {
    const parent = noise(1, 200);
    const r = familyBreadth([
      series("parent", parent),
      series(
        "twin",
        parent.filter((_, i) => i % 2 === 0),
        2
      ),
    ]);
    expect(r.duplicateSentence).not.toBeNull();
    expect(r.duplicateSentence).toContain("parent");
    expect(r.sentence).not.toContain("one series and a subset of itself");
    expect(r.sentence).not.toContain("rho");
  });

  it("has no duplicate sentence when no pair is a duplicate", () => {
    const family = [1, 2, 3].map((s) => series(`h${s}`, noise(s * 7919, 300)));
    expect(familyBreadth(family).duplicateSentence).toBeNull();
  });

  it("reports genuinely unrelated hypotheses as close to their headcount", () => {
    const family = [1, 2, 3, 4].map((s) => series(`h${s}`, noise(s * 7919, 300)));
    const r = familyBreadth(family);
    expect(r.breadth.effective_bets).not.toBeNull();
    // Independent noise: breadth should be most of the headcount, not a collapse.
    expect(r.breadth.effective_bets!).toBeGreaterThan(3);
    expect(r.breadth.near_duplicates_total).toBe(0);
  });

  /*
   * The bracket is the honesty mechanism: the measured end is biased low
   * because the pairs that CAN be measured are the ones sharing a calendar.
   * If the generous end ever collapsed into the measured one, the module
   * would be quoting a point estimate while claiming to quote a range.
   */
  it("brackets upward when holding periods differ enough to refuse pairs", () => {
    /*
     * Four on a shared calendar and one on its own. `effectiveBreadth`
     * refuses outright below half the pairs, so the sparse member has to stay
     * a minority for there to be a bracket to widen at all.
     *
     * The four share a common factor, which is the situation the bracket is
     * FOR: the pairs that can be measured are correlated, the pairs that
     * cannot are the ones most likely to be independent, so the measured
     * figure understates breadth by an amount nobody can measure.
     */
    const common = noise(7, 400);
    const fast = [1, 2, 3, 4].map((s) =>
      series(
        `fast${s}`,
        noise(s * 31, 400).map((x, i) => x * 0.5 + common[i]),
        1
      )
    );
    // A 37-session step shares only 11 dates with a 1-session run of 400.
    const slow = series("slow", noise(155, 400), 37);
    const r = familyBreadth([...fast, slow]);

    expect(r.pairsUnmeasurable).toBeGreaterThan(0);
    expect(r.bestCaseBets).not.toBeNull();
    expect(r.bestCaseBets!).toBeGreaterThan(r.breadth.effective_bets!);
    expect(r.sentence).toContain("perfectly independent");
    expect(r.sentence).toContain("nearer the lower end");
  });

  it("excludes series too short to correlate rather than scoring them independent", () => {
    const family = [
      series("long-a", noise(11, 200)),
      series("long-b", noise(12, 200)),
      // Four periods: cannot support a correlation, must not count as a bet.
      series("stub", [0.01, -0.02, 0.03, -0.01]),
    ];
    const r = familyBreadth(family);
    expect(r.declared).toBe(3);
    expect(r.measured).toBe(2);
    expect(r.breadth.n).toBe(2);
  });

  it("refuses a figure rather than inventing one when nothing overlaps", () => {
    // Disjoint calendars entirely — no pair can be correlated.
    const r = familyBreadth([
      series("a", noise(5, 100), 1, 0),
      series("b", noise(6, 100), 1, 10_000),
    ]);
    expect(r.breadth.effective_bets).toBeNull();
    expect(r.bestCaseBets).toBeNull();
    expect(r.sentence).toContain("Reported as unmeasured");
  });

  /*
   * The conclusion the page will rest on. Correlated tests make the FDR
   * correction STRICTER, not weaker, and a sentence that let a reader infer
   * the opposite would be the worst possible outcome of publishing this.
   */
  it("states that correlation does not invalidate a survivor", () => {
    const parent = noise(1, 200);
    const r = familyBreadth([
      series("parent", parent),
      series("twin", parent.map((x) => x * 1.01)),
      series("other", noise(99, 200)),
    ]);
    expect(r.sentence).toContain("does not make a surviving result wrong");
    expect(r.sentence).toContain("harder");
  });
});

/**
 * THE CRYPTO CASE: A SIGNAL AND ITS OWN NEGATION.
 *
 * `squeezeRisk` fades a crowded side and `longShort` trends it, off
 * overlapping positioning inputs, so on all 1181 observations where both take
 * a position they take opposite ones. The signed formula scores that as
 * diversification — correctly, for a basket — and the family reads 8.5 bets
 * of 12. Nobody holds these. They are tests, and two of them are one test.
 */
describe("familyBreadth — one idea, inverted", () => {
  it("separates the counting answer from the portfolio answer", () => {
    const a = noise(3, 300);
    const family = [
      series("squeeze", a),
      series(
        "longshort",
        a.map((x) => -x)
      ),
      series("other", noise(41, 300)),
    ];
    const r = familyBreadth(family);

    /*
     * The whole finding in two assertions. A perfect hedge inside a
     * three-name family drags mean SIGNED rho toward zero, so the bets figure
     * comes out near the headcount — while mean |rho| cannot cancel and the
     * counting figure collapses.
     */
    expect(r.breadth.effective_bets!).toBeGreaterThan(2.9);
    expect(r.distinctTests!).toBeLessThan(2);
    expect(r.distinctTests!).toBeLessThan(r.breadth.effective_bets!);
  });

  it("sees the negation as a duplicate, which a signed screen cannot", () => {
    const a = noise(3, 300);
    const r = familyBreadth([
      series("squeeze", a),
      series(
        "longshort",
        a.map((x) => -x)
      ),
      series("other", noise(41, 300)),
    ]);
    expect(r.breadth.near_duplicates_total).toBe(1);
    expect(r.breadth.near_duplicates[0].rho).toBeLessThan(-0.999);
    expect(r.inversePairs).toBe(1);
    expect(r.duplicateSentence).toContain("one signal and its negation");
  });

  /*
   * The sentence is what a reader actually gets, and the failure mode is
   * subtle: quoting "8.5 independent ideas" is TRUE and reads as coverage.
   * The prose has to hand the reader the smaller figure for the question
   * multiple testing asks, or the measurement makes the overstatement more
   * credible rather than less.
   */
  it("points the coverage claim at the counting figure, not the bets figure", () => {
    const a = noise(3, 300);
    const r = familyBreadth([
      series("squeeze", a),
      series(
        "longshort",
        a.map((x) => -x)
      ),
      series("other", noise(41, 300)),
    ]);
    expect(r.sentence).toContain("independent BETS, not distinct IDEAS");
    expect(r.sentence).toContain("squeeze");
    expect(r.sentence).toContain(`${r.distinctTests!.toFixed(1)} is the figure that applies`);
    // And the correction is framed against the small number, not the large one.
    expect(r.sentence).toContain(`correcting across ${Math.round(r.distinctTests!)}`);
  });

  /*
   * Silence is not diversification. Seven of the nineteen crypto modules never
   * emit a directional call in the replay, so the measured end covers twelve
   * — and "8.5 of 19" would be a claim about the seven that nothing supports.
   */
  it("refuses a percentage of the headcount when part of the family is silent", () => {
    const r = familyBreadth(
      [
        series("a", noise(11, 200)),
        series("b", noise(12, 200)),
        series("silent", []),
        series("also-silent", []),
      ],
      "modules"
    );
    expect(r.declared).toBe(4);
    expect(r.measured).toBe(2);
    expect(r.sentence).toContain("4 declared modules");
    expect(r.sentence).toContain("unmeasured rather than independent");
    expect(r.sentence).not.toMatch(/% of the headcount/);
  });

  it("keeps the percentage when every declared member was measured", () => {
    const r = familyBreadth([series("a", noise(11, 200)), series("b", noise(12, 200))]);
    expect(r.sentence).toContain("% of the headcount at the measured end");
  });
});
