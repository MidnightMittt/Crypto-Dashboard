import { describe, it, expect } from "vitest";
import { computeCorrelationMatrix } from "./correlation";
import { PricePoint } from "../providers/coingeckoHistory";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function series(prices: number[], startT = NOW - prices.length * DAY): PricePoint[] {
  return prices.map((price, i) => ({ t: startT + i * DAY, price }));
}

describe("computeCorrelationMatrix", () => {
  it("returns null with fewer than 2 assets", () => {
    expect(computeCorrelationMatrix({ BTC: series([100, 110, 121]) }, 30, NOW)).toBeNull();
  });

  it("returns null when everything is empty", () => {
    expect(computeCorrelationMatrix({}, 30, NOW)).toBeNull();
  });

  it("drops an asset with fewer than 3 price points rather than crashing on it", () => {
    const result = computeCorrelationMatrix(
      {
        BTC: series([100, 110, 121, 108.9]),
        ETH: series([50, 55]), // only 1 return - excluded
      },
      30,
      NOW
    );
    expect(result).toBeNull(); // only BTC survives the filter -> fewer than 2 assets
  });

  it("is exactly 1.0 for a pure positive-scalar relationship (B's returns are always 2x A's)", () => {
    // A returns: [+0.10, -0.05, +0.08]. B returns: exactly 2x each.
    const a = series([100, 110, 104.5, 112.86]);
    const b = series([50, 60, 54, 62.64]);
    const result = computeCorrelationMatrix({ BTC: a, ETH: b }, 30, NOW)!;
    const btcIdx = result.assets.indexOf("BTC");
    const ethIdx = result.assets.indexOf("ETH");
    expect(result.matrix[btcIdx][ethIdx]).toBeCloseTo(1, 6);
    expect(result.matrix[ethIdx][btcIdx]).toBeCloseTo(1, 6);
  });

  it("is exactly -1.0 for an exact inverse relationship (B's returns are always -A's)", () => {
    // A returns: [+0.10, -0.05, +0.08]. B returns: exactly negated.
    const a = series([100, 110, 104.5, 112.86]);
    const b = series([50, 45, 47.25, 43.47]); // -10%, +5%, -8%
    const result = computeCorrelationMatrix({ BTC: a, ETH: b }, 30, NOW)!;
    const btcIdx = result.assets.indexOf("BTC");
    const ethIdx = result.assets.indexOf("ETH");
    expect(result.matrix[btcIdx][ethIdx]).toBeCloseTo(-1, 6);
  });

  it("always puts exactly 1 on the diagonal", () => {
    const result = computeCorrelationMatrix(
      { BTC: series([100, 110, 121]), ETH: series([50, 48, 52]) },
      30,
      NOW
    )!;
    for (let i = 0; i < result.assets.length; i++) {
      expect(result.matrix[i][i]).toBe(1);
    }
  });

  it("is symmetric: matrix[i][j] equals matrix[j][i]", () => {
    const result = computeCorrelationMatrix(
      {
        BTC: series([100, 110, 121, 108.9, 115]),
        ETH: series([50, 48, 52, 55, 51]),
        SOL: series([10, 11, 9.5, 10.2, 11.1]),
      },
      30,
      NOW
    )!;
    for (let i = 0; i < result.assets.length; i++) {
      for (let j = 0; j < result.assets.length; j++) {
        expect(result.matrix[i][j]).toBe(result.matrix[j][i]);
      }
    }
  });

  it("returns null for a pair where one series never moves (zero variance)", () => {
    const result = computeCorrelationMatrix(
      { BTC: series([100, 110, 121]), ETH: series([50, 50, 50, 50]) },
      30,
      NOW
    )!;
    const btcIdx = result.assets.indexOf("BTC");
    const ethIdx = result.assets.indexOf("ETH");
    expect(result.matrix[btcIdx][ethIdx]).toBeNull();
    // The flat series still gets 1 on its own diagonal - "undefined
    // correlation with something else" isn't the same claim as "undefined
    // correlation with itself".
    expect(result.matrix[ethIdx][ethIdx]).toBe(1);
  });

  it("sorts out-of-order input by timestamp before computing returns", () => {
    const shuffled: PricePoint[] = [
      { t: NOW - 0 * DAY, price: 121 },
      { t: NOW - 2 * DAY, price: 100 },
      { t: NOW - 1 * DAY, price: 110 },
    ];
    const inOrder = series([100, 110, 121]);
    const shuffledResult = computeCorrelationMatrix({ BTC: shuffled, ETH: inOrder }, 30, NOW)!;
    const orderedResult = computeCorrelationMatrix({ BTC: inOrder, ETH: inOrder }, 30, NOW)!;
    const bi = shuffledResult.assets.indexOf("BTC");
    const ei = shuffledResult.assets.indexOf("ETH");
    const obi = orderedResult.assets.indexOf("BTC");
    const oei = orderedResult.assets.indexOf("ETH");
    expect(shuffledResult.matrix[bi][ei]).toBeCloseTo(orderedResult.matrix[obi][oei]!, 6);
  });

  it("aligns mismatched-length series to the shorter one's length rather than dropping the pair", () => {
    const short = series([100, 110, 99]); // 2 returns, +10%/-10% (real variance)
    const long = series([50, 55, 49.5, 53, 47, 52]); // 5 returns, more variance
    const result = computeCorrelationMatrix({ BTC: short, ETH: long }, 30, NOW)!;
    const bi = result.assets.indexOf("BTC");
    const ei = result.assets.indexOf("ETH");
    expect(result.matrix[bi][ei]).not.toBeNull();
  });

  it("passes through windowDays and updatedAt unchanged", () => {
    const result = computeCorrelationMatrix(
      { BTC: series([100, 110, 121]), ETH: series([50, 48, 52]) },
      30,
      NOW
    )!;
    expect(result.windowDays).toBe(30);
    expect(result.updatedAt).toBe(NOW);
  });
});
