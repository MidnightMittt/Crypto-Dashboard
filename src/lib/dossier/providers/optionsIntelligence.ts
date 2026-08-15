import { TradierExpiryChain, TradierOptionRow } from "./tradierOptions";

/**
 * OPTIONS INTELLIGENCE — what the options market is pricing, and why it
 * matters for the trade on the page.
 *
 * Deliberately not a statistics panel. Every number here exists because it
 * changes a decision: an expected move smaller than the plan's first target
 * says the target needs volatility expansion; a gamma wall says where
 * hedging flows will resist; a liquidity score says whether any of it is
 * tradeable. Numbers that cannot be turned into that kind of sentence do not
 * belong in this module.
 *
 * ── Everything is measured, nothing is asserted ───────────────────────
 *
 * Each field is computed from the chain or returns null with a stated
 * reason. The composed sentences quote the numbers they were derived from,
 * so a reader can check any claim against the figure beside it. Where the
 * industry convention is an assumption rather than an observation — dealer
 * positioning above all — it is carried as a caveat wherever the number
 * goes, not buried in a footnote.
 *
 * ── What is deliberately absent, and why ──────────────────────────────
 *
 * IV RANK and IV PERCENTILE need a year of this symbol's own implied
 * volatility, and no such history is stored yet. They are reported as null
 * with the requirement named rather than approximated from realised
 * volatility, which measures a different thing and would quietly answer a
 * question nobody asked.
 */

export interface GammaWall {
  strike: number;
  kind: "call" | "put";
  /** gamma x open interest x 100 — the hedging weight sitting at that strike. */
  weight: number;
  distancePct: number;
}

export interface OptionsIntelligence {
  spot: number;
  frontExpiry: string;
  /** The ~monthly expiry an expected move is quoted over. */
  horizonExpiry: string | null;
  daysToHorizon: number | null;

  // ── What the market is pricing ──
  atmStraddlePrice: number | null;
  expectedMovePct: number | null;
  expectedMoveAbs: number | null;
  atmIvPct: number | null;
  realizedVolPct: number | null;
  /** Realised vol with the single largest session removed — see `realizedVol`. */
  realizedVolExJumpPct: number | null;
  /** True when one session drove the plain reading, so the comparison uses the ex-jump figure. */
  realizedVolJumpDominated: boolean;
  largestSessionMovePct: number | null;
  /** Implied minus realised, measured against whichever realised figure is honest here. */
  ivMinusRvPct: number | null;
  /** Put IV minus call IV at comparable distance out of the money. */
  skewPct: number | null;

  // ── Positioning ──
  putCallOiRatio: number | null;
  putCallVolumeRatio: number | null;
  maxPainStrike: number | null;
  netGexUsdPer1Pct: number | null;
  gammaWalls: GammaWall[];
  oiConcentrations: Array<{ strike: number; kind: "call" | "put"; openInterest: number; distancePct: number }>;

  // ── Activity ──
  chainVolume: number;
  chainAverageVolume: number;
  volumeVsAverage: number | null;
  unusual: Array<{ strike: number; kind: "call" | "put"; volume: number; openInterest: number; volumeOverOi: number }>;

  // ── Tradeability ──
  liquidityScore: number | null;
  liquidityLabel: string;

  // ── Does it agree with the engine? ──
  optionsLean: "bullish" | "bearish" | "neutral";
  agreesWithEngine: boolean | null;

  // ── Not yet measurable, named rather than faked ──
  ivRankPct: null;
  ivPercentile: null;
  ivHistoryRequirement: string;

  /** 0-100 — how much of the picture the chain actually supported. */
  confidence: number;
  /** One sentence a reader can stop at. */
  summary: string;
  /** The WHY, each sentence tied to a number above. */
  lines: string[];
  caveats: string[];
}

const mid = (r: TradierOptionRow): number | null =>
  r.bid !== null && r.ask !== null && r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : r.last ?? null;

const nearestStrike = (rows: TradierOptionRow[], spot: number): number | null => {
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => (Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best), rows[0].strike);
};

