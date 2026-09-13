import { basketsOf } from "../markets/baskets";

/**
 * THE LIVE RUNG — and the reason it is still empty.
 *
 * `~/trading/roundtrips.jsonl` is real. Fifty-nine closed round trips, real
 * money, emitted by the trading session. It is the only record on this site of
 * a price anybody actually got. The obvious thing to do with it is join it to
 * the register and finally fill rung 3.
 *
 * It cannot be done, and the interesting part is WHY — because the reason is
 * not "not enough data yet".
 *
 * ── The join has no key ───────────────────────────────────────────────
 *
 * Schema `roundtrip/1.1` has no field naming a declared strategy. Not a
 * `strategy_id`, not a `leg`, nothing. `rules_at_entry` is the nearest thing
 * and it is null on all 59 with the producer's own note: "not recorded at
 * entry; this trade predates the round-trip log". So there is no key to join
 * on, and no amount of further trading fixes a missing column.
 *
 * ── The tempting number ───────────────────────────────────────────────
 *
 * Twenty-nine of the 59 trips are in names a declared basket holds — RIOT,
 * CLSK, MARA, CIFR, HUT, BTDR in `miners`, APLD, IREN, CORZ in `datacenter`.
 * That number is computed here on purpose. Left uncomputed it is the number a
 * future reader derives themselves and quietly treats as the join, and it is
 * not one: the declared strategy buys the WHOLE basket at the close and sells
 * it at the next open. A discretionary long in RIOT held for an unknown span
 * is a different position that happens to share a ticker. Holding a name a
 * strategy also holds is not executing the strategy.
 *
 * ── Every blocker here is MEASURED, not asserted ──────────────────────
 *
 * This matters more than the specific findings. A refusal written as prose has
 * to be revisited by hand when the data improves, and in practice it never is
 * — it just goes stale and keeps saying no. Every blocker below is a predicate
 * over the rows, so the day the trading session emits better rows the count
 * falls to zero and the page changes without anyone editing a sentence.
 *
 * The sharpest one is `exit.ts`. It looks like a fill time. It is not: no
 * timezone offset in the 24 puts these stamps in market hours (best is 39%,
 * and 27% of the clock IS market hours). A genuine fill series would sit above
 * 90% under the right offset. So this is not "we could not confirm they are
 * fill times" — it is a rejection with an enormous margin, and it means every
 * fill here is unpriceable against a reference. That kills execution-quality
 * measurement too, which was the other thing this log looked like it could do.
 *
 * @see PaperDeclaration in ../research/paperEngine — the other half of the join
 */

/** Regular trading hours, in minutes from local midnight. */
const RTH_OPEN_MIN = 9 * 60 + 30;
const RTH_CLOSE_MIN = 16 * 60;

/** Share of the 24-hour clock that is RTH. A stamp landing here by chance. */
export const RTH_SHARE_OF_CLOCK = (RTH_CLOSE_MIN - RTH_OPEN_MIN) / (24 * 60);

/**
 * How much of a timestamp series must fall in RTH before we will treat it as
 * fill times. Deliberately far above chance and a little below 1: real fills
 * include the occasional pre- and post-market print, but not 61% of them.
 */
export const FILL_TIME_RTH_THRESHOLD = 0.9;

export interface RawRoundTrip {
  schema: string;
  id: string;
  symbol: string;
  instrument: "equity" | "option" | string;
  qty: number;
  multiplier: number;
  entry: { price: number | null; price_source: string; ts: string | null; ts_source: string };
  exit: { price: number | null; ts: string | null; venue: string | null; order_id: string | null };
  realized_usd: number;
  hold_sessions: number | null;
  rules_at_entry: Record<string, unknown> | null;
  levels_armed_at_entry: unknown;
  side: string;
  /** Absent in 1.1. The join key, when it exists. @see JOIN_CONTRACT */
  strategy_id?: string | null;
}

/**
 * One reason the log cannot answer a question, with the count that earned it.
 *
 * `blocks` names the question specifically rather than saying "unusable". Two
 * of these blockers kill the register join and a different two kill execution
 * measurement, and a reader who cannot tell them apart will assume fixing one
 * fixes both.
 */
export interface Blocker {
  id: string;
  /** Rows failing the predicate. */
  count: number;
  /** Rows the predicate was evaluated over. */
  of: number;
  /** The question this closes off. */
  blocks: "register-join" | "execution-quality" | "any-aggregate";
  /** Stated so a reader can check the predicate rather than trust the count. */
  detail: string;
}

/**
 * Can `exit.ts` be a fill timestamp under ANY fixed timezone offset?
 *
 * Scanning all 24 rather than assuming UTC, because the producer's convention
 * is not documented anywhere and guessing it wrong is the exact failure this
 * codebase has hit before. The answer is reported as a fraction against the
 * chance baseline so the margin is visible, not just the verdict.
 */
export interface FillTimeScan {
  bestOffsetHours: number;
  bestRthFraction: number;
  /** What a series of stamps scattered around the clock would score. */
  chanceFraction: number;
  /** What a genuine fill series would have to clear. */
  threshold: number;
  credible: boolean;
  n: number;
}

