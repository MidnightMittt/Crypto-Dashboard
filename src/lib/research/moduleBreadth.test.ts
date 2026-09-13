import { describe, expect, it } from "vitest";
import { ModuleDay, moduleFamilySeries } from "./moduleBreadth";
import { familyBreadth } from "./familyBreadth";

const day = (asset: string, t: number, calls: Record<string, string>): ModuleDay => ({
  asset,
  t,
  metrics: Object.entries(calls).map(([id, verdict]) => ({ id, verdict })),
});

describe("moduleFamilySeries", () => {
  it("maps the two directions to opposite signs and drops neutral", () => {
    const series = moduleFamilySeries(
      [
        day("BTC", 1, { a: "bullish" }),
        day("BTC", 2, { a: "bearish" }),
        day("BTC", 3, { a: "neutral" }),
      ],
      ["a"]
    );
    expect(series[0].periods.map((p) => p.spread)).toEqual([1, -1]);
  });

  /*
   * A neutral is an ABSENCE, not a flat reading. Two modules that fall silent
   * on the same days would otherwise correlate purely by being quiet
   * together, which is how a gate starts to look like an independent idea.
   */
  it("does not let shared silence correlate two modules", () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((t) =>
      // `a` calls on odd days, `b` on even; both neutral otherwise. They share
      // no observation at all, so nothing can be correlated between them.
      day("BTC", t, {
        a: t % 2 === 1 ? "bullish" : "neutral",
        b: t % 2 === 0 ? "bullish" : "neutral",
      })
    );
    const [a, b] = moduleFamilySeries(days, ["a", "b"]);
    expect(a.periods).toHaveLength(5);
    expect(b.periods).toHaveLength(5);
    expect(new Set(a.periods.map((p) => p.entryTime))).not.toEqual(
      new Set(b.periods.map((p) => p.entryTime))
    );
    // No overlapping dates -> no correlation -> a refusal, not a zero.
    expect(familyBreadth([a, b]).breadth.effective_bets).toBeNull();
  });

  /*
   * THE ALIGNMENT KEY. The replay scores BTC and ETH on one timestamp, and
   * `familyBreadth` aligns on entryTime — so without the per-asset offset the
   * second row overwrites the first and half the sample vanishes silently.
   * Deleting the offset makes this test fail with 10 periods instead of 20.
   */
  it("keeps two assets sharing one timestamp as two observations", () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((t) => [
      day("BTC", t * 1000, { a: "bullish" }),
      day("ETH", t * 1000, { a: "bearish" }),
    ]);
    const [a] = moduleFamilySeries(days, ["a"]);
    expect(a.periods).toHaveLength(20);
    expect(new Set(a.periods.map((p) => p.entryTime)).size).toBe(20);
  });

  it("returns an empty series for a module that never appears", () => {
    const [ghost] = moduleFamilySeries([day("BTC", 1, { a: "bullish" })], ["ghost"]);
    expect(ghost.id).toBe("ghost");
    expect(ghost.periods).toEqual([]);
  });

  it("ignores a verdict that is neither direction", () => {
    const [a] = moduleFamilySeries(
      [day("BTC", 1, { a: "unavailable" }), day("BTC", 2, { a: "bullish" })],
      ["a"]
    );
    expect(a.periods).toHaveLength(1);
  });
});

/**
 * The measured arrangement, in miniature: one module is another with the sign
 * flipped on every shared observation, and a third is unrelated. What the real
 * family does at n=12 this does at n=3.
 */
describe("moduleFamilySeries — the pair that is one pair", () => {
  it("carries an exact negation through to the breadth read", () => {
    // 80 observations, comfortably over effectiveBreadth's 60-session floor
    // for correlating a pair at all.
    const days = Array.from({ length: 80 }, (_, i) => {
      const up = i % 3 !== 0;
      return day("BTC", i, {
        squeezeRisk: up ? "bullish" : "bearish",
        longShort: up ? "bearish" : "bullish",
        funding: i % 2 === 0 ? "bullish" : "bearish",
      });
    });
    const r = familyBreadth(
      moduleFamilySeries(days, ["squeezeRisk", "longShort", "funding"]),
      "modules"
    );

    expect(r.breadth.near_duplicates_total).toBe(1);
    expect(r.breadth.near_duplicates[0].rho).toBeLessThan(-0.999);
    expect(r.distinctTests!).toBeLessThan(r.breadth.effective_bets!);
  });
});
