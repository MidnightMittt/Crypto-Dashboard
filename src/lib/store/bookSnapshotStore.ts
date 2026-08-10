import { AssetSymbol } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "./kv";
import { LiquidityWall } from "@/lib/technicals/liquidityWalls";

/**
 * Short-retention wall-snapshot history — whether a detected wall recurred
 * across recent polls, or is appearing for the first time.
 *
 * Deliberately NOT the same shape as `dailyStore.ts`'s 3-year history: that
 * store exists specifically to survive a local filesystem's ephemerality
 * because the backtest genuinely needs years of depth. This one only needs
 * the last few minutes, and losing it on a local restart is a fine, honest
 * degradation — so there is no filesystem fallback here. Unconfigured KV
 * (local dev, or a deploy with no Upstash credentials) means persistence
 * classification is simply unavailable, exactly as `kv.ts`'s own contract
 * already promises; every wall still gets returned, just without a
 * new/recurring label attached.
 *
 * Only the detected walls themselves are stored (side + price + usd), not
 * full order-book snapshots — smaller, and it is literally the only thing
 * "did this recur" needs to compare against.
 */

export interface StoredWallSnapshot {
  t: number;
  walls: Array<{ side: LiquidityWall["side"]; price: number; usd: number }>;
}

const MAX_SNAPSHOTS = 4;
const TTL_SECONDS = 120;
/** Same proportional tolerance liquidityWalls.ts uses for "at this price" — a wall's exact print can drift a tick between polls without being a different wall. */
const RECURRENCE_TOLERANCE_PCT = 0.0005;

function kvKey(asset: AssetSymbol): string {
  return `book-walls:${asset}`;
}

async function readSnapshots(asset: AssetSymbol): Promise<StoredWallSnapshot[]> {
  const stored = await kvGet<StoredWallSnapshot[]>(kvKey(asset));
  return Array.isArray(stored) ? stored : [];
}

/**
 * Appends the current poll's detected walls and returns the snapshots that
 * existed BEFORE this one — i.e. what `classifyPersistence` below should
 * compare the new walls against. Never throws; a failed write just means
 * the next poll starts persistence tracking fresh.
 */
export async function recordAndGetPriorSnapshots(
  asset: AssetSymbol,
  now: number,
  currentWalls: LiquidityWall[]
): Promise<StoredWallSnapshot[]> {
  if (!kvConfigured()) return [];

  const prior = await readSnapshots(asset);
  const next = [
    ...prior.slice(-(MAX_SNAPSHOTS - 1)),
    { t: now, walls: currentWalls.map((w) => ({ side: w.side, price: w.price, usd: w.usd })) },
  ];
  await kvSet(kvKey(asset), next, TTL_SECONDS);
  return prior;
}

export type PersistenceLabel =
  | { kind: "unavailable" }
  | { kind: "new" }
  | { kind: "recurring"; snapshotsSeenIn: number; snapshotsChecked: number };

/**
 * Was a wall at this price seen in the recent snapshot history?
 *
 * Conservative terminology only: this counts how many of the last few
 * polls also showed a wall here. It does NOT attempt to infer intent — a
 * wall that stops recurring is just "not seen in the latest snapshot,"
 * never labelled spoofing, since disappearance alone supports no such
 * conclusion (a real order can fill, not just vanish).
 */
export function classifyPersistence(
  wall: LiquidityWall,
  priorSnapshots: StoredWallSnapshot[]
): PersistenceLabel {
  if (!kvConfigured()) return { kind: "unavailable" };
  if (priorSnapshots.length === 0) return { kind: "new" };

  const tolerance = wall.price * RECURRENCE_TOLERANCE_PCT;
  const seenIn = priorSnapshots.filter((snap) =>
    snap.walls.some((w) => w.side === wall.side && Math.abs(w.price - wall.price) <= tolerance)
  ).length;

  return seenIn === 0
    ? { kind: "new" }
    : { kind: "recurring", snapshotsSeenIn: seenIn, snapshotsChecked: priorSnapshots.length };
}