export function scanFillTimes(stamps: readonly string[]): FillTimeScan {
  const minutes: number[] = [];
  for (const s of stamps) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) continue;
    const d = new Date(t);
    minutes.push(d.getUTCHours() * 60 + d.getUTCMinutes());
  }

  let bestOffsetHours = 0;
  let bestCount = -1;
  for (let off = -12; off <= 12; off++) {
    let hits = 0;
    for (const m of minutes) {
      const local = (((m + off * 60) % 1440) + 1440) % 1440;
      if (local >= RTH_OPEN_MIN && local <= RTH_CLOSE_MIN) hits++;
    }
    if (hits > bestCount) {
      bestCount = hits;
      bestOffsetHours = off;
    }
  }

  const n = minutes.length;
  const bestRthFraction = n === 0 ? 0 : bestCount / n;
  return {
    bestOffsetHours,
    bestRthFraction,
    chanceFraction: RTH_SHARE_OF_CLOCK,
    threshold: FILL_TIME_RTH_THRESHOLD,
    credible: n > 0 && bestRthFraction >= FILL_TIME_RTH_THRESHOLD,
    n,
  };
}

/**
 * WHAT A TRIP MUST CARRY TO TEST ANYTHING — the v1.2 ask, as code.
 *
 * Written here rather than in a brief so the producer has something to emit
 * against and this side has something to validate with. Each entry says what
 * question the field unlocks, because a field list without that reads as
 * bureaucracy and gets partially implemented.
 */
export const JOIN_CONTRACT: readonly { field: string; unlocks: string; why: string }[] = [
  {
    field: "strategy_id",
    unlocks: "register-join",
    why:
      "The declared strategy this fill was executing, matching a PaperDeclaration.id, " +
      "or an explicit null meaning discretionary. Null is a real answer and must be " +
      "recorded as one — an absent field and a discretionary trade are different facts.",
  },
  {
    field: "entry.ts / exit.ts as fill times",
    unlocks: "execution-quality",
    why:
      "The instant the fill printed, in a stated timezone. Today's stamps fail the RTH " +
      "scan, so no reference price can be paired to them and slippage is unmeasurable.",
  },
  {
    field: "entry.price observed",
    unlocks: "execution-quality",
    why:
      "All 59 entries are derived_from_realized_gain — an arithmetic identity from the " +
      "exit price and the realised P&L. It carries no information the exit does not " +
      "already carry, so entry slippage cannot be computed from it even in principle.",
  },
  {
    field: "reference_price + reference_source",
    unlocks: "execution-quality",
    why:
      "The price the paper book assumed for this leg, captured at decision time. " +
      "Reconstructing it later from bars re-prices the decision with hindsight.",
  },
  {
    field: "open positions emitted, not only closes",
    unlocks: "any-aggregate",
    why:
      "The log holds closed trips only. Losers get held and winners get taken, so any " +
      "mean over closes is conditioned on having closed. Same shape as the resolution " +
      "asymmetry that once published a 100% forward record.",
  },
];

export interface LiveLedger {
  /** Whether the source log was readable in the environment that built this. */
  source: "read" | "unavailable";
  schemas: string[];
  trips: number;
  window: { from: string; to: string } | null;
  /** Trips carrying a key that names a declared strategy. */
  joinable: number;
  /** Trips in a name some declared basket holds. NOT the join. @see header */
  inDeclaredNames: number;
  /** Which baskets those names sit in, with counts. */
  declaredNameBreakdown: { basket: string; trips: number }[];
  blockers: Blocker[];
  fillTimes: FillTimeScan;
  /**
   * Realised dollars over the closed trips. PROVENANCE, NOT EVIDENCE.
   *
   * Present because a reader needs to know the log contains real money rather
   * than a simulation. It is not a track record and the page must not frame it
   * as one: it is conditioned on having closed, which is the `closed-only`
   * blocker, and it answers "did Mitchell make money" — a question this page
   * does not ask. Rung 3 asks whether we can get the price the paper book
   * assumed, and a P&L sum is silent on that.
   */
  realized: { usd: number; wins: number; losses: number; flat: number } | null;
  /** One sentence. The conclusion, computed. */
  statement: string;
}

const EMPTY_SCAN: FillTimeScan = {
  bestOffsetHours: 0,
  bestRthFraction: 0,
  chanceFraction: RTH_SHARE_OF_CLOCK,
  threshold: FILL_TIME_RTH_THRESHOLD,
  credible: false,
  n: 0,
};

/** The ledger for an environment that could not see the log at all. */
export function unavailableLedger(): LiveLedger {
  return {
    source: "unavailable",
    schemas: [],
    trips: 0,
    window: null,
    joinable: 0,
    inDeclaredNames: 0,
    declaredNameBreakdown: [],
    blockers: [],
    fillTimes: EMPTY_SCAN,
    realized: null,
    statement:
      "The round-trip log was not readable from the environment that built this page, " +
      "so this is not a claim that no fills exist — it is a claim that none were seen.",
  };
}

