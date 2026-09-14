import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  ROBINHOOD_CHAIN,
  blockNumber,
  blockTimestamp,
  decodeSwapData,
  getSwapLogs,
  lpFeeShareFromSlot0,
  rawSlot0,
  decodeTickWord,
  valuePerLiquidityWeth,
} from "../../src/lib/desk/poolReader";

/**
 * SWAP-LOG SCAN — the fee-yield falsifier's reading source.
 *
 * Incremental, per the trading session's own working shape: scan only the
 * blocks since the last run in <=18,000-block chunks (the public RPC caps
 * eth_getLogs at 10,000 events; ~18k blocks returned 200-900 there all
 * week), store per-window aggregates, and derive daily readings from the
 * stored series. A nightly run is one small delta; the artifact is a real
 * time series rather than a snapshot.
 *
 * THE STATISTIC, exact rather than snapshot-divided: each Swap event
 * carries the liquidity active at that swap, so the accumulator is
 *
 *     fee_per_unit_L = sum over swaps of |amount0| x feeTier x lpShare / L_swap
 *
 * — WETH per unit of liquidity, using each swap's OWN denominator. The
 * trading session watched active liquidity move 297k -> 260k -> 308k in
 * six hours; dividing a day's volume by one snapshot hands the reading to
 * whichever air-pocket the scan lands on, and this construction cannot.
 *
 * Two stated approximations, both conservative or negligible against a
 * 0.25%/day line: fees are charged on the input token, and |amount0| uses
 * the WETH leg for both directions (PONS-in swaps counted at their
 * WETH-out equivalent, ~0.3% low on half the flow); lpShare uses the
 * WORSE of slot0's two per-direction protocol-fee nibbles, because a
 * falsifier that overstates yield is one that misses its kill.
 *
 * DAILY READINGS, on the falsifier's own cadence: the kill line is three
 * consecutive DAILY readings under 0.25%/day — declared cadence, not an
 * intraday sample. A UTC day becomes a reading only when the scanned
 * windows cover >= 20 of its 24 hours; partial days are stored, marked,
 * and never counted. Yield = day's fee_per_unit_L / value of one unit of
 * L for the position's own range, valued at the day's LAST scanned tick.
 *
 *   npx tsx scripts/ingest/scanLpSwaps.ts            # incremental
 *   npx tsx scripts/ingest/scanLpSwaps.ts --backfill # first run: ~24h back
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "lpSwapVolume.json");

const CHUNK_BLOCKS = 18_000;
const BACKFILL_BLOCKS = 900_000; // ~24h at the observed ~10 blocks/s
const MAX_CHUNKS_PER_RUN = 96; // safety valve: ~2 days of catch-up per run
const PACE_MS = 300;
const FEE_TIER = 0.003;
const [TICK_LOWER, TICK_UPPER] = ROBINHOOD_CHAIN.positionTicks;

interface Window {
  fromBlock: number;
  toBlock: number;
  fromTs: string;
  toTs: string;
  swaps: number;
  wethVolume: number;
  /** sum |amount0| x feeTier x lpShare / L_swap — raw-unit consistent with valuePerLiquidityWeth. */
  feePerUnitL: number;
  /** Pool tick at the window's last swap (or previous window's, carried). */
  lastTick: number | null;
}

interface DailyReading {
  date: string;
  yieldPctPerDay: number | null;
  feePerUnitL: number;
  valuePerL: number | null;
  hoursCovered: number;
  complete: boolean;
  swaps: number;
  wethVolume: number;
}

