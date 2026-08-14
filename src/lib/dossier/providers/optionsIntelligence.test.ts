import { describe, expect, it } from "vitest";
import { TradierExpiryChain, TradierOptionRow } from "./tradierOptions";
import {
  atmIv,
  buildOptionsIntelligence,
  liquidityScore,
  maxPain,
  realizedVol,
  skew,
} from "./optionsIntelligence";

const row = (over: Partial<TradierOptionRow> & { strike: number; kind: "call" | "put" }): TradierOptionRow => ({
  expiry: "2026-09-18",
  bid: 1,
  ask: 1.1,
  last: 1.05,
  volume: 100,
  averageVolume: 100,
  openInterest: 1000,
  iv: 0.3,
  gamma: 0.01,
  delta: 0.5,
  ...over,
});

/** A symmetric chain around 100, used where the shape is not the point. */
const plainChain = (): TradierExpiryChain => {
  const rows: TradierOptionRow[] = [];
  for (const strike of [85, 90, 95, 100, 105, 110, 115]) {
    rows.push(row({ strike, kind: "call" }), row({ strike, kind: "put" }));
  }
  return { expiry: "2026-09-18", contracts: [], rows };
};

describe("maxPain", () => {
  /*
   * The common shortcut — "the strike with the most open interest" — is a
   * DIFFERENT quantity that merely correlates. This chain is built so the two
   * answers disagree: the heaviest single strike is the 115 calls, but those
   * are far out of the money and cost nothing to settle, so total payout is
   * minimised at 110, where the big put position expires worthless and the
   * calls are only ten points in.
   */
  it("minimises total payout rather than reporting the heaviest strike", () => {
    const rows = [
      row({ strike: 85, kind: "put", openInterest: 100 }),
      row({ strike: 90, kind: "call", openInterest: 100 }),
      row({ strike: 100, kind: "call", openInterest: 3000 }),
      row({ strike: 110, kind: "put", openInterest: 5000 }),
      row({ strike: 115, kind: "call", openInterest: 20000 }),
    ];
    const heaviest = [...rows].sort((a, b) => b.openInterest - a.openInterest)[0].strike;
    expect(heaviest).toBe(115);
    expect(maxPain(rows)).toBe(110);
  });

  it("returns null rather than a meaningless minimum on a stub chain", () => {
    expect(maxPain([row({ strike: 100, kind: "call" }), row({ strike: 105, kind: "put" })])).toBeNull();
  });
});

describe("skew", () => {
  /*
   * Comparing a 5%-out put against a 15%-out call would measure the
   * DISTANCE, not the skew. Both sides must be picked at comparable
   * moneyness for the difference to mean anything.
   */
  it("compares puts and calls at comparable distance from spot", () => {
    const rows = [
      row({ strike: 93, kind: "put", iv: 0.4 }), // ~7% out — the one to use
      row({ strike: 70, kind: "put", iv: 0.9 }), // far out, must not dominate
      row({ strike: 107, kind: "call", iv: 0.3 }), // ~7% out
      row({ strike: 130, kind: "call", iv: 0.1 }),
    ];
    expect(skew(rows, 100)).toBeCloseTo(10, 5); // 40 - 30, not 90 - 10
  });

  it("normalises decimals and percents to the same unit", () => {
    const decimals = [row({ strike: 93, kind: "put", iv: 0.4 }), row({ strike: 107, kind: "call", iv: 0.3 })];
    const percents = [row({ strike: 93, kind: "put", iv: 40 }), row({ strike: 107, kind: "call", iv: 30 })];
    expect(skew(decimals, 100)).toBeCloseTo(skew(percents, 100)!, 5);
  });

  it("returns null when one side has no implied vol at all", () => {
    expect(skew([row({ strike: 93, kind: "put", iv: 0.4 })], 100)).toBeNull();
  });
});