function countingBlocker(
  id: string,
  blocks: Blocker["blocks"],
  detail: string,
  rows: readonly RawRoundTrip[],
  fails: (r: RawRoundTrip) => boolean
): Blocker | null {
  const count = rows.filter(fails).length;
  return count === 0 ? null : { id, count, of: rows.length, blocks, detail };
}

export function buildLiveLedger(rows: readonly RawRoundTrip[]): LiveLedger {
  if (rows.length === 0) {
    return { ...unavailableLedger(), source: "read", statement: "The round-trip log is empty." };
  }

  const exitStamps = rows.map((r) => r.exit.ts).filter((t): t is string => Boolean(t));
  const fillTimes = scanFillTimes(exitStamps);

  const joinable = rows.filter((r) => Boolean(r.strategy_id)).length;

  const basketCounts = new Map<string, number>();
  let inDeclaredNames = 0;
  for (const r of rows) {
    const baskets = basketsOf(r.symbol).filter((b) => b !== "scanned");
    if (baskets.length > 0) inDeclaredNames++;
    for (const b of baskets) basketCounts.set(b, (basketCounts.get(b) ?? 0) + 1);
  }

  const blockers = [
    countingBlocker(
      "no-strategy-id",
      "register-join",
      "No field names the declared strategy this fill was executing, so there is no key " +
        "to join the register on. Not a sample-size problem: more trading does not add a column.",
      rows,
      (r) => !r.strategy_id
    ),
    countingBlocker(
      "entry-price-derived",
      "execution-quality",
      "entry.price is derived_from_realized_gain — recovered arithmetically from the exit " +
        "price and the realised P&L, so it is not an observed fill and carries no independent " +
        "information about what was paid.",
      rows,
      (r) => r.entry.price_source !== "observed"
    ),
    countingBlocker(
      "no-entry-timestamp",
      "execution-quality",
      "entry.ts is absent, so the position's hold span is unknown and no reference price " +
        "can be paired to the entry.",
      rows,
      (r) => !r.entry.ts
    ),
    countingBlocker(
      "hold-unknown",
      "register-join",
      "hold_sessions is null, so a one-session overnight hold cannot be distinguished from " +
        "a multi-week position in the same name — which is the difference between executing " +
        "the declared strategy and merely owning the ticker.",
      rows,
      (r) => r.hold_sessions === null || r.hold_sessions === undefined
    ),
    fillTimes.credible
      ? null
      : {
          id: "exit-timestamp-not-a-fill-time",
          count: exitStamps.length,
          of: rows.length,
          blocks: "execution-quality" as const,
          detail:
            `No timezone offset places these stamps in market hours: the best of the 24 is ` +
            `UTC${fillTimes.bestOffsetHours >= 0 ? "+" : ""}${fillTimes.bestOffsetHours} at ` +
            `${(fillTimes.bestRthFraction * 100).toFixed(0)}%, against ` +
            `${(fillTimes.chanceFraction * 100).toFixed(0)}% for stamps scattered around the ` +
            `clock. A genuine fill series clears ${(fillTimes.threshold * 100).toFixed(0)}%. ` +
            `These are report or settlement times, so no fill here can be differenced against ` +
            `a reference price.`,
        },
    {
      id: "closed-only",
      count: rows.length,
      of: rows.length,
      blocks: "any-aggregate" as const,
      detail:
        "Every row is a CLOSED trip. Open positions are absent, and that is where losers " +
        "sit — a loser is held and a winner is taken. Any mean over this log is conditioned " +
        "on having closed, the same shape as the resolution asymmetry that once published a " +
        "100% forward record.",
    },
  ].filter((b): b is Blocker => b !== null);

  const dates = exitStamps.map((s) => s.slice(0, 10)).sort();
  const wins = rows.filter((r) => r.realized_usd > 0).length;
  const losses = rows.filter((r) => r.realized_usd < 0).length;

  return {
    source: "read",
    schemas: [...new Set(rows.map((r) => r.schema))].sort(),
    trips: rows.length,
    window: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    joinable,
    inDeclaredNames,
    declaredNameBreakdown: [...basketCounts.entries()]
      .map(([basket, trips]) => ({ basket, trips }))
      .sort((a, b) => b.trips - a.trips || a.basket.localeCompare(b.basket)),
    blockers,
    fillTimes,
    realized: {
      usd: Math.round(rows.reduce((s, r) => s + r.realized_usd, 0) * 100) / 100,
      wins,
      losses,
      flat: rows.length - wins - losses,
    },
    statement: statementFor(rows.length, joinable, inDeclaredNames),
  };
}

function statementFor(trips: number, joinable: number, inDeclaredNames: number): string {
  if (joinable > 0) {
    return `${joinable} of ${trips} round trips name the strategy they were executing and can be differenced against its paper price.`;
  }
  return (
    `${trips} round trips are recorded and none of them can test anything on this page. ` +
    `Not one names the strategy it was executing, so there is no key to join the register on` +
    (inDeclaredNames > 0
      ? `; ${inDeclaredNames} are in names a declared basket holds, which is a coincidence of ticker rather than a join.`
      : ".")
  );
}
