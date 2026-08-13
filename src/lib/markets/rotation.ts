import { Bar } from "@/lib/research/types";

/**
 * CAPITAL ROTATION — where money is moving, measured rather than asserted.
 *
 * The question this answers is the platform's central one: not "is the market
 * up" but "which parts of it are being bought at the expense of which others".
 *
 * ── Why relative strength, and why against the index ──────────────────
 *
 * A sector rising 3% tells you almost nothing, because on most days most
 * sectors rise together — the common market factor dominates every individual
 * series. The universe file records the consequence: five US index ETFs carry
 * about 1.17x the independent evidence of one.
 *
 * That redundancy is the measurement. Dividing a sector by the benchmark
 * cancels the shared factor, and what survives is the part that is ABOUT that
 * sector. So rotation is read from the ratio line, never from the price line.
 *
 * ── Two horizons, because rotation has a direction in time ────────────
 *
 * A sector that has outperformed for six months and is now lagging over one
 * month is a DIFFERENT proposition from one doing the reverse, even though
 * both may sit mid-table on either horizon alone. Crossing a long lookback
 * with a short one separates them into the four states below, which is the
 * whole point of the quadrant a rotation graph draws.
 *
 * ── What this file will not do ────────────────────────────────────────
 *
 * No sector is favoured, named as a theme, or given a house view. The order
 * is whatever the ratio lines produce. Every number below is reproducible
 * from two price series and a subtraction, which is what makes the ranking
 * arguable rather than asserted.
 */

/** Long horizon: roughly six months of sessions. Establishes the standing trend. */
export const ROTATION_LONG_SESSIONS = 126;
/** Short horizon: roughly one month. Detects the turn against that trend. */
export const ROTATION_SHORT_SESSIONS = 21;

/**
 * The four states a sector can occupy, and the only four that matter.
 *
 * Named for what a trader does about them rather than for their quadrant
 * coordinates: "leading" and "lagging" are positions, "improving" and
 * "weakening" are transitions, and the transitions are where the decisions
 * are.
 */
export type RotationState = "leading" | "improving" | "weakening" | "lagging";

export const ROTATION_STATE_LABEL: Record<RotationState, string> = {
  leading: "Leading",
  improving: "Improving",
  weakening: "Weakening",
  lagging: "Lagging",
};

export const ROTATION_STATE_MEANING: Record<RotationState, string> = {
  leading: "Outperforming over both horizons — capital is here and still arriving.",
  improving: "Behind over six months but ahead over one — capital is rotating IN. Early, and the least crowded of the four.",
  weakening: "Ahead over six months but behind over one — capital is rotating OUT. The most dangerous state to buy, because the long-horizon number still looks good.",
  lagging: "Behind over both horizons — capital is elsewhere and has not turned.",
};

/**
 * The relative move as a SENTENCE, because the bare number was unreadable.
 *
 * The board printed "+5.0" and "-3.3" with nothing saying these are
 * performance AGAINST THE S&P rather than raw returns — so a sector that
 * fell 2% in a market that fell 7% displayed "+5.0" and read like a gain.
 * That is the most misleading thing a rotation board can do, and it cost
 * one clause to fix.
 */
export function describeRelative(relPct: number, horizon: string): string {
  const size = Math.abs(relPct).toFixed(1);
  if (Math.abs(relPct) < 0.1) return `matching the S&P over ${horizon}`;
  return relPct > 0
    ? `${size}% ahead of the S&P over ${horizon}`
    : `${size}% behind the S&P over ${horizon}`;
}

/**
 * `momentumPct` (short-horizon relative minus long-horizon relative) as a
 * direction of travel. It was displayed as "shift +5.4" — a number whose
 * units and sign convention a reader had no way to guess. What it actually
 * answers is "is this getting stronger or weaker", so it now says that.
 */
export function describeMomentum(momentumPct: number): string {
  if (momentumPct >= 5) return "improving quickly";
  if (momentumPct >= 1) return "improving";
  if (momentumPct <= -5) return "deteriorating quickly";
  if (momentumPct <= -1) return "deteriorating";
  return "holding steady";
}

export interface SectorRotation {
  symbol: string;
  name: string;
  /** Relative performance vs the benchmark over the long horizon, in percentage points. */
  longRelPct: number;
  /** Same over the short horizon. */
  shortRelPct: number;
  /** shortRel - longRel: whether the relative trend is accelerating or decaying. */
  momentumPct: number;
  state: RotationState;
  /** Absolute price change over the short horizon, for context — never for ranking. */
  shortAbsPct: number;
}

export interface RotationRead {
  benchmark: string;
  asOf: number;
  sectors: SectorRotation[];
  /**
   * Dispersion: the spread between the best and worst short-horizon relative
   * performance, in percentage points.
   *
   * The single most useful number here and the one nobody shows. When it is
   * wide, sector selection is most of the return and rotation is worth
   * trading. When it is narrow, everything is moving together, and picking
   * sectors is an expensive way to own the index.
   */
  dispersionPct: number;
}

