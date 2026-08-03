import fs from "fs/promises";
import path from "path";
import { AssetSymbol } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "../store/kv";
import { Verdict } from "../signals/types";

/**
 * The market thesis over time, not just right now.
 *
 * ── Why this is event-driven and not a fixed-interval series ───────────
 *
 * A reading every 15 minutes would produce ~96 near-identical rows a day
 * and bury the two moments that actually mattered. What a strategist wants
 * from a timeline is the SHIFTS: the market was bullish, then funding
 * overheated, then it turned cautious. So an entry is appended only when
 * the read genuinely moves — the verdict flips, the regime changes, or the
 * score travels far enough to mean something — plus a slow heartbeat so a
 * genuinely flat day still shows it was flat rather than showing nothing.
 *
 * This is a separate store from biasStore.ts on purpose. That one answers
 * "what changed since the last reading" and only ever holds a single
 * snapshot; this one is the arc. Merging them would force one of the two
 * questions to be answered badly.
 *
 * IMPORTANT: this accumulates FORWARD. There is no backfill, because the
 * only historical source available (the backtest replay) runs on daily
 * bars with a reduced metric set, and presenting that on the same timeline
 * as live intraday readings would be two different things wearing one
 * label. A fresh deployment shows one entry and grows from there.
 */

export interface BiasHistoryEntry {
  t: number;
  score: number;
  verdict: Verdict;
  /** Regime label at the time, when a thesis was available. */
  regime: string | null;
  /** Metric labels driving the read, most significant first. */
  reasons: string[];
  /** The strongest metric arguing the other way, if any. */
  topRisk: string | null;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

/** Score movement, in points, treated as a real shift rather than noise. */
const SCORE_SHIFT_THRESHOLD = 8;
/** Even with no change, record this often so a flat stretch is visible as flat. */
const HEARTBEAT_MS = 4 * 60 * 60 * 1000;
/** Never append twice inside this window, however much the score jitters. */
const MIN_GAP_MS = 10 * 60 * 1000;

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}-bias-history.json`);
}

function kvKey(asset: AssetSymbol | "MARKET"): string {
  return `bias-history:${asset}`;
}

export async function readBiasHistory(asset: AssetSymbol | "MARKET"): Promise<BiasHistoryEntry[]> {
  if (kvConfigured()) {
    const stored = await kvGet<BiasHistoryEntry[]>(kvKey(asset));
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
 * Whether this reading is different enough from the last recorded one to be
 * worth a row on the timeline. Pure, so the rule is testable on its own.
 */
export function shouldRecord(previous: BiasHistoryEntry | undefined, next: BiasHistoryEntry): boolean {
  if (!previous) return true;

  const elapsed = next.t - previous.t;
  // Guard against a burst of writes when several requests fill the cache at
  // once — without this, one volatile minute could add several rows.
  if (elapsed < MIN_GAP_MS) return false;

  if (next.verdict !== previous.verdict) return true;
  if (next.regime !== previous.regime) return true;
  if (Math.abs(next.score - previous.score) >= SCORE_SHIFT_THRESHOLD) return true;

  return elapsed >= HEARTBEAT_MS;
}

/**
 * Appends when the read has genuinely moved. Returns the resulting series so
 * the caller can render it without a second read.
 *
 * Never throws: a failed write costs one row on a timeline, never the
 * response — same rule as every other store in this codebase.
 */
export async function recordBiasHistory(
  asset: AssetSymbol | "MARKET",
  entry: BiasHistoryEntry
): Promise<BiasHistoryEntry[]> {
  const existing = await readBiasHistory(asset);
  const last = existing[existing.length - 1];

  if (!shouldRecord(last, entry)) return existing;

  const cutoff = entry.t - RETENTION_MS;
  const next = [...existing.filter((e) => e.t >= cutoff), entry].slice(-MAX_ENTRIES);

  if (kvConfigured()) {
    await kvSet(kvKey(asset), next);
    return next;
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(fileFor(asset), JSON.stringify(next), "utf8");
  } catch (err) {
    console.warn(`[biasHistory] could not persist ${asset}:`, err);
    return existing;
  }

  return next;
}
