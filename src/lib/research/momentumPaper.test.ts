import { describe, expect, it } from "vitest";
import { Hypothesis, PeriodLeg } from "./signalLab";
import { BP, buildPaperLine, buildPaperRecord, fingerprintDeclaration } from "./paperEngine";
import {
  HYPOTHESES_DECLARED_ON,
  decileTurnover,
  momentumDeclaration,
  momentumSessions,
} from "./momentumPaper";

const DECLARED = HYPOTHESES_DECLARED_ON;

const DAY = 86_400_000;
const t = (n: number) => Date.UTC(2026, 0, 1) + n * DAY;

const period = (over: Partial<PeriodLeg> & { entryTime: number; exitTime: number }): PeriodLeg => ({
  top: 0.02,
  universe: 0.01,
  topSymbols: ["AAA", "BBB", "CCC", "DDD"],
  topEntryCostBp: 10,
  ...over,
});

/** The declared hypothesis, as close to the real one as a fixture needs to be. */
const H: Hypothesis = {
  id: "momentum-12-1-long-only-broad-up",
  statement: "The top decile beats the panel.",
  rationale: "why",
  hold: 21,
  warmup: 273,
  costPp: 2,
  killCriteria: "a losing decade",
  leg: "long-vs-panel",
  rank: () => 0,
};

describe("decileTurnover", () => {
  it("is zero when the same names are held again", () => {
    expect(decileTurnover(["A", "B", "C", "D"], ["A", "B", "C", "D"])).toBe(0);
  });

  it("is one when the book is replaced entirely", () => {
    expect(decileTurnover(["A", "B"], ["C", "D"])).toBe(1);
  });

  it("is the replaced fraction in between", () => {
    expect(decileTurnover(["A", "B", "C", "D"], ["A", "B", "X", "Y"])).toBeCloseTo(0.5, 12);
  });

  /*
   * A null predecessor is a FULL entry, not a free one — the first period, or
   * the first after the regime gate reopened. Treating it as zero would give
   * the strategy a free position on every re-entry, and this gate reopens
   * often enough for that to matter.
   */
  it("charges a full entry when there was no previous book", () => {
    expect(decileTurnover(null, ["A", "B"])).toBe(1);
  });

  it("is zero with nothing held, rather than dividing by an empty book", () => {
    expect(decileTurnover(["A"], [])).toBe(0);
  });

  /*
   * Divides by CURRENT, not previous. A decile that shrinks from ten names to
   * five while keeping all five has replaced nothing; dividing by the old
   * count would report 50% turnover and charge for trades nobody made.
   */
  it("measures replacement of what is held now, not shrinkage of what was", () => {
    expect(decileTurnover(["A", "B", "C", "D"], ["A", "B"])).toBe(0);
  });
});

