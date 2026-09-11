import { LegStats, summariseSeries } from "./overnightDecomposition";
import { detectableEffectBp } from "./overnightBasket";

/**
 * THE PAPER ENGINE — a strategy's result computed every night, by the site,
 * whether or not anybody traded it.
 *
 * ── The problem it solves ─────────────────────────────────────────────
 *
 * The overnight premium's live series is stuck at n=2, not because the edge
 * died but because a scheduler did. Every missed window is an observation that
 * can never be recovered, and the consequence is that the live trades were
 * carrying two burdens at once: proving the effect exists AND proving we can
 * execute it. Those are different questions and they need different samples.
 *
 * A paper line separates them. If the site computes the declared strategy's
 * result on every session automatically, then "is the edge alive" is answered
 * by a series that cannot be interrupted, and the live fills only have to
 * answer "did we get the paper price", which is a question n=2 can begin to
 * speak to because it is about execution cost rather than about expectancy.
 *
 * ── What this module is, and is NOT ───────────────────────────────────
 *
 * It is the SHARED STATISTICS: dated net returns in, an honest record out. It
 * is deliberately not a position abstraction. The two strategies registered
 * against it hold genuinely different things — one is open-relative and turns
 * over every night, the other is close-to-close and holds 21 sessions — and
 * forcing a common `positionsOn()` over both would be a fiction in the layer
 * where fictions are most expensive. Each producer computes its own legs in
 * its own terms and hands over a dated series. What they share is the part
 * where errors actually live: the sample size, the clustering, the cost
 * arithmetic, and the breakeven.
 *
 * It also does NOT decide anything. A PaperRecord is evidence, not a verdict.
 * Nothing here sets `earnsEdge`, and nothing here may feed a forecast: the
 * forward record is out-of-sample by construction and a recomputable paper
 * line is not, however long it gets.
 *
 * ── Why the record is DERIVED and re-computed, not appended ───────────
 *
 * Both inputs are committed artefacts. Recomputing from them every night
 * means there is no partial state to repair and no resolution job to forget.
 * The cost of that choice is that changing the arithmetic silently rewrites
 * every past number, so the declaration is fingerprinted and stamped into the
 * output: a redefinition shows up as a changed fingerprint in the diff rather
 * than as a history that quietly improved overnight.
 */

/**
 * Bumped when the arithmetic below changes in a way that moves past numbers.
 * The fingerprint covers the STRATEGY's declaration; this covers the ENGINE's.
 */
export const PAPER_ENGINE_VERSION = 1;

/** Basis points per unit of return. Named so the conversions are greppable. */
export const BP = 10_000;

/**
 * What a strategy claims, stated before its numbers are looked at.
 *
 * Every field here is prose a reader can check against the producer's code.
 * `entry` and `exit` in particular exist because the two overnight legs differ
 * ONLY in where they are marked, and a record that did not say which one it
 * was would be indistinguishable from the other while meaning something else
 * entirely.
 */
export interface PaperDeclaration {
  id: string;
  /** One sentence, in the direction claimed. */
  statement: string;
  /** Where the position is marked ON, in words. */
  entry: string;
  /** Where it is marked OFF. */
  exit: string;
  /** Sessions held per observation. 1 for an overnight hold. */
  holdSessions: number;
  /**
   * THE DATE THIS CLAIM WAS FIXED, as YYYY-MM-DD.
   *
   * Part of the declaration, not metadata about it: a strategy backfilled over
   * three years of bars it was selected on is a backtest, and one accruing
   * nightly since the day it was written down is a paper record. They are
   * different kinds of evidence and the only thing separating them is this
   * date. Sessions before it are reported, because they are the reason the
   * strategy was declared at all — but they are reported separately, and the
   * record that carries weight is the one after.
   *
   * Honest means the date the STATEMENT was fixed, not the date this file was
   * written. The overnight and momentum legs are dated to the commits that
   * declared them; a leg declared today is dated today and starts at n=0.
   */
  declaredOn: string;
  /**
   * Whether the charged cost is an assumption or an observation.
   *
   * Load-bearing, not decorative. A modelled tick and a measured book differ
   * by enough on these names to decide the sign of the net line, and the whole
   * point of the spread capture is to replace the first with the second.
   */
  costBasis: "modelled" | "measured";
  /** What the cost figure actually is, so the basis can be audited. */
  costNote: string;
  /**
   * WHY THE OBSERVATIONS MAY BE TREATED AS INDEPENDENT, in the producer's own
   * terms — declared rather than assumed, because the assumption is wrong far
   * more often than it is right in this codebase. Consecutive overnight
   * returns share no bar; periods that step by the holding period do not
   * overlap. Anything that samples more often than it holds owes an overlap
   * correction instead and must say so here.
   */
  independenceBasis: string;
  /** Stated before the run. What result retires this. */
  killCriteria: string;
}

