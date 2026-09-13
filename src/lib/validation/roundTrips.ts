import { basketsOf } from "../markets/baskets";

/**
 * THE LIVE RUNG — and the reason it is still empty.
 *
 * `~/trading/roundtrips.jsonl` is real. Sixty closed round trips, real money,
 * emitted by the trading session. It is the only record on this site of a
 * price anybody actually got. The obvious thing to do with it is join it to
 * the register and finally fill rung 3.
 *
 * It cannot be done, and the interesting part is WHY — because the reason is
 * not "not enough data yet".
 *
 * ── The join has a key now, and it still does not join ────────────────
 *
 * Schema `roundtrip/1.1` had no field naming a declared strategy at all.
 * `roundtrip/1.2` added one — as `method.method_id`, nested, rather than the
 * top-level `strategy_id` this contract asked for. The reader below accepts
 * BOTH, because arguing about the spelling of a field would be a worse use of
 * the channel than reading what was actually emitted; `JOIN_CONTRACT` now
 * names the shape that exists.
 *
 * What 1.2 also added is `method.source`, and it is more useful than the
 * contract knew to ask for. A label carrying `declared_at_entry` was written
 * down before the outcome was known. A label carrying `backfill` was applied
 * afterwards by someone who already knew how the trade went, which is a
 * different fact wearing the same field, and it must not join.
 *
 * ── Three ways a labelled trip still fails to join ────────────────────
 *
 * Each is a predicate below, and each has a different fix:
 *
 *  1. The label is the `unlabelled-pre-log` sentinel — honest, and not a key.
 *  2. The label was backfilled — hindsight, not a pre-commitment.
 *  3. The label names a method, but the ENTRY PREDATES that method's own
 *     declaration on this site. This is the one that catches the CLSK trip:
 *     it is labelled `ivrv-option-screen` and `declared_at_entry`, entered
 *     2026-09-02, and the screen was declared here on 2026-09-13. The trade
 *     is what motivated the declaration, so counting it as evidence for the
 *     declaration is the in-sample loop the paper book already refuses.
 *
 * So a v1.2 log with one perfectly-formed label still joins zero trips, and
 * the reason is not a missing column. Stating it that way matters: the fix
 * for (3) is not a schema change, it is trading the declared method from here
 * on and letting the record accumulate forward.
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

/**
 * The producer's own sentinel for "no method was recorded at entry".
 *
 * Read as an explicit absence rather than as a key, and matched literally: a
 * method that quietly renamed this string would start joining 59 backfilled
 * trips to a strategy nobody executed, which is exactly the failure the
 * sentinel exists to prevent.
 */
export const UNLABELLED_METHOD = "unlabelled-pre-log";

/** The `method` block schema 1.2 added. @see JOIN_CONTRACT */
export interface RoundTripMethod {
  method_id?: string | null;
  method_fingerprint?: string | null;
  /** `declared_at_entry` is a pre-commitment; `backfill` is hindsight. */
  source?: "declared_at_entry" | "backfill" | string | null;
}

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
  /** Schema 1.2's join key, and where the label actually lives. */
  method?: RoundTripMethod | null;
  /**
   * The 1.1-era spelling this contract originally asked for. Never emitted,
   * still read: a producer that adopts the flat field later should not have
   * to coordinate a reader change on the same day.
   */
  strategy_id?: string | null;
}

/**
 * A method this site has declared, and the date it declared it.
 *
 * Passed in rather than imported here so the register stays one list assembled
 * in one place. `declaredOn` is not decoration — it is what separates a trip
 * that tested a commitment from a trip that inspired one.
 */
export interface DeclaredMethod {
  id: string;
  declaredOn: string;
  /**
   * Whether the method has a nightly paper line to difference a fill against.
   * The IV/RV screen is declared and has no paper price, so a fill under it
   * can be attributed but not yet priced.
   */
  hasPaperPrice: boolean;
}

/** Why a trip does or does not join the register. One per trip. */
export type LabelStatus =
  | "joins"
  | "unlabelled"
  | "backfilled"
  | "method-not-declared"
  | "predates-declaration";

/** The label on a trip, from whichever field carries it. */
export function methodLabelOf(r: RawRoundTrip): { id: string | null; source: string | null } {
  const raw = r.method?.method_id ?? r.strategy_id ?? null;
  const id = raw && raw !== UNLABELLED_METHOD ? raw : null;
  return { id, source: r.method?.source ?? (r.strategy_id ? "declared_at_entry" : null) };
}

/**
 * Classify one trip against the register.
 *
 * Order matters and is the order a reader would ask the questions in: is
 * there a label, was it a pre-commitment, do we know the method, and did the
 * method exist before the trade. Reporting only the first failure per trip
 * keeps the counts a partition — every trip lands in exactly one bucket, so
 * the buckets sum to the trip count and cannot double-count a trip that fails
 * two ways.
 */
