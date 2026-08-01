import fs from "fs/promises";
import path from "path";
import { AssetSymbol } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "../store/kv";

/**
 * Long-retention daily snapshot store — deliberately separate from
 * store.ts's 30-day live history.
 *
 * The backtest's replay window (scripts/backtest/) is stuck at ~180 days
 * forever, bounded by OKX's open-interest/long-short retention having a
 * hard, unpaginable ceiling. This store exists purely to outlive that
 * ceiling: one point per asset per UTC day, kept for years, so the
 * backtest can eventually stretch past what any external archive offers.
 *
 * No new fetches happen here — every field comes from what the aggregator
 * already computed for the live 30-day store, just persisted at a coarser
 * cadence and a much longer retention.
 */

export interface DailyHistoryPoint {
  t: number;
  totalOpenInterestUsd: number;
  weightedFundingRatePct: number;
  longShortRatio: number | null;
  price: number;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000; // 3 years

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}-daily.json`);
}

function kvKey(asset: AssetSymbol | "MARKET"): string {
  return `daily-history:${asset}`;
}

function sameUtcDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}

export async function readDailyHistory(asset: AssetSymbol | "MARKET"): Promise<DailyHistoryPoint[]> {
  if (kvConfigured()) {
    const stored = await kvGet<DailyHistoryPoint[]>(kvKey(asset));
    return Array.isArray(stored) ? stored : [];
  }

  try {
    const raw = await fs.readFile(fileFor(asset), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Records at most one point per asset per UTC calendar day — dedup by day,
 * not a time-gap threshold, so a point right after midnight UTC can't be
 * skipped just because the previous one landed a few hours earlier.
 */
export async function recordDailyPoint(
  asset: AssetSymbol | "MARKET",
  point: DailyHistoryPoint
): Promise<DailyHistoryPoint[]> {
  const existing = await readDailyHistory(asset);
  const last = existing[existing.length - 1];

  if (last && sameUtcDay(last.t, point.t)) {
    return existing;
  }

  if (point.totalOpenInterestUsd <= 0) {
    return existing;
  }

  const cutoff = point.t - RETENTION_MS;
  const next = [...existing.filter((p) => p.t >= cutoff), point];

  if (kvConfigured()) {
    await kvSet(kvKey(asset), next);
    return next;
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(fileFor(asset), JSON.stringify(next), "utf8");
  } catch (err) {
    console.warn(`[dailyHistory] could not persist ${asset}:`, err);
    return existing;
  }

  return next;
}
