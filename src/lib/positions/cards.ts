import { BOOK, BookPosition, LpV3Position, LpV4Position, Thesis } from "./book";
import { PositionRead, ThesisVerdict, coverage, evaluateThesis, lpKeepFraction, yieldReading, YieldReading } from "./lpHealth";
import { poolStats, ratioSigma } from "./gecko";
import { ethCallAt } from "../chain/rpc";
import { decodePosition, decodeSlot0Tick, encodeUint256, wordAt } from "../chain/abi";

/**
 * POSITION CARDS — one per holding, assembled from live reads plus the book.
 *
 * The acceptance test, from the brief: two LPs with near-identical sigma and
 * coverage of 0.29x vs 4.23x — "if the console cannot make that difference
 * obvious at a glance, it is not built yet." So the card leads with coverage
 * and the thesis verdicts, and every number says where it came from:
 * `chain` (read from the contract this request), `api` (GeckoTerminal), or
 * `posted` (the holder said so, with a date). An unlabeled number is a bug.
 */

const SLOT0 = "0x3850c7bd";
const POSITIONS_SEL = "0x99fbab88";
/** v4 StateView getSlot0(bytes32) — verified live against SEND 2026-10-02. */
const V4_GET_SLOT0 = "0xc815641c";

export interface LpCardMetrics {
  tick: { value: number; source: "chain" };
  inRange: boolean;
  liquidity: { value: string; source: "chain" } | null;
  yield: YieldReading & { source: "api" };
  sigmaDaily: { value: number; windowHours: number; source: "api" } | null;
  coverage: number | null;
  reserveUsd: { value: number; source: "api" } | null;
}

export interface PositionCardV2 {
  id: string;
  label: string;
  venue: string;
  kind: BookPosition["kind"];
  observedAt: string;
  /** LP-only metrics; null for posted holdings. */
  lp: LpCardMetrics | null;
  posted: Record<string, unknown>;
  theses: ThesisVerdict[];
  /** The one-line state of the position, worded as measurement. */
  headline: string;
  errors: string[];
  /** The read the recorder persists — null for posted holdings (nothing to poll). */
  readRow: PositionRead | null;
}

async function readV3Tick(p: LpV3Position): Promise<number> {
  return decodeSlot0Tick(await ethCallAt(p.chain.rpcUrl, p.pool, SLOT0));
}

async function readV3Liquidity(p: LpV3Position): Promise<string> {
  const ret = await ethCallAt(p.chain.rpcUrl, p.npm, POSITIONS_SEL + encodeUint256(p.tokenId));
  return decodePosition(ret).liquidity.toString();
}

async function readV4Tick(p: LpV4Position): Promise<number> {
  const ret = await ethCallAt(p.chain.rpcUrl, p.stateView, V4_GET_SLOT0 + p.poolId.slice(2));
  // getSlot0 returns (sqrtPriceX96, tick, protocolFee, lpFee) — tick is word 1.
  return Number(BigInt.asIntN(256, wordAt(ret, 1)));
}

