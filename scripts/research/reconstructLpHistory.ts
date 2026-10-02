import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CHAIN, POOL, POSITION, TOPICS } from "../../src/lib/chain/config";
import { MAX_SPARSE_SPAN, blockHeader, blockNumber, getLogs } from "../../src/lib/chain/rpc";
import { TOKEN_ID_TOPIC, decodePositionEvent } from "../../src/lib/chain/lpEvents";
import { DatedPositionEvent, TickSample, buildRealizedRecord } from "../../src/lib/chain/lpRealized";
import { wordAt } from "../../src/lib/chain/abi";

/**
 * RECONSTRUCT THE LP POSITION'S ENTIRE REALIZED HISTORY FROM LOGS.
 *
 * Why this exists: the 6h fee series cannot be backfilled, because the RPC
 * prunes state. It therefore cannot answer "what did this position earn over
 * its life" for any period before the cron started — and for this position the
 * cron never started, so the answer was "nothing known".
 *
 * Logs are NOT pruned. Every Collect is a realized fee receipt at a known
 * block; every Increase/Decrease is an exact flow. Eight sparse queries
 * recover the complete financial record of the position, wei-precise,
 * regardless of whether anything was watching at the time.
 *
 * Writes src/data/lpRealizedRecord.json — a derived artefact, reproducible
 * from chain at any time, so it is safe to regenerate and commit.
 *
 *   npx tsx scripts/research/reconstructLpHistory.ts
 *
 * READ-ONLY. Sweeps logs and block headers; nothing here can move value.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "lpRealizedRecord.json");

/** Blocks between tick samples. ~100k ≈ 2.7h — dense enough for a daily sigma. */
const TICK_SAMPLE_STEP = 100_000n;
/** Window scanned at each sample point to find a swap. */
const TICK_SAMPLE_WINDOW = 2_000n;

