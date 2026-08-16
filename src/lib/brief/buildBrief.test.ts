import { describe, expect, it } from "vitest";
import { BriefInputs, buildBrief } from "./buildBrief";

const NOW = Date.parse("2026-08-15T12:00:00Z");
const DAY = 86_400_000;

/**
 * The default fixture is a QUALIFYING day: fresh panel, healthy breadth, a
 * record that earns Edge. Every test below turns exactly one thing off, so a
 * failure names its own cause.
 */
function inputs(over: Partial<BriefInputs> = {}): BriefInputs {
  return {
    regime: { regime: "risk-on", headline: "Risk-ON, on 3 of 3 independent pairs." },
    diff: null,
    ledgerEntries: 2,
    crossSection: {
      asOf: NOW - 1 * DAY,
      breadthPct: 0.73,
      decileSize: 3,
      members: [
        { symbol: "MU", mom: 5.87 },
        { symbol: "INTC", mom: 2.1 },
        { symbol: "HUT", mom: 1.9 },
        { symbol: "AAPL", mom: 0.4 },
      ],
    },
    momentumRecord: {
      winRate: 0.602,
      lowerBound: 0.554,
      n: 412,
      meanSpread: 0.0131,
      worstSpread: -0.172,
      holdSessions: 21,
      earnsEdge: true,
    },
    earnings: [],
    now: NOW,
    ...over,
  };
}

describe("buildBrief — the actionable item", () => {
  it("offers the decile as ONE decision carrying its names", () => {
    const b = buildBrief(inputs());
    expect(b.items).toHaveLength(1);
    expect(b.items[0].symbols).toEqual(["MU", "INTC", "HUT"]);
    expect(b.noItemsReason).toBeNull();
  });

  /*
   * The record belongs to holding the whole basket. A brief that let a reader
   * think it applied to one name would be quoting a portfolio statistic at a
   * single position — the same error the momentum module exists to prevent.
   */
  it("says the record is the basket's, not any single name's", () => {
    const b = buildBrief(inputs());
    expect(b.items[0].detail).toMatch(/WHOLE decile/);
    expect(b.items[0].detail).toMatch(/not a claim about any single name/);
  });

  it("quotes the measured record rather than asserting an edge", () => {
    const b = buildBrief(inputs());
    expect(b.items[0].record).toMatch(/60\.2% of 412/);
    expect(b.items[0].record).toMatch(/lower bound 55\.4%/);
    expect(b.items[0].record).toMatch(/2pp of costs/);
  });

  it("caps decisions at three", () => {
    expect(buildBrief(inputs()).items.length).toBeLessThanOrEqual(3);
  });
});

describe("buildBrief — why nothing qualifies", () => {
  /*
   * THE POINT OF THE WHOLE SECTION. Each refusal is a different claim, and a
   * shared empty state would destroy the distinction between "the market is
   * not offering this" and "we cannot currently tell you".
   */
  it("stands aside in broad weakness, and says the signal INVERTS there", () => {
    const b = buildBrief(inputs({ crossSection: { ...inputs().crossSection!, breadthPct: 0.41 } }));
    expect(b.items).toHaveLength(0);
    expect(b.noItemsReason).toMatch(/41%/);
    expect(b.noItemsReason).toMatch(/INVERTS/);
    // The distinction that matters: the signal worked, it did not go missing.
    expect(b.noItemsReason).toMatch(/signal working, not the signal missing/);
  });

  it("withholds on a stale panel and names the age", () => {
    const b = buildBrief(inputs({ crossSection: { ...inputs().crossSection!, asOf: NOW - 30 * DAY } }));
    expect(b.items).toHaveLength(0);
    expect(b.noItemsReason).toMatch(/30 days ago/);
  });

  it("withholds when breadth is unmeasurable, distinctly from weak breadth", () => {
    const weak = buildBrief(inputs({ crossSection: { ...inputs().crossSection!, breadthPct: 0.41 } }));
    const unknown = buildBrief(inputs({ crossSection: { ...inputs().crossSection!, breadthPct: null } }));
    expect(unknown.items).toHaveLength(0);
    expect(unknown.noItemsReason).toMatch(/regime is unknown/);
    expect(unknown.noItemsReason).not.toEqual(weak.noItemsReason);
  });

  it("offers nothing when no signal clears its own gate", () => {
    const b = buildBrief(inputs({ momentumRecord: { ...inputs().momentumRecord!, earnsEdge: false } }));
    expect(b.items).toHaveLength(0);
    expect(b.noItemsReason).toMatch(/clears its own gate/);
  });

  /*
   * A pipeline gap must not read as a market condition. "We failed to build
   * the panel" and "the market is not offering this" are opposite claims and
   * the brief has to own the first one.
   */
  it("blames itself, not the market, when the panel is missing", () => {
    const b = buildBrief(inputs({ crossSection: null }));
    expect(b.noItemsReason).toMatch(/gap in our pipeline, not a statement about the market/);
  });

  it("always gives a reason when it gives no items", () => {
    for (const broken of [
      inputs({ crossSection: null }),
      inputs({ momentumRecord: null }),
      inputs({ crossSection: { ...inputs().crossSection!, breadthPct: 0.2 } }),
    ]) {
      const b = buildBrief(broken);
      expect(b.items).toHaveLength(0);
      expect(b.noItemsReason).toBeTruthy();
    }
  });
});

