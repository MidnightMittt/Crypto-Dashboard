import { Bar } from "@/lib/research/types";
import { ordinal } from "@/lib/utils/format";

/**
 * THE FIRST VALIDATED SIGNAL AN EQUITY PAGE CAN QUOTE.
 *
 * Every equity module in this engine is State: it describes conditions and
 * never claims to forecast them, which is why the equity composite reads
 * "descriptive" and why `evidenceGrade` reports 0% validated weight there.
 * That was accurate and it was also a hole — a research platform with no
 * validated equity signal is a research platform with nothing to say about
 * equities beyond what any chart says.
 *
 * `momentum-12-1-long-only` closes it. Declared before it was run, measured
 * on a 128-instrument panel over 1980-2026 in non-overlapping 21-session
 * periods, corrected across a 12-hypothesis family at q = 0.05, and charged
 * 2pp of costs.
 *
 * ── The distinction this module exists to protect ─────────────────────
 *
 * The headline momentum result — 56.3%, lower bound 52.6% — belongs to a
 * LONG-SHORT SPREAD. A reader looking at one ticker holds the long leg and
 * inherits none of it. Quoting the spread here would be the most tempting
 * overstatement available to this platform, because the number is real and
 * merely about something else.
 *
 * So the long leg was declared and measured separately, against the
 * equal-weighted panel over the same window, which is the comparison a
 * single long position actually faces. It cleared on its own at the same
 * 2pp bar: 57.0%, lower bound 53.3%, +0.85% mean excess over the panel per
 * 21 sessions. THAT is the number this module is allowed to say, and it is
 * the only one it says.
 *
 * ── Why it does not vote in the composite ─────────────────────────────
 *
 * The equity composite runs on the `state` basis, where only State-role
 * metrics carry weight. Registering this as an Edge metric there would give
 * it a weight of zero — it would not vote, it would merely look like it
 * did. Flipping the basis to `edge` to let it vote would silence trend,
 * structure, relative strength and volatility in one stroke, leaving a
 * "composite" of exactly one metric.
 *
 * Neither is an improvement, so this reports alongside the composite rather
 * than inside it, answering a different question: not "what are conditions"
 * but "does the one thing here with a proven record have an opinion". Those
 * are genuinely two questions and merging them would lose both answers.
 *
 * ── What is NOT claimed ───────────────────────────────────────────────
 *
 *  - Nothing about the SHORT leg. The bottom decile was only ever measured
 *    as half of a spread; no standalone short record exists, so a ticker
 *    ranked at the bottom gets the ranking and an explicit refusal to
 *    forecast, not an inverted long claim.
 *  - Nothing in broad weakness. The declared complement measured 49.2% —
 *    below its own base rate — so the record does not apply and the module
 *    says so rather than quietly averaging the two regimes.
 *  - Nothing about a ticker in the middle eight deciles. The effect was
 *    measured at the extremes; the middle has no measured claim attached.
 */

import crossSectionJson from "@/data/equityCrossSection.json";
import validationJson from "@/data/signalValidation.json";

export interface CrossSection {
  generatedAt: number;
  asOf: number;
  instruments: number;
  lookbackSessions: number;
  skipSessions: number;
  decileSize: number;
  topCut: number;
  bottomCut: number;
  breadthPct: number | null;
  members: Array<{ symbol: string; mom: number }>;
}

interface ValidationRow {
  id: string;
  n: number;
  winRate: number;
  meanSpread: number;
  worstSpread: number;
  lowerBound: number | null;
  holdSessions: number;
  earnsEdge: boolean;
}

/**
 * How stale the 12-month return distribution may be before the decile
 * boundaries stop describing today's market. Generous on purpose: these are
 * twelve-month returns and they move slowly, so a boundary computed six
 * weeks ago is still close to right.
 */
const BREAKPOINT_MAX_AGE_MS = 45 * 86_400_000;

/**
 * How stale BREADTH may be, which is a much shorter fuse. The share of a
 * panel above its own 200-session average can move fifteen points in a
 * month, and it is the switch that decides whether the record applies at
 * all — so past this the regime is reported as unknown and the forecast is
 * withheld, even though the ranking still stands.
 */
