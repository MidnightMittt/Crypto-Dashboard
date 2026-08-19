/**
 * THE POINT-IN-TIME UNIVERSE — the only survivorship fix available here.
 *
 * Every cross-sectional claim on this site ranks names against each other,
 * and every one of them is measured on TODAY'S instrument list. Names that
 * failed and delisted were never added, so a "buy the top decile" result is
 * flattered by a universe assembled with hindsight. The validation page says
 * so out loud, which is more than most publish, but saying it does not fix it.
 *
 * It cannot be fixed backwards. There is no archive of what this panel
 * contained on an arbitrary past date, and reconstructing one would mean
 * deciding today which names "would have" been in it — which is the bias
 * itself, wearing a lab coat.
 *
 * It fixes itself FORWARD, for free. One row a day naming who was actually
 * ranked, and in a year the file IS a point-in-time universe: `snapshotAsOf`
 * then answers "who was in the panel on 2027-03-14" from a record written on
 * 2027-03-14, with no hindsight available to it. Every cross-sectional result
 * computed against that answer is survivorship-free by construction.
 *
 * Nothing else available to this project achieves that, it costs almost
 * nothing, and every day it does not run is a day that cannot be recovered.
 *
 * ── Write a row even when nothing changed ─────────────────────────────
 *
 * The list is identical on most days, so an append-on-change store would be
 * smaller. It would also make "no row" ambiguous between "the panel was the
 * same" and "the job did not run" — and this file's whole value is being
 * trustworthy about the past. A visible gap beats an invisible one, which is
 * the same reason the daily job commits its heartbeat on every run.
 */

/** Why a declared member did not make it into the ranking on a given day. */
export type UniverseExclusionReason =
  /** A bar series with an implausible move — an unadjusted split or a bad print. */
  | "corrupt_bars"
  /** Stopped updating; would contribute a stale return to a current ranking. */
  | "stale_series"
  /** Not enough history to compute the signal's lookback. */
  | "short_history"
  /** Declared in the panel but absent from the ingest directory entirely. */
  | "missing_from_ingest";

export interface UniverseExclusion {
  symbol: string;
  reason: UniverseExclusionReason;
}

export interface UniverseSnapshot {
  /** The SESSION described, not the day the row was written. */
  date: string;
  /**
   * Which declared composition this is. Recorded per row so that a future
   * versioned panel appears as a different name rather than silently
   * replacing the meaning of past rows.
   */
  panel: string;
  /** The declared membership on that date — the claim. */
  declared: string[];
  /** Who was actually ranked — the claim, minus what the data refused. */
  ranked: string[];
  /** The difference between those two, with a reason each. */
  excluded: UniverseExclusion[];
}

export interface UniverseHistory {
  version: 1;
  generatedAt: number;
  snapshots: UniverseSnapshot[];
}

export const EMPTY_UNIVERSE_HISTORY: UniverseHistory = {
  version: 1,
  generatedAt: 0,
  snapshots: [],
};

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/**
 * Build a row. Sorts both lists so a day-to-day diff shows real membership
 * change rather than the order the loader happened to walk a directory in.
 */
export function snapshot(input: {
  date: string;
  panel: string;
  declared: readonly string[];
  ranked: readonly string[];
  excluded: readonly UniverseExclusion[];
}): UniverseSnapshot {
  return {
    date: input.date,
    panel: input.panel,
    declared: sorted(input.declared),
    ranked: sorted(input.ranked),
    excluded: [...input.excluded].sort((a, b) => a.symbol.localeCompare(b.symbol)),
  };
}

/**
 * Add rows, replacing any already held for the same date and panel.
 *
 * Idempotent for the same reason appendPoints is: a re-run of the daily job
 * must land on the same row rather than growing the file. Two DIFFERENT
 * panels on one date are two rows, not a collision — that is what makes a
 * versioned second composition possible without disturbing the first.
 */
export function appendSnapshots(
  existing: readonly UniverseSnapshot[],
  fresh: readonly UniverseSnapshot[]
): UniverseSnapshot[] {
  const keyOf = (s: UniverseSnapshot) => `${s.date}|${s.panel}`;
  const byKey = new Map(existing.map((s) => [keyOf(s), s]));
  for (const s of fresh) byKey.set(keyOf(s), s);
  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.panel.localeCompare(b.panel)
  );
}

/**
 * THE POINT OF THE FILE: who was in the panel on a given date.
 *
 * Returns the latest row at or BEFORE the date, so a research run replaying
 * 2027-03-14 sees the membership recorded on or before 2027-03-14 and cannot
 * see a name added afterwards. Returns null before the record begins, which
 * callers must treat as "unknown" — the honest answer for any date preceding
 * the first snapshot, and never today's list as a stand-in, since substituting
 * it would reintroduce exactly the bias this exists to remove.
 */
export function snapshotAsOf(
  history: readonly UniverseSnapshot[],
  date: string,
  panel: string
): UniverseSnapshot | null {
  let best: UniverseSnapshot | null = null;
  for (const s of history) {
    if (s.panel !== panel) continue;
    if (s.date > date) continue;
    if (best === null || s.date > best.date) best = s;
  }
  return best;
}

export interface MembershipChange {
  addedToPanel: string[];
  removedFromPanel: string[];
  /** Ranked one day and not the next — usually a data refusal, not a delisting. */
  droppedFromRanking: string[];
  returnedToRanking: string[];
}

/**
 * What changed between two rows.
 *
 * Panel change and ranking change are reported separately because they mean
 * different things: a name leaving `declared` is a decision someone made,
 * while a name leaving `ranked` while staying declared is the data refusing
 * it that day. Collapsing them would make a one-day bad print look like a
 * change to the reference set.
 */
export function membershipChange(
  prev: UniverseSnapshot,
  next: UniverseSnapshot
): MembershipChange {
  const missing = (a: readonly string[], b: readonly string[]): string[] => {
    const has = new Set(b);
    return a.filter((s) => !has.has(s));
  };
  return {
    addedToPanel: missing(next.declared, prev.declared),
    removedFromPanel: missing(prev.declared, next.declared),
    droppedFromRanking: missing(prev.ranked, next.ranked),
    returnedToRanking: missing(next.ranked, prev.ranked),
  };
}