/**
 * MAX PAIN — the strike where the most option value expires worthless.
 *
 * Computed properly (total intrinsic payout across every strike), not by the
 * common shortcut of "strike with the most open interest", which is a
 * different quantity that happens to correlate. Returned only when the chain
 * has enough distinct strikes for the minimum to mean something.
 */
export function maxPain(rows: TradierOptionRow[]): number | null {
  const strikes = [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
  if (strikes.length < 5) return null;

  let best: { strike: number; pain: number } | null = null;
  for (const settle of strikes) {
    let pain = 0;
    for (const r of rows) {
      if (r.openInterest <= 0) continue;
      const intrinsic = r.kind === "call" ? Math.max(0, settle - r.strike) : Math.max(0, r.strike - settle);
      pain += intrinsic * r.openInterest;
    }
    if (best === null || pain < best.pain) best = { strike: settle, pain };
  }
  return best?.strike ?? null;
}

/**
 * A 0-100 tradeability score from the three things that decide whether a
 * retail order fills near its mid: relative spread, open interest and
 * volume, measured on the strikes nearest the money where anyone would
 * actually trade.
 */
export function liquidityScore(rows: TradierOptionRow[], spot: number): { score: number | null; label: string } {
  const atm = nearestStrike(rows, spot);
  if (atm === null || spot <= 0) return { score: null, label: "not measurable" };
  const near = rows.filter((r) => Math.abs(r.strike - spot) / spot <= 0.1);
  if (near.length < 4) return { score: null, label: "too few strikes near the money to judge" };

  const spreads: number[] = [];
  for (const r of near) {
    const m = mid(r);
    if (m && m > 0 && r.bid !== null && r.ask !== null && r.ask > r.bid) spreads.push((r.ask - r.bid) / m);
  }
  if (spreads.length === 0) return { score: null, label: "no two-sided quotes near the money" };

  const medianSpread = [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length / 2)];
  const oi = near.reduce((s, r) => s + r.openInterest, 0);
  const vol = near.reduce((s, r) => s + r.volume, 0);

  // Each leg 0-100, then the mean. Thresholds are conventional retail bars,
  // stated here rather than tuned against any outcome.
  const spreadScore = Math.max(0, Math.min(100, (1 - medianSpread / 0.25) * 100));
  const oiScore = Math.max(0, Math.min(100, (Math.log10(Math.max(1, oi)) / 4) * 100));
  const volScore = Math.max(0, Math.min(100, (Math.log10(Math.max(1, vol)) / 3.5) * 100));
  const score = Math.round((spreadScore + oiScore + volScore) / 3);

  const label =
    score >= 70 ? "liquid — orders should fill near the mid"
    : score >= 45 ? "workable — expect to give up some edge to the spread"
    : "thin — the spread will cost more than the edge on most trades";
  return { score, label };
}

/**
 * Implied vol of the contracts nearest the money, in percent.
 *
 * ── One expiry, enforced rather than assumed ──────────────────────────
 *
 * Implied vol has a TERM STRUCTURE: short-dated ATM vol on a volatile name
 * runs far above the long end, so an unweighted mean across expiries is
 * dominated by whichever tenor happens to contribute the most rows — a
 * number with no meaning, since "implied move" is undefined without a
 * horizon.
 *
 * Callers pass single-expiry chains today, so this was never wrong in
 * practice; but a signature that ACCEPTS mixed rows is a bug waiting for its
 * second caller. Taking the expiry explicitly makes the guarantee the
 * function's own rather than the caller's to remember.
 *
 * Units are already percent — normalised in the Tradier adapter, where the
 * unit is known. See `toRow`.
 */
export function atmIv(rows: TradierOptionRow[], spot: number, expiry?: string): number | null {
  const scoped = expiry === undefined ? rows : rows.filter((r) => r.expiry === expiry);
  const near = scoped.filter((r) => Math.abs(r.strike - spot) / spot <= 0.05 && r.iv !== null && r.iv > 0);
  if (near.length < 2) return null;
  return near.reduce((s, r) => s + (r.iv ?? 0), 0) / near.length;
}