/**
 * One observation: the strategy's realised result on one date.
 *
 * `date` is the session the return is REALISED on, not the one the decision
 * was made on. Dating by the decision would put an outcome in the past
 * relative to its own information.
 */
export interface PaperSession {
  date: string;
  grossBp: number;
  costBp: number;
  /** gross − cost. Carried rather than derived so a producer can charge
   *  asymmetrically if its legs genuinely differ, and the record still adds up. */
  netBp: number;
  /**
   * Instruments contributing to this date's number.
   *
   * Never a sample size. A basket of twelve correlated miners on one night is
   * one bet, not twelve, which is exactly why the producer averages within a
   * date before handing the series over.
   */
  names: number;
  /**
   * Round trips consumed by this observation, in [0, 1].
   *
   * 1 means fully in and out. A 21-session hold that replaces 40% of its
   * basket at rebalance consumes 0.4. This is the field a flat per-period cost
   * charge silently gets wrong: charging the same amount to a strategy that
   * trades nightly and one that trades monthly makes the first look like the
   * second.
   */
  turnover: number;
}

export interface PaperRecord {
  declaration: PaperDeclaration;
  engineVersion: number;
  /**
   * Changes whenever the declaration changes. A strategy redefined in place
   * would otherwise rewrite its own history into agreement with itself.
   */
  definitionFingerprint: string;
  /** Distinct dates. THE sample size. */
  n: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Clustered on dates, which is the unit of risk. */
  net: LegStats | null;
  /** The same series before costs — the number breakeven is computed from. */
  gross: LegStats | null;
  /** Compounded, not summed: 250 nights of tens of bp are not additive. */
  cumulativeNetPct: number | null;
  cumulativeGrossPct: number | null;
  /** Peak-to-trough on the compounded net line. What actually ends a strategy. */
  maxDrawdownPct: number | null;
  worstSessionBp: number | null;
  p05SessionBp: number | null;
  /**
   * THE COST QUESTION, answered as a number instead of an assumption.
   *
   * The round-trip cost in basis points at which this strategy's mean net
   * return reaches zero. Above it the edge is arithmetic that belongs to the
   * broker. It is the gross mean divided by mean turnover, so a nightly
   * strategy and a monthly one are quoted on the same per-round-trip scale and
   * can be compared honestly.
   */
  breakevenCostBp: number | null;
  /** Mean round trips per observation. Quoted so breakeven can be checked. */
  meanTurnover: number | null;
  /** Mean cost actually charged per observation. */
  meanCostBp: number | null;
  /**
   * THE POWER LINE. The smallest true effect this many observations at this
   * dispersion could have called significant at t=3. A record that has not
   * yet reached significance is not a record of absence, and this says so.
   */
  detectableAtT3Bp: number | null;
  /**
   * Observations still needed before the observed mean would reach t=3, at the
   * dispersion measured so far. The answer to "how long until this decides
   * anything", which is the only question a two-observation series can be
   * asked.
   */
  sessionsToT3: number | null;
  meanNamesPerSession: number | null;
  sessions: PaperSession[];
}

