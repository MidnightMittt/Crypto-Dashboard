import { describe, expect, it } from "vitest";
import { DatedValue, readVolTermStructure } from "./volTermStructure";

/**
 * Fixtures are built so the ratio and its percentile can be worked out by
 * hand. A term-structure read is a division and a rank; both are easy to get
 * subtly wrong and impossible to notice downstream, because the output is a
 * plausible-looking number either way.
 */

/** `n` sessions of a constant ratio, dated backwards from 2026-08-13. */
function series(n: number, vixAt: (i: number) => number, farAt: (i: number) => number) {
  const vix: DatedValue[] = [];
  const vix3m: DatedValue[] = [];
  const start = Date.parse("2026-08-13T00:00:00Z");
  for (let i = n - 1; i >= 0; i--) {
    const date = new Date(start - i * 86_400_000).toISOString().slice(0, 10);
    vix.push({ date, value: vixAt(n - 1 - i) });
    vix3m.push({ date, value: farAt(n - 1 - i) });
  }
  return { vix, vix3m };
}

describe("readVolTermStructure — the measurement", () => {
  it("divides three-month by spot at the latest shared date", () => {
    // Flat 20 spot, 24 three-month → 1.20 throughout.
    const { vix, vix3m } = series(300, () => 20, () => 24);
    const r = readVolTermStructure(vix, vix3m)!;
    expect(r.ratio).toBeCloseTo(1.2, 10);
    expect(r.asOf).toBe("2026-08-13");
    expect(r.state).toBe("contango");
  });

  it("calls an inverted curve backwardation", () => {
    const { vix, vix3m } = series(300, (i) => (i === 299 ? 40 : 20), () => 24);
    const r = readVolTermStructure(vix, vix3m)!;
    // 24 / 40 = 0.60
    expect(r.ratio).toBeCloseTo(0.6, 10);
    expect(r.state).toBe("backwardation");
    expect(r.sentence).toMatch(/BACKWARDATED/);
    // Direction is not claimed — only that protection is being paid up for.
    expect(r.sentence).toMatch(/says nothing about direction/);
  });

  /*
   * 1.0 is the mechanically meaningful line and a bad threshold: the ratio
   * crosses it by rounding on quiet days, and a state that flickers is one
   * nobody can act on. The band between 0.98 and 1.02 reads as flat.
   */
  it("treats a curve hovering at parity as flat rather than flickering", () => {
    for (const far of [19.9, 20.0, 20.3]) {
      const { vix, vix3m } = series(300, () => 20, (i) => (i === 299 ? far : 24));
      expect(readVolTermStructure(vix, vix3m)!.state, `far=${far}`).toBe("flat");
    }
  });
});

describe("readVolTermStructure — the percentile", () => {
  /*
   * A ratio well above everything it has ever printed sits at the top of its
   * own distribution. This is what separates "contango" from "unusually
   * steep contango", which the level alone cannot say.
   */
  it("places today's ratio in its own history", () => {
    const { vix, vix3m } = series(400, () => 20, (i) => (i === 399 ? 30 : 22));
    const r = readVolTermStructure(vix, vix3m)!;
    expect(r.ratio).toBeCloseTo(1.5, 10);
    expect(r.percentile).toBeCloseTo(100, 6);
    expect(r.sentence).toMatch(/Unusually steep/);
  });

  it("flags contango that is thin for this market", () => {
    const { vix, vix3m } = series(400, () => 20, (i) => (i === 399 ? 20.8 : 26));
    const r = readVolTermStructure(vix, vix3m)!;
    expect(r.state).toBe("contango");
    expect(r.percentile).toBeCloseTo(0, 6);
    expect(r.sentence).toMatch(/Thin for this market/);
  });

  /*
   * Mid-rank, matching every other banded metric here. A measure with no
   * variation must land at the middle rather than the floor — the
   * zero-variance trap that once turned a flat relative-strength series into
   * a maximally bearish reading.
   */
  it("puts a value tying its whole history at the middle, not the floor", () => {
    const { vix, vix3m } = series(300, () => 20, () => 24);
    expect(readVolTermStructure(vix, vix3m)!.percentile).toBeCloseTo(50, 6);
  });
});

describe("readVolTermStructure — refusals and alignment", () => {
  it("refuses when there is not enough shared history to rank against", () => {
    const { vix, vix3m } = series(100, () => 20, () => 24);
    expect(readVolTermStructure(vix, vix3m)).toBeNull();
  });

  /*
   * THE FAILURE THIS PREVENTS, and it is not hypothetical: Yahoo's ^VIX3M was
   * a month staler than its ^VIX when this was built. Pairing by POSITION
   * would divide a fresh near-dated print by a month-old far-dated one and
   * return a confident number describing nothing. Pairing by DATE makes it
   * impossible — the read simply ends at the last date both legs share.
   */
  it("ends at the last date BOTH legs have, never the fresher one", () => {
    const { vix, vix3m } = series(300, () => 20, () => 24);
    // The far leg stops a month early, exactly as the live source did.
    const stale = vix3m.slice(0, vix3m.length - 21);
    const r = readVolTermStructure(vix, stale)!;
    expect(r.asOf).toBe(stale[stale.length - 1].date);
    expect(r.asOf).not.toBe("2026-08-13");
  });

  it("drops sessions only one leg has rather than interpolating them", () => {
    const { vix, vix3m } = series(300, () => 20, () => 24);
    const gapped = vix.filter((_, i) => i !== 150);
    const r = readVolTermStructure(gapped, vix3m)!;
    expect(r.historyLength).toBe(gapped.length - 1);
  });

  it("ignores non-positive prints instead of dividing by them", () => {
    const { vix, vix3m } = series(300, (i) => (i === 150 ? 0 : 20), () => 24);
    const r = readVolTermStructure(vix, vix3m)!;
    expect(Number.isFinite(r.ratio)).toBe(true);
    expect(r.historyLength).toBe(298);
  });
});