const BREADTH_MAX_AGE_MS = 10 * 86_400_000;

/** Above this share of the panel above its own 200-session average, the validated regime is on. */
const BREADTH_THRESHOLD = 0.5;

export type MomentumLeg = "long-decile" | "short-decile" | "middle";
export type BreadthRegime = "broad-strength" | "broad-weakness" | "unknown";

export interface MomentumRecord {
  winRatePct: number;
  lowerBoundPct: number;
  n: number;
  /** Mean excess over the equal-weighted panel per holding period, in percent. */
  meanExcessPct: number;
  /** The worst single period measured. Sizing information the hit rate hides. */
  worstPct: number;
  holdSessions: number;
}

export interface MomentumRead {
  /** The ticker's own trailing 12-1 return, in percent. */
  momentumPct: number;
  /** Where that sits in the panel, 0-100. */
  percentile: number;
  leg: MomentumLeg;
  breadthPct: number | null;
  regime: BreadthRegime;
  /**
   * True only when the validated long-only record genuinely covers this
   * ticker's current situation. Everything else is ranking without forecast.
   */
  applies: boolean;
  /** The measured record, present only when `applies`. */
  record: MomentumRecord | null;
  /** One sentence stating the position. Never a bare number. */
  headline: string;
  /** What it means for a decision, in the engine's own voice. */
  detail: string;
  /** Everything that bounds the claim. Always non-empty. */
  caveats: string[];
  /** Other names currently in the same decile, so concentration is visible. */
  peers: string[];
  panelSize: number;
  /** The panel's as-of date, so staleness is legible rather than implied. */
  asOf: number;
}

export type MomentumOutcome =
  | { ok: true; read: MomentumRead }
  | { ok: false; blockedBy: "insufficient-history" | "not-applicable" | "no-provider"; reason: string };

