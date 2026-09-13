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
    expect(r.sentence).toContain("does not make a surviving hypothesis wrong");
    expect(r.sentence).toContain("harder");
  });
});
