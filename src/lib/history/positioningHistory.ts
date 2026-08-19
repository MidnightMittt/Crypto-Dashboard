/**
 * POSITIONING HISTORY — turning point-in-time reads into testable series.
 *
 * The dossier shows net dealer gamma, short-sale volume share, put/call
 * ratios and ATM implied vol as today's numbers with no past. That makes them
 * undecidable: "does negative dealer gamma precede a larger overnight move"
 * is not a hard question, it is an unaskable one, because there is no series
 * to ask it of. This store is what makes the question answerable in a few
 * months' time.
 *
 * ── The asymmetry that shapes the whole design ────────────────────────
 *
 * Two of these can be reconstructed and two cannot, and the difference is
 * not a detail:
 *
 *   SHORT VOLUME  FINRA publishes one file PER DATE
 *                 (cdn.finra.org/equity/regsho/daily/CNMSshvol20260813.txt).
 *                 Verified reachable back to at least 2020 — 2016 returns
 *                 403. So this is genuinely backfillable, years of it.
 *   OPTIONS       CBOE's delayed chain is one live snapshot per symbol
 *                 (delayed_quotes/options/AAPL.json). No date parameter, no
 *                 archive. Gamma, put/call and ATM IV therefore have NO past
 *                 and cannot be given one. They begin the day recording
 *                 begins, and nothing can change that.
 *
 * So a backfilled row and a live row are DIFFERENT OBJECTS. A backfilled row
 * has short volume and nothing else; its null gamma means "never observed",
 * not "observed as absent". Plot them on one chart without that distinction
 * and the first thing anyone will do is read the gap as a regime change. That
 * is why `origin` is on every row and why `seriesOf` reports coverage per
 * field rather than a single row count.
 *
 * ── Why one row per symbol-date, appended, never recomputed ───────────
 *
 * Same rule the signal ledger lives by: this must record what the site
 * actually SHOWED on that date. Recomputing later from stored inputs would
 * let a model change quietly rewrite its own history, which is exactly the
 * failure the forward record was built to avoid.
 */

export type PositioningOrigin = "live" | "backfill";

export interface PositioningPoint {
  /** ISO date of the SESSION described, not of the run that recorded it. */
  date: string;
  symbol: string;
  /**
   * Where the row came from. `backfill` rows carry short volume only — their
   * option fields are null because the data never existed, not because the
   * market had nothing to say.
   */
  origin: PositioningOrigin;

  /** Dollars of dealer gamma per 1% move. Positive dampens, negative amplifies. */
  netGexUsdPer1Pct: number | null;
  /** Derived, but stored: the sign is the read, and deriving it twice invites drift. */
  gammaSign: "positive" | "negative" | null;

  /** Share of the session's volume that printed as a short sale, in percent. */
  shortRatioPct: number | null;

  putCallOiRatio: number | null;
  putCallVolumeRatio: number | null;

  /** ATM implied vol in percent, annualised. */
  atmIvPct: number | null;
  /**
   * Days to the expiry that IV came from. An annualised vol without its tenor
   * is two different quantities wearing the same units, so the two travel
   * together or not at all.
   */
  atmIvDaysToExpiry: number | null;

  /**
   * THE VENDOR'S OWN INSTANT PER GROUP, never our write time.
   *
   * `date` is the SESSION this row describes, derived from the price bars.
   * That is a different clock belonging to a different provider, and using it
   * for everything meant a CBOE chain read at 20:43:18Z was filed under the
   * bars' last session — which ran four days stale while the backfill was
   * behind. The envelope's `as_of` is defined as the instant the VALUE was
   * true, so the vendor's stamp wins wherever the vendor publishes one.
   *
   * Absent for a group whose vendor publishes no instant. Never our clock
   * standing in for theirs: that is the write date wearing the value's name,
   * which is the specific substitution this whole file exists to refuse.
   */
  sourceAsOf?: Partial<Record<FieldGroup, string>>;

