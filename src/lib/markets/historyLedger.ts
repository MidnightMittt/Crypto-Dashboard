/**
 * THE SIGNAL HISTORY LEDGER — the platform's memory.
 *
 * Every daily pipeline run appends one entry: the regime read, every rotation
 * state, every industry's state and breadth, every equity verdict. Committed
 * to git by the cron, which makes it point-in-time BY CONSTRUCTION — an entry
 * cannot be revised after the fact without the revision being visible in
 * history, which is the property every "when X happened before, Y followed"
 * claim will eventually rest on.
 *
 * ── Why one file, and why so small ────────────────────────────────────
 *
 * A single append-only JSON keeps the ledger importable by build-time pages
 * (per-day files would need fs globbing that serverless bundles break on).
 * Entries are deliberately COMPACT SUMMARIES — states and scores, not full
 * evidence trees. The full trees live in that day's git commit of the
 * snapshot files; the ledger is the index that makes them queryable. A few
 * hundred bytes per day is decades of runway.
 *
 * ── The idempotency rule ──────────────────────────────────────────────
 *
 * Appending the same date twice REPLACES the entry rather than duplicating
 * it. A re-run of the pipeline (manual dispatch after a partial failure) must
 * converge on one entry per date, or every downstream duration count
 * ("risk-off for 9 days") silently double-counts the re-run days.
 *
 * This file is pure. The pipeline script does the reading and writing.
 */

export interface LedgerEntry {
  /** ISO date, the entry's identity. One entry per date, enforced by `appendEntry`. */
  date: string;
  regime: {
    regime: string;
    agreeing: number;
    total: number;
  } | null;
  /** Sector rotation states, compact. */
  rotation: Array<{ symbol: string; state: string; shortRelPct: number }>;
  dispersionPct: number | null;
  industries: Array<{ slug: string; state: string; shortRelPct: number; breadthPct: number | null }>;
  equity: Array<{ symbol: string; verdict: string; score: number; confidence: number }>;
}

export interface Ledger {
  entries: LedgerEntry[];
}

export function emptyLedger(): Ledger {
  return { entries: [] };
}

/** Append or replace by date, keeping entries sorted ascending. Pure. */
export function appendEntry(ledger: Ledger, entry: LedgerEntry): Ledger {
  const others = ledger.entries.filter((e) => e.date !== entry.date);
  return { entries: [...others, entry].sort((a, b) => a.date.localeCompare(b.date)) };
}

/**
 * How long the current value of some field has held, in ENTRIES (trading
 * days for equities — the ledger only gains entries when the pipeline runs).
 *
 * Walks backward from the latest entry while `read` returns the same value.
 * Returns the run length and the date the current value first appeared.
 * Null when the ledger is empty or the latest value is null — "unknown" and
 * "zero days" are different claims and only one of them is ever true.
 */
export function currentRun<T>(
  ledger: Ledger,
  read: (entry: LedgerEntry) => T | null
): { value: T; days: number; since: string } | null {
  const entries = ledger.entries;
  if (entries.length === 0) return null;

  const latest = read(entries[entries.length - 1]);
  if (latest === null) return null;

  let days = 0;
  let since = entries[entries.length - 1].date;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (read(entries[i]) !== latest) break;
    days++;
    since = entries[i].date;
  }
  return { value: latest, days, since };
}

/**
 * Every completed episode of a value over the ledger's history — the input
 * to "6th risk-off episode this year; prior episodes lasted a median of N
 * days". Returns newest-last. The final episode may still be open; the
 * caller can tell because its end date equals the latest entry's date.
 */
export function episodesOf<T>(
  ledger: Ledger,
  read: (entry: LedgerEntry) => T | null
): Array<{ value: T; start: string; end: string; days: number }> {
  const out: Array<{ value: T; start: string; end: string; days: number }> = [];
  for (const entry of ledger.entries) {
    const v = read(entry);
    if (v === null) continue;
    const last = out[out.length - 1];
    if (last && last.value === v) {
      last.end = entry.date;
      last.days++;
    } else {
      out.push({ value: v, start: entry.date, end: entry.date, days: 1 });
    }
  }
  return out;
}

/**
 * ── THE SPINE HAS TO NOTICE WHEN IT STOPS ────────────────────────────
 *
 * Measured 2026-08-15: the ledger held ONE entry, dated 2026-08-12, and the
 * pipeline had been reporting success. Its single committed run refreshed
 * marketIntelligence.json and equityMarkets.json and never touched
 * signalLedger.json — the snapshot's as-of had not advanced, the append
 * idempotently rewrote the same entry, the file did not change, and the
 * commit step said "no data changes, nothing to deploy" and exited 0.
 *
 * Every green light was accurate about its own step. The platform's memory
 * had stopped accumulating and nothing anywhere said so — which is exactly
 * the "looks live while standing still" failure this project refuses to ship
 * to users, turned inward on the pipeline itself.
 *
 * ── The distinction this makes ───────────────────────────────────────
 *
 * A RE-RUN of today is legitimate, and idempotency is the feature that makes
 * it safe. Data that has stopped advancing is a broken ingest wearing a
 * re-run's clothes. They are told apart by the DATA'S OWN DATE, never by
 * whether the file happened to change — which is the signal the pipeline was
 * using, and the reason it stayed quiet.
 *
 * Pure and injected-clock so the rules are testable; the script that calls
 * this does nothing but throw on a refusal.
 */

/** Weekdays-after-close means today's or yesterday's data. Four days absorbs a long weekend plus a holiday. */
export const MAX_LEDGER_DATA_AGE_DAYS = 4;

export type LedgerGuard =
  | { ok: true; kind: "appended" | "replaced" }
  | { ok: false; reason: string };

export function guardEntry(
  ledger: Ledger,
  entry: LedgerEntry,
  asOfMs: number,
  nowMs: number
): LedgerGuard {
  const previous = ledger.entries.at(-1)?.date ?? null;

  if (previous !== null && entry.date < previous) {
    return {
      ok: false,
      reason:
        `refusing to record ${entry.date}: the ledger already holds ${previous}, so the snapshot went BACKWARDS. ` +
        `The ingest served older bars than the ones already recorded, and appending would corrupt every duration ` +
        `count derived from this file. Fix the ingest; do not rerun.`,
    };
  }

  const ageDays = Math.floor((nowMs - asOfMs) / 86_400_000);
  if (ageDays > MAX_LEDGER_DATA_AGE_DAYS) {
    return {
      ok: false,
      reason:
        `refusing to record ${entry.date}: that snapshot is ${ageDays} days old and the limit is ` +
        `${MAX_LEDGER_DATA_AGE_DAYS}. The pipeline rebuilt its outputs from bars that never advanced, so every ` +
        `"since when" answer built on this file would be wrong.`,
    };
  }

  return { ok: true, kind: previous !== null && ledger.entries.some((e) => e.date === entry.date) ? "replaced" : "appended" };
}