/**
 * A stable, dependency-free fingerprint of the declared fields.
 *
 * FNV-1a rather than a crypto hash: this runs in a module that may be bundled
 * for the browser, and the requirement is only that a changed declaration
 * produces a changed string — not that the string is hard to forge.
 */
export function fingerprintDeclaration(d: PaperDeclaration): string {
  const canonical = [
    d.id,
    d.statement,
    d.entry,
    d.exit,
    String(d.holdSessions),
    d.declaredOn,
    d.costBasis,
    d.costNote,
    d.independenceBasis,
    d.killCriteria,
  ].join(" ");
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;

/** Nearest-rank percentile. Small samples do not deserve interpolation. */
function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** Compounded return of a bp series, as a percentage. */
function compound(bp: number[]): number | null {
  if (!bp.length) return null;
  let equity = 1;
  for (const x of bp) equity *= 1 + x / BP;
  return (equity - 1) * 100;
}

/** Peak-to-trough of the compounded line, as a positive percentage. */
function maxDrawdown(bp: number[]): number | null {
  if (!bp.length) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const x of bp) {
    equity *= 1 + x / BP;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? 1 - equity / peak : 0;
    if (dd > worst) worst = dd;
  }
  return worst * 100;
}

/**
 * Observations needed for the OBSERVED mean to reach t=3 at the OBSERVED sd.
 *
 * t = mean * sqrt(n) / sd, so n = (3 * sd / mean)^2. Stated as a count rather
 * than a date because sessions are not calendar days and a strategy that only
 * trades in some regimes accrues them slower than the calendar suggests.
 *
 * Null when the mean is the wrong sign or indistinguishable from zero: "how
 * long until a negative mean becomes significantly positive" has no answer,
 * and producing a very large number would read as one.
 */
export function sessionsToReachT(
  stats: LegStats | null,
  atT = 3
): number | null {
  if (!stats || !(stats.sdBp > 0) || !(stats.meanBp > 0)) return null;
  return Math.ceil(((atT * stats.sdBp) / stats.meanBp) ** 2);
}

/**
 * Fold a dated series into a record.
 *
 * Dates are deduplicated by taking the LAST entry for a date rather than
 * summing: two rows on one date is a producer bug, and summing them would
 * quietly double that date's contribution while adding an observation, which
 * moves both the mean and the sample size in the flattering direction.
 */
export function buildPaperRecord(
  declaration: PaperDeclaration,
  sessions: PaperSession[]
): PaperRecord {
  const byDate = new Map<string, PaperSession>();
  for (const s of sessions) {
    if (!Number.isFinite(s.netBp) || !Number.isFinite(s.grossBp)) continue;
    byDate.set(s.date, s);
  }
  const ordered = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const netBp = ordered.map((s) => s.netBp);
  const grossBp = ordered.map((s) => s.grossBp);
  const net = summariseSeries(netBp);
  const gross = summariseSeries(grossBp);
  const meanTurnover = mean(ordered.map((s) => s.turnover));
  const grossMean = mean(grossBp);

  return {
    declaration,
    engineVersion: PAPER_ENGINE_VERSION,
    definitionFingerprint: fingerprintDeclaration(declaration),
    n: ordered.length,
    firstDate: ordered.length ? ordered[0].date : null,
    lastDate: ordered.length ? ordered[ordered.length - 1].date : null,
    net,
    gross,
    cumulativeNetPct: compound(netBp),
    cumulativeGrossPct: compound(grossBp),
    maxDrawdownPct: maxDrawdown(netBp),
    worstSessionBp: netBp.length ? Math.min(...netBp) : null,
    p05SessionBp: percentile(netBp, 0.05),
    /*
     * Null rather than Infinity at zero turnover. A strategy that never trades
     * has no round-trip cost that would break it even, and rendering that as
     * an unbounded number would read as "survives any cost".
     */
    breakevenCostBp:
      grossMean !== null && meanTurnover !== null && meanTurnover > 1e-9
        ? grossMean / meanTurnover
        : null,
    meanTurnover,
    meanCostBp: mean(ordered.map((s) => s.costBp)),
    detectableAtT3Bp: net ? detectableEffectBp(net.sdBp, net.n) : null,
    sessionsToT3: sessionsToReachT(net),
    meanNamesPerSession: mean(ordered.map((s) => s.names)),
    sessions: ordered,
  };
}

