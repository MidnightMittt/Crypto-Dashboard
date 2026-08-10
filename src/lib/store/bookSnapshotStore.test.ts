import { describe, expect, it, vi, beforeEach } from "vitest";
import { LiquidityWall } from "@/lib/technicals/liquidityWalls";

const state = { configured: true, stored: null as unknown };

vi.mock("./kv", () => ({
  kvConfigured: () => state.configured,
  kvGet: vi.fn(async () => state.stored),
  kvSet: vi.fn(async (_key: string, value: unknown) => {
    state.stored = value;
  }),
}));

import { recordAndGetPriorSnapshots, classifyPersistence, StoredWallSnapshot } from "./bookSnapshotStore";

function wall(price: number, side: LiquidityWall["side"] = "bid"): LiquidityWall {
  return { side, price, usd: 1_000_000, zScore: 10 };
}

beforeEach(() => {
  state.configured = true;
  state.stored = null;
});

describe("classifyPersistence", () => {
  it("reports unavailable when KV isn't configured, regardless of history", () => {
    state.configured = false;
    expect(classifyPersistence(wall(100), [])).toEqual({ kind: "unavailable" });
    expect(classifyPersistence(wall(100), [{ t: 1, walls: [{ side: "bid", price: 100, usd: 1 }] }])).toEqual({
      kind: "unavailable",
    });
  });

  it("reports new when there is no prior history to compare against", () => {
    expect(classifyPersistence(wall(100), [])).toEqual({ kind: "new" });
  });

  it("reports new when the price wasn't seen in any prior snapshot", () => {
    const prior: StoredWallSnapshot[] = [{ t: 1, walls: [{ side: "bid", price: 90, usd: 1 }] }];
    expect(classifyPersistence(wall(100), prior)).toEqual({ kind: "new" });
  });

  it("reports recurring with an accurate count when the price DID appear before", () => {
    const prior: StoredWallSnapshot[] = [
      { t: 1, walls: [{ side: "bid", price: 100, usd: 1 }] },
      { t: 2, walls: [{ side: "bid", price: 55, usd: 1 }] },
      { t: 3, walls: [{ side: "bid", price: 100.01, usd: 1 }] }, // within tolerance
    ];
    expect(classifyPersistence(wall(100), prior)).toEqual({
      kind: "recurring",
      snapshotsSeenIn: 2,
      snapshotsChecked: 3,
    });
  });

  it("does not match a wall on the wrong side at the same price", () => {
    const prior: StoredWallSnapshot[] = [{ t: 1, walls: [{ side: "ask", price: 100, usd: 1 }] }];
    expect(classifyPersistence(wall(100, "bid"), prior)).toEqual({ kind: "new" });
  });

  it("does not match a price outside the proportional tolerance", () => {
    // 0.0005 tolerance of 100 = 0.05 -> 0.2 away should NOT match.
    const prior: StoredWallSnapshot[] = [{ t: 1, walls: [{ side: "bid", price: 100.2, usd: 1 }] }];
    expect(classifyPersistence(wall(100), prior)).toEqual({ kind: "new" });
  });

  it("never labels a disappeared wall as spoofing — only reports what IS present", () => {
    // The module has no concept of "was here, now gone" as its own state;
    // confirmed by exercising the full PersistenceLabel union above and
    // finding no such variant. This test exists to catch a regression if
    // one is ever added without the conservative-terminology review this
    // file's own doc comment requires.
    const prior: StoredWallSnapshot[] = [{ t: 1, walls: [{ side: "bid", price: 100, usd: 1 }] }];
    const result = classifyPersistence(wall(200), prior); // a DIFFERENT wall now, 100 no longer present
    expect(result.kind).not.toBe("spoofing" as never);
    expect(["unavailable", "new", "recurring"]).toContain(result.kind);
  });
});

describe("recordAndGetPriorSnapshots", () => {
  it("returns an empty prior list and writes nothing when KV is unconfigured", async () => {
    state.configured = false;
    const prior = await recordAndGetPriorSnapshots("BTC", 1000, [wall(100)]);
    expect(prior).toEqual([]);
    expect(state.stored).toBeNull();
  });

  it("returns the PRE-existing snapshots, not including the one just written", async () => {
    state.stored = [{ t: 500, walls: [{ side: "bid", price: 90, usd: 1 }] }];
    const prior = await recordAndGetPriorSnapshots("BTC", 1000, [wall(100)]);
    expect(prior).toEqual([{ t: 500, walls: [{ side: "bid", price: 90, usd: 1 }] }]);
    // The write happened, and now includes the new one appended after the old.
    expect(state.stored).toEqual([
      { t: 500, walls: [{ side: "bid", price: 90, usd: 1 }] },
      { t: 1000, walls: [{ side: "bid", price: 100, usd: 1_000_000 }] },
    ]);
  });

  it("caps stored history at the retention window rather than growing unbounded", async () => {
    state.stored = [
      { t: 1, walls: [] },
      { t: 2, walls: [] },
      { t: 3, walls: [] },
      { t: 4, walls: [] },
    ];
    await recordAndGetPriorSnapshots("BTC", 5, [wall(100)]);
    const written = state.stored as StoredWallSnapshot[];
    expect(written).toHaveLength(4); // MAX_SNAPSHOTS
    expect(written.map((s) => s.t)).toEqual([2, 3, 4, 5]); // oldest (t=1) dropped
  });

  it("handles no prior data (first ever poll for this asset) without error", async () => {
    state.stored = null;
    const prior = await recordAndGetPriorSnapshots("ETH", 1000, [wall(100)]);
    expect(prior).toEqual([]);
  });
});
