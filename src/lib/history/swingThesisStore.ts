import fs from "fs/promises";
import path from "path";
import { AssetSymbol } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "../store/kv";
import { SwingThesisStore, emptySwingStore } from "@/lib/signals/swingThesis";

/**
 * Persistence for the swing-thesis state machine.
 *
 * Follows the same contract as `dailyStore.ts` — KV when configured,
 * `.data/` JSON otherwise, never throws — but with one important difference
 * in how absence is reported.
 *
 * Every other store here is additive: a missing read costs you some history
 * and nothing else. This one is LOAD-BEARING. The action shown on the
 * dashboard depends on it, so "there is no active thesis" and "we could not
 * find out whether there is one" are completely different answers and must
 * not collapse into the same empty store. Reads therefore return an
 * `available` flag, and the UI is expected to say so out loud rather than
 * quietly falling back to the stateless read and implying a plan was
 * evaluated when it wasn't.
 *
 * No TTL: this is storage, not cache. A swing thesis is supposed to outlive
 * days of polling.
 */

const DATA_DIR = path.join(process.cwd(), ".data");

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}-swing-thesis.json`);
}

function kvKey(asset: AssetSymbol | "MARKET"): string {
  return `swing-thesis:${asset}`;
}

export interface SwingThesisRead {
  store: SwingThesisStore;
  /**
   * False when the backing store could not be consulted at all. An empty
   * store with `available: true` genuinely means "no thesis yet".
   */
  available: boolean;
}

/** Cheap shape check — a malformed or half-written record should degrade to "unavailable", never crash a request or half-apply. */
function isSwingStore(value: unknown): value is SwingThesisStore {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SwingThesisStore>;
  return typeof v.nextVersion === "number" && typeof v.lastCloseAt === "number" && Array.isArray(v.events);
}

export async function readSwingThesis(asset: AssetSymbol | "MARKET"): Promise<SwingThesisRead> {
  if (kvConfigured()) {
    const stored = await kvGet<SwingThesisStore>(kvKey(asset));
    // `kvGet` swallows its own errors and returns null, so a null here is
    // ambiguous between "empty" and "failed". Treating it as an empty but
    // AVAILABLE store is the right call: KV being configured and returning
    // nothing is overwhelmingly the first-run case, and refusing to ever
    // start a thesis would be the worse failure.
    if (stored === null) return { store: emptySwingStore(), available: true };
    return isSwingStore(stored)
      ? { store: stored, available: true }
      : { store: emptySwingStore(), available: false };
  }

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(fileFor(asset), "utf8"));
    return isSwingStore(parsed) ? { store: parsed, available: true } : { store: emptySwingStore(), available: false };
  } catch (err) {
    // A genuinely absent file is the first run, not a failure.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { store: emptySwingStore(), available: true };
    }
    return { store: emptySwingStore(), available: false };
  }
}

/**
 * Persists the state. Returns whether the write landed, so a caller can tell
 * the difference between a thesis that advanced and one that only appeared
 * to.
 *
 * No locking, by design: `applyDailyClose` is idempotent per close
 * timestamp, so two concurrent requests folding in the same close compute
 * the identical store and last-writer-wins is harmless.
 */
export async function writeSwingThesis(
  asset: AssetSymbol | "MARKET",
  store: SwingThesisStore
): Promise<boolean> {
  if (kvConfigured()) {
    await kvSet(kvKey(asset), store);
    return true;
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(fileFor(asset), JSON.stringify(store), "utf8");
    return true;
  } catch (err) {
    console.warn(`[swingThesis] could not persist ${asset}:`, err);
    return false;
  }
}
