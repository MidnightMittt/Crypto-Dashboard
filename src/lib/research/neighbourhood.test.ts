import { describe, expect, it } from "vitest";
import { summariseNeighbourhood, NeighbourOutcome, MIN_EFFECTIVE_N } from "./neighbourhood";
import { FINGERPRINT_VERSION, Neighbour } from "./fingerprint";

const n = (
  symbol: string,
  date: string,
  outcome: Partial<NeighbourOutcome> = {},
  distance = 0.4
): Neighbour<NeighbourOutcome> => ({
  fingerprint: { symbol, date, version: FINGERPRINT_VERSION, values: {} },
  distance,
  outcome: {
    forwardReturnPct: 2,
    maxAdversePct: -3,
    maxFavourablePct: 5,
    sessionsHeld: 12,
    ...outcome,
  },
});

/** Twelve instruments, twelve separate years — a genuinely spread sample. */
const spread = (over: Partial<NeighbourOutcome> = {}) =>
  Array.from({ length: 12 }, (_, i) => n(`S${i}`, `20${String(10 + i).padStart(2, "0")}-06-01`, over));

const opts = { baselineReturnPct: 0.5, rho: 0.82, windowDays: 21, forwardHorizonDays: 10 };

describe("summariseNeighbourhood", () => {
  it("returns null rather than an empty shell with no neighbours", () => {
    expect(summariseNeighbourhood([], opts)).toBeNull();
  });

  /*
   * ── THE POINT OF THE MODULE ──────────────────────────────────────────
   *
   * The broad-bucket analogs reported "71,585 times seen" for NVDA: the same
   * environments counted thousands of times, once per correlated instrument
   * and once per overlapping window. Forty names in one week is close to ONE
   * observation, and the summary has to lead with that rather than with an
   * attractive median drawn from it.
   */
  it("refuses to quote a probability from forty names in the same week", () => {
    const sameWeek = Array.from({ length: 40 }, (_, i) => n(`S${i}`, "2020-03-16", { forwardReturnPct: 9 }));
    const s = summariseNeighbourhood(sameWeek, opts)!;

    expect(s.matches).toBe(40);
    expect(s.effectiveN).toBeLessThan(MIN_EFFECTIVE_N);
    expect(s.summary).toContain("too thin to quote a probability");
    // The flattering median is still computed — it is simply not sold as evidence.
    expect(s.medianReturnPct).toBeCloseTo(9, 5);
    expect(s.summary).not.toContain("9.0% —");
  });

  it("quotes the independent count, never the raw match count", () => {
    const s = summariseNeighbourhood(spread({ forwardReturnPct: 6 }), opts)!;
    expect(s.effectiveN).toBeGreaterThanOrEqual(MIN_EFFECTIVE_N);
    expect(s.summary).toContain("independent similar environments");
    expect(s.summary).not.toContain("12 similar");
  });

  /*
   * Every claim is measured against the return of a random day over the same
   * horizon. A +6% median in a market that returned +6% anyway is not an
   * edge, and reporting it against zero would say it was.
   */
  it("measures the median against a random day, not against zero", () => {
    const s = summariseNeighbourhood(spread({ forwardReturnPct: 6 }), { ...opts, baselineReturnPct: 6 })!;
    expect(s.medianReturnPct).toBeCloseTo(6, 5);
    expect(s.edgeVsBaselinePct).toBeCloseTo(0, 5);
    expect(s.summary).toContain("did not, historically, change the odds");
  });

  it("calls out a real edge with its size and direction", () => {
    const s = summariseNeighbourhood(spread({ forwardReturnPct: 6 }), { ...opts, baselineReturnPct: 0.5 })!;
    expect(s.edgeVsBaselinePct).toBeCloseTo(5.5, 5);
    expect(s.summary).toContain("5.5 points better");
  });

  it("names a NEGATIVE edge as plainly as a positive one", () => {
    const s = summariseNeighbourhood(spread({ forwardReturnPct: -4 }), { ...opts, baselineReturnPct: 0.5 })!;
    expect(s.summary).toContain("points worse");
  });

  /*
   * Sub-0.2-point differences at these sample sizes are noise. Dressing one
   * up as an edge is the single easiest way to make a research page lie.
   */
  it("treats a fractional difference as no edge at all", () => {
    const s = summariseNeighbourhood(spread({ forwardReturnPct: 0.6 }), { ...opts, baselineReturnPct: 0.5 })!;
    expect(s.summary).toContain("did not, historically, change the odds");
  });

  /*
   * A stop is sized to survive the drawdown that WINNING trades routinely
   * endure, so the number that matters is a high quantile, not the middle
   * one. Here two thirds dipped 2% and a third dipped 12%: a stop placed at
   * the typical 2% would be taken out on a third of the sample before those
   * trades worked.
   */
  it("reports the drawdown a stop must survive, not the typical one", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => n(`S${i}`, `20${10 + i}-06-01`, { maxAdversePct: -2 })),
      ...Array.from({ length: 4 }, (_, i) => n(`D${i}`, `19${90 + i}-06-01`, { maxAdversePct: -12 })),
    ];
    const s = summariseNeighbourhood(rows, opts)!;
    expect(s.typicalDrawdownPct).toBeCloseTo(12, 5);
  });

  it("measures how far WINNERS ran, not how far everything ran", () => {
    const rows = [
      ...spread({ forwardReturnPct: 5, maxFavourablePct: 9 }),
      ...Array.from({ length: 6 }, (_, i) => n(`L${i}`, `199${i}-06-01`, { forwardReturnPct: -5, maxFavourablePct: 0.2 })),
    ];
    const s = summariseNeighbourhood(rows, opts)!;
    // The losers' 0.2% excursions must not drag the winners' figure down.
    expect(s.typicalRunPct).toBeCloseTo(9, 5);
  });

  it("carries the independence line and the distance range for auditing", () => {
    const rows = [n("A", "2011-01-01", {}, 0.2), n("B", "2015-01-01", {}, 0.9)];
    const s = summariseNeighbourhood(rows, opts)!;
    expect(s.nearestDistance).toBeCloseTo(0.2, 5);
    expect(s.furthestDistance).toBeCloseTo(0.9, 5);
    expect(s.independenceLine.length).toBeGreaterThan(20);
    expect(s.instruments).toBe(2);
  });
});
