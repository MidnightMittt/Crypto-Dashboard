import { describe, expect, it } from "vitest";
import {
  BUDGET_RUNGS,
  DELTA_BAND,
  MAX_SPREAD_PCT_OF_MID,
  MIN_OPEN_INTEREST,
  buildEntry,
  cheapestInBand,
  coverageCurve,
  excludedAt,
  selectAffordabilityExpiries,
  tradeableAt,
  type AffordabilityEntry,
  type AffordabilityView,
  type CandidateContract,
} from "./affordability";

/**
 * The properties under test are the ones that decide whether the universe is
 * REAL. A cheapest-contract number that quietly includes an untradeable quote,
 * or that only ever sees calls, would report an account as able to express
 * views it cannot express — which is the failure this module exists to end.
 */

function contract(over: Partial<CandidateContract> = {}): CandidateContract {
  return {
    expiry: "2026-10-16",
    kind: "call",
    strike: 20,
    bid: 0.95,
    ask: 1.05,
    delta: 0.4,
    openInterest: 500,
    ...over,
  };
}

describe("cheapestInBand", () => {
  it("takes the cheapest contract inside the delta band, not the cheapest on the chain", () => {
    const chain = [
      // A far out-of-the-money lottery ticket: cheapest on the chain by far,
      // and outside the band precisely because it will expire worthless.
      contract({ strike: 40, delta: 0.05, bid: 0.02, ask: 0.03 }),
      contract({ strike: 22, delta: 0.35, bid: 0.6, ask: 0.7 }),
      contract({ strike: 20, delta: 0.48, bid: 1.4, ask: 1.5 }),
    ];
    const { best, inBand } = cheapestInBand(chain);
    expect(inBand).toBe(2);
    expect(best?.strike).toBe(22);
    expect(best?.costUsd).toBe(65);
  });

  it("compares delta by magnitude, so a put is visible to the band", () => {
    const { best, inBand } = cheapestInBand([
      contract({ kind: "put", strike: 15, delta: -0.42, bid: 0.5, ask: 0.56 }),
    ]);
    expect(inBand).toBe(1);
    expect(best?.kind).toBe("put");
    expect(best?.delta).toBe(-0.42);
  });

  it("counts a band contract that fails a gate as gated rather than silently dropping it", () => {
    const wide = contract({ bid: 0.6, ask: 1.4 }); // 80% of mid
    const thin = contract({ openInterest: MIN_OPEN_INTEREST - 1 });
    const { best, inBand, gated } = cheapestInBand([wide, thin]);
    expect(best).toBeNull();
    expect(inBand).toBe(2);
    expect(gated).toBe(2);
  });

  it("rejects a one-sided or crossed market as unpriceable", () => {
    const { best, gated } = cheapestInBand([
      contract({ bid: null }),
      contract({ ask: 0 }),
      contract({ bid: 2, ask: 1 }),
    ]);
    expect(best).toBeNull();
    expect(gated).toBe(3);
  });

  it("keeps a contract exactly on either band edge", () => {
    const lo = cheapestInBand([contract({ delta: DELTA_BAND[0] })]);
    const hi = cheapestInBand([contract({ delta: DELTA_BAND[1] })]);
    expect(lo.inBand).toBe(1);
    expect(hi.inBand).toBe(1);
  });

  it("admits a spread exactly at the limit and refuses one past it", () => {
    // mid 1.00, spread 0.25 -> exactly MAX_SPREAD_PCT_OF_MID.
    const at = cheapestInBand([contract({ bid: 0.875, ask: 1.125 })]);
    expect(at.best).not.toBeNull();
    expect(at.best?.spreadPctOfMid).toBe(MAX_SPREAD_PCT_OF_MID);
    const past = cheapestInBand([contract({ bid: 0.86, ask: 1.14 })]);
    expect(past.best).toBeNull();
  });
});

