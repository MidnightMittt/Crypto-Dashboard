import { describe, expect, it } from "vitest";
import artifactJson from "@/data/paperLines.json";
import type { LegStats } from "@/lib/research/overnightDecomposition";
import type { PaperDeclaration, PaperRecord } from "@/lib/research/paperEngine";
import {
  PaperLinesArtifact,
  buildPaperBook,
  headlineFor,
} from "./paperBook";

const DECLARED_ON = "2026-08-17";

function declaration(over: Partial<PaperDeclaration> = {}): PaperDeclaration {
  return {
    id: "test-line",
    statement: "A thing returns more than zero.",
    entry: "close of session D",
    exit: "open of session D+1",
    holdSessions: 1,
    declaredOn: DECLARED_ON,
    costBasis: "modelled",
    costNote: "One tick.",
    independenceBasis: "Consecutive overnights share no bar.",
    killCriteria: "A net mean at or below zero once the record clears its own floor.",
    ...over,
  };
}

function stats(meanBp: number, tStat: number, n: number): LegStats {
  return {
    meanBp,
    sdBp: n > 0 && tStat !== 0 ? (meanBp * Math.sqrt(n)) / tStat : 100,
    tStat,
    pValue: 0.5,
    sharpe: 0.1,
    sharpeAnnualised: 1.6,
    n,
  };
}

function record(over: Partial<PaperRecord> & { n: number }): PaperRecord {
  const { n } = over;
  return {
    declaration: declaration(),
    engineVersion: 1,
    definitionFingerprint: "deadbeef",
    firstDate: n ? "2025-07-03" : null,
    lastDate: n ? "2026-09-10" : null,
    net: n ? stats(30, 2, n) : null,
    gross: n ? stats(35, 2.3, n) : null,
    cumulativeNetPct: n ? 121.9 : null,
    cumulativeGrossPct: n ? 160.2 : null,
    maxDrawdownPct: n ? 21.5 : null,
    worstSessionBp: n ? -564 : null,
    p05SessionBp: n ? -403 : null,
    breakevenCostBp: n ? 35 : null,
    meanTurnover: n ? 1 : null,
    meanCostBp: n ? 5.3 : null,
    detectableAtT3Bp: n ? 45 : null,
    sessionsToT3: n ? 672 : null,
    meanNamesPerSession: n ? 12 : null,
    sessions: [],
    ...over,
  };
}

function artifact(
  entries: Array<{
    id?: string;
    full: PaperRecord;
    sinceDeclared: PaperRecord;
    inSampleSessions: number;
  }>,
  markDrag: PaperLinesArtifact["markDrag"] = null
): PaperLinesArtifact {
  return {
    version: 1,
    generatedAt: 1789247492841,
    engineVersion: 1,
    lines: entries.map((e, i) => ({
      id: e.id ?? `line-${i}`,
      source: "close-to-open",
      line: { full: e.full, sinceDeclared: e.sinceDeclared, inSampleSessions: e.inSampleSessions },
      caveatFull: "the cost charged is a model.",
      caveatSinceDeclared: null,
    })),
    markDrag,
    refusals: [],
  };
}

describe("buildPaperBook — the declaration split", () => {
  it("labels the full half with its in-sample count rather than as a clean sample", () => {
    const book = buildPaperBook(
      artifact([
        { full: record({ n: 299 }), sinceDeclared: record({ n: 18 }), inSampleSessions: 281 },
      ])
    );
    expect(book.lines[0].full.label).toContain("281 precede the declaration");
    expect(book.lines[0].full.reading).toContain("SELECTED the strategy");
  });

  it("names the sign flip as a field, not just in prose", () => {
    /*
     * The failure this whole surface is built around: +30bp in-sample and
     * -37bp since declaration are both true, and a reader comparing two
     * columns will keep the larger, flattering one.
     */
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299, net: stats(30, 2, 299) }),
          sinceDeclared: record({ n: 18, net: stats(-37.3, -0.78, 18) }),
          inSampleSessions: 281,
        },
      ])
    );
    expect(book.lines[0].signFlip).toBe(true);
    expect(book.lines[0].badges.map((b) => b.label)).toContain("sign flips");
  });

  it("does not cry flip when both halves agree in sign", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299, net: stats(30, 2, 299) }),
          sinceDeclared: record({ n: 18, net: stats(12, 0.4, 18) }),
          inSampleSessions: 281,
        },
      ])
    );
    expect(book.lines[0].signFlip).toBe(false);
    expect(book.lines[0].badges.map((b) => b.label)).not.toContain("sign flips");
  });

  it("says the paper record has not started rather than printing a zero", () => {
    const book = buildPaperBook(
      artifact([
        { full: record({ n: 406 }), sinceDeclared: record({ n: 0 }), inSampleSessions: 406 },
      ])
    );
    const paper = book.lines[0].paper;
    expect(paper.power).toBe("empty");
    expect(paper.reading).toContain("has not started");
    expect(book.lines[0].badges.map((b) => b.label)).toContain("no paper record");
  });
});

