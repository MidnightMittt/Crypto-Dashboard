import { describe, expect, it } from "vitest";
import { parseShortVolumeRow } from "./finraShortVolume";
import { MIN_TAGGED, summariseMessages, StocktwitsMessage } from "./attention";

describe("parseShortVolumeRow", () => {
  it("parses the real FINRA row shape, hand-verified against the live file", () => {
    // Verbatim row format observed from CNMSshvol20260812.txt during probing.
    const row = parseShortVolumeRow("20260812|AAPL|5521379.994964|43970.500000|14277891.689275|B,Q,N")!;
    expect(row.date).toBe("20260812");
    expect(row.shortVolume).toBeCloseTo(5_521_379.99, 1);
    expect(row.totalVolume).toBeCloseTo(14_277_891.69, 1);
    // 5521379.994964 / 14277891.689275 = 38.67%
    expect(row.shortRatioPct).toBeCloseTo(38.67, 1);
  });

  it("rejects malformed rows rather than computing a ratio from garbage", () => {
    expect(parseShortVolumeRow("")).toBeNull();
    expect(parseShortVolumeRow("20260812|AAPL|abc|0|123|Q")).toBeNull();
    expect(parseShortVolumeRow("20260812|AAPL|100|0|0|Q")).toBeNull(); // zero total volume
    expect(parseShortVolumeRow("banana|AAPL|100|0|200|Q")).toBeNull(); // bad date
  });
});

describe("summariseMessages", () => {
  const msg = (sentiment: string | null, at = "2026-08-13T12:00:00Z"): StocktwitsMessage => ({
    created_at: at,
    entities: sentiment ? { sentiment: { basic: sentiment } } : { sentiment: null },
  });

  it("counts only self-tagged messages and computes the bullish share among them", () => {
    const messages = [
      ...Array(6).fill(msg("Bullish")),
      ...Array(2).fill(msg("Bearish")),
      ...Array(10).fill(msg(null)), // untagged posts are attention, not direction
    ];
    const s = summariseMessages(messages);
    expect(s.sampleSize).toBe(18);
    expect(s.taggedCount).toBe(8);
    expect(s.bullishPctOfTagged).toBe(75); // 6 of 8
  });

  it("refuses a percentage below the tagged floor — noise must not wear a number", () => {
    const s = summariseMessages([...Array(MIN_TAGGED - 1).fill(msg("Bullish"))]);
    expect(s.taggedCount).toBe(MIN_TAGGED - 1);
    expect(s.bullishPctOfTagged).toBeNull();
  });

  it("measures the sample span, because 30 messages in 2 hours and in 4 days are different facts", () => {
    const s = summariseMessages([
      msg("Bullish", "2026-08-13T10:00:00Z"),
      msg("Bearish", "2026-08-13T16:00:00Z"),
    ]);
    expect(s.sampleSpanHours).toBe(6);
  });

  it("carries the self-report caveat in the data itself", () => {
    expect(summariseMessages([msg("Bullish")]).selfReportNote).toContain("self-reported");
  });
});

describe("baselineShortRatio", () => {
  const day = (date: string, ratio: number) => ({
    date,
    shortVolume: ratio,
    totalVolume: 100,
    shortRatioPct: ratio,
  });

  it("hand-verifies the percentile: today above 9 of 10 priors reads 90th (mid-rank)", async () => {
    const { baselineShortRatio } = await import("./finraShortVolume");
    const prior = Array.from({ length: 10 }, (_, i) => day(`202608${String(i + 1).padStart(2, "0")}`, 30 + i)); // 30..39
    const b = baselineShortRatio(day("20260812", 38.5), prior)!;
    // 9 below, 0 ties -> (9 + 0)/10 = 90th
    expect(b.percentile).toBe(90);
    expect(b.signalLine).toContain("unusually heavy");
    expect(b.typicalRatioPct).toBeCloseTo(34.5, 6);
  });

  it("uses mid-rank on ties so a flat series reads as the middle, not an extreme", async () => {
    const { baselineShortRatio } = await import("./finraShortVolume");
    const prior = Array.from({ length: 10 }, (_, i) => day(`2026080${i}`, 40));
    const b = baselineShortRatio(day("20260812", 40), prior)!;
    expect(b.percentile).toBe(50);
    expect(b.signalLine).toContain("ordinary for this name");
  });

  it("refuses a baseline below the session floor", async () => {
    const { baselineShortRatio, MIN_BASELINE_SESSIONS } = await import("./finraShortVolume");
    const prior = Array.from({ length: MIN_BASELINE_SESSIONS - 1 }, (_, i) => day(`2026080${i}`, 30));
    expect(baselineShortRatio(day("20260812", 50), prior)).toBeNull();
  });
});

describe("detectOpeningFlow", () => {
  const contract = (kind: "call" | "put", strike: number, volume: number, oi: number) => ({
    expiry: "2026-08-14",
    kind,
    strike,
    iv: 0.3,
    gamma: 0.01,
    openInterest: oi,
    volume,
  });

  it("flags a strike only past BOTH bars: 2x open interest AND the absolute floor", async () => {
    const { detectOpeningFlow } = await import("./cboeOptions");
    const flow = detectOpeningFlow([
      contract("call", 110, 1200, 400), // 3x OI, above floor -> hot
      contract("call", 115, 300, 50), // 6x OI but under the 500 floor -> not hot
      contract("put", 90, 5000, 4000), // big volume but only 1.25x OI -> not hot
    ]);
    expect(flow.hotStrikes).toHaveLength(1);
    expect(flow.hotStrikes[0]).toMatchObject({ strike: 110, volume: 1200, openInterest: 400 });
    expect(flow.hotStrikes[0].volumeOverOi).toBeCloseTo(3, 6);
    expect(flow.signalLine).toContain("New positioning is being opened");
  });

  it("states the identification honestly: new money, direction not knowable from the tape", async () => {
    const { detectOpeningFlow } = await import("./cboeOptions");
    const flow = detectOpeningFlow([contract("call", 110, 1200, 400)]);
    expect(flow.signalLine).toContain("not knowable from the tape");
  });

  it("says so plainly when nothing is opening", async () => {
    const { detectOpeningFlow } = await import("./cboeOptions");
    const flow = detectOpeningFlow([contract("call", 110, 100, 4000)]);
    expect(flow.hotStrikes).toHaveLength(0);
    expect(flow.signalLine).toContain("existing positions, not opening new ones");
  });

  it("a zero-OI strike cannot divide by zero its way into an infinite ratio", async () => {
    const { detectOpeningFlow } = await import("./cboeOptions");
    const flow = detectOpeningFlow([contract("put", 95, 600, 0)]);
    expect(flow.hotStrikes[0].volumeOverOi).toBe(600);
    expect(Number.isFinite(flow.hotStrikes[0].volumeOverOi)).toBe(true);
  });
});
