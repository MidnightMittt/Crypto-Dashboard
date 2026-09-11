import { describe, expect, it } from "vitest";
import {
  BP,
  PAPER_ENGINE_VERSION,
  PaperDeclaration,
  PaperSession,
  buildPaperLine,
  buildPaperRecord,
  fingerprintDeclaration,
  paperCaveat,
  sessionsToReachT,
} from "./paperEngine";

/**
 * The failures this guards are all of the flattering kind: a sample size that
 * counts the same night twice, a breakeven that ignores how often the strategy
 * trades, a cumulative line that sums basis points as though they compounded
 * linearly, and a caveat that disappears exactly when the record is weakest.
 */

const DECLARATION: PaperDeclaration = {
  id: "test-strategy",
  statement: "A strategy that exists only in this file.",
  entry: "prior close",
  exit: "next open",
  holdSessions: 1,
  // Before every fixture date below, so the default record is entirely
  // out-of-sample and the in-sample clause has to be provoked deliberately.
  declaredOn: "2025-12-31",
  costBasis: "modelled",
  costNote: "one tick round trip",
  independenceBasis: "consecutive overnight returns share no bar",
  killCriteria: "a negative mean over 250 sessions",
};

const session = (date: string, grossBp: number, costBp = 0, over: Partial<PaperSession> = {}): PaperSession => ({
  date,
  grossBp,
  costBp,
  netBp: grossBp - costBp,
  names: 1,
  turnover: 1,
  ...over,
});

/** n dated sessions starting 2026-01-01, each with the same gross. */
const flat = (n: number, grossBp: number, costBp = 0): PaperSession[] =>
  Array.from({ length: n }, (_, i) =>
    session(`2026-01-${String(i + 1).padStart(2, "0")}`, grossBp, costBp)
  );

/**
 * A short, genuinely underpowered record: a small positive mean buried in
 * dispersion an order of magnitude larger, which is what a real overnight
 * series at low n looks like.
 *
 * The first draft of this fixture was ten flat sessions plus one outlier, on
 * the assumption that "short" meant "not significant". It came out at t=4.5 —
 * eleven nearly identical numbers have almost no dispersion, so the standard
 * error is tiny and the t is huge. The assertion caught the fixture rather
 * than the code, which is the correct outcome and the reason the dispersion
 * here is chosen against the mean instead of by eye.
 */
const noisy = (n = 12): PaperSession[] =>
  Array.from({ length: n }, (_, i) =>
    session(`2026-01-${String(i + 1).padStart(2, "0")}`, i % 2 === 0 ? 110 : -90)
  );