describe("buildEntry", () => {
  it("reports the cheapest across expiries, not merely within the nearest", () => {
    const entry = buildEntry("APLD", 14.2, [
      [contract({ expiry: "2026-09-18", bid: 1.1, ask: 1.2 })],
      [contract({ expiry: "2026-10-16", bid: 0.4, ask: 0.44 })],
    ]);
    expect(entry.cheapestByExpiry).toHaveLength(2);
    expect(entry.cheapest?.expiry).toBe("2026-10-16");
    expect(entry.cheapest?.costUsd).toBe(42);
    expect(entry.missReason).toBeNull();
  });

  it("separates a chain that never offers the structure from one whose markets are unusable", () => {
    const noBand = buildEntry("XYZ", 100, [[contract({ delta: 0.05 })]]);
    expect(noBand.missReason).toBe("no_contract_in_delta_band");

    const allGated = buildEntry("XYZ", 100, [[contract({ openInterest: 1 })]]);
    expect(allGated.missReason).toBe("band_contracts_all_gated");
    // The distinction is the point: one will never change with price, the
    // other can become tradeable tomorrow.
    expect(allGated.detail).toContain("Quotable, not tradeable");
  });

  it("calls a missing chain unknown rather than unaffordable", () => {
    const entry = buildEntry("NOOPT", 40, []);
    expect(entry.missReason).toBe("no_chain");
    expect(entry.detail).toContain("unknown rather than false");
  });

  it("names the number in the detail line, per the /api/distance rule", () => {
    const entry = buildEntry("MU", 190, [[contract({ strike: 195, bid: 15.0, ask: 15.4 })]]);
    expect(entry.detail).toContain("$1520");
    expect(entry.detail).toContain("2026-10-16 195 call");
  });
});

describe("gate attribution", () => {
  /*
   * The first full sweep excluded GILD, ISRG, REGN, LMT, UNP and CSX as
   * "quotable, not tradeable" — six of the most liquid option markets in the
   * country. The old reason said "spread OR open-interest", which is
   * compatible with both a thin market and a broken feed. It was the feed:
   * GILD's 2026-09-25 140 put came back bid 0.36 against ask 3.45.
   */
  it("attributes the miss to the gate that actually fired, not to an or", () => {
    const entry = buildEntry("GILD", 142, [
      [
        contract({ strike: 140, kind: "put", delta: -0.315, bid: 0.36, ask: 3.45, openInterest: 38 }),
        contract({ strike: 141, kind: "put", delta: -0.364, bid: 0.72, ask: 3.0, openInterest: 28 }),
      ],
    ]);
    expect(entry.missReason).toBe("band_contracts_all_gated");
    expect(entry.gates).toMatchObject({ inBand: 2, spread: 2, openInterest: 0, both: 0, passed: 0 });
    expect(entry.detail).toContain("2 on the spread gate");
    expect(entry.detail).not.toContain("open interest under");
    // The phrasing this replaced. An `or` let a broken feed read as a thin market.
    expect(entry.detail).not.toContain("spread or open-interest");
  });

  it("flags a market too wide to be the market rather than the feed", () => {
    const entry = buildEntry("GILD", 142, [
      [contract({ delta: 0.35, bid: 0.36, ask: 3.45, openInterest: 38 })],
    ]);
    // 162% of mid, against a 25% limit.
    expect(entry.gates.medianSpreadPctOfMid).toBeGreaterThan(MAX_SPREAD_PCT_OF_MID * 2);
    expect(entry.detail).toContain("stale or one-sided quote feed");
    expect(entry.detail).toContain("unconfirmed until the chain is read from a live venue");
  });

  it("does not cry feed for a merely wide market", () => {
    // 33% of mid — over the limit, but the shape of a thin name, not a stale bid.
    const entry = buildEntry("SMALL", 20, [
      [contract({ delta: 0.35, bid: 0.85, ask: 1.18, openInterest: 40 })],
    ]);
    expect(entry.gates.spread).toBe(1);
    expect(entry.detail).not.toContain("quote feed");
  });

  it("separates a thin market from a wide one, and counts a contract failing both once", () => {
    const entry = buildEntry("THIN", 20, [
      [
        contract({ delta: 0.35, bid: 0.98, ask: 1.02, openInterest: 2 }), // OI only
        contract({ delta: 0.4, bid: 0.6, ask: 1.4, openInterest: 2 }), // both
        contract({ delta: 0.45, bid: 0.6, ask: 1.4, openInterest: 900 }), // spread only
      ],
    ]);
    expect(entry.gates).toMatchObject({ inBand: 3, spread: 1, openInterest: 1, both: 1, passed: 0 });
    expect(entry.gates.spread + entry.gates.openInterest + entry.gates.both).toBe(3);
    /*
     * The counts in the sentence must reconcile to inBand. Stating the overlap
     * as an overlap is what makes that possible: 2 + 1 already covers all 3,
     * and the shared contract is named rather than counted twice.
     */
    expect(entry.detail).toContain("2 on the spread gate");
    expect(entry.detail).toContain("1 of those also under the open-interest floor");
    expect(entry.detail).toContain("1 on open interest under 10 alone");
  });

  it("records the gates on a name that passed, so the page can show near-misses", () => {
    const entry = buildEntry("OK", 20, [
      [
        contract({ delta: 0.35, bid: 0.95, ask: 1.05, openInterest: 500 }),
        contract({ delta: 0.45, bid: 0.6, ask: 1.4, openInterest: 500 }),
      ],
    ]);
    expect(entry.cheapest).not.toBeNull();
    expect(entry.gates).toMatchObject({ inBand: 2, passed: 1, spread: 1 });
  });
});

