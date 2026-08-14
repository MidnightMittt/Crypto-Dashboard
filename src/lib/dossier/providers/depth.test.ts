import { describe, expect, it } from "vitest";
import { buildFundamentals, CompanyFacts, fillFiscalGaps, frameOfPeriodEnd, quarterlySeries } from "./secFundamentals";
import { buildConsensus, buildSurpriseHistory, composeStreetLines, parseDisplayNumber, parseEarningsAnnouncement } from "./nasdaqStreet";
import { composeBackdrop } from "./macroBackdrop";

/** Synthetic company facts: 8 quarters of revenue/income, 5 share instants. */
function facts(o: {
  revenue: Array<[string, number]>;
  income?: Array<[string, number]>;
  shares?: Array<[string, number]>;
}): CompanyFacts {
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: o.revenue.map(([frame, val]) => ({ frame, val })) } },
        NetIncomeLoss: { units: { USD: (o.income ?? []).map(([frame, val]) => ({ frame, val })) } },
      },
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: { shares: (o.shares ?? []).map(([frame, val]) => ({ frame, val })) },
        },
      },
    },
  };
}

const q8 = (vals: number[]): Array<[string, number]> =>
  vals.map((v, i) => [`CY${2024 + Math.floor(i / 4)}Q${(i % 4) + 1}`, v]);