describe("buildPaperRecord", () => {
  it("orders by date whatever order the producer emitted", () => {
    const r = buildPaperRecord(DECLARATION, [
      session("2026-03-02", 10),
      session("2026-01-05", 10),
      session("2026-02-09", 10),
    ]);
    expect(r.sessions.map((s) => s.date)).toEqual(["2026-01-05", "2026-02-09", "2026-03-02"]);
    expect(r.firstDate).toBe("2026-01-05");
    expect(r.lastDate).toBe("2026-03-02");
  });

  /*
   * A duplicated date is a producer bug, and the two wrong answers point in
   * opposite directions. Summing inflates that date's contribution AND the
   * sample size; dropping it silently loses an observation. Taking the last
   * entry keeps n honest, which is the field every other statistic divides by.
   */
  it("counts one date once", () => {
    const r = buildPaperRecord(DECLARATION, [
      session("2026-01-05", 10),
      session("2026-01-05", 90),
      session("2026-01-06", 10),
    ]);
    expect(r.n).toBe(2);
    expect(r.sessions.find((s) => s.date === "2026-01-05")!.grossBp).toBe(90);
  });

  it("drops a non-finite observation rather than poisoning every statistic", () => {
    const r = buildPaperRecord(DECLARATION, [
      session("2026-01-05", 10),
      session("2026-01-06", NaN),
      session("2026-01-07", 10),
    ]);
    expect(r.n).toBe(2);
    expect(r.net!.meanBp).toBeCloseTo(10, 9);
  });

  /*
   * COMPOUNDING, not summing. 250 sessions at 50bp is 1.25x if the returns
   * compound and 1.125x if they are added, and the gap grows with the record.
   */
  it("compounds the cumulative line instead of adding basis points", () => {
    const r = buildPaperRecord(DECLARATION, flat(250, 50));
    const compounded = (1.005 ** 250 - 1) * 100;
    expect(r.cumulativeGrossPct!).toBeCloseTo(compounded, 6);
    expect(r.cumulativeGrossPct!).toBeGreaterThan(250 * 0.5); // strictly above the sum
  });

  it("charges cost into the net line and leaves gross alone", () => {
    const r = buildPaperRecord(DECLARATION, flat(100, 40, 15));
    expect(r.gross!.meanBp).toBeCloseTo(40, 9);
    expect(r.net!.meanBp).toBeCloseTo(25, 9);
    expect(r.meanCostBp).toBeCloseTo(15, 9);
  });

  it("reports drawdown off the peak of the compounded net line", () => {
    // Up 100bp, up 100bp, then down 300bp.
    const r = buildPaperRecord(DECLARATION, [
      session("2026-01-01", 100),
      session("2026-01-02", 100),
      session("2026-01-03", -300),
    ]);
    const peak = 1.01 * 1.01;
    const trough = peak * 0.97;
    expect(r.maxDrawdownPct!).toBeCloseTo((1 - trough / peak) * 100, 9);
    expect(r.worstSessionBp).toBe(-300);
  });

  it("has no statistics, and says so, below two observations", () => {
    const r = buildPaperRecord(DECLARATION, flat(1, 40));
    expect(r.n).toBe(1);
    expect(r.net).toBeNull();
    expect(r.detectableAtT3Bp).toBeNull();
    expect(paperCaveat(r)).toContain("too few");
  });

  it("is empty, not zero, with nothing to compute", () => {
    const r = buildPaperRecord(DECLARATION, []);
    expect(r.n).toBe(0);
    expect(r.cumulativeNetPct).toBeNull();
    expect(r.maxDrawdownPct).toBeNull();
    expect(r.worstSessionBp).toBeNull();
    expect(r.breakevenCostBp).toBeNull();
    expect(paperCaveat(r)).toContain("nothing here");
  });
});

/*
 * THE BREAKEVEN, which is the number that decides whether any of this is a
 * trade. A flat per-period cost charge makes a nightly strategy and a monthly
 * one look alike; dividing by turnover puts them on one scale.
 */
describe("breakevenCostBp", () => {
  it("equals the gross mean when the strategy turns over fully each session", () => {
    const r = buildPaperRecord(DECLARATION, flat(50, 37));
    expect(r.meanTurnover).toBeCloseTo(1, 12);
    expect(r.breakevenCostBp!).toBeCloseTo(37, 9);
  });

  /*
   * The case the flat charge gets wrong. Same gross per period, but only 40%
   * of the book is replaced — so the strategy survives a round trip 2.5x more
   * expensive than a nightly one earning the same gross.
   */
  it("scales up when only part of the book is replaced", () => {
    const r = buildPaperRecord(
      DECLARATION,
      flat(50, 37).map((s) => ({ ...s, turnover: 0.4 }))
    );
    expect(r.breakevenCostBp!).toBeCloseTo(37 / 0.4, 9);
  });

  it("refuses rather than reporting an unbounded breakeven at zero turnover", () => {
    const r = buildPaperRecord(
      DECLARATION,
      flat(50, 37).map((s) => ({ ...s, turnover: 0 }))
    );
    expect(r.breakevenCostBp).toBeNull();
  });

  /*
   * Breakeven is computed from GROSS. Computing it from net would answer "what
   * extra cost on top of the cost already charged", which is a different and
   * much smaller number wearing the same label.
   */
  it("is measured against gross, not against the already-charged net", () => {
    const r = buildPaperRecord(DECLARATION, flat(50, 37, 20));
    expect(r.breakevenCostBp!).toBeCloseTo(37, 9);
  });
});

