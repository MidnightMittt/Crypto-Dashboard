import fs from "fs/promises";
import path from "path";
import { AssetSymbol } from "@/types/market";

/**
 * Local time-series store.
 *
 * Most exchanges either don't publish open-interest history or block it by
 * region. Rather than depend on them, the app records its own snapshot on
 * every poll and derives 24h change, percentile, and the chart from that.
 *
 * Storage is a JSON file per asset under `.data/`. That's deliberately
 * boring: no database to install, survives restarts, and is trivial to
 * inspect or delete.
 *
 * NOTE FOR DEPLOYMENT: serverless platforms (Vercel, Netlify) have an
 * ephemeral filesystem — writes vanish between invocations. For a hosted
 * deployment, swap the read/write pair below for Vercel KV, Upstash Redis,
 * Postgres, or any other persistent store. The rest of the app is unaffected.
 */

import { LocalHistoryPoint } from "@/types/market";

export type HistoryPoint = LocalHistoryPoint;

const DATA_DIR = path.join(process.cwd(), ".data");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_GAP_MS = 5 * 60 * 1000; // record at most one point per 5 minutes

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}.json`);
}

export async function readHistory(asset: AssetSymbol | "MARKET"): Promise<HistoryPoint[]> {
  try {
    const raw = await fs.readFile(fileFor(asset), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // No file yet — first run for this asset.
    return [];
  }
}

/**
 * Append a point if enough time has passed since the last one. Returns the
 * full series (including the new point) so callers don't need a second read.
 */
export async function recordHistory(
  asset: AssetSymbol | "MARKET",
  point: HistoryPoint
): Promise<HistoryPoint[]> {
  const existing = await readHistory(asset);
  const last = existing[existing.length - 1];

  // Throttle: polling every 15s shouldn't write 5,760 points a day.
  if (last && point.t - last.t < MIN_GAP_MS) {
    return existing;
  }

  // Don't record a snapshot built on nothing.
  if (point.venueCount === 0 || point.totalOpenInterestUsd <= 0) {
    return existing;
  }

  const cutoff = point.t - RETENTION_MS;
  const next = [...existing.filter((p) => p.t >= cutoff), point];

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(fileFor(asset), JSON.stringify(next), "utf8");
  } catch (err) {
    // A failed write must never break the response — the dashboard still
    // works, it just won't accumulate history this cycle.
    console.warn(`[history] could not persist ${asset}:`, err);
    return existing;
  }

  return next;
}

/** Percent change in total OI vs the closest point ~24h ago. Null if not enough history. */
export function oiChangeFromHistory(
  history: HistoryPoint[],
  currentOi: number
): number | null {
  const target = Date.now() - 24 * 60 * 60 * 1000;
  // Require a point at least 20h old so we don't report a "24h" change
  // computed from 40 minutes of data.
  const candidates = history.filter((p) => p.t <= Date.now() - 20 * 60 * 60 * 1000);
  if (candidates.length === 0) return null;

  const closest = candidates.reduce((best, p) =>
    Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best
  );
  if (!closest.totalOpenInterestUsd) return null;
  return ((currentOi - closest.totalOpenInterestUsd) / closest.totalOpenInterestUsd) * 100;
}

/** Percentile rank of current OI within recorded history. Null until enough points. */
export function oiPercentileFromHistory(
  history: HistoryPoint[],
  currentOi: number
): number | null {
  const values = history.map((p) => p.totalOpenInterestUsd).filter((v) => v > 0);
  // 48 points at one per 5 minutes is ~4 hours — below that a percentile is
  // more misleading than useful.
  if (values.length < 48) return null;
  const below = values.filter((v) => v <= currentOi).length;
  return Math.round((below / values.length) * 100);
}

/** Hours of history collected so far, for "still collecting" UI states. */
export function historySpanHours(history: HistoryPoint[]): number {
  if (history.length < 2) return 0;
  return (history[history.length - 1].t - history[0].t) / 3_600_000;
}