/**
 * SKEW — what downside protection costs relative to upside participation.
 *
 * Compared at roughly equal distance either side of spot, because comparing
 * a 5%-out put with a 15%-out call would measure the distance, not the skew.
 */
export function skew(
  rows: TradierOptionRow[],
  spot: number,
  targetPct = 0.07,
  expiry?: string
): number | null {
  // Same term-structure argument as `atmIv`: a put from one expiry against a
  // call from another measures the calendar, not the skew.
  const scoped = expiry === undefined ? rows : rows.filter((r) => r.expiry === expiry);
  const pick = (kind: "call" | "put") => {
    const side = scoped.filter(
      (r) => r.kind === kind && r.iv !== null && r.iv > 0 && (kind === "call" ? r.strike > spot : r.strike < spot)
    );
    if (side.length === 0) return null;
    const want = kind === "call" ? spot * (1 + targetPct) : spot * (1 - targetPct);
    return side.reduce((best, r) => (Math.abs(r.strike - want) < Math.abs(best.strike - want) ? r : best), side[0]);
  };
  const c = pick("call");
  const p = pick("put");
  if (!c || !p || c.iv === null || p.iv === null) return null;
  // Both already percent, normalised in the adapter. The `< 3` guess that
  // used to live here is gone — see `toRow` for why it was dangerous.
  return p.iv - c.iv;
}

const annualise = (rets: number[]): number => {
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
};

export interface RealizedVol {
  /** Annualised standard deviation over the window, in percent. */
  pct: number;
  /** The same, with the single largest absolute session removed. */
  exJumpPct: number;
  /** That session's return, in percent. */
  largestMovePct: number;
  /**
   * True when one session is doing most of the work. Volatility is a squared
   * measure, so a single earnings gap can lift a 20-day reading by fifteen
   * points on its own.
   */
  jumpDominated: boolean;
}

/**
 * REALISED VOLATILITY, and how much of it is one day.
 *
 * The plain 20-day number is the convention, and on its own it misleads
 * after an earnings gap. AAPL measured 35% purely because one 7.4% session
 * sat inside the window — which made 22% implied look "cheap" when the event
 * that caused the move had already happened and cannot repeat before expiry.
 * The ten-day reading over the same stretch was 19%.
 *
 * So both are computed and the caller is told when they disagree. An
 * interpretation that flips on a single observation has to say so rather
 * than quietly pick a side.
 */