/** Percentage change over the last `sessions` bars. Null when history is short. */
function changePct(bars: Bar[], sessions: number): number | null {
  if (bars.length <= sessions) return null;
  const last = bars[bars.length - 1].close;
  const prior = bars[bars.length - 1 - sessions].close;
  if (prior <= 0) return null;
  return ((last - prior) / prior) * 100;
}

export interface RotationInput {
  symbol: string;
  name: string;
  bars: Bar[];
}

/**
 * Ranks a set of sectors by how they are performing against the benchmark.
 *
 * Returns null rather than a partial read when the benchmark itself is too
 * short — a relative measure with nothing to be relative to is not a
 * degraded answer, it is a different and meaningless one.
 */
export function buildRotation(sectors: RotationInput[], benchmark: RotationInput): RotationRead | null {
  const benchLong = changePct(benchmark.bars, ROTATION_LONG_SESSIONS);
  const benchShort = changePct(benchmark.bars, ROTATION_SHORT_SESSIONS);
  if (benchLong === null || benchShort === null) return null;

  const rows: SectorRotation[] = [];
  for (const s of sectors) {
    const long = changePct(s.bars, ROTATION_LONG_SESSIONS);
    const short = changePct(s.bars, ROTATION_SHORT_SESSIONS);
    // A sector without both horizons is OMITTED, not defaulted to zero.
    // Zero would read as "exactly in line with the market", which is a claim.
    if (long === null || short === null) continue;

    const longRelPct = long - benchLong;
    const shortRelPct = short - benchShort;

    rows.push({
      symbol: s.symbol,
      name: s.name,
      longRelPct,
      shortRelPct,
      momentumPct: shortRelPct - longRelPct,
      state: stateOf(longRelPct, shortRelPct),
      shortAbsPct: short,
    });
  }

  if (rows.length === 0) return null;

  // Ordered by the SHORT horizon: where capital is going now outranks where it
  // has been. Ties broken by momentum then alphabetically, so the list is
  // stable across rebuilds rather than dependent on input order.
  rows.sort((a, b) => b.shortRelPct - a.shortRelPct || b.momentumPct - a.momentumPct || a.symbol.localeCompare(b.symbol));

  return {
    benchmark: benchmark.symbol,
    asOf: benchmark.bars[benchmark.bars.length - 1].t,
    sectors: rows,
    dispersionPct: rows[0].shortRelPct - rows[rows.length - 1].shortRelPct,
  };
}

/**
 * The quadrant, with zero as the only boundary.
 *
 * No deadband, deliberately. A band would need a width, the width would need
 * a justification, and nothing in this repository establishes one — an
 * invented threshold would be exactly the kind of unearned precision the
 * engine refuses elsewhere. Zero is the one non-arbitrary cut: it is the
 * benchmark. Rows near it are genuinely ambiguous, and `momentumPct` is
 * published so a reader can see how far from the line a sector sits rather
 * than trusting the label alone.
 */
export function stateOf(longRelPct: number, shortRelPct: number): RotationState {
  if (longRelPct >= 0) return shortRelPct >= 0 ? "leading" : "weakening";
  return shortRelPct >= 0 ? "improving" : "lagging";
}

/**
 * Rotation stated as a sentence, because a quadrant chart is not a conclusion.
 *
 * Reads the ordered rows rather than re-deriving anything, and names the
 * transitions first — `improving` and `weakening` are where a decision is,
 * `leading` and `lagging` are where a position already is.
 */
export function describeRotation(read: RotationRead): string {
  const improving = read.sectors.filter((s) => s.state === "improving");
  const weakening = read.sectors.filter((s) => s.state === "weakening");
  const leading = read.sectors.filter((s) => s.state === "leading");

  const parts: string[] = [];

  if (read.dispersionPct < 3) {
    parts.push(
      `Sector dispersion is only ${read.dispersionPct.toFixed(1)} points between best and worst over the last month — sectors are moving together, so sector selection is currently a small part of the return and owning the index is close to owning the leaders.`
    );
  } else {
    parts.push(
      `${read.dispersionPct.toFixed(1)} points separate the best and worst sector over the last month, so which sector you own is doing real work.`
    );
  }

  if (leading.length > 0) {
    parts.push(
      `${leading[0].name} leads on both horizons (${fmtRel(leading[0].shortRelPct)} vs ${read.benchmark} over a month).`
    );
  }
  if (improving.length > 0) {
    parts.push(
      `Capital is rotating INTO ${improving.map((s) => s.name).join(", ")} — behind over six months, ahead over one.`
    );
  }
  if (weakening.length > 0) {
    parts.push(
      `It is rotating OUT of ${weakening.map((s) => s.name).join(", ")}, which still look strong on the six-month number and are not.`
    );
  }
  if (improving.length === 0 && weakening.length === 0) {
    parts.push("No sector has crossed against its six-month trend — the current leadership is intact rather than turning.");
  }

  return parts.join(" ");
}

const fmtRel = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