describe("momentumSessions", () => {
  it("dates each observation by its exit, not its decision", () => {
    const s = momentumSessions([period({ entryTime: t(0), exitTime: t(21) })], "long-vs-panel");
    expect(s[0].date).toBe(new Date(t(21)).toISOString().slice(0, 10));
  });

  it("puts the decile against the panel, in basis points", () => {
    const s = momentumSessions(
      [period({ entryTime: t(0), exitTime: t(21), top: 0.03, universe: 0.011 })],
      "long-vs-panel"
    );
    expect(s[0].grossBp).toBeCloseTo(0.019 * BP, 9);
  });

  /*
   * THE CHARGE THAT costPp GETS WRONG. Same gross, same entry prices — but a
   * period that keeps three of four names must cost a quarter of one that
   * keeps none. A flat charge makes them identical.
   */
  it("charges cost in proportion to what was actually traded", () => {
    const first = period({ entryTime: t(0), exitTime: t(21), topSymbols: ["A", "B", "C", "D"] });
    const keptMost = period({
      entryTime: t(21),
      exitTime: t(42),
      topSymbols: ["A", "B", "C", "Z"],
    });
    const s = momentumSessions([first, keptMost], "long-vs-panel");
    expect(s[0].turnover).toBe(1); // opening the book
    expect(s[0].costBp).toBeCloseTo(10, 9);
    expect(s[1].turnover).toBeCloseTo(0.25, 12);
    expect(s[1].costBp).toBeCloseTo(2.5, 9);
    expect(s[1].netBp).toBeCloseTo(s[1].grossBp - 2.5, 9);
  });

  /*
   * THE GATE. `runHypothesis` omits periods its regime gate closed, so two
   * adjacent entries can be months apart. Carrying the old decile across that
   * gap would credit the strategy with holding names it had sold and charge
   * nothing to buy them back — a discount granted precisely when the strategy
   * was switched off, which is when re-entry is most expensive.
   */
  it("resets turnover to a full entry across a gated-out gap", () => {
    const before = period({ entryTime: t(0), exitTime: t(21), topSymbols: ["A", "B"] });
    // A gap: this period ENTERS at t(84), not at the previous exit t(21).
    const after = period({ entryTime: t(84), exitTime: t(105), topSymbols: ["A", "B"] });
    const s = momentumSessions([before, after], "long-vs-panel");
    expect(s[1].turnover).toBe(1);
    // ...and the identical names held CONTIGUOUSLY cost nothing.
    const contiguous = period({ entryTime: t(21), exitTime: t(42), topSymbols: ["A", "B"] });
    expect(momentumSessions([before, contiguous], "long-vs-panel")[1].turnover).toBe(0);
  });

  it("orders by entry whatever order the lab emitted", () => {
    const s = momentumSessions(
      [
        period({ entryTime: t(42), exitTime: t(63), topSymbols: ["X"] }),
        period({ entryTime: t(0), exitTime: t(21), topSymbols: ["A"] }),
        period({ entryTime: t(21), exitTime: t(42), topSymbols: ["A"] }),
      ],
      "long-vs-panel"
    );
    expect(s.map((x) => x.date)).toEqual([t(21), t(42), t(63)].map((x) => new Date(x).toISOString().slice(0, 10)));
    // Sorting must happen BEFORE turnover is computed, or the overlap chain
    // is measured against whichever period happened to be emitted first.
    expect(s[1].turnover).toBe(0); // A -> A, contiguous
    expect(s[2].turnover).toBe(1); // A -> X
  });

  it("reports the held count as names, never as a sample size", () => {
    const s = momentumSessions(
      [period({ entryTime: t(0), exitTime: t(21), topSymbols: ["A", "B", "C"] })],
      "long-vs-panel"
    );
    expect(s[0].names).toBe(3);
    expect(s).toHaveLength(1);
  });

  /*
   * A long-short paper line owes a borrow cost and a short-side spread.
   * Neither is measured anywhere in this repository, so producing one by
   * defaulting would publish a net figure missing its largest cost term —
   * the same shape as pricing an option's entry and omitting its decay.
   */
  it("refuses a long-short leg rather than pricing a short book it cannot cost", () => {
    expect(() =>
      momentumSessions([period({ entryTime: t(0), exitTime: t(21) })], "long-short")
    ).toThrow(/borrow cost/);
    expect(() =>
      momentumSessions([period({ entryTime: t(0), exitTime: t(21) })], undefined)
    ).toThrow();
  });

  it("is empty rather than throwing on no periods", () => {
    expect(momentumSessions([], "long-vs-panel")).toEqual([]);
  });
});

