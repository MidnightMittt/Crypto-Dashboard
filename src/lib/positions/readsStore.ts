import fs from "fs";
import path from "path";
import { PositionRead } from "./lpHealth";

/**
 * THE READS STORE — append-only JSONL, one row per position per cron tick.
 *
 * Same pattern and same reason as the LP fee series: a read not persisted is
 * gone (neither RPC retains old state), and the two-consecutive-reads rule
 * cannot be evaluated without the previous read surviving somewhere. Rows are
 * only ever appended; a correction is a new row.
 */

const STORE = path.join(process.cwd(), "src", "data", "positionReads.jsonl");

export function loadReads(): PositionRead[] {
  if (!fs.existsSync(STORE)) return [];
  return fs
    .readFileSync(STORE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PositionRead);
}

export function readsById(all: readonly PositionRead[]): Map<string, PositionRead[]> {
  const m = new Map<string, PositionRead[]>();
  for (const r of all) {
    const list = m.get(r.id) ?? [];
    list.push(r);
    m.set(r.id, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.ts.localeCompare(b.ts));
  return m;
}

export function appendReads(rows: readonly PositionRead[]): void {
  if (!rows.length) return;
  fs.appendFileSync(STORE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export const READS_STORE_PATH = STORE;
