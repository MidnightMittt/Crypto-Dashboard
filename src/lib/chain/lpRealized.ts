import { POSITION } from "./config";
import { sqrtPriceAtTick } from "./uniV3Math";

/**
 * THE REALIZED LP RECORD, RECONSTRUCTED FROM LOGS.
 *
 * ── Why this exists, and why it beats the thing it replaces ───────────
 *
 * The fee-rate series this repo built in P0 samples live state every 6h and
 * cannot be backfilled, because the RPC prunes state within minutes. That
 * design was correct for its purpose and useless for one specific question:
 * "what did the position actually earn over its life?" — because the series
 * only begins when the cron begins.
 *
 * LOGS ARE NOT PRUNED. Measured 2026-10-01: filtered eth_getLogs returns
 * results 40M+ blocks back (~44 days) with no error, and allows 10,000,000-
 * block spans per query — not the 20k the earlier brief assumed, which makes
 * a full-history sweep eight queries instead of thousands.
 *
 * That changes the evidence available. Every Collect event on our tokenId is
 * a REALIZED fee receipt at a known block; every Increase/Decrease is an
 * exact liquidity and principal flow. Together they are the position's
 * complete financial history, wei-precise, independent of any snapshot having
 * been taken at the time. This module turns those events into the record.
 *
 * Realized beats accrued: an accrual computed from fee-growth accumulators is
 * an estimate of what is owed; a Collect is what was actually received.
 *
 * ── The pairing subtlety that makes fee extraction correct ───────────
 *
 * A Collect in the SAME BLOCK as a Decrease returns principal + fees
 * together. Reading such a Collect as "fees" overstates them enormously — the
 * 2026-09-27 close collected 211.47 PONS of which 210.25 was principal and
 * only 1.23 was fee. So a Collect paired with a same-block Decrease has the
 * Decrease amounts subtracted; an unpaired Collect is pure fee.
 *
 * ── Unit-free by design ───────────────────────────────────────────────
 *
 * Fee yield and LVR coverage are computed as RATIOS in PONS terms, so no
 * historical USD price is needed and none is invented. A USD figure would
 * require a dated ETH/USD series we do not hold for past dates, and quoting
 * one would import an unverifiable number into the one place it must not be.
 */

/** A decoded position event, dated. */
export interface DatedPositionEvent {
  block: number;
  tsMs: number;
  kind: "collect" | "increase" | "decrease";
  /** Raw wei amounts as the event carried them. */
  amount0: bigint;
  amount1: bigint;
  /** Signed liquidity delta: +increase, -decrease, 0n for collect. */
  liquidityDelta: bigint;
}

/** One sampled point of the pool's tick series, from Swap logs. */
export interface TickSample {
  block: number;
  tick: number;
}

/** A realized fee interval: Collect to Collect, with its measured context. */
export interface FeeInterval {
  fromBlock: number;
  toBlock: number;
  fromIso: string;
  toIso: string;
  days: number;
  /** Fee amounts realized at the closing Collect, wei. */
  fee0Wei: bigint;
  fee1Wei: bigint;
  /** Liquidity held over the interval (at its start). */
  liquidity: bigint;
  /** Mean tick over the interval, from the sampled series. Null with no samples. */
  avgTick: number | null;
  /** Daily sigma of the PONS/ETH price from the pool's own ticks. Null if too few samples. */
  sigmaDaily: number | null;
  /** sigma^2/8 — the daily LVR as a fraction of position value. */
  lvrDaily: number | null;
  /**
   * Realized fees as a fraction of position value, per day. NULL when the
   * interval has no duration or no tick samples — a zero-length interval (the
   * close's second Collect, seconds after the first) has no rate, and NaN in a
   * committed artefact is the kind of value that silently poisons a chart.
   */
  feeYieldDaily: number | null;
  /** feeYield / LVR. Above 1 means fees paid for the volatility's implied loss. */
  coverage: number | null;
  /** Tick samples the sigma rests on — the sample size travels with the claim. */
  tickSamples: number;
}

export interface RealizedRecord {
  openedIso: string;
  closedIso: string | null;
  /** True when the liquidity timeline nets to exactly zero. */
  isClosed: boolean;
  /** Liquidity implied by summing every event delta. Zero for a closed position. */
  finalLiquidity: bigint;
  lifeDays: number;
  deposited: { weth: number; pons: number };
  /** Every Collect summed: principal returned PLUS fees. */
  withdrawn: { weth: number; pons: number };
  /** Fees only, with same-block principal removed. */
  fees: { weth: number; pons: number };
  intervals: FeeInterval[];
  /** Fraction of sampled ticks inside the declared range — fees only accrue in range. */
  inRangeFraction: number | null;
  /** Whole-life fee yield vs LVR. */
  lifeCoverage: number | null;
  lifeSigmaDaily: number | null;
  /**
   * LP outcome against simply holding the deposited tokens, in WETH terms at
   * the closing tick. The honest bottom line: LVR coverage is a theoretical
   * benchmark, this is what happened.
   */
  vsHodlPct: number | null;
  closingTick: number | null;
}