describe("momentumDeclaration", () => {
  /*
   * THE OVERSTATEMENT THIS LINE INVITES. A rising relative-return line beside
   * a dollar figure reads as profit. It is not: the decile can beat the panel
   * by 200bp while both fall. The declaration has to say so, because the
   * declaration is what a reader checks the number against.
   */
  it("says in the statement that the return is relative", () => {
    const d = momentumDeclaration(H, DECLARED);
    expect(d.statement).toMatch(/relative/i);
    expect(d.statement).toMatch(/falling market/i);
  });

  it("carries the hold through to the engine's holding period", () => {
    expect(momentumDeclaration(H, DECLARED).holdSessions).toBe(21);
    expect(momentumDeclaration({ ...H, hold: 5 }, DECLARED).holdSessions).toBe(5);
  });

  it("names what replaced costPp, so the change is not silent", () => {
    expect(momentumDeclaration(H, DECLARED).costNote).toMatch(/costPp/);
    expect(momentumDeclaration(H, DECLARED).costNote).toMatch(/turnover/);
  });

  it("inherits the hypothesis's own kill criteria rather than inventing one", () => {
    expect(momentumDeclaration(H, DECLARED).killCriteria).toBe(H.killCriteria);
  });

  it("changes fingerprint when the hypothesis it wraps changes", () => {
    expect(fingerprintDeclaration(momentumDeclaration(H, DECLARED))).not.toBe(
      fingerprintDeclaration(momentumDeclaration({ ...H, hold: 5 }, DECLARED))
    );
  });

  /*
   * THE DATE IS THE WHOLE DIFFERENCE FOR THIS LEG. The overnight legs backfill
   * a few hundred sessions; this one backfills years of periods the panel, the
   * warmup and the regime gate were all chosen against. Taken as given rather
   * than read off the hypothesis, so a hypothesis declared later cannot
   * inherit this date by sitting in the same array.
   */
  it("carries the declaration date it was given, not one it invented", () => {
    expect(momentumDeclaration(H, DECLARED).declaredOn).toBe(DECLARED);
    expect(momentumDeclaration(H, "2027-01-01").declaredOn).toBe("2027-01-01");
    expect(fingerprintDeclaration(momentumDeclaration(H, DECLARED))).not.toBe(
      fingerprintDeclaration(momentumDeclaration(H, "2027-01-01"))
    );
  });
});

describe("feeding the engine", () => {
  /*
   * The point of sharing the engine: a 21-session strategy and a nightly one
   * become comparable, because breakeven divides out the turnover. A period
   * earning 100bp gross while replacing a quarter of its book survives a
   * round trip four times more expensive than a nightly leg earning the same.
   */
  it("quotes breakeven per round trip, so the two strategies are comparable", () => {
    const periods = [0, 1, 2, 3, 4].map((i) =>
      period({
        entryTime: t(i * 21),
        exitTime: t((i + 1) * 21),
        top: 0.02,
        universe: 0.01,
        // Three of four names kept each rebalance -> 25% turnover after the first.
        topSymbols: ["A", "B", "C", `Z${i}`],
      })
    );
    const r = buildPaperRecord(
      momentumDeclaration(H, DECLARED),
      momentumSessions(periods, "long-vs-panel")
    );
    expect(r.n).toBe(5);
    expect(r.gross!.meanBp).toBeCloseTo(100, 6);
    // (1 + 0.25*4) / 5 = 0.4 mean turnover.
    expect(r.meanTurnover).toBeCloseTo(0.4, 9);
    expect(r.breakevenCostBp!).toBeCloseTo(100 / 0.4, 6);
  });

  /*
   * The fixture's periods run through 2026-01; the register was declared
   * 2026-08-15. Every one of them is in-sample, and the paper record for this
   * strategy is therefore empty until periods accrue past the declaration.
   * That is the correct and uncomfortable answer: the momentum line is a
   * backtest with a paper record not yet started.
   */
  it("puts the backfilled periods in-sample, leaving the paper record empty", () => {
    const periods = [0, 1, 2].map((i) =>
      period({ entryTime: t(i * 21), exitTime: t((i + 1) * 21), topSymbols: ["A"] })
    );
    const line = buildPaperLine(
      momentumDeclaration(H, DECLARED),
      momentumSessions(periods, "long-vs-panel")
    );
    expect(line.full.n).toBe(3);
    expect(line.inSampleSessions).toBe(3);
    expect(line.sinceDeclared.n).toBe(0);
  });
});
