import fs from "fs";
import path from "path";
import { kvGet, kvSet, kvConfigured } from "../store/kv";
import { PaperPosition, RiskConfig, DEFAULT_RISK_CONFIG, SetupState } from "./types";

/**
 * PAPER-TRADING PERSISTENCE.
 *
 * ── WHY THERE IS A FILE FALLBACK ────────────────────────────────────────
 *
 * `store/kv.ts` is the existing persistence layer and is used first. But it
 * requires Upstash credentials, and when they are absent `kvGet` returns null
 * and `kvSet` SILENTLY NO-OPS — correct behaviour for a cache, fatal for a
 * position ledger. A paper position that vanishes on restart is not a paper
 * position, it is a guess.
 *
 * So: KV when configured, a local JSON file when not. Same interface either
 * way, so nothing upstream knows or cares which is active.
 *
 * ── IDEMPOTENCE IS THE WHOLE JOB ────────────────────────────────────────
 *
 * Every mutation here is keyed by an id and is safe to repeat. The scanner
 * runs on a schedule and the UI polls; both will replay the same event. A
 * ledger that double-books a partial exit because two requests arrived at
 * once produces a P&L nobody can reconcile.
 */

const KEY = "swing:state:v1";
const FILE = path.join(process.cwd(), ".swing-state.json");

export interface SwingState {
  positions: PaperPosition[];
  /** Opportunity ids the user has chosen to keep an eye on. */
  watchlist: string[];
  /** Last seen lifecycle state per opportunity id — the basis for firing alerts on TRANSITIONS only. */
  lastStates: Record<string, SetupState>;
  config: RiskConfig;
  /** Append-only notification log, newest first, capped. */
  notifications: Array<{ t: number; message: string; opportunityId?: string }>;
  updatedAt: number;
}

export const EMPTY_STATE: SwingState = {
  positions: [],
  watchlist: [],
  lastStates: {},
  config: DEFAULT_RISK_CONFIG,
  notifications: [],
  updatedAt: 0,
};

function readFile(): SwingState | null {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as SwingState;
  } catch (err) {
    console.warn("[swing-store] local file unreadable:", err);
    return null;
  }
}

function writeFile(state: SwingState): void {
  try {
    // Write-then-rename so a crash mid-write cannot leave a truncated ledger.
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn("[swing-store] local file write failed:", err);
  }
}

/**
 * THE FILE FALLBACK DOES NOT WORK ON SERVERLESS.
 *
 * Vercel's filesystem is ephemeral — anything written during one invocation is
 * gone by the next. Locally the file IS the ledger; on Vercel it is a scratch
 * pad that forgets. So a KV-less serverless deploy would silently lose every
 * paper position, which is worse than refusing to run.
 *
 * Warned loudly rather than failed, because the READ path still works for the
 * scanner and the dashboard is still useful read-only. `persistenceHealthy()`
 * lets callers surface it instead of discovering it when a position vanishes.
 */
function onServerless(): boolean {
  return !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
}

export function persistenceHealthy(): boolean {
  return kvConfigured() || !onServerless();
}

let warned = false;

export async function loadState(): Promise<SwingState> {
  if (!persistenceHealthy() && !warned) {
    warned = true;
    console.error(
      "[swing-store] RUNNING ON SERVERLESS WITHOUT KV. The local-file fallback " +
        "cannot persist here — the filesystem is ephemeral, so paper positions " +
        "WILL be lost between requests. Configure KV_REST_API_URL and " +
        "KV_REST_API_TOKEN (or the UPSTASH_* equivalents)."
    );
  }
  /*
   * CONFIG IS MERGED FIELD-BY-FIELD, NOT REPLACED.
   *
   * A top-level spread swaps the whole config object, so any setting added
   * AFTER a state was written comes back undefined forever. Seen immediately:
   * `autoPaper` read as undefined against stored config that predated it.
   * Harmless there because undefined is falsy, but the next flag might
   * default to ON and silently read as off — or worse, the reverse.
   */
  const hydrate = (s: SwingState): SwingState => ({
    ...EMPTY_STATE,
    ...s,
    config: { ...DEFAULT_RISK_CONFIG, ...(s.config ?? {}) },
  });

  if (kvConfigured()) {
    const s = await kvGet<SwingState>(KEY);
    if (s) return hydrate(s);
  }
  const local = readFile();
  return local ? hydrate(local) : { ...EMPTY_STATE };
}

export async function saveState(state: SwingState): Promise<void> {
  const next = { ...state, updatedAt: Date.now() };
  if (kvConfigured()) await kvSet(KEY, next);
  // ALWAYS write the file too. If KV is later configured mid-life, the local
  // ledger is still the record of what happened before it was.
  writeFile(next);
}

/** Where state is actually being persisted, for the UI to display honestly. */
export function storeBackend(): "kv" | "file" {
  return kvConfigured() ? "kv" : "file";
}

// ── IDEMPOTENT MUTATIONS ─────────────────────────────────────────────────

/**
 * Open a position, unless one already exists for this opportunity.
 *
 * Returns the state unchanged when a live position for the same opportunity
 * is already present. This is the guard against "the same opportunity cannot
 * accidentally open twice": the scanner may report ENTRY_CONFIRMED on several
 * consecutive polls, and each poll must not mint a trade.
 */
export function addPosition(state: SwingState, position: PaperPosition): { state: SwingState; added: boolean } {
  const live = state.positions.some(
    (p) => p.opportunityId === position.opportunityId && (p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED")
  );
  if (live) return { state, added: false };
  if (state.positions.some((p) => p.id === position.id)) return { state, added: false };
  return { state: { ...state, positions: [...state.positions, position] }, added: true };
}

/**
 * Replace a position by id.
 *
 * Fills are compared by (reason, t) before being accepted, so replaying the
 * same bar cannot append a duplicate TP1. Without this, two concurrent
 * requests stepping the same bar would book the partial exit twice and halve
 * the position on a single touch.
 */
export function updatePosition(state: SwingState, next: PaperPosition): SwingState {
  return {
    ...state,
    positions: state.positions.map((p) => {
      if (p.id !== next.id) return p;
      const seen = new Set(p.fills.map((f) => `${f.reason}@${f.t}`));
      const merged = [...p.fills];
      for (const f of next.fills) {
        const k = `${f.reason}@${f.t}`;
        if (!seen.has(k)) { merged.push(f); seen.add(k); }
      }
      return { ...next, fills: merged };
    }),
  };
}

export function toggleWatch(state: SwingState, opportunityId: string): SwingState {
  const on = state.watchlist.includes(opportunityId);
  return {
    ...state,
    watchlist: on ? state.watchlist.filter((w) => w !== opportunityId) : [...state.watchlist, opportunityId],
  };
}

const MAX_NOTIFICATIONS = 200;

/**
 * Record a notification only when the lifecycle state actually changed.
 *
 * This is where "alerts are event-based, not repeated every scan" is
 * enforced. The previous state is held per opportunity id, so a setup sitting
 * in WATCHING for a week produces one notification rather than one per poll.
 */
export function noteTransition(
  state: SwingState,
  opportunityId: string,
  next: SetupState,
  message: string | null
): { state: SwingState; fired: boolean } {
  if (state.lastStates[opportunityId] === next || !message) {
    return { state: { ...state, lastStates: { ...state.lastStates, [opportunityId]: next } }, fired: false };
  }
  return {
    state: {
      ...state,
      lastStates: { ...state.lastStates, [opportunityId]: next },
      notifications: [{ t: Date.now(), message, opportunityId }, ...state.notifications].slice(0, MAX_NOTIFICATIONS),
    },
    fired: true,
  };
}