const WEI = 1e18;
const LN_1_0001 = Math.log(1.0001);

/** Liquidity after each event, in block order. */
export function liquidityTimeline(events: readonly DatedPositionEvent[]): { block: number; liquidity: bigint }[] {
  const out: { block: number; liquidity: bigint }[] = [];
  let L = 0n;
  for (const e of [...events].sort((a, b) => a.block - b.block)) {
    if (e.liquidityDelta === 0n) continue;
    L += e.liquidityDelta;
    out.push({ block: e.block, liquidity: L });
  }
  return out;
}

/** Liquidity in force at a block, from the timeline. */
export function liquidityAt(timeline: readonly { block: number; liquidity: bigint }[], block: number): bigint {
  let L = 0n;
  for (const p of timeline) if (p.block <= block) L = p.liquidity;
  return L;
}

/**
 * Fee-only receipts. A Collect sharing a block with a Decrease has the
 * Decrease's principal subtracted; an unpaired Collect is pure fee.
 */
export function feeReceipts(
  events: readonly DatedPositionEvent[]
): { block: number; tsMs: number; fee0: bigint; fee1: bigint; principalRemoved: boolean }[] {
  const decreaseByBlock = new Map<number, { a0: bigint; a1: bigint }>();
  for (const e of events) {
    if (e.kind !== "decrease") continue;
    const cur = decreaseByBlock.get(e.block) ?? { a0: 0n, a1: 0n };
    decreaseByBlock.set(e.block, { a0: cur.a0 + e.amount0, a1: cur.a1 + e.amount1 });
  }
  return events
    .filter((e) => e.kind === "collect")
    .sort((a, b) => a.block - b.block)
    .map((e) => {
      const d = decreaseByBlock.get(e.block);
      return {
        block: e.block,
        tsMs: e.tsMs,
        fee0: d ? e.amount0 - d.a0 : e.amount0,
        fee1: d ? e.amount1 - d.a1 : e.amount1,
        principalRemoved: d !== undefined,
      };
    });
}

/** Position token amounts at a tick, clamped to the range. Whole tokens. */
function amountsAt(L: bigint, tick: number, lower: number, upper: number): { weth: number; pons: number } {
  const t = Math.min(Math.max(tick, lower), upper);
  const Ln = Number(L);
  return {
    weth: (Ln * (1 / sqrtPriceAtTick(t) - 1 / sqrtPriceAtTick(upper))) / WEI,
    pons: (Ln * (sqrtPriceAtTick(t) - sqrtPriceAtTick(lower))) / WEI,
  };
}

/** PONS per WETH at a tick — the conversion that makes the record unit-free. */
export function ponsPerWeth(tick: number): number {
  return Math.pow(1.0001, tick);
}

/** Daily sigma of the PONS/ETH price from a sampled tick series. */
export function sigmaFromTickSamples(samples: readonly TickSample[], blocksPerSecond: number): number | null {
  if (samples.length < 3) return null;
  const s = [...samples].sort((a, b) => a.block - b.block);
  const rets: number[] = [];
  const gapsHours: number[] = [];
  for (let i = 1; i < s.length; i++) {
    rets.push(-(s[i].tick - s[i - 1].tick) * LN_1_0001);
    gapsHours.push((s[i].block - s[i - 1].block) / blocksPerSecond / 3600);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const variance = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1);
  const meanGap = gapsHours.reduce((a, x) => a + x, 0) / gapsHours.length;
  if (!(meanGap > 0)) return null;
  return Math.sqrt(variance) * Math.sqrt(24 / meanGap);
}

/**
 * The whole record. `events` must be every position event ever (the full-
 * history sweep); `ticks` a sampled tick series over the same span.
 */