describe("buildPaperBook — power, never verdict", () => {
  it("calls an unresolved mean silence rather than a negative result", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299 }),
          sinceDeclared: record({ n: 18, net: stats(-37.3, -0.78, 18), detectableAtT3Bp: 143.5 }),
          inSampleSessions: 281,
        },
      ])
    );
    const paper = book.lines[0].paper;
    expect(paper.power).toBe("underpowered");
    expect(paper.reading).toContain("silence, not a negative result");
    expect(paper.reading).toContain("143.5bp");
    expect(book.lines[0].badges.map((b) => b.label)).toContain("underpowered");
  });

  it("refuses to call a cleared t an edge", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299 }),
          sinceDeclared: record({ n: 200, net: stats(60, 4.1, 200) }),
          inSampleSessions: 99,
        },
      ])
    );
    const paper = book.lines[0].paper;
    expect(paper.power).toBe("clears");
    expect(paper.reading).toContain("not the same as tradeable");
  });

  it("reports no dispersion rather than a statistic at n=1", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 1 }),
          sinceDeclared: record({ n: 1, net: null, gross: null }),
          inSampleSessions: 0,
        },
      ])
    );
    expect(book.lines[0].paper.power).toBe("no-dispersion");
    expect(book.lines[0].paper.reading).toContain("too few to estimate dispersion");
  });
});

describe("buildPaperBook — n travels with every number", () => {
  it("stamps the segment's n onto each basis-point figure", () => {
    const book = buildPaperBook(
      artifact([
        { full: record({ n: 299 }), sinceDeclared: record({ n: 18 }), inSampleSessions: 281 },
      ])
    );
    for (const seg of [book.lines[0].full, book.lines[0].paper]) {
      for (const m of [seg.net, seg.gross, seg.detectable, seg.breakeven, seg.meanCost]) {
        expect(m).not.toBeNull();
        expect(m!.n).toBe(seg.n);
      }
    }
  });

  it("nulls a figure rather than pairing it with a sample that does not exist", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299 }),
          sinceDeclared: record({ n: 0, breakevenCostBp: null, detectableAtT3Bp: null }),
          inSampleSessions: 299,
        },
      ])
    );
    const paper = book.lines[0].paper;
    expect(paper.net).toBeNull();
    expect(paper.breakeven).toBeNull();
    expect(paper.detectable).toBeNull();
  });
});

describe("buildPaperBook — badges carry the registration, not the result", () => {
  it("prints the declaration date, the fingerprint and the engine version", () => {
    const book = buildPaperBook(
      artifact([
        { full: record({ n: 299 }), sinceDeclared: record({ n: 18 }), inSampleSessions: 281 },
      ])
    );
    const labels = book.lines[0].badges.map((b) => b.label);
    expect(labels[0]).toBe(`registered ${DECLARED_ON}`);
    expect(labels[1]).toBe("fp deadbeef · engine v1");
  });

  it("distinguishes a measured book from a modelled tick", () => {
    const measured = declaration({ costBasis: "measured", costNote: "The half-spread at 15:50." });
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 12, declaration: measured }),
          sinceDeclared: record({ n: 4, declaration: measured }),
          inSampleSessions: 8,
        },
      ])
    );
    const badge = book.lines[0].badges.find((b) => b.label.startsWith("cost"))!;
    expect(badge.label).toBe("cost measured");
    expect(badge.tone).toBe("success");
    expect(badge.title).toContain("The half-spread at 15:50.");
  });

  it("gives every badge a reason, because a decorative badge is noise", () => {
    const book = buildPaperBook(
      artifact([
        {
          full: record({ n: 299, net: stats(30, 2, 299) }),
          sinceDeclared: record({ n: 18, net: stats(-37, -0.8, 18) }),
          inSampleSessions: 281,
        },
      ])
    );
    for (const b of book.lines[0].badges) expect(b.title.length).toBeGreaterThan(40);
  });
});