async function main(): Promise<void> {
  const head = await blockNumber();
  console.log(`[lp-hist] head ${head}`);

  /*
   * 1. EVERY position event, ever. Sparse filter (tokenId indexed), so the
   *    10M-block span applies and genesis→head is a handful of queries.
   */
  const rawEvents = [];
  for (const topic0 of [TOPICS.collect, TOPICS.increaseLiquidity, TOPICS.decreaseLiquidity]) {
    const logs = await getLogs({
      address: POSITION.npm,
      topics: [topic0, TOKEN_ID_TOPIC],
      fromBlock: 0n,
      toBlock: head,
      chunkBlocks: MAX_SPARSE_SPAN,
    });
    rawEvents.push(...logs);
  }
  console.log(`[lp-hist] ${rawEvents.length} position events across the full chain`);
  if (rawEvents.length === 0) {
    console.log("[lp-hist] no events — nothing to reconstruct. Check the tokenId topic.");
    process.exit(1);
  }

  /*
   * 2. Date each event. Headers are served even where state is not, which is
   *    the whole reason a historical reconstruction is possible at all.
   */
  const tsByBlock = new Map<number, number>();
  for (const log of rawEvents) {
    const b = Number(BigInt(log.blockNumber));
    if (!tsByBlock.has(b)) {
      const hdr = await blockHeader("0x" + b.toString(16));
      tsByBlock.set(b, hdr.timestampMs);
    }
  }

  const events: DatedPositionEvent[] = rawEvents
    .map((log) => {
      const ev = decodePositionEvent(log);
      if (!ev) return null;
      return {
        block: ev.block,
        tsMs: tsByBlock.get(ev.block)!,
        kind: ev.kind,
        // decodePositionEvent returns whole tokens; re-read wei for exactness.
        amount0: wordAt(log.data, ev.kind === "collect" ? 1 : 1),
        amount1: wordAt(log.data, ev.kind === "collect" ? 2 : 2),
        liquidityDelta: ev.liquidityDelta,
      } satisfies DatedPositionEvent;
    })
    .filter((e): e is DatedPositionEvent => e !== null)
    .sort((a, b) => a.block - b.block);

  const openBlock = BigInt(events[0].block);
  const lastBlock = BigInt(events[events.length - 1].block);
  console.log(`[lp-hist] life spans blocks ${openBlock}..${lastBlock}`);

  /*
   * 3. Sample the pool's tick series across the life. Dense Swap filter, so
   *    small windows at regular intervals rather than one vast query.
   */
  const ticks: TickSample[] = [];
  let sampled = 0;
  for (let b = openBlock; b <= lastBlock; b += TICK_SAMPLE_STEP) {
    const to = b + TICK_SAMPLE_WINDOW < lastBlock ? b + TICK_SAMPLE_WINDOW : lastBlock;
    try {
      const logs = await getLogs({
        address: POOL.address,
        topics: [TOPICS.swap],
        fromBlock: b,
        toBlock: to,
        chunkBlocks: MAX_SPARSE_SPAN,
      });
      if (logs.length) {
        const last = logs.reduce((acc, l) => (BigInt(l.blockNumber) > BigInt(acc.blockNumber) ? l : acc), logs[0]);
        ticks.push({
          block: Number(BigInt(last.blockNumber)),
          tick: Number(BigInt.asIntN(256, wordAt(last.data, 4))),
        });
      }
    } catch (err) {
      console.log(`[lp-hist] tick sample at ${b} failed: ${err instanceof Error ? err.message : err}`);
    }
    sampled++;
    if (sampled % 25 === 0) console.log(`[lp-hist]   ${sampled} windows sampled, ${ticks.length} ticks`);
  }
  console.log(`[lp-hist] ${ticks.length} tick samples over the life`);

  const rec = buildRealizedRecord(events, ticks, CHAIN.blocksPerSecond);
  if (!rec) {
    console.log("[lp-hist] record could not be built");
    process.exit(1);
  }

  const artifact = {
    version: 1,
    generatedAt: Date.now(),
    source: {
      chainId: CHAIN.chainId,
      rpc: CHAIN.rpcUrl,
      pool: POOL.address,
      npm: POSITION.npm,
      tokenId: POSITION.tokenId.toString(),
      range: { tickLower: POSITION.tickLower, tickUpper: POSITION.tickUpper },
      method:
        "full-history eth_getLogs sweep of Collect/Increase/Decrease on the tokenId topic, " +
        "plus a sampled Swap tick series. Realized receipts, not accruals. Logs are not pruned; " +
        "state is, which is why this is reconstructable and the 6h series is not.",
    },
    record: {
      ...rec,
      finalLiquidity: rec.finalLiquidity.toString(),
      intervals: rec.intervals.map((i) => ({
        ...i,
        fee0Wei: i.fee0Wei.toString(),
        fee1Wei: i.fee1Wei.toString(),
        liquidity: i.liquidity.toString(),
        feeWeth: Number(i.fee0Wei) / 1e18,
        feePons: Number(i.fee1Wei) / 1e18,
        ponsPerDay: i.days > 0 ? Number(i.fee1Wei) / 1e18 / i.days : null,
      })),
    },
    events: events.map((e) => ({
      block: e.block,
      iso: new Date(e.tsMs).toISOString(),
      kind: e.kind,
      weth: Number(e.amount0) / 1e18,
      pons: Number(e.amount1) / 1e18,
      liquidityDelta: e.liquidityDelta.toString(),
    })),
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 1));

  // ── Report ──────────────────────────────────────────────────────────
  const f = (n: number, d = 4) => n.toFixed(d);
  console.log(`\n═══ REALIZED LP RECORD ═══`);
  console.log(`  opened  ${rec.openedIso}`);
  console.log(`  ${rec.isClosed ? `CLOSED  ${rec.closedIso}` : `OPEN (liquidity ${rec.finalLiquidity})`}`);
  console.log(`  life    ${f(rec.lifeDays, 2)} days`);
  console.log(`  in range ${rec.inRangeFraction === null ? "n/a" : f(rec.inRangeFraction * 100, 1) + "%"} of sampled ticks`);
  console.log(`\n  deposited  ${f(rec.deposited.weth, 6)} WETH + ${f(rec.deposited.pons, 4)} PONS`);
  console.log(`  withdrawn  ${f(rec.withdrawn.weth, 6)} WETH + ${f(rec.withdrawn.pons, 4)} PONS  (principal + fees)`);
  console.log(`  FEES       ${f(rec.fees.weth, 8)} WETH + ${f(rec.fees.pons, 6)} PONS`);
  console.log(`\n  σ (life)        ${rec.lifeSigmaDaily === null ? "n/a" : f(rec.lifeSigmaDaily * 100, 2) + "%/day"}`);
  console.log(`  LVR coverage    ${rec.lifeCoverage === null ? "n/a" : f(rec.lifeCoverage, 2) + "x"}   (gate: PASS ≥1.5x, floor 1.0x)`);
  console.log(`  LP vs HODL      ${rec.vsHodlPct === null ? "n/a" : (rec.vsHodlPct >= 0 ? "+" : "") + f(rec.vsHodlPct, 2) + "%"}  (WETH terms, at the closing tick)`);
  console.log(`\n  per-interval realized fee rate:`);
  for (const i of rec.intervals) {
    if (i.days <= 0) continue;
    console.log(
      `    ${i.fromIso.slice(5, 16)} → ${i.toIso.slice(5, 16)}  ${f(i.days, 2).padStart(5)}d  ` +
        `${f(Number(i.fee1Wei) / 1e18 / i.days, 4).padStart(8)} PONS/day  ` +
        `yield ${(i.feeYieldDaily === null ? "n/a" : f(i.feeYieldDaily * 100, 4) + "%").padStart(9)}/day  ` +
        `cov ${i.coverage === null ? "   n/a" : f(i.coverage, 2).padStart(6) + "x"}  (${i.tickSamples} ticks)`
    );
  }
  console.log(`\n[lp-hist] wrote ${OUT}`);
}

main().catch((err) => {
  console.error("[lp-hist] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
