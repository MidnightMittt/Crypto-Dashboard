import fs from "fs/promises";
import path from "path";
import { kvConfigured, kvGet, kvSet } from "../store/kv";

/**
 * Balance-snapshot store for exchangeFlows — same shape and same reasoning
 * as history/store.ts (Redis when configured, filesystem otherwise, since
 * Vercel's filesystem is ephemeral between invocations), but a separate
 * store because it holds a different thing: raw wallet balances, not market
 * snapshots, and only ever for "BTC" | "ETH".
 *
 * Netflow is a balance DELTA — this store exists purely so there's a past
 * balance to diff the current one against.
 */

export interface FlowPoint {
  t: number;
  balanceNative: number;
}

const DATA_DIR = path.join(process.cwd(), ".data");
// Only needs to cover the netflow window (24h) plus slack for gaps in
// polling — unlike price/OI history this isn't shown as a long chart.
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const MIN_GAP_MS = 5 * 60 * 1000; // one point per 5 minutes, same as history/store.ts

type FlowAsset = "BTC" | "ETH";

function fileFor(asset: FlowAsset): string {
  return path.join(DATA_DIR, `flow-${asset}.json`);
}

function kvKey(asset: FlowAsset): string {
  return `flow-history:${asset}`;
}

export async function readFlowHistory(asset: FlowAsset): Promise<FlowPoint[]> {
  if (kvConfigured()) {
    const stored = await kvGet<FlowPoint[]>(kvKey(asset));
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

export async function recordFlowBalance(
  asset: FlowAsset,
  point: FlowPoint
): Promise<FlowPoint[]> {
  const existing = await readFlowHistory(asset);
  const last = existing[existing.length - 1];

  if (last && point.t - last.t < MIN_GAP_MS) {
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
    console.warn(`[flow-history] could not persist ${asset}:`, err);
    return existing;
  }

  return next;
}

/**
 * Closest recorded point to `windowHours` ago, requiring it to be at least
 * 80% of that window old — mirrors history/store.ts's oiChangeFromHistory
 * guard against reporting a "24h" figure computed from 40 minutes of data.
 * Null until enough history has accumulated.
 */
export function balanceWindowAgo(
  history: FlowPoint[],
  windowHours: number
): FlowPoint | null {
  const now = Date.now();
  const target = now - windowHours * 3_600_000;
  const minAge = now - windowHours * 3_600_000 * 0.8;

  const candidates = history.filter((p) => p.t <= minAge);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, p) =>
    Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best
  );
}