export function buildRealizedRecord(
  events: readonly DatedPositionEvent[],
  ticks: readonly TickSample[],
  blocksPerSecond: number,
  lower = POSITION.tickLower,
  upper = POSITION.tickUpper
): RealizedRecord | null {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.block - b.block);
  const timeline = liquidityTimeline(sorted);
  const finalLiquidity = timeline.length ? timeline[timeline.length - 1].liquidity : 0n;
  const isClosed = finalLiquidity === 0n;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const lifeDays = (last.tsMs - first.tsMs) / 86_400_000;

  let dep0 = 0n, dep1 = 0n, wd0 = 0n, wd1 = 0n;
  for (const e of sorted) {
    if (e.kind === "increase") { dep0 += e.amount0; dep1 += e.amount1; }
    if (e.kind === "collect") { wd0 += e.amount0; wd1 += e.amount1; }
  }

  const receipts = feeReceipts(sorted);
  const fee0 = receipts.reduce((a, r) => a + r.fee0, 0n);
  const fee1 = receipts.reduce((a, r) => a + r.fee1, 0n);

  // Intervals run from the position's open, then Collect to Collect.
  const intervals: FeeInterval[] = [];
  let prevBlock = first.block;
  let prevTs = first.tsMs;
  for (const r of receipts) {
    const days = (r.tsMs - prevTs) / 86_400_000;
    const seg = ticks.filter((t) => t.block >= prevBlock && t.block <= r.block);
    const avgTick = seg.length ? seg.reduce((a, t) => a + t.tick, 0) / seg.length : null;
    const sigmaDaily = sigmaFromTickSamples(seg, blocksPerSecond);
    const L = liquidityAt(timeline, prevBlock);
    let feeYieldDaily: number | null = null;
    let coverage: number | null = null;
    let lvrDaily: number | null = null;
    if (days > 0 && avgTick !== null && L > 0n) {
      const pw = ponsPerWeth(avgTick);
      const pos = amountsAt(L, avgTick, lower, upper);
      const valuePons = pos.pons + pos.weth * pw;
      const feePons = Number(r.fee1) / WEI + (Number(r.fee0) / WEI) * pw;
      if (valuePons > 0) feeYieldDaily = feePons / valuePons / days;
      if (sigmaDaily !== null) {
        lvrDaily = (sigmaDaily * sigmaDaily) / 8;
        if (lvrDaily > 0 && feeYieldDaily !== null) coverage = feeYieldDaily / lvrDaily;
      }
    }
    intervals.push({
      fromBlock: prevBlock,
      toBlock: r.block,
      fromIso: new Date(prevTs).toISOString(),
      toIso: new Date(r.tsMs).toISOString(),
      days,
      fee0Wei: r.fee0,
      fee1Wei: r.fee1,
      liquidity: L,
      avgTick,
      sigmaDaily,
      lvrDaily,
      feeYieldDaily,
      coverage,
      tickSamples: seg.length,
    });
    prevBlock = r.block;
    prevTs = r.tsMs;
  }

  const inRange = ticks.length
    ? ticks.filter((t) => t.tick >= lower && t.tick < upper).length / ticks.length
    : null;
  const lifeSigma = sigmaFromTickSamples(ticks, blocksPerSecond);
  const closingTick = ticks.length ? [...ticks].sort((a, b) => a.block - b.block)[ticks.length - 1].tick : null;

  // Whole-life coverage, on the mean tick and the modal liquidity.
  let lifeCoverage: number | null = null;
  if (lifeSigma !== null && ticks.length && lifeDays > 0) {
    const avgTick = ticks.reduce((a, t) => a + t.tick, 0) / ticks.length;
    const pw = ponsPerWeth(avgTick);
    const Lmid = liquidityAt(timeline, Math.floor((first.block + last.block) / 2));
    const pos = amountsAt(Lmid, avgTick, lower, upper);
    const valuePons = pos.pons + pos.weth * pw;
    const feePons = Number(fee1) / WEI + (Number(fee0) / WEI) * pw;
    const lvr = (lifeSigma * lifeSigma) / 8;
    if (valuePons > 0 && lvr > 0) lifeCoverage = feePons / valuePons / lifeDays / lvr;
  }

  /*
   * LP vs HODL, in WETH terms at the closing tick. Deposits are summed
   * without time-weighting — later top-ups entered at different prices, so
   * this is an approximation and labelled as one. It is still the right
   * bottom line: the alternative to providing liquidity was holding the
   * tokens, and this compares exactly those two bundles.
   */
  let vsHodlPct: number | null = null;
  if (closingTick !== null) {
    const pw = ponsPerWeth(closingTick);
    const lpWeth = Number(wd0) / WEI + Number(wd1) / WEI / pw;
    const hodlWeth = Number(dep0) / WEI + Number(dep1) / WEI / pw;
    if (hodlWeth > 0) vsHodlPct = (lpWeth / hodlWeth - 1) * 100;
  }

  return {
    openedIso: new Date(first.tsMs).toISOString(),
    closedIso: isClosed ? new Date(last.tsMs).toISOString() : null,
    isClosed,
    finalLiquidity,
    lifeDays,
    deposited: { weth: Number(dep0) / WEI, pons: Number(dep1) / WEI },
    withdrawn: { weth: Number(wd0) / WEI, pons: Number(wd1) / WEI },
    fees: { weth: Number(fee0) / WEI, pons: Number(fee1) / WEI },
    intervals,
    inRangeFraction: inRange,
    lifeCoverage,
    lifeSigmaDaily: lifeSigma,
    vsHodlPct,
    closingTick,
  };
}
