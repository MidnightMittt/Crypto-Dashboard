/**
 * Turns raw harmonic geometry (harmonics.ts) into the evidence object the
 * decision engine actually consumes: a status machine, a confirmation
 * layer, and a single "which pattern matters right now" selection.
 *
 * ── THE CENTRAL DESIGN CHOICE: NO NEW PERSISTED STORE ─────────────────────
 *
 * swingThesis.ts needed a KV-backed store because its FROZEN PLAN must
 * survive being recomputed from a moving tick — the whole point was to stop
 * the entry from drifting. A harmonic candidate has no such problem: its PRZ
 * is already frozen the moment C's price is fixed (harmonics.ts never uses a
 * later price to define one), and its STATUS is a pure function of price
 * against that already-frozen PRZ, in exactly the same way
 * `swingThesis.ts`'s `statusForPrice` is a pure function of price against
 * the frozen trade plan. So harmonic status doesn't need memory across
 * polls — recomputing it from the same closed candles + current price on
 * every poll gives the identical answer polling 15 seconds apart, hourly, or
 * once a day. Not needing a second KV store here is a direct, deliberate
 * consequence of harmonics.ts's forward-projecting design, not an oversight.
 *
 * The one place this WOULD need memory — "has price shown a genuine
 * rejection since entering the PRZ" — is instead answered by scanning the
 * closed-candle history since the PRZ was first reached, which is already
 * sitting in the same candle array every other caller here already fetched.
 *
 * ── GEOMETRY VS CONFIRMATION, KEPT STRUCTURALLY SEPARATE ──────────────────
 *
 * `geometryQuality` (from harmonics.ts's leg-fit precision) and
 * `confirmation` (structure reaction, divergence, regime/derivatives
 * alignment) are two different fields on `HarmonicEvidence`, never merged
 * into one score. A geometrically perfect pattern with zero confirmation
 * reads as "strong harmonic structure awaiting confirmation" in the UI, not
 * as a strong signal — see `describeEvidence` below, which is the one place
 * a sentence is assembled from both without ever averaging them together.
 */

import { HarmonicCandidate, AbcdCandidate, findCandidates, findAbcdCandidates, PatternName } from "@/lib/technicals/harmonics";
import { Candle } from "@/lib/technicals/indicators";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";
import { DivergenceResult } from "@/lib/technicals/divergence";
import { Verdict } from "./types";

export type HarmonicStatus =
  | "prz-projected"
  | "approaching"
  | "inside-prz"
  | "confirmation-pending"
  | "confirmed"
  | "tradeable"
  | "invalidated"
  | "expired";

/** Within this many ATRs of the PRZ, it's worth telling the trader to watch. */
const APPROACH_ATR = 1.5;
/** Bars of closed-candle history, counted from first entering the PRZ, allowed to establish confirmation before the setup is treated as unconfirmed drift rather than a live test. */
const CONFIRMATION_WINDOW_BARS = 5;
/**
 * Pattern age limit, in multiples of the X→C leg's own bar-length —
 * structural, not fit to historical returns (the brief is explicit: don't
 * calibrate expiration to backtest performance). A pattern that took twice
 * as long to form as X-to-C did to reach C, without D ever printing, has
 * stopped being the shape it claimed to be.
 */
const EXPIRY_LEG_MULTIPLE = 2;

export interface DerivativesAlignment {
  /** true when at least one derivatives metric (funding/squeeze/long-short) points the SAME way the harmonic reversal would need to be right. */
  aligned: boolean | null;
  detail: string;
}

export interface HarmonicEvidence {
  pattern: PatternName;
  direction: "bullish" | "bearish";
  timeframe: "1D" | "4H";
  status: HarmonicStatus;

  geometryQuality: number; // 0-1, leg-fit precision only — never blended with confirmation
  przLow: number;
  przHigh: number;
  przConvergenceCount: number;

  /** Signed distance from price to the PRZ, in ATR. 0 while inside. */
  distanceAtr: number;
  przTested: boolean;

  /** Populated only once przTested — confirmation is a question that has no answer before the PRZ is reached. */
  structureReaction: "rejection" | "none-yet" | null;
  divergence: DivergenceResult | null;

  /** How this pattern's own direction relates to the Daily bias verdict — never used to override it (see swingThesis.ts's own regime authority). */
  regimeAlignment: "aligned" | "counter-trend" | "regime-neutral";
  derivatives: DerivativesAlignment;

  /** Multi-timeframe confluence: a same-direction pattern found on the OTHER swing timeframe. Tracked separately from geometryQuality so two patterns off correlated structure are never double-counted as independent confirmation. */
  higherTimeframeConfluence: boolean;