  /** ATR as a percent of close — the same figure the page calls "typical daily move". */
  typicalDailyMovePct: number | null;

  /**
   * Total listed open interest, calls plus puts.
   *
   * The DENOMINATOR that makes putCallOiRatio a fact rather than a number. A
   * ratio of 0.55 on 819,240 contracts and the same 0.55 on eight hundred are
   * different observations, and the ratio alone cannot tell them apart.
   */
  chainOi: number | null;

  /**
   * Sell-side consensus. Nasdaq serves only the CURRENT survey — there is no
   * date parameter and no archive — so a revision series exists only if it is
   * recorded as it happens. Count travels with target for the same reason
   * chainOi travels with the ratio.
   */
  analystCount: number | null;
  analystMeanTargetUsd: number | null;

  /**
   * Retail self-reported direction, StockTwits. Bullish share among the
   * SELF-TAGGED, so it is already a conditional figure, and the two fields
   * below are what make it interpretable rather than decorative.
   *
   * The sample is small — tens of messages, not thousands — and the provider
   * refuses a percentage below MIN_TAGGED. Recorded because the window is
   * rolling and unrecoverable, NOT because a single day's read is evidence of
   * anything: at n=30 the standard error on a share is about nine points.
   */
  socialBullishPctOfTagged: number | null;
  socialTaggedCount: number | null;
  /** Hours the sample spans. 30 messages in 2 hours is not 30 in 4 days. */
  socialSpanHours: number | null;
}

/**
 * FIELDS THAT WERE OBSERVED TOGETHER, and must therefore travel together.
 *
 * Two writers fill these rows with different coverage: recordPositioning
 * writes a LIVE row carrying every group, while backfillShortVolume writes
 * short volume ONLY, because CBOE publishes no chain archive. Once backfill
 * reaches a date past the newest live row, "the latest row" stops being the
 * latest of everything — which erased gamma from all 105 symbols the first
 * time the wider backfill ran.
 *
 * The projection therefore takes the latest observation PER GROUP. It must not
 * do so per field: `atmIvPct` taken from one session and `atmIvDaysToExpiry`
 * from another is an annualised vol without its own tenor, which this file
 * already refuses to allow, and a bullish share separated from its
 * self-tagged count is the claim that was nine votes out of ten pretending to
 * be twenty-seven out of thirty.
 *
 * A group is one provider, one fetch, one instant. That is why the grouping is
 * exactly the shape of recordPositioning's `Promise.all`.
 */
export type FieldGroup = "options" | "shortVolume" | "price" | "street" | "social";

export const GROUP_FIELDS: Record<FieldGroup, readonly (keyof PositioningPoint)[]> = {
  /** One CBOE chain read. Gamma, its sign, put/call, ATM IV with its tenor, chain OI. */
  options: [
    "netGexUsdPer1Pct",
    "gammaSign",
    "putCallOiRatio",
    "putCallVolumeRatio",
    "atmIvPct",
    "atmIvDaysToExpiry",
    "chainOi",
  ],
  /** One FINRA daily file. The only group a backfill can supply. */
  shortVolume: ["shortRatioPct"],
  /** Derived from the bar series, not fetched. */
  price: ["typicalDailyMovePct"],
  /** One Nasdaq consensus read; the target is meaningless without its count. */
  street: ["analystCount", "analystMeanTargetUsd"],
  /** One StockTwits window; the share is meaningless without count and span. */
  social: ["socialBullishPctOfTagged", "socialTaggedCount", "socialSpanHours"],
} as const;

export const FIELD_GROUPS = Object.keys(GROUP_FIELDS) as FieldGroup[];

/** True when a row carries an observation for this group at all. */
export function hasGroup(p: PositioningPoint, group: FieldGroup): boolean {
  return GROUP_FIELDS[group].some((f) => p[f] !== null && p[f] !== undefined);
}