describe("sessionsToReachT", () => {
  /*
   * The only question a two-observation series can honestly be asked. If a
   * record has to run for 4,000 sessions to decide anything, that is a fact
   * about the design, not about the market, and it should be visible on day
   * one rather than discovered in year three.
   */
  it("inverts the t statistic: n scales with (sd/mean) squared", () => {
    const r = buildPaperRecord(DECLARATION, [
      ...flat(10, 10),
      // Introduce dispersion so sd is real.
      session("2026-02-01", -10),
      session("2026-02-02", 30),
    ]);
    const need = sessionsToReachT(r.net)!;
    expect(need).toBe(Math.ceil(((3 * r.net!.sdBp) / r.net!.meanBp) ** 2));
    expect(r.sessionsToT3).toBe(need);
  });

  /*
   * A negative mean has no answer to "when does this become significantly
   * positive". Returning a very large number would be read as one.
   */
  it("refuses when the mean points the wrong way", () => {
    const r = buildPaperRecord(DECLARATION, [
      session("2026-01-01", -20),
      session("2026-01-02", -5),
      session("2026-01-03", -30),
    ]);
    expect(r.net!.meanBp).toBeLessThan(0);
    expect(r.sessionsToT3).toBeNull();
  });

  it("refuses on a series with no dispersion", () => {
    // A constant series: summariseSeries floors its t at 0, so no n suffices.
    const r = buildPaperRecord(DECLARATION, flat(30, 25));
    expect(r.net!.sdBp).toBe(0);
    expect(r.sessionsToT3).toBeNull();
  });
});

/*
 * THE FINGERPRINT. This record is DERIVED — recomputed from committed inputs
 * every night — so redefining the strategy rewrites its entire history in
 * place, in the direction of whoever did the redefining. The fingerprint is
 * what makes that visible in a diff instead of invisible in a number.
 */
describe("definitionFingerprint", () => {
  it("is stable across runs of an unchanged declaration", () => {
    expect(fingerprintDeclaration(DECLARATION)).toBe(fingerprintDeclaration({ ...DECLARATION }));
  });

  it("moves when ANY declared field moves", () => {
    const base = fingerprintDeclaration(DECLARATION);
    const mutations: PaperDeclaration[] = [
      { ...DECLARATION, id: "other" },
      { ...DECLARATION, statement: "something else" },
      { ...DECLARATION, entry: "15:50 mark" },
      { ...DECLARATION, exit: "next close" },
      { ...DECLARATION, holdSessions: 21 },
      { ...DECLARATION, declaredOn: "2026-06-01" },
      { ...DECLARATION, costBasis: "measured" },
      { ...DECLARATION, costNote: "measured book" },
      { ...DECLARATION, independenceBasis: "periods step by the hold" },
      { ...DECLARATION, killCriteria: "anything at all" },
    ];
    for (const m of mutations) {
      expect(fingerprintDeclaration(m), JSON.stringify(m)).not.toBe(base);
    }
  });

  /*
   * The two overnight legs differ ONLY in where they are marked. If the
   * fingerprint could not tell them apart, a record of one would be
   * indistinguishable from a record of the other — and the difference between
   * them is the entire measurement.
   */
  it("separates the two overnight legs, which differ only in the mark", () => {
    const closeToOpen = { ...DECLARATION, id: "overnight", entry: "prior close" };
    const markToOpen = { ...DECLARATION, id: "overnight", entry: "15:50 mark" };
    expect(fingerprintDeclaration(closeToOpen)).not.toBe(fingerprintDeclaration(markToOpen));
  });

  it("is stamped into the record along with the engine version", () => {
    const r = buildPaperRecord(DECLARATION, flat(5, 10));
    expect(r.definitionFingerprint).toBe(fingerprintDeclaration(DECLARATION));
    expect(r.engineVersion).toBe(PAPER_ENGINE_VERSION);
  });
});

/*
 * THE CAVEAT, which has to be loudest exactly where the record is weakest.
 * A positive mean at n=4 renders identically to a positive mean at n=400
 * unless something says otherwise, and this engine exists precisely because
 * the live series is tiny.
 */