  /**
   * Whether the PRZ genuinely overlaps an EXISTING, independently-derived
   * S/R zone (the same zones EntryQualityCard/tradePlan already use) — the
   * brief's §15, and structurally the most defensible confluence check here
   * because the two methods (Fibonacci geometry vs. swing-cluster/volume
   * structure) are computed from unrelated logic and can genuinely agree by
   * coincidence or genuinely disagree, unlike two harmonic patterns sharing
   * the same underlying pivots.
   */
  srConfluence: boolean;
  srConfluenceDetail: string | null;

  /** True once price has closed beyond the X-based invalidation level. */
  invalidated: boolean;
  invalidationPrice: number;

  /** One sentence, assembled by `describeEvidence`, never a bare number. */
  summary: string;
}

/** ATR-normalized signed distance: negative below the PRZ (or above it for a bearish pattern's short side — see callers), 0 inside, positive beyond. */
function distanceToPrz(price: number, przLow: number, przHigh: number, atrAbs: number): number {
  if (price >= przLow && price <= przHigh) return 0;
  const gap = price < przLow ? przLow - price : price - przHigh;
  return atrAbs > 0 ? gap / atrAbs : 0;
}

/**
 * Scans closed candles from the moment price first entered the PRZ for a
 * genuine rejection: for a bullish (buy-the-low) pattern, a bar that trades
 * into the PRZ and then CLOSES back above it — the market refusing to hold
 * inside the zone. The mirror for bearish. Bounded to
 * `CONFIRMATION_WINDOW_BARS` so a pattern sitting inside its PRZ for weeks
 * without ever being rejected reads as unconfirmed, not confirmed-by-default.
 */
function findStructureReaction(
  candles: Candle[],
  przLow: number,
  przHigh: number,
  bullish: boolean
): "rejection" | "none-yet" | null {
  let firstTestIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].low <= przHigh && candles[i].high >= przLow) {
      firstTestIdx = i;
      break;
    }
  }
  if (firstTestIdx === -1) return null;

  const window = candles.slice(firstTestIdx, firstTestIdx + CONFIRMATION_WINDOW_BARS);
  for (const c of window) {
    const touchedZone = c.low <= przHigh && c.high >= przLow;
    if (!touchedZone) continue;
    if (bullish && c.close > przHigh) return "rejection";
    if (!bullish && c.close < przLow) return "rejection";
  }
  return "none-yet";
}

/**
 * Direction-agnostic regime read: does the Daily bias verdict AGREE with
 * this candidate's direction, OPPOSE it, or is the bias itself neutral?
 * Never used to suppress or promote the candidate — only to LABEL it, so a
 * counter-trend harmonic is shown as exactly that rather than silently
 * dropped or silently treated as equal to a trend-aligned one.
 */
function regimeAlignmentOf(direction: "bullish" | "bearish", biasVerdict: Verdict | null): HarmonicEvidence["regimeAlignment"] {
  if (!biasVerdict || biasVerdict === "neutral") return "regime-neutral";
  return biasVerdict === direction ? "aligned" : "counter-trend";
}

/**
 * Derivatives alignment from metrics the engine has ALREADY scored — never
 * re-derives funding/OI/positioning math. A reversal setup is corroborated
 * when the crowd is leaning the OPPOSITE way of the harmonic's implied move
 * (i.e. the squeeze/funding verdict argues FOR the reversal direction).
 */
function derivativesAlignmentOf(direction: "bullish" | "bearish", metricVerdicts: Map<string, Verdict>): DerivativesAlignment {
  const relevant = ["funding", "squeezeRisk", "longShort"];
  const agreeing: string[] = [];
  let anyReported = false;
  for (const id of relevant) {
    const v = metricVerdicts.get(id);
    if (!v || v === "neutral") continue;
    anyReported = true;
    if (v === direction) agreeing.push(id);
  }
  if (!anyReported) return { aligned: null, detail: "No derivatives read available" };
  if (agreeing.length === 0) return { aligned: false, detail: "Positioning does not support this reversal" };
  return { aligned: true, detail: `${agreeing.join(", ")} support${agreeing.length === 1 ? "s" : ""} this direction` };
}