export function realizedVol(closes: number[], window = 20): RealizedVol | null {
  if (closes.length < window + 1) return null;
  const rets: number[] = [];
  for (let i = closes.length - window; i < closes.length; i++) {
    if (closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 6) return null;

  const pct = annualise(rets);
  const biggestIdx = rets.reduce((b, r, i) => (Math.abs(r) > Math.abs(rets[b]) ? i : b), 0);
  const exJumpPct = annualise(rets.filter((_, i) => i !== biggestIdx));
  return {
    pct,
    exJumpPct,
    largestMovePct: (Math.exp(rets[biggestIdx]) - 1) * 100,
    jumpDominated: pct - exJumpPct > 8,
  };
}

const HOT_VOL_OVER_OI = 2;
const HOT_MIN_VOLUME = 250;

export interface IntelligenceInputs {
  chains: TradierExpiryChain[];
  spot: number;
  /** Daily closes for realised vol — the same bars the rest of the page uses. */
  closes: number[];
  /** The engine's own direction, for the agreement check. */
  engineVerdict: "bullish" | "bearish" | "neutral";
  /** The plan's first target, when one exists — the expected-move comparison. */
  firstTargetPct: number | null;
  now: number;
}

/**
 * Expiries with less than this long to run are excluded from every figure
 * below.
 *
 * Not a tuning knob — a correctness rule. AAPL's chain expiring the same
 * afternoon carried 630,851 contracts against 9,153 in the September expiry,
 * so leaving it in meant the 0DTE session decided the put/call ratio, the
 * unusual-activity list, the gamma walls and the net gamma. Worse, it did so
 * wrongly: expiry-day volume-to-open-interest ratios explode mechanically
 * because open interest has already been drained and same-day traders open
 * and close within the session, so the rule that reads "volume far above
 * open interest means new positions" is exactly backwards there.
 *
 * Same-day flow is real, it is simply a different question — intraday
 * positioning, not the standing book this section is about.
 */
const MIN_DAYS_TO_EXPIRY = 1;

export function buildOptionsIntelligence(inputs: IntelligenceInputs): OptionsIntelligence | null {
  const { chains: allChains, spot, closes, engineVerdict, firstTargetPct, now } = inputs;
  if (allChains.length === 0 || spot <= 0) return null;

  const daysTo = (expiry: string) => (Date.parse(`${expiry}T00:00:00Z`) - now) / 86_400_000;
  const chains = allChains.filter((c) => daysTo(c.expiry) >= MIN_DAYS_TO_EXPIRY);
  if (chains.length === 0) return null;

  const front = chains[0];
  const horizon = chains.length > 1 ? chains[chains.length - 1] : chains[0];
  const daysToHorizon = Math.round((Date.parse(`${horizon.expiry}T00:00:00Z`) - now) / 86_400_000);

  // ── Expected move from the ATM straddle on the horizon expiry ──
  const hRows = horizon.rows;
  const atmStrike = nearestStrike(hRows, spot);
  const call = hRows.find((r) => r.strike === atmStrike && r.kind === "call");
  const put = hRows.find((r) => r.strike === atmStrike && r.kind === "put");
  const cMid = call ? mid(call) : null;
  const pMid = put ? mid(put) : null;
  const atmStraddlePrice = cMid !== null && pMid !== null ? cMid + pMid : null;
  const expectedMoveAbs = atmStraddlePrice;
  const expectedMovePct = atmStraddlePrice !== null ? (atmStraddlePrice / spot) * 100 : null;

  const atmIvPct = atmIv(hRows, spot, horizon.expiry) ?? atmIv(front.rows, spot, front.expiry);
  const rv = realizedVol(closes);
  const realizedVolPct = rv?.pct ?? null;
  /*
   * The comparison is made against the JUMP-ROBUST realised vol when one
   * session dominates the window. A gap that already happened cannot repeat
   * before expiry, so pricing options against it would call them cheap on
   * the strength of an event that is over. Both numbers are still reported;
   * only the verdict uses the robust one, and the sentence says so.
   */
  const rvForComparison = rv === null ? null : rv.jumpDominated ? rv.exJumpPct : rv.pct;
  const ivMinusRvPct = atmIvPct !== null && rvForComparison !== null ? atmIvPct - rvForComparison : null;
  const skewPct = skew(hRows, spot, undefined, horizon.expiry) ?? skew(front.rows, spot, undefined, front.expiry);

  // ── Positioning across every fetched expiry ──
  const all = chains.flatMap((c) => c.rows);
  const callOi = all.filter((r) => r.kind === "call").reduce((s, r) => s + r.openInterest, 0);
  const putOi = all.filter((r) => r.kind === "put").reduce((s, r) => s + r.openInterest, 0);
  const callVol = all.filter((r) => r.kind === "call").reduce((s, r) => s + r.volume, 0);
  const putVol = all.filter((r) => r.kind === "put").reduce((s, r) => s + r.volume, 0);

  /*
   * Gamma walls are aggregated BY STRIKE, across kinds and expiries.
   * Hedging pressure at a price level is the sum of everything sitting
   * there — listing the 305 calls and the 305 puts and the 305 calls of the
   * next expiry as three separate "walls" named one level three times and
   * crowded out the second and third real levels.
   */
  let gex = 0;
  let sawGamma = false;
  const byStrike = new Map<number, { weight: number; callWeight: number; putWeight: number }>();
  for (const r of all) {
    if (r.gamma !== null && r.gamma !== 0 && r.openInterest > 0) {
      sawGamma = true;
      const sign = r.kind === "call" ? 1 : -1;
      gex += sign * r.gamma * r.openInterest * 100 * spot * (spot * 0.01);
      const w = Math.abs(r.gamma) * r.openInterest * 100;
      const cur = byStrike.get(r.strike) ?? { weight: 0, callWeight: 0, putWeight: 0 };
      cur.weight += w;
      if (r.kind === "call") cur.callWeight += w;
      else cur.putWeight += w;
      byStrike.set(r.strike, cur);
    }
  }
  const walls: GammaWall[] = [...byStrike.entries()]
    .map(([strike, w]) => ({
      strike,
      // Which side dominates the level, so the label describes the level's own character.
      kind: (w.callWeight >= w.putWeight ? "call" : "put") as "call" | "put",
      weight: w.weight,
      distancePct: ((strike - spot) / spot) * 100,
    }))
    .sort((a, b) => b.weight - a.weight);

  const oiConcentrations = [...all]
    .filter((r) => r.openInterest > 0)
    .sort((a, b) => b.openInterest - a.openInterest)
    .slice(0, 3)
    .map((r) => ({
      strike: r.strike,
      kind: r.kind,
      openInterest: r.openInterest,
      distancePct: ((r.strike - spot) / spot) * 100,
    }));

  const chainVolume = all.reduce((s, r) => s + r.volume, 0);
  const chainAverageVolume = all.reduce((s, r) => s + r.averageVolume, 0);
  const volumeVsAverage = chainAverageVolume > 0 ? chainVolume / chainAverageVolume : null;

  const unusual = all
    .filter((r) => r.volume >= HOT_MIN_VOLUME && r.volume >= HOT_VOL_OVER_OI * Math.max(r.openInterest, 1))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3)
    .map((r) => ({
      strike: r.strike,
      kind: r.kind,
      volume: r.volume,
      openInterest: r.openInterest,
      volumeOverOi: r.volume / Math.max(r.openInterest, 1),
    }));

  const { score: liqScore, label: liquidityLabel } = liquidityScore(front.rows, spot);

  /*
   * THE OPTIONS LEAN, from two independent readings that must agree.
   *
   * Skew says what protection costs; call-vs-put volume says where today's
   * money went. Requiring both to point the same way is what stops a single
   * lopsided session being read as positioning — and when they disagree the
   * honest answer is neutral, not a tiebreak.
   */
  const volLean = callVol > 0 || putVol > 0 ? (putVol / Math.max(callVol, 1) < 0.7 ? 1 : putVol / Math.max(callVol, 1) > 1.3 ? -1 : 0) : 0;
  const skewLean = skewPct === null ? 0 : skewPct > 3 ? -1 : skewPct < -1 ? 1 : 0;
  const optionsLean: OptionsIntelligence["optionsLean"] =
    volLean === 1 && skewLean >= 0 ? "bullish" : volLean === -1 && skewLean <= 0 ? "bearish" : "neutral";

  const agreesWithEngine =
    engineVerdict === "neutral" || optionsLean === "neutral" ? null : optionsLean === engineVerdict;

  // ── Confidence: how much of the picture the chain actually supported ──
  const have = [atmStraddlePrice, atmIvPct, skewPct, liqScore, maxPain(hRows), sawGamma ? 1 : null].filter(
    (x) => x !== null
  ).length;
  const confidence = Math.round((have / 6) * 100);

  const intel: OptionsIntelligence = {
    spot,
    frontExpiry: front.expiry,
    horizonExpiry: horizon.expiry,
    daysToHorizon,
    atmStraddlePrice,
    expectedMovePct,
    expectedMoveAbs,
    atmIvPct,
    realizedVolPct,
    realizedVolExJumpPct: rv?.exJumpPct ?? null,
    realizedVolJumpDominated: rv?.jumpDominated ?? false,
    largestSessionMovePct: rv?.largestMovePct ?? null,
    ivMinusRvPct,
    skewPct,
    putCallOiRatio: callOi > 0 ? putOi / callOi : null,
    putCallVolumeRatio: callVol > 0 ? putVol / callVol : null,
    maxPainStrike: maxPain(hRows),
    netGexUsdPer1Pct: sawGamma ? gex : null,
    gammaWalls: walls.slice(0, 3),
    oiConcentrations,
    chainVolume,
    chainAverageVolume,
    volumeVsAverage,
    unusual,
    liquidityScore: liqScore,
    liquidityLabel,
    optionsLean,
    agreesWithEngine,
    ivRankPct: null,
    ivPercentile: null,
    ivHistoryRequirement:
      "IV rank and IV percentile need a year of this symbol's own implied volatility, which is not recorded yet. Approximating them from realised volatility would answer a different question, so they are left blank until the history exists.",
    confidence,
    summary: "",
    lines: [],
    caveats: [],
  };

  intel.lines = composeLines(intel, firstTargetPct);
  intel.summary = composeSummary(intel);
  intel.caveats = [
    "Gamma exposure assumes the standard dealer convention (dealers long the calls customers bought, short the puts). That is an industry assumption, not an observation — true dealer inventory is not public.",
    "Quotes are 15-minute delayed, the same delay the rest of the options section carries.",
  ];
  return intel;
}