describe("buildFundamentals", () => {
  it("hand-verifies TTM growth: 100×4 then 110×4 quarters reads +10%", () => {
    const s = buildFundamentals(facts({ revenue: q8([100, 100, 100, 100, 110, 110, 110, 110]) }))!;
    expect(s.ttmRevenueUsd).toBe(440);
    expect(s.revenueGrowthPct).toBeCloseTo(10, 6);
    expect(s.latestQuarterYoYPct).toBeCloseTo(10, 6);
    expect(s.lines[0]).toContain("up 10%");
  });

  it("computes margin and states unprofitability as a warning, not a style choice", () => {
    const p = buildFundamentals(
      facts({ revenue: q8([100, 100, 100, 100, 100, 100, 100, 100]), income: q8([20, 20, 20, 20, 20, 20, 20, 20]) })
    )!;
    expect(p.netMarginPct).toBeCloseTo(20, 6);
    expect(p.lines.some((l) => l.includes("about 20 cents reach the bottom line"))).toBe(true);

    const u = buildFundamentals(
      facts({ revenue: q8([100, 100, 100, 100, 100, 100, 100, 100]), income: q8([-5, -5, -5, -5, -5, -5, -5, -5]) })
    )!;
    expect(u.profitable).toBe(false);
    expect(u.lines.some((l) => l.includes("NOT currently profitable"))).toBe(true);
  });

  it("reads buybacks and dilution from the share-count instants", () => {
    const shares5 = (vals: number[]): Array<[string, number]> =>
      vals.map((v, i) => [`CY${2024 + Math.floor(i / 4)}Q${(i % 4) + 1}I`, v]);

    const buyback = buildFundamentals(
      facts({ revenue: q8([1, 1, 1, 1, 1, 1, 1, 1]), shares: shares5([1000, 995, 990, 985, 980]) })
    )!;
    expect(buyback.shareCountChangePct).toBeCloseTo(-2, 6);
    expect(buyback.lines.some((l) => l.includes("buying back its own stock"))).toBe(true);

    const dilution = buildFundamentals(
      facts({ revenue: q8([1, 1, 1, 1, 1, 1, 1, 1]), shares: shares5([1000, 1030, 1060, 1090, 1120]) })
    )!;
    expect(dilution.shareCountChangePct).toBeCloseTo(12, 6);
    expect(dilution.lines.some((l) => l.includes("being diluted"))).toBe(true);
  });

  it("only trusts canonical CY-quarter frames — duplicates without frames are ignored", () => {
    const f = facts({ revenue: q8([1, 1, 1, 1, 1, 1, 1, 1]) });
    // Inject a frameless duplicate (a comparative restated in a later filing).
    f.facts!["us-gaap"]!.Revenues!.units!.USD!.push({ val: 999 });
    expect(quarterlySeries(f, "Revenues")).toHaveLength(8);
  });

  it("refuses with fewer than four quarters rather than annualising a stub", () => {
    expect(buildFundamentals(facts({ revenue: q8([1, 1, 1, 1]).slice(0, 3) }))).toBeNull();
  });

  /*
   * The three bugs the NVDA/AAPL live check exposed, pinned so they cannot
   * return: a stale tag chosen by list order, a TTM summed across the fiscal-
   * Q4 hole, and an annual report mapped to the wrong quarters when the
   * fiscal year straddles the frame label.
   */

  it("picks the tag the filer currently reports under, not the first tag with old data", () => {
    // NVDA in miniature: the first-listed tag ends in 2019; Revenues is current.
    const f = facts({ revenue: q8([100, 100, 100, 100, 110, 110, 110, 110]) });
    f.facts!["us-gaap"]!.RevenueFromContractWithCustomerExcludingAssessedTax = {
      units: { USD: [["CY2018Q1", 3], ["CY2018Q2", 3], ["CY2018Q3", 3], ["CY2018Q4", 2]].map(([frame, val]) => ({ frame: frame as string, val: val as number })) },
    };
    const s = buildFundamentals(f)!;
    expect(s.latestFrame).toBe("CY2025Q4");
    expect(s.ttmRevenueUsd).toBe(440);
  });

  it("locates an annual report's quarters from its end date, across a straddling fiscal year", () => {
    // A January fiscal year-end sits in calendar Q1 but its quarter is CY-prior-Q4.
    expect(frameOfPeriodEnd("2026-01-25")).toBe("CY2025Q4");
    // A September year-end (AAPL): terminal quarter is Q3 of the SAME year.
    expect(frameOfPeriodEnd("2025-09-27")).toBe("CY2025Q3");
    // A calendar filer: December year-end is Q4 of its own year.
    expect(frameOfPeriodEnd("2025-12-31")).toBe("CY2025Q4");
  });

  it("reconstructs the missing fiscal Q4 as the 10-K total minus its three 10-Qs", () => {
    const quarterly = [
      { frame: "CY2025Q1", val: 44 },
      { frame: "CY2025Q2", val: 47 },
      { frame: "CY2025Q3", val: 57 },
      // CY2025Q4 (fiscal year-end quarter) is never filed as a 10-Q.
      { frame: "CY2026Q1", val: 82 },
    ];
    const filled = fillFiscalGaps(quarterly, [{ val: 216, end: "2026-01-25" }]);
    expect(filled.map((q) => q.frame)).toEqual(["CY2025Q1", "CY2025Q2", "CY2025Q3", "CY2025Q4", "CY2026Q1"]);
    expect(filled.find((q) => q.frame === "CY2025Q4")!.val).toBe(216 - 44 - 47 - 57);
  });

  it("leaves a hole alone when more than one quarter is missing — no guessing", () => {
    const quarterly = [
      { frame: "CY2025Q1", val: 44 },
      { frame: "CY2025Q2", val: 47 },
    ];
    const filled = fillFiscalGaps(quarterly, [{ val: 216, end: "2026-01-25" }]);
    expect(filled).toHaveLength(2);
  });

  it("refuses a TTM whose window silently spans a quarter gap", () => {
    // Eight quarters but CY2025Q2 missing: the last four frames span five quarters.
    const rev: Array<[string, number]> = [
      ["CY2024Q1", 100], ["CY2024Q2", 100], ["CY2024Q3", 100], ["CY2024Q4", 100],
      ["CY2025Q1", 100], ["CY2025Q3", 100], ["CY2025Q4", 100], ["CY2026Q1", 100],
    ];
    const s = buildFundamentals(facts({ revenue: rev }))!;
    expect(s.ttmRevenueUsd).toBeNull();
    expect(s.revenueGrowthPct).toBeNull();
  });
});