/** Build one LP card. Failures land in `errors`, never as invented values. */
async function lpCard(p: LpV3Position | LpV4Position, reads: readonly PositionRead[]): Promise<PositionCardV2> {
  const errors: string[] = [];
  const nowIso = new Date().toISOString();

  let tick: number | null = null;
  let liquidity: string | null = null;
  try {
    tick = p.kind === "lp-v3" ? await readV3Tick(p) : await readV4Tick(p);
  } catch (err) {
    errors.push(`tick read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (p.kind === "lp-v3") {
    try {
      liquidity = await readV3Liquidity(p);
    } catch (err) {
      errors.push(`liquidity read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let stats = null;
  let sigma = null;
  try {
    stats = await poolStats(p.gecko.network, p.gecko.pool);
  } catch (err) {
    errors.push(`pool stats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    sigma = await ratioSigma(p.gecko.network, p.gecko.pool);
  } catch (err) {
    errors.push(`sigma failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lpKeep = p.kind === "lp-v3" ? lpKeepFraction(p.feeProtocol) : 1;
  const y = yieldReading({
    vol6hUsd: stats?.vol6hUsd ?? null,
    vol24hUsd: stats?.vol24hUsd ?? null,
    feePips: p.feePips,
    lpKeep,
    reserveUsd: stats?.reserveUsd ?? null,
  });

  const inRange = tick !== null && tick >= p.tickLower && tick < p.tickUpper;
  /*
   * Out of range earns NOTHING regardless of pool volume — the position's own
   * yield is zero there, and coverage judged on pool yield would flatter it.
   */
  const effectiveYield = inRange ? y.y6DailyPct : 0;
  let cov: number | null = null;
  try {
    cov = coverage({ yieldDailyPct: effectiveYield, sigmaDaily: sigma?.sigmaDaily ?? null });
  } catch (err) {
    errors.push(String(err instanceof Error ? err.message : err));
  }

  /*
   * The out-of-range clock ACCUMULATES in the store: each recorded read
   * carries the hours out as of that read (the recorder adds the gap since
   * the previous read while out, and zeroes on re-entry). The live card
   * extends the last recorded value by the time since that record — so the
   * clock keeps running between cron ticks, and a page refresh cannot reset
   * what only re-entering the range should reset.
   */
  const oorHours = accumulatedOutOfRangeHours(reads, inRange, nowIso);

  const metricsNow: PositionRead = {
    ts: nowIso,
    id: p.id,
    inRange,
    metrics: {
      coverage: cov,
      out_of_range_hours: oorHours,
      fee_yield_daily_pct: inRange ? y.y6DailyPct : 0,
    },
  };
  const theses = p.theses.map((t: Thesis) => evaluateThesis(t, [...reads, metricsNow]));

  const broken = theses.filter((t) => t.state === "broken");
  const breaking = theses.filter((t) => t.state === "breaking");
  const headline = broken.length
    ? `THESIS BROKEN${broken[0].brokenSince ? ` since ${broken[0].brokenSince.slice(0, 10)}` : ""}: ${broken
        .map((b) => `${b.rule} (now ${b.value === null ? "n/a" : round2(b.value)})`)
        .join("; ")}`
    : breaking.length
      ? `BREAKING (1 of 2 reads): ${breaking.map((b) => b.rule).join("; ")}`
      : cov !== null
        ? `holding: coverage ${round2(cov)}x${inRange ? "" : " — OUT OF RANGE"}`
        : `holding — coverage unmeasured`;

  return {
    id: p.id,
    label: p.label,
    venue: p.venue,
    kind: p.kind,
    observedAt: nowIso,
    lp: {
      tick: { value: tick ?? NaN, source: "chain" },
      inRange,
      liquidity: liquidity ? { value: liquidity, source: "chain" } : null,
      yield: { ...y, source: "api" },
      sigmaDaily: sigma ? { value: sigma.sigmaDaily, windowHours: sigma.windowHours, source: "api" } : null,
      coverage: cov,
      reserveUsd: stats?.reserveUsd != null ? { value: stats.reserveUsd, source: "api" } : null,
    },
    posted: { basisUsd: p.posted.basisUsd, asOf: p.posted.asOf, source: "posted" },
    theses,
    headline,
    errors,
    readRow: metricsNow,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The current out-of-range clock, in hours.
 *
 * In range → 0: re-entry is the ONLY thing that resets the clock. Out of
 * range → the last recorded accumulation plus the time elapsed since that
 * record (the record's own value already contains all prior out time). A
 * position that just exited with no recorded history starts at 0 and the
 * recorder begins accumulating on its next tick.
 */
export function accumulatedOutOfRangeHours(
  reads: readonly PositionRead[],
  inRangeNow: boolean,
  nowIso: string
): number {
  if (inRangeNow) return 0;
  const last = reads.length ? reads[reads.length - 1] : null;
  if (!last) return 0;
  /*
   * Extend the clock ONLY from a read that was itself out of range — keyed on
   * the read's own inRange flag, because the hours value cannot distinguish
   * "in range" from "first read out, clock at 0 but running". If the last
   * read was in range, the exit happened somewhere inside the gap and its
   * moment is unknown; extending from the read's timestamp would OVERSTATE
   * by up to the whole gap. An alert input must understate, never overstate:
   * the clock starts at the next recorded out-of-range tick.
   */
  if (last.inRange !== false) return 0;
  const lastHours = last.metrics.out_of_range_hours ?? 0;
  const sinceLast = Math.max(0, (Date.parse(nowIso) - Date.parse(last.ts)) / 3_600_000);
  return lastHours + sinceLast;
}

/** All cards: LPs live, posted holdings passed through with their stamps. */
export async function buildBookCards(readsById: ReadonlyMap<string, PositionRead[]>): Promise<PositionCardV2[]> {
  const out: PositionCardV2[] = [];
  for (const p of BOOK) {
    if (p.kind === "posted") {
      out.push({
        id: p.id,
        label: p.label,
        venue: p.venue,
        kind: p.kind,
        observedAt: new Date().toISOString(),
        lp: null,
        posted: { ...p.posted, volDragAnnualPct: p.volDragAnnualPct, notes: p.notes, source: "posted" },
        theses: [],
        headline: p.volDragAnnualPct
          ? `posted holding — vol drag ${p.volDragAnnualPct}%/yr (σ²/2): must ~${p.volDragAnnualPct >= 60 ? "triple" : "double"} annually to tread water`
          : `posted holding, as of ${p.posted.asOf}`,
        errors: [],
        readRow: null,
      });
    } else {
      out.push(await lpCard(p, readsById.get(p.id) ?? []));
    }
  }
  return out;
}