describe("coverage and budget views", () => {
  const entries: AffordabilityEntry[] = [
    buildEntry("APLD", 14, [[contract({ bid: 0.4, ask: 0.44 })]]), // $42
    buildEntry("MARA", 18, [[contract({ bid: 1.7, ask: 1.8 })]]), // $175
    buildEntry("MU", 190, [[contract({ bid: 15.0, ask: 15.4 })]]), // $1520
    buildEntry("NOOPT", 40, []),
  ];
  const view: AffordabilityView = {
    generatedAt: 1_760_000_000_000,
    session: "2026-09-11",
    panelSession: "2026-09-11",
    deltaBand: DELTA_BAND,
    maxSpreadPctOfMid: MAX_SPREAD_PCT_OF_MID,
    minOpenInterest: MIN_OPEN_INTEREST,
    expiriesExamined: 2,
    entries,
    coverage: coverageCurve(entries),
  };

  it("reports a monotone curve over the declared rungs", () => {
    expect(view.coverage.map((c) => c.budgetUsd)).toEqual([...BUDGET_RUNGS]);
    const counts = view.coverage.map((c) => c.tradeable);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(view.coverage[0]).toMatchObject({ budgetUsd: 100, tradeable: 1, of: 4 });
    expect(view.coverage[1]).toMatchObject({ budgetUsd: 200, tradeable: 2 });
    // $1,520 clears the 2,000 rung and nothing below it — the growth path,
    // as a number rather than a feeling.
    expect(view.coverage.find((c) => c.budgetUsd === 1000)?.tradeable).toBe(2);
    expect(view.coverage.find((c) => c.budgetUsd === 2000)?.tradeable).toBe(3);
  });

  it("never counts a name with no qualifying contract at any budget", () => {
    for (const rung of view.coverage) expect(rung.symbols).not.toContain("NOOPT");
  });

  it("splits the panel into tradeable and excluded with no name lost", () => {
    const budget = 195.51;
    const inSet = tradeableAt(view, budget);
    const out = excludedAt(view, budget);
    expect(inSet.map((r) => r.symbol)).toEqual(["APLD", "MARA"]);
    expect(out.map((r) => r.symbol)).toEqual(["MU", "NOOPT"]);
    expect(inSet.length + out.length).toBe(entries.length);
  });

  it("gives the excluded row the number that excludes it", () => {
    const out = excludedAt(view, 195.51);
    expect(out[0].detail).toBe(
      "MU excluded: cheapest qualifying contract $1520 against budget $196."
    );
  });

  it("orders exclusions by how close they are to reachable, unknowns last", () => {
    const out = excludedAt(view, 195.51);
    expect(out.at(-1)?.symbol).toBe("NOOPT");
    expect(out.at(-1)?.costUsd).toBeNull();
  });
});

describe("selectAffordabilityExpiries", () => {
  const NOW = Date.parse("2026-09-11T14:00:00Z");
  const LISTED = [
    "2026-09-18", // 5 sessions out — a front week
    "2026-09-25", // 10 sessions
    "2026-10-16", // 25 sessions
    "2026-11-20",
  ];

  it("skips an expiry the ranking horizon cannot live through", () => {
    /*
     * The literal ask was "the nearest 2 expiries". Taken literally the front
     * week comes back, a name is recorded as affordable through it, and the
     * screen then rejects that contract for being shorter than the calibrated
     * window — the top row unbuyable again, one layer down.
     */
    expect(selectAffordabilityExpiries(LISTED, NOW)).toEqual(["2026-09-25", "2026-10-16"]);
  });

  it("returns fewer than asked rather than reaching for a short expiry", () => {
    expect(selectAffordabilityExpiries(["2026-09-18", "2026-09-25"], NOW)).toEqual(["2026-09-25"]);
    expect(selectAffordabilityExpiries(["2026-09-18"], NOW)).toEqual([]);
  });

  it("sorts before slicing, so an unordered venue list cannot reorder the sweep", () => {
    const shuffled = ["2026-11-20", "2026-10-16", "2026-09-25", "2026-09-18"];
    expect(selectAffordabilityExpiries(shuffled, NOW)).toEqual(["2026-09-25", "2026-10-16"]);
  });
});