/** Index of the last bar at or before `time`, or -1. */
function indexAsOf(bars: Bar[], time: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function loadCrossSection(): CrossSection {
  return crossSectionJson as CrossSection;
}

export function loadMomentumRecord(id: string): ValidationRow | null {
  const rows = (validationJson as { results: ValidationRow[] }).results;
  return rows.find((r) => r.id === id) ?? null;
}

export interface MomentumInputs {
  symbol: string;
  assetClass: "equity" | "crypto";
  bars: Bar[];
  /** Wall clock, for staleness. Injected so the read is deterministic under test. */
  now: number;
  crossSection?: CrossSection;
}

export function readEquityMomentum(inputs: MomentumInputs): MomentumOutcome {
  const { symbol, assetClass, bars, now } = inputs;
  const cs = inputs.crossSection ?? loadCrossSection();

  /*
   * The panel is US equities. Ranking a crypto asset inside it would import
   * a distribution built from something else entirely — the same category
   * error that produced "bullish 96" gold readings before cross-asset
   * instruments were removed from the equity snapshot.
   */
  if (assetClass !== "equity") {
    return {
      ok: false,
      blockedBy: "not-applicable",
      reason:
        "Cross-sectional momentum is measured against a panel of US equities. Ranking a crypto asset inside that " +
        "distribution would compare it to instruments it has no reason to be comparable with, so no rank is produced.",
    };
  }

  const age = now - cs.asOf;
  if (age > BREAKPOINT_MAX_AGE_MS) {
    return {
      ok: false,
      blockedBy: "no-provider",
      reason:
        `The reference panel was last measured ${Math.round(age / 86_400_000)} days ago, past the ${Math.round(BREAKPOINT_MAX_AGE_MS / 86_400_000)}-day ` +
        "limit for its decile boundaries to still describe this market. A rank against a distribution that old would " +
        "look precise and mean very little, so none is shown until the panel refreshes.",
    };
  }

  /*
   * Read the ticker at the PANEL'S as-of date, not its own last bar. A stock
   * with fresher data would otherwise be ranked on a slightly different
   * window than the distribution it is being placed in.
   */
  const i = indexAsOf(bars, cs.asOf);
  const need = cs.lookbackSessions + cs.skipSessions;
  if (i < need) {
    return {
      ok: false,
      blockedBy: "insufficient-history",
      reason:
        `${symbol} has ${Math.max(0, i + 1)} sessions of history at the panel's measurement date and this ranking needs ${need + 1} — ` +
        "a full twelve months plus the skipped final month. A shorter window would not be the quantity that was validated.",
    };
  }

  const past = bars[i - cs.lookbackSessions].close;
  const recent = bars[i - cs.skipSessions].close;
  if (!(past > 0) || !(recent > 0)) {
    return {
      ok: false,
      blockedBy: "insufficient-history",
      reason: `${symbol} has unusable closes inside the twelve-month window, so no trailing return can be computed.`,
    };
  }

  const mom = recent / past - 1;
  const below = cs.members.filter((m) => m.mom < mom).length;
  const above = cs.members.filter((m) => m.mom > mom).length;
  const percentile = (below / cs.members.length) * 100;

  /*
   * PLACED BY RANK, not by comparison against a stored cut.
   *
   * The question is "would this name enter the top decile if inserted into
   * the panel", and rank answers it directly for a ticker that is not in the
   * panel at all — which is the normal case here, since a reader can search
   * anything. Comparing a float return against a stored boundary also makes
   * the boundary itself a coin toss: a name whose trailing return is
   * arithmetically equal to the cut lands on either side depending on how
   * the two numbers were computed.
   */
  const leg: MomentumLeg =
    above + 1 <= cs.decileSize
      ? "long-decile"
      : below + 1 <= cs.decileSize
        ? "short-decile"
        : "middle";

  const breadthFresh = age <= BREADTH_MAX_AGE_MS;
  const regime: BreadthRegime =
    !breadthFresh || cs.breadthPct === null
      ? "unknown"
      : cs.breadthPct > BREADTH_THRESHOLD
        ? "broad-strength"
        : "broad-weakness";

  const row = loadMomentumRecord("momentum-12-1-long-only");
  const gated = loadMomentumRecord("momentum-12-1-long-only-broad-up");
  const applies = leg === "long-decile" && regime === "broad-strength" && !!gated?.earnsEdge;

  const record: MomentumRecord | null =
    applies && gated
      ? {
          winRatePct: gated.winRate * 100,
          lowerBoundPct: (gated.lowerBound ?? 0) * 100,
          n: gated.n,
          meanExcessPct: gated.meanSpread * 100,
          worstPct: gated.worstSpread * 100,
          holdSessions: gated.holdSessions,
        }
      : null;

  const decile = cs.decileSize;
  const peers =
    leg === "long-decile"
      ? cs.members.slice(0, decile).map((m) => m.symbol).filter((s) => s !== symbol)
      : leg === "short-decile"
        ? cs.members.slice(-decile).map((m) => m.symbol).filter((s) => s !== symbol)
        : [];

  return {
    ok: true,
    read: {
      momentumPct: mom * 100,
      percentile,
      leg,
      breadthPct: breadthFresh ? cs.breadthPct : null,
      regime,
      applies,
      record,
      headline: headlineFor(symbol, mom, percentile, leg, regime, applies),
      detail: detailFor(symbol, leg, regime, applies, record, row),
      caveats: caveatsFor(cs, leg, regime, peers),
      peers,
      panelSize: cs.members.length,
      asOf: cs.asOf,
    },
  };
}

function headlineFor(
  symbol: string,
  mom: number,
  percentile: number,
  leg: MomentumLeg,
  regime: BreadthRegime,
  applies: boolean
): string {
  const pct = `${mom >= 0 ? "+" : ""}${(mom * 100).toFixed(0)}%`;
  const rank = `${ordinal(percentile)} percentile`;

  if (applies) {
    return `${symbol} is in the top decile of twelve-month momentum (${pct}, ${rank}), and the market is in the regime where that has paid.`;
  }
  if (leg === "long-decile" && regime === "broad-weakness") {
    return `${symbol} is in the top decile of twelve-month momentum (${pct}, ${rank}), but breadth is weak — the regime in which this signal stops working.`;
  }
  if (leg === "long-decile") {
    return `${symbol} is in the top decile of twelve-month momentum (${pct}, ${rank}). The market regime cannot be established, so the record is not applied.`;
  }
  if (leg === "short-decile") {
    return `${symbol} is in the bottom decile of twelve-month momentum (${pct}, ${rank}) — the side the validated spread is short.`;
  }
  return `${symbol} sits mid-pack on twelve-month momentum (${pct}, ${rank}), outside both deciles where the effect was measured.`;
}

function detailFor(
  symbol: string,
  leg: MomentumLeg,
  regime: BreadthRegime,
  applies: boolean,
  record: MomentumRecord | null,
  unconditional: ValidationRow | null
): string {
  if (applies && record) {
    return (
      `Over 1980-2026, the top decile of this ranking beat the equal-weighted panel in ${record.winRatePct.toFixed(1)}% of ` +
      `${record.n} non-overlapping ${record.holdSessions}-session periods when breadth was this healthy, averaging ` +
      `${record.meanExcessPct >= 0 ? "+" : ""}${record.meanExcessPct.toFixed(2)}% excess return per period. The 95% lower bound is ` +
      `${record.lowerBoundPct.toFixed(1)}%, clear of the 50% null plus 2pp of costs. That is a claim about the ranking, not about ` +
      `${symbol} specifically: it says a basket held for these reasons has beaten the market, not that this name will.`
    );
  }

  if (leg === "long-decile" && regime === "broad-weakness") {
    return (
      `The complement of this hypothesis was declared and measured at the same time, precisely so this case could not be ` +
      `quietly ignored. When half or fewer of the panel trades above its own 200-session average, the top momentum decile beat ` +
      `the panel in only 49.2% of periods — below its own base rate. The ranking below is real; the forward claim is withdrawn ` +
      `until breadth recovers. This is the signal's own stated "do not take this trade" condition.`
    );
  }

  if (leg === "long-decile") {
    return (
      `The ranking stands, but the breadth reading behind the regime gate is too old to trust, and the record only holds in ` +
      `the strong half. Withholding the forecast is the conservative reading rather than assuming the favourable regime.`
    );
  }

  if (leg === "short-decile") {
    return (
      `The validated result is a LONG claim on the top decile. The bottom decile was only ever measured as the short half of a ` +
      `spread, and no standalone short record exists for it — so this reports position and nothing more. Inverting a long ` +
      `signal into a short claim is an assumption, not a measurement, and it is not made here.` +
      (unconditional
        ? ` For scale, the spread that includes this leg won ${(unconditional.winRate * 100).toFixed(1)}% of periods as a four-legged portfolio.`
        : "")
    );
  }

  return (
    `The measured effect lives at the extremes of the ranking. The eight deciles between them were not the thing that was ` +
    `validated, and interpolating a partial edge across the middle would invent precision the study does not contain. ` +
    `No momentum claim is made for ${symbol} today.`
  );
}

function caveatsFor(
  cs: CrossSection,
  leg: MomentumLeg,
  regime: BreadthRegime,
  peers: string[]
): string[] {
  const out: string[] = [];

  out.push(
    `Measured on ${cs.instruments} instruments that exist today, so names that failed and delisted are absent. That flatters ` +
      `a buy-the-winners result, which makes the printed edge a ceiling rather than an estimate.`
  );

  /*
   * CONCENTRATION. The study's decile was drawn from a broad panel; today's
   * can be one sector wearing twelve tickers. A reader who buys "the top
   * decile" in that state owns a sector bet, and the diversification the
   * measured statistic assumed is simply not there.
   */
  if (leg === "long-decile" && peers.length > 0) {
    out.push(
      `Today's long decile is ${peers.length + 1} names — ${peers.slice(0, 6).join(", ")}${peers.length > 6 ? " and others" : ""}. ` +
        `The statistic assumes holding the whole decile; when those names share an industry, that basket is a sector bet and ` +
        `carries risk the measured spread does not.`
    );
  }

  out.push(
    `Deciles are equal-weighted with no liquidity or price filter, and the panel is ranked as of ` +
      `${new Date(cs.asOf).toISOString().slice(0, 10)} rather than in real time.`
  );

  if (regime === "unknown") {
    out.push(`The breadth reading behind the regime gate is stale, so the regime is reported as unknown rather than assumed.`);
  }

  return out;
}