describe("nasdaqStreet pure pieces", () => {
  it("computes implied move to the consensus target from the live price", () => {
    const c = buildConsensus(
      { meanRatingType: "Hold", ratingsSummary: "Based on 29 analysts offering recommendations." },
      { consensusOverview: { priceTarget: 330, lowPriceTarget: 245, highPriceTarget: 400, buy: 16, hold: 9, sell: 4 } },
      300
    )!;
    expect(c.analysts).toBe(29);
    expect(c.impliedMovePct).toBeCloseTo(10, 6);
    const lines = composeStreetLines({
      consensus: c, surprises: null, marketCapUsd: null, averageVolume: null,
      fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, rangePositionPct: null,
      sector: null, nextEarningsDate: null, herdingCaveat: "",
    });
    expect(lines[0]).toContain("10% above the current price");
  });

  it("says BELOW loudly when the street's own target is under the price", () => {
    const c = buildConsensus(null, { consensusOverview: { priceTarget: 90, buy: 1, hold: 1, sell: 1 } }, 100)!;
    const lines = composeStreetLines({
      consensus: c, surprises: null, marketCapUsd: null, averageVolume: null,
      fiftyTwoWeekHigh: null, fiftyTwoWeekLow: null, rangePositionPct: null,
      sector: null, nextEarningsDate: null, herdingCaveat: "",
    });
    expect(lines[0]).toContain("10% BELOW");
  });

  it("counts beats only among quarters that actually reported", () => {
    const s = buildSurpriseHistory([
      { period: "Q1", consensus: 1.0, earnings: 1.1 },
      { period: "Q2", consensus: 1.0, earnings: 0.9 },
      { period: "Q3", consensus: 1.2, earnings: 1.3 },
      { period: "next", consensus: 1.4, earnings: null }, // forecast row — excluded
    ])!;
    expect(s.quarters).toBe(3);
    expect(s.beats).toBe(2);
  });

  it("parses the earnings announcement date and Nasdaq's display numbers", () => {
    expect(parseEarningsAnnouncement("Earnings announcement* for AAPL: Oct 30, 2026")).toBe("2026-10-30");
    expect(parseEarningsAnnouncement("no date provided")).toBeNull();
    expect(parseDisplayNumber("788,501,770,036")).toBe(788_501_770_036);
    expect(parseDisplayNumber("$584.73")).toBeCloseTo(584.73, 6);
    expect(parseDisplayNumber(undefined)).toBeNull();
  });
});

describe("composeBackdrop", () => {
  /** 22 flat sessions then a final value — a clean one-month change. */
  const series = (from: number, to: number) => [...Array(21).fill(from), from, to];

  it("states level, direction and mechanism for a rising-yield month", () => {
    const b = composeBackdrop({
      vix: series(14, 14.5),
      tnx: series(4.3, 4.64), // +34bps
      dxy: null, hyg: null, tlt: null,
    })!;
    expect(b.lines.some((l) => l.includes("up 34 basis points") && l.includes("pressure growth stocks"))).toBe(true);
    expect(b.lines.some((l) => l.includes("calm tape"))).toBe(true);
  });

  it("reads deteriorating credit as the warning it historically is", () => {
    const b = composeBackdrop({
      vix: null, tnx: null, dxy: null,
      hyg: series(80, 78), // junk down...
      tlt: series(100, 101), // ...Treasuries up -> ratio deteriorating
    })!;
    expect(b.lines[0]).toContain("deteriorating");
    expect(b.lines[0]).toContain("smells trouble");
  });

  it("omits any leg whose series is missing, and returns null when all are", () => {
    const partial = composeBackdrop({ vix: series(20, 20), tnx: null, dxy: null, hyg: null, tlt: null })!;
    expect(partial.lines).toHaveLength(1);
    expect(composeBackdrop({ vix: null, tnx: null, dxy: null, hyg: null, tlt: null })).toBeNull();
  });
});