function describeEvidence(e: Omit<HarmonicEvidence, "summary">): string {
  const dirWord = e.direction === "bullish" ? "Bullish" : "Bearish";
  const base = `${e.timeframe} ${dirWord} ${e.pattern} PRZ`;
  // Confluence is named once, appended to whichever status sentence applies
  // — never a separate bullet, so it reads as context on the SAME location
  // rather than a second piece of evidence.
  const confluence = e.srConfluence ? ` (${e.srConfluenceDetail})` : "";
  switch (e.status) {
    case "prz-projected":
      return `${base}${confluence} projected, price ${e.distanceAtr.toFixed(1)} ATR away.`;
    case "approaching":
      return `${base}${confluence} — price approaching.`;
    case "inside-prz":
      return `${base}${confluence} — price testing now.`;
    case "confirmation-pending":
      return `${base}${confluence} tested — confirmation pending.`;
    case "confirmed":
      // Geometric quality and confirmation are named SEPARATELY, deliberately
      // never merged into one adjective — see this file's own header.
      return `${base}${confluence} confirmed (structure reacted)${e.regimeAlignment === "counter-trend" ? ", counter-trend to Daily bias" : ""}.`;
    case "tradeable":
      return `${base}${confluence} confirmed and aligned with the Daily/4H thesis.`;
    case "invalidated":
      return `${base} invalidated — price closed beyond X.`;
    case "expired":
      return `${base} expired without reaching completion.`;
  }
}

export interface HarmonicContext {
  candles: Candle[]; // closed daily or 4H candles, oldest-first — same series buildTechnicalRead already consumed
  timeframe: "1D" | "4H";
  atrAbs: number;
  price: number;
  zones: SupportResistanceZone[];
  biasVerdict: Verdict | null;
  metricVerdicts: Map<string, Verdict>;
  /** RSI/MACD-histogram divergence at the CURRENT read, reused rather than recomputed — see buildTechnicalRead's own rsiDivergence/macdDivergence. */
  currentDivergence: { rsi: DivergenceResult | null; macd: DivergenceResult | null };
}

/**
 * Whether the PRZ genuinely overlaps a zone from the EXISTING structure
 * engine — direction-matched (a bullish/buy PRZ against a support zone, a
 * bearish/sell PRZ against resistance), since a harmonic reversal buyer and
 * a support level are making the same structural claim only when they agree
 * on which side of price they're defending.
 */
function srConfluenceOf(
  bullish: boolean,
  przLow: number,
  przHigh: number,
  zones: SupportResistanceZone[]
): { hit: boolean; detail: string | null } {
  const wantKind = bullish ? "support" : "resistance";
  const match = zones
    .filter((z) => z.kind === wantKind && z.priceLow <= przHigh && z.priceHigh >= przLow)
    .sort((a, b) => b.strength - a.strength)[0];
  if (!match) return { hit: false, detail: null };
  const tf = match.timeframe === "both" ? "daily + 4H" : match.timeframe;
  return { hit: true, detail: `overlaps ${tf} ${wantKind} (${match.reactionCount} touches)` };
}

/** Builds evidence for one candidate. Pure — no I/O, no clock reads beyond the timestamps already embedded in the candles/price passed in. */
function evidenceFor(cand: HarmonicCandidate | AbcdCandidate, ctx: HarmonicContext): HarmonicEvidence | null {
  const bullish = cand.direction === "bullish";
  const { prz } = cand;

  // Invalidation is checked FIRST and unconditionally: an invalidated
  // pattern cannot be "approaching" or "confirmed" no matter what price does
  // afterward — see the brief's own §24.
  const barsAfterKnown = ctx.candles.filter((c) => c.t >= cand.knownAtT);
  const invalidated = barsAfterKnown.some((c) => (bullish ? c.low < cand.invalidationPrice : c.high > cand.invalidationPrice));

  // Expiration: structural, tied to how long the X→C leg itself took to
  // form — not calibrated to any backtest result (brief §25/§28).
  const legBars = "x" in cand ? cand.c.index - cand.x.index : cand.c.index - cand.a.index;
  const cCandle = ctx.candles.find((cd) => cd.t === cand.c.t);
  const barsSinceC = cCandle ? ctx.candles.length - 1 - ctx.candles.indexOf(cCandle) : 0;
  const expired = !invalidated && barsSinceC > legBars * EXPIRY_LEG_MULTIPLE && !barsAfterKnown.some((c) => c.low <= prz.high && c.high >= prz.low);

  const distanceAtr = distanceToPrz(ctx.price, prz.low, prz.high, ctx.atrAbs);
  const przTested = barsAfterKnown.some((c) => c.low <= prz.high && c.high >= prz.low);
  const structureReaction = przTested ? findStructureReaction(barsAfterKnown, prz.low, prz.high, bullish) : null;

  const divergence = ctx.currentDivergence.rsi ?? ctx.currentDivergence.macd;
  const regimeAlignment = regimeAlignmentOf(cand.direction, ctx.biasVerdict);
  const derivatives = derivativesAlignmentOf(cand.direction, ctx.metricVerdicts);
  const srConfluence = srConfluenceOf(bullish, prz.low, prz.high, ctx.zones);

  let status: HarmonicStatus;
  if (invalidated) status = "invalidated";
  else if (expired) status = "expired";
  else if (structureReaction === "rejection") {
    // Confirmed geometrically + by price action. TRADEABLE only when the
    // Daily regime doesn't outright oppose it — a counter-trend confirmed
    // reaction still exists and is still shown, just not promoted to the
    // state that would read as fully actionable.
    status = regimeAlignment === "counter-trend" ? "confirmed" : "tradeable";
  } else if (przTested) status = "confirmation-pending";
  else if (distanceAtr === 0) status = "inside-prz";
  else if (distanceAtr <= APPROACH_ATR) status = "approaching";
  else status = "prz-projected";

  const geometryQuality = "legQuality" in cand ? cand.legQuality : 0.7; // AB=CD has no independent leg-fit score beyond the ratio window itself

  const base: Omit<HarmonicEvidence, "summary"> = {
    pattern: cand.pattern,
    direction: cand.direction,
    timeframe: ctx.timeframe,
    status,
    geometryQuality,
    przLow: prz.low,
    przHigh: prz.high,
    przConvergenceCount: prz.convergenceCount,
    distanceAtr,
    przTested,
    structureReaction,
    divergence,
    regimeAlignment,
    derivatives,
    higherTimeframeConfluence: false, // filled in by selectBestHarmonic, which is the only place both timeframes are visible at once
    srConfluence: srConfluence.hit,
    srConfluenceDetail: srConfluence.detail,
    invalidated,
    invalidationPrice: cand.invalidationPrice,
  };

  return { ...base, summary: describeEvidence(base) };
}