export function labelStatusOf(r: RawRoundTrip, declared: readonly DeclaredMethod[]): LabelStatus {
  const { id, source } = methodLabelOf(r);
  if (id === null) return "unlabelled";
  if (source !== "declared_at_entry") return "backfilled";
  const method = declared.find((d) => d.id === id);
  if (!method) return "method-not-declared";
  /*
   * Compared on the entry stamp, not the exit: a position opened before the
   * method was declared was not selected by it, however it was closed. With
   * no entry stamp the trip cannot be placed either side of the line, and an
   * undatable label is treated as failing rather than passing.
   */
  const entryDay = r.entry.ts?.slice(0, 10) ?? null;
  if (entryDay === null || entryDay < method.declaredOn) return "predates-declaration";
  return "joins";
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
    field: "method.method_id + method.source",
    unlocks: "register-join",
    why:
      "DELIVERED in roundtrip/1.2, and read as emitted rather than renamed to the " +
      "strategy_id this contract first asked for. The id names the declared method, or " +
      "the unlabelled-pre-log sentinel, which is a real answer and not an absence. " +
      "method.source is the half that was not asked for and matters more: only " +
      "declared_at_entry is a pre-commitment, and a backfilled label is hindsight " +
      "wearing the same field.",
  },
  {
    field: "a declaration on this site that predates the entry",
    unlocks: "register-join",
    why:
      "Not a field the producer can emit — the missing half is here. A trip labelled " +
      "with a method declared AFTER the trade was taken is the trade that motivated the " +
      "declaration, and scoring it as evidence for that declaration is the in-sample " +
      "loop the paper book already refuses. Fixed by trading the declared method " +
      "forward, not by a schema change.",
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
      "Almost every entry is derived_from_realized_gain — an arithmetic identity from the " +
      "exit price and the realised P&L. It carries no information the exit does not " +
      "already carry, so entry slippage cannot be computed from it even in principle. The " +
      "exact count is the entry-price-derived blocker above; it is not repeated here, " +
      "because a number written into prose stops being recomputed and starts being wrong.",
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
  /**
   * Every trip placed in exactly one bucket, so the buckets sum to `trips`.
   *
   * Carried instead of a single joinable count because the four ways of
   * failing have four different fixes, and a reader seeing only "0 joinable"
   * will assume the first one — a missing column — which stopped being true
   * at schema 1.2.
   */
  labelBreakdown: { status: LabelStatus; trips: number }[];
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
    labelBreakdown: [],
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

/**
 * Price sources that mean a price was SEEN rather than reconstructed.
 *
 * A set rather than an equality test because 1.2 emits `fill` and
 * `weighted_avg_of_three_fills`, both of which are observations, and the
 * original `!== "observed"` predicate counted them as derived. That over-count
 * is the quiet kind: it makes the log look worse than it is and would have
 * kept the entry-price blocker standing on the first trip that finally cleared
 * it. Anything not on this list is treated as unobserved, so a new source has
 * to be admitted deliberately.
 */
const OBSERVED_PRICE_SOURCES = new Set([
  "observed",
  "fill",
  "weighted_avg_of_three_fills",
  "weighted_avg_of_fills",
]);

const LABEL_ORDER: LabelStatus[] = [
  "joins",
  "unlabelled",
  "backfilled",
  "method-not-declared",
  "predates-declaration",
];

export function buildLiveLedger(
  rows: readonly RawRoundTrip[],
  declared: readonly DeclaredMethod[]
): LiveLedger {
  if (rows.length === 0) {
    return { ...unavailableLedger(), source: "read", statement: "The round-trip log is empty." };
  }

  const exitStamps = rows.map((r) => r.exit.ts).filter((t): t is string => Boolean(t));
  const fillTimes = scanFillTimes(exitStamps);

  const status = new Map<RawRoundTrip, LabelStatus>(
    rows.map((r) => [r, labelStatusOf(r, declared)])
  );
  const withStatus = (s: LabelStatus) => rows.filter((r) => status.get(r) === s);
  const joinable = withStatus("joins").length;
  const labelBreakdown = LABEL_ORDER.map((s) => ({ status: s, trips: withStatus(s).length })).filter(
    (b) => b.trips > 0
  );

  const basketCounts = new Map<string, number>();
  let inDeclaredNames = 0;
  for (const r of rows) {
    const baskets = basketsOf(r.symbol).filter((b) => b !== "scanned");
    if (baskets.length > 0) inDeclaredNames++;
    for (const b of baskets) basketCounts.set(b, (basketCounts.get(b) ?? 0) + 1);
  }

  const blockers = [
    countingBlocker(
      "no-method-id",
      "register-join",
      `No method is named on the trip — either the field is absent, or it carries the ` +
        `producer's ${UNLABELLED_METHOD} sentinel, which is an honest record of a trade ` +
        `entered before any method was declared. Not a sample-size problem and no longer a ` +
        `schema problem: 1.2 has the column, these rows predate it.`,
      rows,
      (r) => status.get(r) === "unlabelled"
    ),
    countingBlocker(
      "label-backfilled",
      "register-join",
      "The method label was applied after the fact rather than recorded at entry, so it " +
        "was written by someone who already knew how the trade went. A backfilled label " +
        "is a description of a trade, not a commitment it was held to.",
      rows,
      (r) => status.get(r) === "backfilled"
    ),
    countingBlocker(
      "method-not-declared",
      "register-join",
      "The trip names a method this site has never declared, so there is nothing to " +
        "difference it against. A label pointing at no declaration is weaker than no " +
        "label, because it reads as a join to anyone counting labelled rows.",
      rows,
      (r) => status.get(r) === "method-not-declared"
    ),
    countingBlocker(
      "label-predates-declaration",
      "register-join",
      "The trip names a declared method but was ENTERED before that method was declared " +
        "here, so it is the trade that motivated the declaration rather than a test of " +
        "it. Counting it would be the same in-sample loop the paper book refuses when a " +
        "line's sessions all precede its own declaration. No schema change fixes this — " +
        "only trading the declared method forward does.",
      rows,
      (r) => status.get(r) === "predates-declaration"
    ),
    countingBlocker(
      "joined-method-has-no-paper-price",
      "register-join",
      "The trip joins a declared method that has no nightly paper line, so the fill can " +
        "be attributed but not yet differenced against the price the method assumed. " +
        "Attribution without a reference answers who, not how well.",
      rows,
      (r) => {
        if (status.get(r) !== "joins") return false;
        const id = methodLabelOf(r).id;
        return declared.find((d) => d.id === id)?.hasPaperPrice === false;
      }
    ),
    countingBlocker(
      "entry-price-derived",
      "execution-quality",
      "entry.price is derived_from_realized_gain — recovered arithmetically from the exit " +
        "price and the realised P&L, so it is not an observed fill and carries no independent " +
        "information about what was paid.",
      rows,
      (r) => !OBSERVED_PRICE_SOURCES.has(r.entry.price_source)
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
    labelBreakdown,
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
    statement: statementFor(rows.length, joinable, inDeclaredNames, labelBreakdown),
  };
}

/**
 * The conclusion, computed rather than written.
 *
 * The zero case names the LEADING reason rather than saying "no key", because
 * the leading reason changed when 1.2 landed and a hard-coded sentence would
 * still be describing a missing column that now exists.
 */
function statementFor(
  trips: number,
  joinable: number,
  inDeclaredNames: number,
  breakdown: readonly { status: LabelStatus; trips: number }[]
): string {
  if (joinable > 0) {
    return `${joinable} of ${trips} round trips name the method they were executing, declared before the entry, and can be differenced against it.`;
  }

  /* Agreement in number, because "1 name a declared method but were entered" reads as a bug. */
  const reasons: Record<Exclude<LabelStatus, "joins">, (n: number) => string> = {
    unlabelled: (n) => `${n} record${n === 1 ? "s" : ""} no method at entry`,
    backfilled: (n) => `${n} ${n === 1 ? "was" : "were"} labelled after the fact rather than at entry`,
    "method-not-declared": (n) => `${n} name${n === 1 ? "s" : ""} a method this site never declared`,
    "predates-declaration": (n) =>
      `${n} name${n === 1 ? "s" : ""} a declared method but ${n === 1 ? "was" : "were"} entered ` +
      `before it was declared here, which makes ${n === 1 ? "it the trade" : "them the trades"} ` +
      `that motivated the declaration rather than ${n === 1 ? "a test" : "tests"} of it`,
  };
  const parts = breakdown
    .filter((b) => b.status !== "joins")
    .sort((a, b) => b.trips - a.trips)
    .map((b) => reasons[b.status as Exclude<LabelStatus, "joins">](b.trips));

  return (
    `${trips} round trips are recorded and none of them can test anything on this page: ` +
    `${listReasons(parts)}` +
    (inDeclaredNames > 0
      ? `. ${inDeclaredNames} are in names a declared basket holds, which is a coincidence of ticker rather than a join.`
      : ".")
  );
}

function listReasons(parts: readonly string[]): string {
  if (parts.length === 0) return "no reason was recorded, which is itself a defect";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
