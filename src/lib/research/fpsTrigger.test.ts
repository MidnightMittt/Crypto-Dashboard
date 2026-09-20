import { describe, expect, it } from "vitest";
import { evaluateFpsT1 } from "./fpsTrigger";
import { PostGapRvResult } from "./postGapRv";

const rv = (rvPct: number): PostGapRvResult => ({
  rvPct,
  retained: 20,
  dropped: [{ date: "2026-09-10", gapPct: 25 }],
  window: { from: "2026-08-20", to: "2026-09-18", sessions: 21 },
});

const base = {
  symbol: "FPS",
  contractLabel: "FPS 2026-10-16 C",
  earningsInContractLife: false,
  earningsInRvWindow: false,
  observedAt: "2026-09-20T12:00:00Z",
};

describe("evaluateFpsT1", () => {
  it("ARMS when IV is at or below 0.90 x post-gap RV21", () => {
    // IV 45, RV 60 → ratio 0.75 ≤ 0.90.
    const r = evaluateFpsT1({ ...base, contractIvPct: 45, rv: rv(60) });
    expect(r.state).toBe("ARMED");
    expect(r.rawRatio).toBeCloseTo(0.75, 3);
  });

  it("does NOT arm when the ratio sits above the line, but still reports the ratio", () => {
    // IV 57, RV 60 → 0.95 > 0.90. The information is the distance, not the boolean.
    const r = evaluateFpsT1({ ...base, contractIvPct: 57, rv: rv(60) });
    expect(r.state).toBe("NOT_ARMED");
    expect(r.rawRatio).toBeCloseTo(0.95, 3);
    expect(r.summary).toContain("+5.0pp from the line");
  });

  it("reports the raw ratio and both windows even when not armed — the correction", () => {
    const r = evaluateFpsT1({ ...base, contractIvPct: 57, rv: rv(60) });
    expect(r.rawRatio).not.toBeNull();
    expect(r.rvWindow).not.toBeNull();
    expect(r.rvWindow!.dropped).toBe(1);
    expect(r.ivPct).toBe(57);
    expect(r.rvPct).toBe(60);
  });

  it("is INCOMPLETE, never fair, when RV could not be measured", () => {
    const r = evaluateFpsT1({ ...base, contractIvPct: 45, rv: null });
    expect(r.state).toBe("INCOMPLETE");
    expect(r.rawRatio).toBeNull();
    expect(r.summary).toContain("not the same as fair");
  });

  it("flags an event-content mismatch: earnings in the contract but not the RV window", () => {
    const r = evaluateFpsT1({ ...base, contractIvPct: 45, rv: rv(60), earningsInContractLife: true });
    expect(r.eventContentMismatch).toContain("understates");
    expect(r.summary).toContain("EVENT-CONTENT MISMATCH");
  });

  it("flags the reverse mismatch: earnings in the RV window but not the contract", () => {
    const r = evaluateFpsT1({ ...base, contractIvPct: 45, rv: rv(60), earningsInRvWindow: true });
    expect(r.eventContentMismatch).toContain("overstates");
  });

  it("no mismatch when both windows agree on earnings content", () => {
    const both = evaluateFpsT1({ ...base, contractIvPct: 45, rv: rv(60), earningsInContractLife: true, earningsInRvWindow: true });
    expect(both.eventContentMismatch).toBeNull();
  });

  it("never emits buy/sell/size language — measure and arm only", () => {
    const r = evaluateFpsT1({ ...base, contractIvPct: 45, rv: rv(60) });
    expect(r.summary.toLowerCase()).not.toMatch(/\b(buy|sell|size|should|enter|exit)\b/);
  });
});
