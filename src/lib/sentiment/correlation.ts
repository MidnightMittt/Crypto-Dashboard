import { AssetSymbol } from "@/types/market";
import { PricePoint } from "../providers/coingeckoHistory";

/**
 * Pairwise price correlation across assets — pure computation, split from
 * the fetch layer for the same reason every other derived signal here is:
 * testable against fixed input, no network dependency.
 *
 * Correlated on RETURNS (day-over-day % change), never on raw price
 * levels. Two assets that both trended up over 30 days would show a
 * spuriously high correlation on price levels alone even if their
 * day-to-day moves were unrelated — returns are what "moves together"
 * actually means.
 */

export interface CorrelationMatrix {
  assets: AssetSymbol[];
  /** matrix[i][j] = correlation between assets[i] and assets[j], -1 to 1. Diagonal is always 1. Null where too little overlapping data exists to compute a pair. */
  matrix: Array<Array<number | null>>;
  windowDays: number;
  updatedAt: number;
}

/** Day-over-day returns, oldest first. Requires ascending-time input. */
function toReturns(series: PricePoint[]): number[] {
  const sorted = [...series].sort((a, b) => a.t - b.t);
  const returns: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].price;
    if (prev > 0) returns.push((sorted[i].price - prev) / prev);
  }
  return returns;
}

/**
 * Pearson correlation coefficient. Aligns to the shorter series' length,
 * taking the most recent N returns from each — a mismatched-length pair
 * (one asset with more history than another) still produces a comparable
 * answer rather than being dropped entirely.
 *
 * Null when there are fewer than 2 overlapping points, or when either
 * series has zero variance (a division by zero waiting to happen, and
 * also not a meaningful correlation — a flat series isn't correlated OR
 * uncorrelated with anything, the question doesn't apply).
 */
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;

  const aa = a.slice(a.length - n);
  const bb = b.slice(b.length - n);

  const meanA = aa.reduce((s, v) => s + v, 0) / n;
  const meanB = bb.reduce((s, v) => s + v, 0) / n;

  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = aa[i] - meanA;
    const db = bb[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

export function computeCorrelationMatrix(
  seriesByAsset: Partial<Record<AssetSymbol, PricePoint[]>>,
  windowDays: number,
  now: number
): CorrelationMatrix | null {
  const assets = (Object.keys(seriesByAsset) as AssetSymbol[])
    .filter((a) => (seriesByAsset[a]?.length ?? 0) >= 3)
    .sort();

  if (assets.length < 2) return null;

  const returnsByAsset = new Map(assets.map((a) => [a, toReturns(seriesByAsset[a]!)]));

  const matrix: Array<Array<number | null>> = assets.map((rowAsset, i) =>
    assets.map((colAsset, j) => {
      if (i === j) return 1;
      return pearson(returnsByAsset.get(rowAsset)!, returnsByAsset.get(colAsset)!);
    })
  );

  return { assets, matrix, windowDays, updatedAt: now };
}