/**
 * The WHY. Each sentence names the number it came from, so nothing here can
 * be read as an opinion the data does not support.
 */
function composeLines(i: OptionsIntelligence, firstTargetPct: number | null): string[] {
  const out: string[] = [];

  if (i.expectedMovePct !== null && i.daysToHorizon !== null) {
    const base = `The options market is pricing a move of about ±${i.expectedMovePct.toFixed(1)}% (±$${i.expectedMoveAbs?.toFixed(2)}) by ${i.horizonExpiry}, ${i.daysToHorizon} days out — that is what the at-the-money straddle costs.`;
    if (firstTargetPct !== null && firstTargetPct > 0) {
      out.push(
        firstTargetPct > i.expectedMovePct
          ? `${base} The plan's first target needs +${firstTargetPct.toFixed(1)}%, MORE than the options market expects over that whole period — reaching it requires volatility to expand beyond what is currently priced, not just direction to be right.`
          : `${base} The plan's first target needs +${firstTargetPct.toFixed(1)}%, comfortably inside that range, so the target does not depend on volatility expanding.`
      );
    } else {
      out.push(base);
    }
  }

  if (i.ivMinusRvPct !== null && i.atmIvPct !== null && i.realizedVolPct !== null) {
    // The figure the verdict was actually measured against.
    const against = i.realizedVolJumpDominated ? i.realizedVolExJumpPct! : i.realizedVolPct;
    const verdict =
      i.ivMinusRvPct > 5
        ? `Implied volatility (${i.atmIvPct.toFixed(0)}%) sits ${i.ivMinusRvPct.toFixed(0)} points above what the stock has actually delivered (${against.toFixed(0)}%). Options are expensive relative to recent movement — buying premium here pays for movement the stock has not been making.`
        : i.ivMinusRvPct < -5
          ? `Implied volatility (${i.atmIvPct.toFixed(0)}%) sits ${Math.abs(i.ivMinusRvPct).toFixed(0)} points BELOW realised (${against.toFixed(0)}%). Options are cheap relative to how much this stock has actually been moving.`
          : `Implied volatility (${i.atmIvPct.toFixed(0)}%) is close to realised (${against.toFixed(0)}%), so options are priced roughly in line with recent movement.`;

    /*
     * When one session drove the raw number, say which one and why it was
     * set aside. Silently substituting the robust figure would be the same
     * kind of hidden choice this module exists to avoid.
     */
    out.push(
      i.realizedVolJumpDominated && i.largestSessionMovePct !== null
        ? `${verdict} That comparison excludes a single ${i.largestSessionMovePct >= 0 ? "+" : ""}${i.largestSessionMovePct.toFixed(1)}% session, which on its own lifts the raw 20-day figure to ${i.realizedVolPct.toFixed(0)}%. A gap that has already happened cannot repeat before this expiry, so pricing against it would call these options cheap on the strength of an event that is over.`
        : verdict
    );
  }

  if (i.skewPct !== null) {
    out.push(
      i.skewPct > 3
        ? `Downside protection is expensive: puts about 7% out of the money carry ${i.skewPct.toFixed(1)} more volatility points than the equivalent calls. Someone is paying up to hedge, which is a caution flag under a bullish read.`
        : i.skewPct < -1
          ? `Upside calls are bid over downside puts by ${Math.abs(i.skewPct).toFixed(1)} volatility points — unusual, and the shape that accompanies speculative upside positioning.`
          : `Put and call volatility are within ${Math.abs(i.skewPct).toFixed(1)} points of each other, so the chain shows no strong directional hedging demand.`
    );
  }

  if (i.gammaWalls.length > 0 && i.netGexUsdPer1Pct !== null) {
    const w = i.gammaWalls[0];
    out.push(
      `The heaviest hedging weight sits at the ${w.strike} ${w.kind}s, ${Math.abs(w.distancePct).toFixed(1)}% ${w.distancePct >= 0 ? "above" : "below"} here. ` +
        (i.netGexUsdPer1Pct > 0
          ? "Net dealer gamma is positive under the standard convention, which means hedging tends to SELL rallies and BUY dips — a dampening force that makes large moves less likely while it holds."
          : "Net dealer gamma is negative under the standard convention, which means hedging tends to sell into weakness and buy into strength — an amplifying force that makes sharp moves more likely.")
    );
  }

  if (i.maxPainStrike !== null) {
    const d = ((i.maxPainStrike - i.spot) / i.spot) * 100;
    out.push(
      `Max pain for ${i.horizonExpiry} is ${i.maxPainStrike}, ${Math.abs(d).toFixed(1)}% ${d >= 0 ? "above" : "below"} the current price — the level where the most option value would expire worthless. It is a gravity argument, not a forecast, and it matters most in the last days before expiry.`
    );
  }

  if (i.unusual.length > 0) {
    const u = i.unusual[0];
    out.push(
      `Unusual activity: the ${u.strike} ${u.kind}s traded ${u.volume.toLocaleString()} contracts against ${u.openInterest.toLocaleString()} open — ${u.volumeOverOi.toFixed(1)}× more than could be closing, so new positions are being opened there. Whether it is outright or one leg of a spread is not knowable from the tape.`
    );
  }

  if (i.volumeVsAverage !== null) {
    out.push(
      i.volumeVsAverage >= 2
        ? `Total chain volume is running ${i.volumeVsAverage.toFixed(1)}× its own average — this name has the options market's attention today.`
        : i.volumeVsAverage <= 0.5
          ? `Chain volume is only ${(i.volumeVsAverage * 100).toFixed(0)}% of average, so today's options prints are thin evidence about anything.`
          : `Chain volume is about ${i.volumeVsAverage.toFixed(1)}× average — ordinary participation.`
    );
  }

  if (i.liquidityScore !== null) {
    out.push(`Option liquidity scores ${i.liquidityScore}/100 near the money: ${i.liquidityLabel}.`);
  }

  if (i.agreesWithEngine === true) {
    out.push(`Options positioning leans ${i.optionsLean}, the same way the engine reads the chart — an independent source agreeing with the decision above.`);
  } else if (i.agreesWithEngine === false) {
    out.push(`Options positioning leans ${i.optionsLean}, the OPPOSITE of the engine's read. One of the two is wrong, and this disagreement is a reason to size smaller rather than to ignore either.`);
  } else {
    out.push(`Options positioning is not leaning either way, so the chain neither supports nor contests the decision above.`);
  }

  return out;
}

function composeSummary(i: OptionsIntelligence): string {
  const parts: string[] = [];
  if (i.expectedMovePct !== null) parts.push(`±${i.expectedMovePct.toFixed(1)}% priced by ${i.horizonExpiry}`);
  if (i.ivMinusRvPct !== null) {
    parts.push(i.ivMinusRvPct > 5 ? "options expensive vs realised" : i.ivMinusRvPct < -5 ? "options cheap vs realised" : "options fairly priced");
  }
  if (i.agreesWithEngine === false) parts.push("positioning disagrees with the chart");
  else if (i.agreesWithEngine === true) parts.push("positioning agrees with the chart");
  if (i.liquidityScore !== null && i.liquidityScore < 45) parts.push("thin liquidity");
  return parts.length > 0 ? parts.join(" · ") : "Chain read, nothing decision-relevant stood out.";
}