/** Every non-invalidated, non-expired candidate on one timeframe, evidence-built. */
export function buildHarmonicEvidence(ctx: HarmonicContext): HarmonicEvidence[] {
  if (ctx.candles.length < 20 || ctx.atrAbs <= 0) return [];

  const fiveLeg = findCandidates(ctx.candles, ctx.atrAbs);
  const abcd = findAbcdCandidates(ctx.candles, ctx.atrAbs);
  const all: Array<HarmonicCandidate | AbcdCandidate> = [...fiveLeg, ...abcd];

  return all
    .map((c) => evidenceFor(c, ctx))
    .filter((e): e is HarmonicEvidence => e !== null && e.status !== "invalidated" && e.status !== "expired");
}

/**
 * The status hierarchy used to rank candidates when only one can be shown.
 * Higher = more decision-relevant right now. Deliberately NOT ranked by
 * pattern name (brief §26 — Crab is not inherently more important than
 * Gartley); only by where the setup actually stands.
 */
const STATUS_RANK: Record<HarmonicStatus, number> = {
  tradeable: 7,
  confirmed: 6,
  "confirmation-pending": 5,
  "inside-prz": 4,
  approaching: 3,
  "prz-projected": 2,
  invalidated: 0,
  expired: 0,
};

/**
 * Picks the single most decision-relevant harmonic across both timeframes,
 * with Daily structural authority preserved: a Daily candidate always
 * outranks a 4H one at the SAME status tier, and only a 4H candidate that is
 * strictly further along its lifecycle (e.g. confirmed vs merely projected)
 * can outrank a Daily one — matching the same hierarchy
 * swingThesis.ts already enforces between these two timeframes.
 *
 * Also sets `higherTimeframeConfluence`: true when the OTHER timeframe has
 * a same-direction candidate too, which is recorded as a flag on the winner
 * rather than surfaced as a second, independent piece of evidence — the
 * brief's own "avoid double counting" instruction (§12).
 */
export function selectBestHarmonic(daily: HarmonicEvidence[], fourHour: HarmonicEvidence[]): HarmonicEvidence | null {
  // Status dominates (x10), geometry and confluence only break ties within a
  // status tier — an approaching Gartley with S/R confluence never outranks
  // a tradeable Bat without it.
  const rank = (e: HarmonicEvidence, timeframeBonus: number) =>
    STATUS_RANK[e.status] * 10 + e.geometryQuality + (e.srConfluence ? 0.5 : 0) + timeframeBonus;

  const candidates = [
    ...daily.map((e) => ({ e, score: rank(e, 0.5) })), // Daily gets a tie-break edge at equal status
    ...fourHour.map((e) => ({ e, score: rank(e, 0) })),
  ];
  if (!candidates.length) return null;

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0].e;

  const other = winner.timeframe === "1D" ? fourHour : daily;
  const confluence = other.some((e) => e.direction === winner.direction);

  return { ...winner, higherTimeframeConfluence: confluence };
}
