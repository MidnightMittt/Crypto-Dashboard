import { POOL, POSITION, TOPICS } from "./config";
import { RawLog, getLogs } from "./rpc";
import { encodeUint256, wordAt } from "./abi";

/**
 * POSITION EVENTS AND SWAP VOLUME, from logs.
 *
 * Logs survive the pruning that state does not, so this is the one part of the
 * chain's past this monitor can actually read. Two consumers:
 *
 *  - the fee-clock RESET (a Collect on our tokenId) detected from EVENTS as
 *    the primary signal, with the state heuristic in feeSeries.ts kept as the
 *    fallback — events need a log sweep, state needs one call, and the
 *    heuristic is what still works when a sweep fails;
 *  - vol_2h, the pool's 2-hour swap volume in USD.
 *
 * Decoders are pure and separated from the sweeps so the trading session's
 * chain-verified fixture logs pin them in unit tests without a network.
 *
 * ── The tokenId trap, preserved so it is not re-learned ───────────────
 *
 * NPM Collect/Increase/Decrease carry tokenId as topics[1]. ENCODE THE DECIMAL
 * (1109566 → 0x…10ee3e); the build reply's pasted constant 0x…10ef3e decodes
 * to 1109822 — a different position — and returns zero events while looking
 * like an empty history. And scan depth matters: a filter that returns nothing
 * over 900k blocks (~25h) proves nothing about a position whose last event is
 * older — scan >=3M blocks (~84h) before concluding "no events".
 */

export const TOKEN_ID_TOPIC = "0x" + encodeUint256(POSITION.tokenId);

export interface PositionEvent {
  kind: "collect" | "increase" | "decrease";
  block: number;
  /** Raw token amounts (18 decimals) the event carried. */
  amount0: number;
  amount1: number;
  /** Liquidity delta for increase/decrease; 0 for collect. */
  liquidityDelta: bigint;
}

/** Decode one NPM position event log. Pure — fixture-testable. */
export function decodePositionEvent(log: RawLog): PositionEvent | null {
  const kind =
    log.topics[0] === TOPICS.collect
      ? ("collect" as const)
      : log.topics[0] === TOPICS.increaseLiquidity
        ? ("increase" as const)
        : log.topics[0] === TOPICS.decreaseLiquidity
          ? ("decrease" as const)
          : null;
  if (!kind) return null;
  if (kind === "collect") {
    // data: recipient, amount0, amount1
    return {
      kind,
      block: Number(BigInt(log.blockNumber)),
      amount0: Number(wordAt(log.data, 1)) / 1e18,
      amount1: Number(wordAt(log.data, 2)) / 1e18,
      liquidityDelta: 0n,
    };
  }
  // increase/decrease data: liquidity, amount0, amount1
  const delta = wordAt(log.data, 0);
  return {
    kind,
    block: Number(BigInt(log.blockNumber)),
    amount0: Number(wordAt(log.data, 1)) / 1e18,
    amount1: Number(wordAt(log.data, 2)) / 1e18,
    liquidityDelta: kind === "increase" ? delta : -delta,
  };
}

/**
 * Every Collect/Increase/Decrease on OUR tokenId in [fromBlock, toBlock].
 * Three filtered queries rather than one unfiltered sweep: the tokenId topic
 * does the work server-side, so each returns only our position's events.
 */
export async function sweepPositionEvents(fromBlock: bigint, toBlock: bigint): Promise<PositionEvent[]> {
  const topics = [TOPICS.collect, TOPICS.increaseLiquidity, TOPICS.decreaseLiquidity];
  const all: PositionEvent[] = [];
  for (const topic0 of topics) {
    const logs = await getLogs({
      address: POSITION.npm,
      topics: [topic0, TOKEN_ID_TOPIC],
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const ev = decodePositionEvent(log);
      if (ev) all.push(ev);
    }
  }
  return all.sort((a, b) => a.block - b.block);
}

/** int256 two's complement from an unsigned word. */
function asInt256(word: bigint): bigint {
  return BigInt.asIntN(256, word);
}

/**
 * Sum of |amount0| (the WETH side) across Swap logs, in whole WETH. Pure.
 *
 * Each swap is counted once on its WETH leg; multiplying by ETH/USD prices the
 * volume. amount0/amount1 are int256 and opposite-signed — abs() before
 * summing, or buys and sells net to ~zero (verified on a live log).
 */
export function sumSwapVolumeWeth(logs: readonly RawLog[]): number {
  let raw = 0n;
  for (const log of logs) {
    const a0 = asInt256(wordAt(log.data, 0));
    raw += a0 < 0n ? -a0 : a0;
  }
  return Number(raw) / 1e18;
}

/** The pool's swap volume over the trailing `hours`, in WETH terms. */
export async function swapVolumeWeth(headBlock: bigint, hours: number, blocksPerSecond: number): Promise<number> {
  const span = BigInt(Math.round(hours * 3600 * blocksPerSecond));
  const from = headBlock > span ? headBlock - span : 0n;
  const logs = await getLogs({
    address: POOL.address,
    topics: [TOPICS.swap],
    fromBlock: from,
    toBlock: headBlock,
  });
  return sumSwapVolumeWeth(logs);
}
