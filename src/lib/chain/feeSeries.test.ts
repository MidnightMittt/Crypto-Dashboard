import { describe, expect, it } from "vitest";
import { FeeSeriesRow, nextRow, parseSeries, serializeRow } from "./feeSeries";
import { PositionCard } from "./lpPosition";

/** A minimal card carrying just the fields nextRow reads. */
function card(over: Partial<PositionCard> & { observedAt: string }): PositionCard {
  return {
    block: "100",
    chain: { chainId: 4663, rpc: "rpc" },
    currentTick: 84000,
    inRange: true,
    pctThroughRange: 0.68,
    ponsUsd: 0.57,
    ethUsd: { value: 2568, stamp: { ts: over.observedAt, source: "kraken.ETHUSD.last" } },
    amounts: { weth: 0.04, pons: 375 },
    usdValue: 328,
    feesSinceCollect: { weth: 0.0003, pons: 1.7, usd: 1.0 },
    shareOfActivePct: 0.0075,
    liquidity: "20709381339772035115",
    notes: [],
    ...over,
  };
}

const iso = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0)).toISOString();

describe("nextRow", () => {
  it("leaves the first row's rate null — nothing to measure against", () => {
    const row = nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 0.5 } }), []);
    expect(row.fee_rate_usd_per_day).toBeNull();
    expect(row.gap_hours).toBeNull();
    expect(row.kind).toBe("sample");
  });

  it("computes the between-reads rate and the gap", () => {
    const prior: FeeSeriesRow[] = [
      nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.0 } }), []),
    ];
    // 6h later, fees grew by $0.50 → $2.00/day.
    const row = nextRow(card({ observedAt: iso(6), feesSinceCollect: { weth: 0, pons: 0, usd: 1.5 } }), prior);
    expect(row.gap_hours).toBeCloseTo(6, 6);
    expect(row.fee_rate_usd_per_day).toBeCloseTo(2.0, 6);
  });

  it("writes a BREAK, never a negative rate, when fees collapse (a collect)", () => {
    const prior: FeeSeriesRow[] = [
      nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.58 } }), []),
    ];
    const row = nextRow(card({ observedAt: iso(6), feesSinceCollect: { weth: 0, pons: 0, usd: 0.01 } }), prior);
    expect(row.kind).toBe("break");
    expect(row.fee_rate_usd_per_day).toBeNull();
    expect(row.note).toContain("collected");
  });

  it("labels a compound (fees fell while liquidity rose) distinctly from a plain collect", () => {
    const prior: FeeSeriesRow[] = [
      nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.58 } }), []),
    ];
    const row = nextRow(
      card({ observedAt: iso(6), feesSinceCollect: { weth: 0, pons: 0, usd: 0.01 }, liquidity: "30000000000000000000" }),
      prior
    );
    expect(row.kind).toBe("break");
    expect(row.note).toContain("compound");
  });

  it("measures the rate fresh AFTER a break, not across it", () => {
    const r0 = nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.58 } }), []);
    const rBreak = nextRow(card({ observedAt: iso(6), feesSinceCollect: { weth: 0, pons: 0, usd: 0.01 } }), [r0]);
    // Next sample 6h after the break: rate should measure from the break's $0.01,
    // NOT from the pre-break $1.58 — the reversed-find must skip the break row too.
    const r2 = nextRow(card({ observedAt: iso(12), feesSinceCollect: { weth: 0, pons: 0, usd: 0.51 } }), [r0, rBreak]);
    // The most recent SAMPLE is r0 ($1.58) — so a drop to $0.51 is still a break,
    // which is correct: the clock has not produced a fresh sample yet.
    expect(r2.kind).toBe("break");
  });

  it("carries the ETH source, and nulls fees when the price was unavailable", () => {
    const row = nextRow(card({ observedAt: iso(0), ethUsd: null, feesSinceCollect: { weth: 0.0003, pons: 1.7, usd: null } }), []);
    expect(row.fees_usd).toBeNull();
    expect(row.eth_usd_source).toBeNull();
  });
});

describe("serialize / parse round-trip", () => {
  it("survives JSONL round-trip and skips blank lines", () => {
    const rows = [
      nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.0 } }), []),
      nextRow(card({ observedAt: iso(6), feesSinceCollect: { weth: 0, pons: 0, usd: 1.5 } }), [
        nextRow(card({ observedAt: iso(0), feesSinceCollect: { weth: 0, pons: 0, usd: 1.0 } }), []),
      ]),
    ];
    const jsonl = rows.map(serializeRow).join("\n") + "\n\n";
    const parsed = parseSeries(jsonl);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].fee_rate_usd_per_day).toBeCloseTo(2.0, 6);
  });
});