interface Store {
  version: 1;
  generatedAt: number;
  pool: string;
  rpc: string;
  feeTier: number;
  lpShare: number;
  positionTicks: [number, number];
  lastScannedBlock: number | null;
  windows: Window[];
  dailyReadings: DailyReading[];
  method: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The public RPC 429s and hiccups under exactly this kind of load — the
 * trading session hit it all week. Transient failures get three retries
 * with backoff; a still-failing call throws and the run stops with the
 * store already holding every completed window, so the next run resumes
 * from lastScannedBlock rather than repeating work.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastErr)}`);
}

function deriveDaily(windows: Window[]): DailyReading[] {
  const byDate = new Map<string, Window[]>();
  for (const w of windows) {
    const date = w.toTs.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(w);
  }
  const out: DailyReading[] = [];
  for (const [date, ws] of [...byDate.entries()].sort()) {
    const ms = ws.reduce((a, w) => a + (Date.parse(w.toTs) - Date.parse(w.fromTs)), 0);
    const hours = ms / 3_600_000;
    const feePerUnitL = ws.reduce((a, w) => a + w.feePerUnitL, 0);
    const lastTick = [...ws].reverse().find((w) => w.lastTick !== null)?.lastTick ?? null;
    const valuePerL = lastTick === null ? null : valuePerLiquidityWeth(lastTick, TICK_LOWER, TICK_UPPER);
    const complete = hours >= 20;
    out.push({
      date,
      yieldPctPerDay:
        complete && valuePerL !== null && valuePerL > 0
          ? Math.round((feePerUnitL / valuePerL) * 100 * 10000) / 10000
          : null,
      feePerUnitL,
      valuePerL,
      hoursCovered: Math.round(hours * 10) / 10,
      complete,
      swaps: ws.reduce((a, w) => a + w.swaps, 0),
      wethVolume: Math.round(ws.reduce((a, w) => a + w.wethVolume, 0) * 10000) / 10000,
    });
  }
  return out;
}

async function main() {
  const backfill = process.argv.includes("--backfill");
  const rpc = process.env.DESK_RPC_URL ?? ROBINHOOD_CHAIN.publicRpc;
  const pool = ROBINHOOD_CHAIN.ponsWethPool;

  let store: Store | null = null;
  if (fs.existsSync(OUT)) store = JSON.parse(fs.readFileSync(OUT, "utf8")) as Store;

  const head = await withRetry("blockNumber", () => blockNumber(rpc));
  const slot0 = await withRetry("slot0", () => rawSlot0(rpc, pool));
  const lpShare = lpFeeShareFromSlot0(slot0);
  const liveTick = decodeTickWord(slot0.replace(/^0x/, "").slice(64, 128));

  let from: number;
  if (store?.lastScannedBlock) {
    from = store.lastScannedBlock + 1;
  } else if (backfill) {
    from = head - BACKFILL_BLOCKS;
  } else {
    console.error("no store yet — run with --backfill for the first ~24h scan");
    process.exit(1);
  }

  const windows: Window[] = store?.windows ?? [];
  let scanned = from - 1;
  let chunks = 0;
  let prevTick: number | null = windows.length > 0 ? windows[windows.length - 1].lastTick : liveTick;

  while (scanned < head && chunks < MAX_CHUNKS_PER_RUN) {
    const a = scanned + 1;
    const b = Math.min(a + CHUNK_BLOCKS - 1, head);
    const logs = await withRetry(`getLogs ${a}-${b}`, () => getSwapLogs(rpc, pool, a, b));
    let feePerUnitL = 0;
    let wethVolume = 0;
    for (const log of logs) {
      const s = decodeSwapData(log.data);
      const v = Number(s.absAmount0Wei);
      feePerUnitL += (v * FEE_TIER * lpShare) / Number(s.liquidity);
      wethVolume += v / 1e18;
      const hex = log.data.replace(/^0x/, "");
      prevTick = decodeTickWord(hex.slice(256, 320));
    }
    // Serialized, not parallel — two simultaneous calls is what tripped the rate limit.
    const fromTs = await withRetry(`ts ${a}`, () => blockTimestamp(rpc, a));
    const toTs = await withRetry(`ts ${b}`, () => blockTimestamp(rpc, b));
    windows.push({
      fromBlock: a,
      toBlock: b,
      fromTs: new Date(fromTs).toISOString(),
      toTs: new Date(toTs).toISOString(),
      swaps: logs.length,
      wethVolume: Math.round(wethVolume * 10000) / 10000,
      feePerUnitL,
      lastTick: prevTick,
    });
    scanned = b;
    chunks++;
    await sleep(PACE_MS);
  }

  const next: Store = {
    version: 1,
    generatedAt: Date.now(),
    pool,
    rpc,
    feeTier: FEE_TIER,
    lpShare,
    positionTicks: [TICK_LOWER, TICK_UPPER],
    lastScannedBlock: scanned,
    windows,
    dailyReadings: deriveDaily(windows),
    method:
      "Incremental Swap-log scan; fee_per_unit_L summed PER SWAP against each swap's own active " +
      "liquidity; daily reading = day's fee_per_unit_L / value of one unit of L on the position's " +
      "range at the day's last scanned tick; a day counts only at >= 20 of 24 hours covered. " +
      "lpShare uses the worse protocol-fee nibble. Falsifier cadence: three consecutive COMPLETE " +
      "daily readings under the declared 0.25%/day.",
  };
  fs.writeFileSync(OUT, JSON.stringify(next, null, 1));

  const daily = next.dailyReadings;
  console.log(
    `scanned ${chunks} chunk(s) to block ${scanned} (head ${head}); windows ${windows.length}; ` +
      `lpShare ${lpShare.toFixed(4)}`
  );
  for (const d of daily.slice(-4)) {
    console.log(
      `  ${d.date}: ${d.complete ? `${d.yieldPctPerDay}%/day` : `partial (${d.hoursCovered}h)`} | ` +
        `${d.swaps} swaps, ${d.wethVolume} WETH`
    );
  }
  if (scanned < head) console.log(`NOTE: ${head - scanned} blocks remain; next run continues.`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main();