describe("buildBrief — risk events", () => {
  const earnings = [
    { symbol: "NVDA", date: "2026-08-18" }, // 3 days out
    { symbol: "AAPL", date: "2026-08-16" }, // 1 day out
    { symbol: "MU", date: "2026-08-12" }, // already happened
    { symbol: "TSM", date: "2026-09-30" }, // far outside the window
  ];

  it("keeps only reports inside the veto window, soonest first", () => {
    const b = buildBrief(inputs({ earnings }));
    expect(b.riskEvents.map((e) => e.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(b.riskEvents[0].daysAway).toBe(1);
    expect(b.riskEvents[1].daysAway).toBe(3);
  });

  /*
   * A report that already happened is not a risk to plan around, and showing
   * "-3 days" makes the reader do arithmetic to discover it is irrelevant.
   */
  it("drops past reports rather than rendering negative distances", () => {
    const b = buildBrief(inputs({ earnings }));
    expect(b.riskEvents.every((e) => e.daysAway >= 0)).toBe(true);
    expect(b.riskEvents.map((e) => e.symbol)).not.toContain("MU");
  });

  it("survives an unparseable date without dropping the rest", () => {
    const b = buildBrief(inputs({ earnings: [...earnings, { symbol: "BAD", date: "not-a-date" }] }));
    expect(b.riskEvents.map((e) => e.symbol)).toEqual(["AAPL", "NVDA"]);
  });
});

describe("buildBrief — state and memory", () => {
  it("carries the regime headline verbatim rather than rewriting it", () => {
    const b = buildBrief(inputs());
    expect(b.stateLine).toBe("Risk-ON, on 3 of 3 independent pairs.");
  });

  it("passes a null regime through instead of inventing a state line", () => {
    expect(buildBrief(inputs({ regime: null })).stateLine).toBeNull();
  });

  it("reports ledger depth so the page can distinguish quiet from blind", () => {
    expect(buildBrief(inputs({ ledgerEntries: 1, diff: null })).ledgerEntries).toBe(1);
  });
});

describe("buildBrief — when the two state reads disagree", () => {
  /*
   * The risk regime is cross-asset appetite; the momentum gate is equity
   * participation. They can point opposite ways, and on 2026-08-15 they did:
   * Risk-OFF at the top of the page, 73% breadth qualifying a long basket at
   * the bottom. Unnamed, that reads as the engine contradicting itself.
   */
  it("names the split rather than leaving a reader to reconcile it", () => {
    const b = buildBrief(inputs({ regime: { regime: "risk-off", headline: "Risk-OFF, on 2 of 3." } }));
    expect(b.items).toHaveLength(1);
    expect(b.items[0].detail).toMatch(/split with the state line/);
    expect(b.items[0].detail).toMatch(/different measurements, not a contradiction/);
  });

  it("says nothing about a split when there is none", () => {
    const b = buildBrief(inputs());
    expect(b.items[0].detail).not.toMatch(/split with the state line/);
  });
});

describe("buildBrief — how the thing is actually held", () => {
  /*
   * A record without execution terms is a fact a reader will act on wrongly.
   * 60.2% belongs to an equal-weighted basket rebalanced at its horizon; a
   * reader who buys the strongest name for a week has not taken this trade,
   * and the number would still be true while no longer being about them.
   */
  it("states weighting, horizon and rebalance, all read off the hypothesis", () => {
    const [item] = buildBrief(inputs()).items;
    expect(item.execution.join(" ")).toMatch(/Equal weight across all 3 names/);
    expect(item.execution.join(" ")).toMatch(/Hold 21 sessions/);
    expect(item.execution.join(" ")).toMatch(/Re-rank when the panel refreshes/);
  });

  /*
   * THE OMISSION THAT IS THE POINT. The study measured periods running to
   * their horizon with no stop. Offering one would describe a strategy nobody
   * has measured while the record beside it stayed unchanged — the most
   * plausible way this page could mislead.
   */
  it("declines to invent a stop, and says why, with the worst period to size on", () => {
    const [item] = buildBrief(inputs()).items;
    const text = item.execution.join(" ");
    expect(text).toMatch(/NO STOP was modelled/);
    expect(text).toMatch(/-17\.2%/);
    expect(text).toMatch(/a strategy nobody has measured/);
  });

  it("names the declared gate as the invalidation, not a discretionary call", () => {
    const [item] = buildBrief(inputs()).items;
    expect(item.invalidation).toMatch(/breadth falls to 50% or below/);
    expect(item.invalidation).toMatch(/not a discretionary call/);
  });
});
