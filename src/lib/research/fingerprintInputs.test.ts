import { describe, expect, it } from "vitest";
import { RollingStandardiser, standardise } from "./fingerprintInputs";
import { DIMENSIONS } from "./fingerprint";

const feed = (s: RollingStandardiser, dim: string, values: number[]) => values.map((v) => s.z(dim, v));

describe("RollingStandardiser", () => {
  it("withholds a z-score until there is enough history to mean anything", () => {
    const s = new RollingStandardiser();
    // Each of the first 60 calls sees at most 59 priors, so all withhold.
    const out = feed(s, "trend", Array.from({ length: 60 }, (_, i) => i));
    expect(out.every((x) => x === null)).toBe(true);
    // The 61st is the first with a full 60 observations behind it.
    expect(s.z("trend", 100)).not.toBeNull();
  });

  /*
   * ── THE LEAK TRIPWIRE ────────────────────────────────────────────────
   *
   * The whole module exists for this test. Standardising against the FULL
   * history rather than the prior history is the classic look-ahead: it is
   * invisible in the output, it improves every backtest, and the improvement
   * is entirely the leak. Replaying a prefix must reproduce the same values
   * the longer series produced.
   */
  it("never changes a value already produced when later data arrives", () => {
    const series = Array.from({ length: 200 }, (_, i) => Math.sin(i / 7) * 10 + i * 0.1);

    const long = new RollingStandardiser();
    const fromFull = feed(long, "volatility", series);

    // Replay only the first 120 observations, as if today were session 120.
    const short = new RollingStandardiser();
    const fromPrefix = feed(short, "volatility", series.slice(0, 120));

    expect(fromPrefix).toEqual(fromFull.slice(0, 120));
  });

  it("is unaffected by an enormous future observation", () => {
    const base = Array.from({ length: 120 }, (_, i) => i % 11);
    const a = feed(new RollingStandardiser(), "trend", base);
    // The same series, but a 10,000-sigma day arrives afterwards.
    const b = feed(new RollingStandardiser(), "trend", [...base, 1e6]);
    expect(b.slice(0, base.length)).toEqual(a);
  });

  it("keeps dimensions independent of one another", () => {
    const s = new RollingStandardiser();
    feed(s, "trend", Array.from({ length: 80 }, () => 5));
    // Volatility has its own history, still empty, so it withholds.
    expect(s.z("volatility", 3)).toBeNull();
    expect(s.seen("trend")).toBe(80);
    expect(s.seen("volatility")).toBe(1);
  });

  /*
   * Distance is Euclidean, so a single 40-sigma reading would dominate every
   * comparison it appears in and make that day resemble nothing. Clipping
   * keeps it extreme without letting it swamp the other dimensions.
   */
  it("clips extremes rather than letting one reading swamp the vector", () => {
    const s = new RollingStandardiser();
    feed(s, "trend", Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 1 : -1)));
    const z = s.z("trend", 10_000)!;
    expect(z).toBe(4);
  });

  it("reports zero rather than infinity for a dimension that never varies", () => {
    const s = new RollingStandardiser();
    feed(s, "breadth", Array.from({ length: 80 }, () => 7));
    expect(s.z("breadth", 7)).toBe(0);
  });

  it("ignores a non-finite reading instead of poisoning the history", () => {
    const s = new RollingStandardiser();
    feed(s, "trend", Array.from({ length: 80 }, (_, i) => i));
    expect(s.z("trend", NaN)).toBeNull();
    // NaN was not recorded, so the next real value standardises cleanly.
    expect(Number.isFinite(s.z("trend", 40)!)).toBe(true);
  });
});

describe("standardise", () => {
  const warm = (s: RollingStandardiser) => {
    for (let i = 0; i < 80; i++) {
      standardise({ trend: Math.sin(i) * 2, volatility: i % 7 }, s);
    }
  };

  it("emits only the dimensions the caller actually supplied", () => {
    const s = new RollingStandardiser();
    warm(s);
    const { values } = standardise({ trend: 1.5, volatility: 3 }, s);
    expect(Object.keys(values).sort()).toEqual(["trend", "volatility"]);
  });

  /*
   * Zero standardises to "exactly average", which is a CLAIM. An absent
   * dimension must stay absent so the distance function can exclude it
   * rather than treat the instrument as unremarkable on that axis.
   */
  it("does not invent a value for a dimension the caller omitted", () => {
    const s = new RollingStandardiser();
    warm(s);
    const { values } = standardise({ trend: 1.5 }, s);
    expect("volatility" in values).toBe(false);
  });

  /*
   * The ingest and the definition live in different files. A dimension
   * renamed in one and not the other would otherwise produce vectors that
   * silently never match on that axis — which reads as "no similar days"
   * rather than as a bug.
   */
  it("reports readings whose dimension the definition does not know", () => {
    const s = new RollingStandardiser();
    const { unknown } = standardise({ trend: 1, sectorLeadership: 2, madeUpAxis: 3 }, s);
    expect(unknown).toEqual(["madeUpAxis"]);
  });

  it("feeds dimensions in definition order, not caller key order", () => {
    // Two callers building the record in opposite orders must produce
    // identical standardisers, or the same day would fingerprint differently
    // depending on how the ingest happened to assemble its object.
    const a = new RollingStandardiser();
    const b = new RollingStandardiser();
    for (let i = 0; i < 80; i++) {
      standardise({ trend: i, volatility: i * 2 }, a);
      standardise({ volatility: i * 2, trend: i }, b);
    }
    expect(standardise({ trend: 90, volatility: 180 }, a).values).toEqual(
      standardise({ volatility: 180, trend: 90 }, b).values
    );
  });

  it("covers every dimension the definition declares", () => {
    const s = new RollingStandardiser();
    const raw = Object.fromEntries(DIMENSIONS.map((d) => [d.id, 1]));
    // No history yet, so nothing is emitted — but nothing is reported unknown
    // either, which is the property under test.
    expect(standardise(raw, s).unknown).toEqual([]);
  });
});