describe("paperCaveat", () => {
  it("names the sample size, the power, and the wait", () => {
    const r = buildPaperRecord(DECLARATION, noisy());
    // The fixture must actually be underpowered, or this asserts nothing.
    expect(Math.abs(r.net!.tStat)).toBeLessThan(3);
    const c = paperCaveat(r)!;
    expect(c).toContain("does not clear t=3");
    expect(c).toContain(`${r.n} sessions`);
    expect(c).toContain("could only have detected");
    expect(c).toContain(`~${r.sessionsToT3} sessions`);
  });

  it("says so while the cost is a model rather than a book", () => {
    expect(paperCaveat(buildPaperRecord(DECLARATION, noisy()))!).toContain(
      "model, not a measured book"
    );
    const measured = paperCaveat(
      buildPaperRecord({ ...DECLARATION, costBasis: "measured" }, noisy())
    )!;
    expect(measured).not.toContain("model, not a measured book");
    // ...and the rest of the caveat survives, rather than the whole thing
    // vanishing because one clause did.
    expect(measured).toContain("does not clear t=3");
  });

  /*
   * Twelve correlated miners on one night is one bet. The record already
   * averages within a date, but a reader seeing "n=200" beside a basket needs
   * telling that the 200 is nights and not name-nights.
   */
  it("warns that a multi-name basket is one bet per night", () => {
    const r = buildPaperRecord(
      DECLARATION,
      noisy().map((s) => ({ ...s, names: 12 }))
    );
    expect(paperCaveat(r)!).toContain("correlated names");
    expect(paperCaveat(r)!).toContain("one bet");
  });

  it("falls silent only once the record clears t=3 on a measured book", () => {
    // 400 sessions, mean 10bp with small dispersion -> a large t.
    const sessions = Array.from({ length: 400 }, (_, i) =>
      session(
        new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
        10 + (i % 2 ? 1 : -1)
      )
    );
    const r = buildPaperRecord({ ...DECLARATION, costBasis: "measured" }, sessions);
    expect(Math.abs(r.net!.tStat)).toBeGreaterThan(3);
    expect(paperCaveat(r)).toBeNull();
  });
});

/*
 * THE SPLIT AT THE DECLARATION. The momentum leg backfills over years of bars
 * the strategy was selected on. Run through the same engine as the overnight
 * leg and reported as one number, its backtest significance would sit beside
 * an overnight paper record three weeks old and read as the same kind of
 * evidence. It is not, and the only thing that separates them is the date.
 */
describe("buildPaperLine", () => {
  const DECLARED = "2026-01-06";
  const spanning = flat(10, 20); // 2026-01-01 .. 2026-01-10

  it("counts only sessions on or after the declaration as the paper record", () => {
    const line = buildPaperLine({ ...DECLARATION, declaredOn: DECLARED }, spanning);
    expect(line.full.n).toBe(10);
    // On the declaration date counts as declared: the claim was fixed before
    // the session it is measured on resolved.
    expect(line.sinceDeclared.n).toBe(5);
    expect(line.sinceDeclared.firstDate).toBe(DECLARED);
    expect(line.inSampleSessions).toBe(5);
  });

  it("keeps the two halves on the same declaration and fingerprint", () => {
    const d = { ...DECLARATION, declaredOn: DECLARED };
    const line = buildPaperLine(d, spanning);
    expect(line.sinceDeclared.definitionFingerprint).toBe(line.full.definitionFingerprint);
    expect(line.sinceDeclared.definitionFingerprint).toBe(fingerprintDeclaration(d));
  });

  /*
   * A leg declared today. Its capture history is real and is still reported in
   * `full`, but the paper record starts empty rather than claiming sessions
   * collected before the rule existed.
   */
  it("starts a freshly declared strategy at n=0 without discarding its history", () => {
    const line = buildPaperLine({ ...DECLARATION, declaredOn: "2026-12-01" }, spanning);
    expect(line.sinceDeclared.n).toBe(0);
    expect(line.sinceDeclared.net).toBeNull();
    expect(line.full.n).toBe(10);
    expect(line.inSampleSessions).toBe(10);
  });

  /*
   * Split off the DE-DUPLICATED sessions, not the raw input. A duplicate date
   * landing in one half and not the other would make the halves disagree about
   * a date they both contain.
   */
  it("splits after de-duplication, so the halves cannot disagree about a date", () => {
    const dup = [...spanning, session("2026-01-07", 999)];
    const line = buildPaperLine({ ...DECLARATION, declaredOn: DECLARED }, dup);
    expect(line.full.n).toBe(10);
    expect(line.sinceDeclared.n + line.inSampleSessions).toBe(line.full.n);
    // The last row for a date wins in both halves.
    expect(line.sinceDeclared.sessions.find((s) => s.date === "2026-01-07")!.grossBp).toBe(999);
  });

  it("warns on the full record that it is in-sample, and not on the paper one", () => {
    const line = buildPaperLine({ ...DECLARATION, declaredOn: DECLARED }, noisy());
    expect(paperCaveat(line.full)!).toContain("in-sample");
    expect(paperCaveat(line.full)!).toContain(DECLARED);
    expect(paperCaveat(line.sinceDeclared) ?? "").not.toContain("in-sample");
  });
});

describe("BP", () => {
  it("is the basis-point scale the whole engine converts through", () => {
    expect(BP).toBe(10_000);
  });
});