describe("realizedVol", () => {
  it("returns null rather than a noisy number on too few bars", () => {
    expect(realizedVol([100, 101, 102])).toBeNull();
  });

  it("annualises a known daily deviation", () => {
    // Alternating ±1% daily moves: daily sigma ~1%, annualised ~sqrt(252)%.
    const closes: number[] = [100];
    for (let i = 1; i <= 40; i++) closes.push(closes[i - 1] * (i % 2 === 0 ? 1.01 : 1 / 1.01));
    const rv = realizedVol(closes)!;
    expect(rv.pct).toBeGreaterThan(12);
    expect(rv.pct).toBeLessThan(20);
    expect(rv.jumpDominated).toBe(false);
  });

  /*
   * THE AAPL CASE, in miniature. One 7.4% earnings gap inside the 20-day
   * window took the reading from 19% to 35% and made 22% implied look
   * "cheap" — a conclusion produced entirely by an event that had already
   * happened. The estimator has to expose that, not average it away.
   */
  it("flags a window whose volatility is one earnings gap", () => {
    const closes: number[] = [100];
    for (let i = 1; i <= 40; i++) closes.push(closes[i - 1] * 1.001); // quiet drift
    closes.push(closes[closes.length - 1] * 1.074); // the gap
    for (let i = 0; i < 5; i++) closes.push(closes[closes.length - 1] * 1.001);

    const rv = realizedVol(closes)!;
    expect(rv.jumpDominated).toBe(true);
    expect(rv.largestMovePct).toBeCloseTo(7.4, 1);
    expect(rv.exJumpPct).toBeLessThan(rv.pct / 2);
  });
});

describe("liquidityScore", () => {
  it("scores a tight, deep chain well above a wide, empty one", () => {
    const tight = [85, 95, 100, 105, 115].flatMap((strike) => [
      row({ strike, kind: "call", bid: 5, ask: 5.05, openInterest: 20000, volume: 5000 }),
      row({ strike, kind: "put", bid: 5, ask: 5.05, openInterest: 20000, volume: 5000 }),
    ]);
    const wide = [95, 100, 105].flatMap((strike) => [
      row({ strike, kind: "call", bid: 1, ask: 2.5, openInterest: 3, volume: 0 }),
      row({ strike, kind: "put", bid: 1, ask: 2.5, openInterest: 3, volume: 0 }),
    ]);
    const t = liquidityScore(tight, 100);
    const w = liquidityScore(wide, 100);
    expect(t.score!).toBeGreaterThan(70);
    expect(w.score!).toBeLessThan(45);
    expect(w.label).toContain("thin");
  });

  it("declines to score rather than guess when nothing quotes near the money", () => {
    const far = [row({ strike: 500, kind: "call" }), row({ strike: 10, kind: "put" })];
    expect(liquidityScore(far, 100).score).toBeNull();
  });
});

describe("atmIv", () => {
  it("ignores strikes far from the money", () => {
    const rows = [
      row({ strike: 100, kind: "call", iv: 0.3 }),
      row({ strike: 101, kind: "put", iv: 0.32 }),
      row({ strike: 200, kind: "call", iv: 5 }),
    ];
    expect(atmIv(rows, 100)).toBeCloseTo(31, 5);
  });
});

