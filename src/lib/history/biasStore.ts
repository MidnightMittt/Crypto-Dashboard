import fs from "fs/promises";
import path from "path";
import { AssetSymbol } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "../store/kv";
import { Verdict } from "../signals/types";

/**
 * Last-seen verdict per metric, so the Market Bias card can say what
 * genuinely CHANGED rather than restating the same picture every poll.
 *
 * Deliberately tiny — one string per metric, not a full snapshot. The only
 * question it has to answer is "did this metric flip since last time", and
 * storing more would make this a second, competing history store alongside
 * history/store.ts and history/dailyStore.ts.
 *
 * Absence is meaningful: no stored snapshot means this is the first reading
 * for the asset, and the UI says so instead of inventing a delta.
 */

export interface BiasSnapshot {
  verdicts: Record<string, Verdict>;
  score: number;
  t: number;
}

const DATA_DIR = path.join(process.cwd(), ".data");

/**
 * Only overwrite the snapshot once a reading is this old, so "what changed"
 * compares against a meaningfully earlier state. Without a floor, a page
 * refresh two seconds later would overwrite the baseline and the diff would
 * always be empty.
 */
const MIN_SNAPSHOT_AGE_MS = 15 * 60 * 1000;

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}-bias.json`);
}

function kvKey(asset: AssetSymbol | "MARKET"): string {
  return `bias-snapshot:${asset}`;
}

export async function readBiasSnapshot(asset: AssetSymbol | "MARKET"): Promise<BiasSnapshot | null> {
  if (kvConfigured()) {
    const stored = await kvGet<BiasSnapshot>(kvKey(asset));
    return stored && typeof stored === "object" && stored.verdicts ? stored : null;
  }

  try {
    const raw = await fs.readFile(fileFor(asset), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.verdicts ? (parsed as BiasSnapshot) : null;
  } catch {
    return null;
  }
}

/** Never throws — a failed write costs one "what changed" diff, not the response. */
export async function writeBiasSnapshot(
  asset: AssetSymbol | "MARKET",
  snapshot: BiasSnapshot,
  previous: BiasSnapshot | null
): Promise<void> {
  if (previous && snapshot.t - previous.t < MIN_SNAPSHOT_AGE_MS) return;

  if (kvConfigured()) {
    await kvSet(kvKey(asset), snapshot);
    return;
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(fileFor(asset), JSON.stringify(snapshot), "utf8");
  } catch (err) {
    console.warn(`[biasStore] could not persist ${asset}:`, err);
  }
}