/**
 * A strategy's evidence, split at the date it was declared.
 *
 * Both halves are computed from the same sessions by the same arithmetic. The
 * split is not a filter applied for presentation — it is the difference
 * between the sample that SELECTED the strategy and the sample that TESTS it,
 * and reporting only the union would let a three-year backtest's significance
 * stand in for a paper record that is three weeks old.
 */
export interface PaperLine {
  /** Every session computable from committed data, declared or not. */
  full: PaperRecord;
  /** Sessions realised on or after `declaration.declaredOn`. The paper record. */
  sinceDeclared: PaperRecord;
  /** Sessions before the declaration. In-sample by construction. */
  inSampleSessions: number;
}

export function buildPaperLine(
  declaration: PaperDeclaration,
  sessions: PaperSession[]
): PaperLine {
  const full = buildPaperRecord(declaration, sessions);
  /*
   * Filtered off `full.sessions` rather than the raw input so the two records
   * agree about which rows exist after de-duplication. Filtering the input
   * would let a duplicate date land in one half and not the other.
   */
  const since = full.sessions.filter((s) => s.date >= declaration.declaredOn);
  return {
    full,
    sinceDeclared: buildPaperRecord(declaration, since),
    inSampleSessions: full.n - since.length,
  };
}

/**
 * The sentence that must appear beside any paper number a human reads.
 *
 * A record with n=4 and a positive mean looks exactly like a record with n=400
 * and a positive mean until somebody reads the sample size, and the whole
 * reason this engine exists is that the live series is tiny. So the caveat is
 * generated FROM the record rather than written once in a template, and it
 * names the specific reason this particular record cannot yet carry weight.
 */
export function paperCaveat(record: PaperRecord): string | null {
  if (record.n === 0) return "No sessions have been computed. There is nothing here.";
  if (!record.net) return `${record.n} session(s) — too few to estimate dispersion.`;

  const parts: string[] = [];
  /*
   * FIRST, because it changes what every number after it means. A t-stat over
   * a window the strategy was chosen on is not evidence in the same sense as
   * one accrued since; saying so after quoting the t reads as a footnote.
   */
  const inSample = record.sessions.filter((s) => s.date < record.declaration.declaredOn).length;
  if (inSample > 0) {
    parts.push(
      `${inSample} of ${record.n} sessions precede the ${record.declaration.declaredOn} ` +
        `declaration and are in-sample — this is a backtest with a paper record attached, ` +
        `not a paper record`
    );
  }
  if (Math.abs(record.net.tStat) < 3) {
    const detect = record.detectableAtT3Bp;
    parts.push(
      `t=${record.net.tStat.toFixed(2)} over ${record.n} sessions does not clear t=3` +
        (detect !== null ? `; this sample could only have detected ${detect.toFixed(0)}bp` : "")
    );
    if (record.sessionsToT3 !== null) {
      parts.push(`at the observed mean and dispersion it would take ~${record.sessionsToT3} sessions`);
    }
  }
  if (record.declaration.costBasis === "modelled") {
    parts.push("the cost charged is a model, not a measured book");
  }
  if ((record.meanNamesPerSession ?? 1) > 1) {
    parts.push(
      `each session averages ${record.meanNamesPerSession!.toFixed(1)} correlated names, which is one bet and not that many`
    );
  }
  return parts.length ? `${parts.join("; ")}.` : null;
}