describe("buildOptionsIntelligence", () => {
  const base = {
    chains: [plainChain()],
    spot: 100,
    closes: Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 2),
    engineVerdict: "bullish" as const,
    firstTargetPct: null,
    now: Date.UTC(2026, 7, 14),
  };

  it("prices the expected move off the ATM straddle, not the whole chain", () => {
    const chain = plainChain();
    const atmCall = chain.rows.find((r) => r.strike === 100 && r.kind === "call")!;
    const atmPut = chain.rows.find((r) => r.strike === 100 && r.kind === "put")!;
    atmCall.bid = 4;
    atmCall.ask = 4.2;
    atmPut.bid = 3.8;
    atmPut.ask = 4;
    const out = buildOptionsIntelligence({ ...base, chains: [chain] })!;
    expect(out.atmStraddlePrice).toBeCloseTo(8.0, 5); // 4.1 + 3.9
    expect(out.expectedMovePct).toBeCloseTo(8.0, 5);
  });

  /*
   * THE SENTENCE THE USER ASKED FOR. A target beyond what the options market
   * prices for the whole period is not merely optimistic — it needs
   * volatility to expand, which is a different bet from being right about
   * direction. The wording has to say so.
   */
  it("warns when the plan's first target exceeds the entire priced move", () => {
    const chain = plainChain();
    for (const r of chain.rows) {
      if (r.strike === 100) {
        r.bid = 2.3;
        r.ask = 2.5;
      }
    }
    const out = buildOptionsIntelligence({ ...base, chains: [chain], firstTargetPct: 11 })!;
    expect(out.expectedMovePct!).toBeLessThan(11);
    const line = out.lines.find((l) => l.includes("first target"))!;
    expect(line).toContain("MORE than the options market expects");
    expect(line).toContain("volatility to expand");
  });

  it("says the target is inside the priced move when it is", () => {
    const chain = plainChain();
    for (const r of chain.rows) {
      if (r.strike === 100) {
        r.bid = 5;
        r.ask = 5.2;
      }
    }
    const out = buildOptionsIntelligence({ ...base, chains: [chain], firstTargetPct: 3 })!;
    expect(out.lines.find((l) => l.includes("first target"))).toContain("does not depend on volatility expanding");
  });

  /*
   * Two readings that must AGREE before a lean is claimed. One lopsided
   * session of call buying is not positioning, and a tiebreak between
   * contradictory evidence would be an invention.
   */
  it("refuses a lean when volume and skew point opposite ways", () => {
    const chain = plainChain();
    for (const r of chain.rows) {
      r.volume = r.kind === "call" ? 5000 : 100; // heavy call buying
      if (r.kind === "put" && r.strike === 93) r.iv = 0.5;
    }
    // ...but puts are bid 20 vol points over calls: fear, not enthusiasm.
    chain.rows.push(row({ strike: 93, kind: "put", iv: 0.5, volume: 100 }));
    chain.rows.push(row({ strike: 107, kind: "call", iv: 0.3, volume: 5000 }));
    const out = buildOptionsIntelligence({ ...base, chains: [chain] })!;
    expect(out.skewPct!).toBeGreaterThan(3);
    expect(out.optionsLean).toBe("neutral");
    expect(out.agreesWithEngine).toBeNull();
  });

  it("flags disagreement with the engine instead of quietly siding with it", () => {
    const chain = plainChain();
    for (const r of chain.rows) r.volume = r.kind === "put" ? 5000 : 100;
    const out = buildOptionsIntelligence({ ...base, chains: [chain], engineVerdict: "bullish" })!;
    expect(out.optionsLean).toBe("bearish");
    expect(out.agreesWithEngine).toBe(false);
    expect(out.lines.some((l) => l.includes("size smaller"))).toBe(true);
  });

  /*
   * IV rank needs a year of this symbol's own implied vol. Approximating it
   * from realised vol would answer a different question in the same words —
   * so the field stays null and states its requirement.
   */
  it("never fabricates IV rank from realised volatility", () => {
    const out = buildOptionsIntelligence(base)!;
    expect(out.ivRankPct).toBeNull();
    expect(out.ivPercentile).toBeNull();
    expect(out.realizedVolPct).not.toBeNull();
    expect(out.ivHistoryRequirement).toMatch(/year/i);
  });

  it("carries the dealer-convention caveat wherever gamma is reported", () => {
    const out = buildOptionsIntelligence(base)!;
    expect(out.netGexUsdPer1Pct).not.toBeNull();
    expect(out.caveats.join(" ")).toMatch(/assumption, not an observation/);
  });

  it("only calls activity unusual when volume exceeds what could be closing", () => {
    const chain = plainChain();
    const hot = chain.rows.find((r) => r.strike === 110 && r.kind === "call")!;
    hot.volume = 9000;
    hot.openInterest = 200;
    const out = buildOptionsIntelligence({ ...base, chains: [chain] })!;
    expect(out.unusual).toHaveLength(1);
    expect(out.unusual[0].strike).toBe(110);
    // Every other strike traded 100 on 1000 open — ordinary, and excluded.
    expect(out.lines.some((l) => l.includes("new positions are being opened"))).toBe(true);
  });

  it("reports lower confidence when the chain supports less of the picture", () => {
    const bare = plainChain();
    for (const r of bare.rows) {
      r.iv = null;
      r.gamma = null;
      r.bid = null;
      r.ask = null;
      r.last = null;
    }
    const rich = buildOptionsIntelligence(base)!;
    const thin = buildOptionsIntelligence({ ...base, chains: [bare] })!;
    expect(thin.confidence).toBeLessThan(rich.confidence);
  });

  it("returns null rather than an empty shell with no chain", () => {
    expect(buildOptionsIntelligence({ ...base, chains: [] })).toBeNull();
  });

  /*
   * ── The three defects found by reading AAPL's real chain ──────────────
   * Each of these shipped a confidently worded, wrong sentence before the
   * live check caught it. They are pinned with the shapes that produced
   * them.
   */

  it("excludes the same-day expiry from every aggregate", () => {
    // AAPL's real proportions: 630k contracts expiring today, 9k in the
    // month. Leaving the 0DTE in let one session decide the whole read.
    const zeroDte: TradierExpiryChain = {
      expiry: "2026-08-14",
      contracts: [],
      rows: [
        row({ strike: 307.5, kind: "call", expiry: "2026-08-14", volume: 225664, openInterest: 24712 }),
        row({ strike: 305, kind: "put", expiry: "2026-08-14", volume: 97116, openInterest: 14740 }),
      ],
    };
    const month = plainChain();
    const out = buildOptionsIntelligence({
      ...base,
      chains: [zeroDte, month],
      spot: 100,
      now: Date.UTC(2026, 7, 14),
    })!;

    expect(out.frontExpiry).toBe("2026-09-18");
    // 225,664 contracts on 24,712 open is 9.1x — it would have dominated the
    // list, and on expiry day that ratio means closing, not opening.
    expect(out.unusual.some((u) => u.strike === 307.5)).toBe(false);
    expect(out.chainVolume).toBe(month.rows.reduce((s, r) => s + r.volume, 0));
  });

  it("returns null when the only chain expires today", () => {
    const zeroDte: TradierExpiryChain = { ...plainChain(), expiry: "2026-08-14" };
    expect(buildOptionsIntelligence({ ...base, chains: [zeroDte], now: Date.UTC(2026, 7, 14) })).toBeNull();
  });

  it("aggregates gamma walls by strike instead of naming one level three times", () => {
    const a = plainChain();
    const b: TradierExpiryChain = { ...plainChain(), expiry: "2026-10-16" };
    const out = buildOptionsIntelligence({ ...base, chains: [a, b] })!;
    const strikes = out.gammaWalls.map((w) => w.strike);
    expect(new Set(strikes).size).toBe(strikes.length);
    // Calls and puts at the same strike are one wall whose weight is the sum.
    const top = out.gammaWalls[0];
    expect(top.weight).toBeCloseTo(0.01 * 1000 * 100 * 4, 5); // 2 kinds x 2 expiries
  });

  it("names the earnings gap rather than calling options cheap because of it", () => {
    // Quiet stock, one 7.4% gap, and implied vol of ~30% on the chain.
    const closes: number[] = [100];
    for (let i = 1; i <= 40; i++) closes.push(closes[i - 1] * 1.001);
    closes.push(closes[closes.length - 1] * 1.074);
    for (let i = 0; i < 5; i++) closes.push(closes[closes.length - 1] * 1.001);

    const chain = plainChain();
    for (const r of chain.rows) r.iv = 0.3;
    const out = buildOptionsIntelligence({ ...base, chains: [chain], closes })!;

    expect(out.realizedVolJumpDominated).toBe(true);
    // Raw realised is the larger number, but the verdict is measured against
    // the ex-jump figure — so implied reads EXPENSIVE, not cheap.
    expect(out.realizedVolPct!).toBeGreaterThan(out.realizedVolExJumpPct!);
    expect(out.ivMinusRvPct!).toBeGreaterThan(0);
    const line = out.lines.find((l) => l.includes("Implied volatility"))!;
    expect(line).toContain("7.4% session");
    expect(line).toContain("cannot repeat before this expiry");
  });
});
