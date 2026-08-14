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