describe("buildPaperBook — ordering and totals", () => {
  it("orders by whether a paper record exists, never by how well a line did", () => {
    const book = buildPaperBook(
      artifact([
        {
          id: "big-backtest-no-record",
          full: record({ n: 406, net: stats(105, 3.4, 406) }),
          sinceDeclared: record({ n: 0 }),
          inSampleSessions: 406,
        },
        {
          id: "small-record",
          full: record({ n: 299, net: stats(30, 2, 299) }),
          sinceDeclared: record({ n: 18, net: stats(-37, -0.8, 18) }),
          inSampleSessions: 281,
        },
      ])
    );
    expect(book.lines.map((l) => l.id)).toEqual(["small-record", "big-backtest-no-record"]);
  });

  it("counts a line as clearing only on its paper half", () => {
    const book = buildPaperBook(
      artifact([
        {
          // A backtest well past t=3 with nothing out of sample.
          full: record({ n: 406, net: stats(105, 3.4, 406) }),
          sinceDeclared: record({ n: 0 }),
          inSampleSessions: 406,
        },
      ])
    );
    expect(book.totals).toEqual({ registered: 1, withPaperRecord: 0, clearing: 0 });
  });
});

describe("headlineFor", () => {
  it("leads with the absence when nothing is out of sample", () => {
    expect(headlineFor(6, 0, 0)).toContain("None of 6");
    expect(headlineFor(6, 0, 0)).toContain("precedes its own declaration");
  });

  it("reports the clearing count against the registered count, not the recorded one", () => {
    const h = headlineFor(6, 4, 0);
    expect(h).toContain("0 of 6 registered strategies clear t=3");
    expect(h).toContain("4 have a paper record");
  });

  it("says so when there is no register at all", () => {
    expect(headlineFor(0, 0, 0)).toContain("no paper book");
  });
});

describe("markDrag", () => {
  const drag = (meanBp: number, tStat: number, n: number) => ({
    n,
    firstDate: "2026-08-19",
    lastDate: "2026-09-10",
    net: stats(meanBp, tStat, n),
    gross: stats(meanBp - 1, tStat, n),
    detectableAtT3Bp: 40.4,
  });

  it("names the direction and then refuses to call it measured", () => {
    const book = buildPaperBook(artifact([], drag(22.5, 1.67, 12)));
    const d = book.markDrag!;
    expect(d.power).toBe("underpowered");
    expect(d.reading).toContain("entered BETTER than the close");
    expect(d.reading).toContain("40.4bp");
    expect(d.reading).toContain("placeholder");
  });

  it("flips the direction sentence with the sign", () => {
    const book = buildPaperBook(artifact([], drag(-22.5, -1.67, 12)));
    expect(book.markDrag!.reading).toContain("entered WORSE than the close");
  });

  it("pairs the drag's own n onto its figures", () => {
    const book = buildPaperBook(artifact([], drag(22.5, 1.67, 12)));
    expect(book.markDrag!.net).toEqual({ bp: 22.5, n: 12 });
    expect(book.markDrag!.detectable).toEqual({ bp: 40.4, n: 12 });
  });
});

/**
 * AGAINST THE COMMITTED ARTEFACT.
 *
 * The fixtures above prove the reshaping is internally consistent. These prove
 * it holds on the file the page actually renders, which is the only version
 * that can go wrong in production — a field renamed by the engine would pass
 * every test above and render blanks.
 */
describe("the committed paperLines.json", () => {
  const book = buildPaperBook(artifactJson as unknown as PaperLinesArtifact);

  it("reshapes without losing a line", () => {
    expect(book.lines.length).toBe((artifactJson as unknown as PaperLinesArtifact).lines.length);
    expect(book.lines.length).toBeGreaterThan(0);
  });

  it("reconciles the split: full = in-sample + since-declared, on every line", () => {
    for (const l of book.lines) {
      expect(l.full.n, l.id).toBe(l.inSampleSessions + l.paper.n);
    }
  });

  it("never renders a statistic whose n disagrees with its segment", () => {
    for (const l of book.lines) {
      for (const seg of [l.full, l.paper]) {
        for (const m of [seg.net, seg.gross, seg.detectable, seg.breakeven, seg.meanCost]) {
          if (m) expect(m.n, `${l.id}/${seg.key}`).toBe(seg.n);
        }
      }
    }
  });

  it("carries a declaration date and a fingerprint for every registered line", () => {
    for (const l of book.lines) {
      expect(l.declaration.declaredOn, l.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l.badges.some((b) => b.label.startsWith("fp ")), l.id).toBe(true);
    }
  });

  it("does not claim an out-of-sample result nobody has", () => {
    /*
     * A guard on the headline rather than an assertion about the market. If
     * this ever fails it means a line reached t=3 since its declaration, which
     * is the first genuinely good news this surface could carry — and it
     * should be looked at by a human rather than published automatically.
     */
    expect(book.totals.clearing).toBe(0);
    expect(book.headline).toContain(`0 of ${book.totals.registered}`);
  });
});
