import { describe, it, expect } from "vitest";
import {
  fundingPer8h,
  toBps,
  formatBps,
  formatPct,
  formatCompactUsd,
  formatUsd,
  formatFundingPct,
  formatCountdown,
  timeAgo,
  cx,
  orDash,
} from "./format";

describe("fundingPer8h", () => {
  it("passes an 8h rate through unchanged", () => {
    expect(fundingPer8h(0.01, 8)).toBeCloseTo(0.01, 10);
  });

  it("scales an hourly rate up by 8x to its 8h equivalent", () => {
    // This is the exact normalization whose absence/inversion previously made
    // hourly-funding venues (Kraken, Hyperliquid, dYdX, Backpack) compare as
    // if permanently near-zero against 8h venues.
    expect(fundingPer8h(0.00125, 1)).toBeCloseTo(0.01, 10);
  });

  it("scales a 4h rate up by 2x", () => {
    expect(fundingPer8h(0.005, 4)).toBeCloseTo(0.01, 10);
  });

  it("preserves sign for negative funding", () => {
    expect(fundingPer8h(-0.00125, 1)).toBeCloseTo(-0.01, 10);
  });

  it("returns 0 for 0 input regardless of interval", () => {
    expect(fundingPer8h(0, 1)).toBe(0);
    expect(fundingPer8h(0, 8)).toBe(0);
  });
});

describe("toBps", () => {
  it("converts a percentage to basis points via x100", () => {
    // The exact conversion whose accidental double-application (a source
    // already in bps, multiplied again) was the historical x100 bug.
    expect(toBps(0.01)).toBeCloseTo(1, 10);
    expect(toBps(0.27)).toBeCloseTo(27, 10);
  });

  it("handles zero and negative values", () => {
    expect(toBps(0)).toBe(0);
    expect(toBps(-0.05)).toBeCloseTo(-5, 10);
  });
});

describe("formatBps", () => {
  it("always shows an explicit sign on positive values", () => {
    expect(formatBps(0.01)).toBe("+1.0");
  });

  it("shows a minus sign (not double sign) on negative values", () => {
    expect(formatBps(-0.01)).toBe("-1.0");
  });

  it("respects the decimals argument", () => {
    expect(formatBps(0.01234, 3)).toBe("+1.234");
  });

  it("shows a bare + for zero", () => {
    expect(formatBps(0)).toBe("+0.0");
  });
});

describe("formatPct", () => {
  it("adds a leading + for positive values by default", () => {
    expect(formatPct(1.5)).toBe("+1.50%");
  });

  it("does not add a sign to negative values (toFixed already supplies it)", () => {
    expect(formatPct(-1.5)).toBe("-1.50%");
  });

  it("suppresses the forced + when forceSign is false", () => {
    expect(formatPct(1.5, 2, false)).toBe("1.50%");
  });

  it("does not sign zero", () => {
    expect(formatPct(0)).toBe("0.00%");
  });
});

describe("formatCompactUsd", () => {
  it("abbreviates billions", () => {
    expect(formatCompactUsd(30_310_000_000)).toBe("$30.31B");
  });

  it("abbreviates millions", () => {
    expect(formatCompactUsd(6_739_531)).toBe("$6.74M");
  });

  it("picks the billions path only at >= 1e9, millions just under it", () => {
    expect(formatCompactUsd(999_999_999)).toBe("$1000.00M");
    expect(formatCompactUsd(1_000_000_000)).toBe("$1.00B");
  });

  it("abbreviates thousands", () => {
    expect(formatCompactUsd(1_500)).toBe("$1.5K");
  });

  it("shows small values as whole dollars", () => {
    expect(formatCompactUsd(42)).toBe("$42");
  });

  it("preserves the negative sign", () => {
    expect(formatCompactUsd(-1_500)).toBe("-$1.5K");
  });

  it("does not choke on zero", () => {
    expect(formatCompactUsd(0)).toBe("$0");
  });
});

describe("formatUsd", () => {
  it("formats a whole number as US currency with 2 decimals by default", () => {
    expect(formatUsd(1234)).toBe("$1,234.00");
  });

  it("respects a custom decimals argument", () => {
    expect(formatUsd(1234.5678, 0)).toBe("$1,235");
  });
});

describe("formatFundingPct", () => {
  it("shows 4 decimal places, since real funding rates are small", () => {
    expect(formatFundingPct(0.0125)).toBe("+0.0125%");
  });

  it("does not force a sign on negative or zero values (toFixed supplies the minus itself)", () => {
    expect(formatFundingPct(-0.0125)).toBe("-0.0125%");
    expect(formatFundingPct(0)).toBe("0.0000%");
  });
});

describe("formatCountdown", () => {
  it("renders hours, minutes and seconds, zero-padded", () => {
    const now = 0;
    const target = now + 2 * 3_600_000 + 5 * 60_000 + 9_000; // 2h 5m 9s
    expect(formatCountdown(target, now)).toBe("02:05:09");
  });

  it("clamps a target already in the past to 00:00:00 rather than a negative countdown", () => {
    expect(formatCountdown(0, 100_000)).toBe("00:00:00");
  });
});

describe("timeAgo", () => {
  it("shows seconds under a minute", () => {
    expect(timeAgo(0, 45_000)).toBe("45s ago");
  });

  it("shows minutes under an hour", () => {
    expect(timeAgo(0, 5 * 60_000)).toBe("5m ago");
  });

  it("shows hours at or beyond an hour", () => {
    expect(timeAgo(0, 3 * 3_600_000)).toBe("3h ago");
  });

  it("clamps a future timestamp to 0s rather than a negative age", () => {
    expect(timeAgo(100_000, 0)).toBe("0s ago");
  });
});

describe("cx", () => {
  it("joins truthy class names with a space", () => {
    expect(cx("a", "b", "c")).toBe("a b c");
  });

  it("drops false, null, and undefined entries", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cx(false, null, undefined)).toBe("");
  });
});

describe("orDash", () => {
  it("renders null as an em dash rather than a fake zero", () => {
    expect(orDash(null, (v) => `${v}%`)).toBe("—");
  });

  it("renders undefined as an em dash", () => {
    expect(orDash(undefined, (v) => `${v}%`)).toBe("—");
  });

  it("renders NaN/Infinity as an em dash, not a broken string", () => {
    expect(orDash(NaN, (v) => `${v}%`)).toBe("—");
    expect(orDash(Infinity, (v) => `${v}%`)).toBe("—");
  });

  it("renders a real zero through the formatter, not as a dash", () => {
    // 0 is a valid, meaningful reading (e.g. flat funding) and must not be
    // conflated with "unavailable".
    expect(orDash(0, (v) => `${v}%`)).toBe("0%");
  });

  it("passes a real value through the formatter", () => {
    expect(orDash(1.5, (v) => `${v.toFixed(1)}%`)).toBe("1.5%");
  });
});