export interface PositioningHistory {
  version: 1;
  generatedAt: number;
  points: PositioningPoint[];
}

export const EMPTY_POSITIONING_HISTORY: PositioningHistory = {
  version: 1,
  generatedAt: 0,
  points: [],
};

const keyOf = (p: { symbol: string; date: string }): string => `${p.symbol}|${p.date}`;

/**
 * Add rows, replacing any already held for the same symbol and date.
 *
 * Idempotent by (symbol, date) so a re-run of the daily job cannot stuff the
 * series with duplicates — the same rule registerPredictions enforces, and
 * for the same reason.
 *
 * A LIVE row always wins over a backfill for the same date, whichever order
 * they arrive in. Backfill is a floor, not an overwrite: it must never
 * replace a richer observation with a sparser one.
 */
export function appendPoints(
  existing: PositioningPoint[],
  fresh: PositioningPoint[]
): PositioningPoint[] {
  const byKey = new Map(existing.map((p) => [keyOf(p), p]));
  for (const p of fresh) {
    const prior = byKey.get(keyOf(p));
    if (prior && prior.origin === "live" && p.origin === "backfill") continue;
    byKey.set(keyOf(p), p);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

export interface FieldCoverage {
  field: string;
  observed: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface PositioningSeries {
  symbol: string;
  points: PositioningPoint[];
  /**
   * Per-FIELD coverage, because a row count is misleading here: a symbol can
   * have 800 rows and 3 gamma observations, and quoting "800" beside a gamma
   * chart would be a lie of composition.
   */
  coverage: FieldCoverage[];
}

const NUMERIC_FIELDS = [
  "netGexUsdPer1Pct",
  "shortRatioPct",
  "putCallOiRatio",
  "putCallVolumeRatio",
  "atmIvPct",
  "typicalDailyMovePct",
] as const;

/** One symbol's series, oldest first, with honest per-field coverage. */
export function seriesOf(history: PositioningPoint[], symbol: string): PositioningSeries {
  const points = history
    .filter((p) => p.symbol === symbol)
    .sort((a, b) => a.date.localeCompare(b.date));

  const coverage: FieldCoverage[] = NUMERIC_FIELDS.map((field) => {
    /*
     * `!= null` catches undefined too, and that is load-bearing rather than
     * sloppy. A row written by an older schema, or one where a field was
     * simply omitted, arrives as `undefined` — and `undefined !== null` is
     * TRUE, which would silently count a field that was never recorded as an
     * observation. Overstating coverage is the one error this module exists
     * to prevent.
     */
    const seen = points.filter((p) => p[field] != null);
    return {
      field,
      observed: seen.length,
      firstDate: seen.length ? seen[0].date : null,
      lastDate: seen.length ? seen[seen.length - 1].date : null,
    };
  });

  return { symbol, points, coverage };
}

/**
 * Below this a field is not worth charting, let alone testing. Matches the
 * minimum the forward record uses — a series shorter than this describes its
 * own start-up, not the market.
 */
export const MIN_SERIES_N = 30;

/** True when a field has enough observations to be worth showing at all. */
export function isChartable(series: PositioningSeries, field: string): boolean {
  const c = series.coverage.find((x) => x.field === field);
  return (c?.observed ?? 0) >= MIN_SERIES_N;
}

/**
 * Keep the artefact bounded. Oldest-first drop, per symbol, so one heavily
 * covered name cannot crowd out every other symbol's early history.
 */
export const MAX_POINTS_PER_SYMBOL = 1_500;

export function prunePoints(
  points: PositioningPoint[],
  cap = MAX_POINTS_PER_SYMBOL
): PositioningPoint[] {
  const bySymbol = new Map<string, PositioningPoint[]>();
  for (const p of points) {
    bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
  }
  const kept: PositioningPoint[] = [];
  for (const [, rows] of bySymbol) {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    kept.push(...sorted.slice(Math.max(0, sorted.length - cap)));
  }
  return kept.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}
