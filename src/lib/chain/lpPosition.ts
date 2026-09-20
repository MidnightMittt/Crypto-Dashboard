import { CHAIN, POOL, POSITION, SELECTORS, Stamp } from "./config";
import { blockHeader, blockNumber, ethCall } from "./rpc";
import {
  decodePosition,
  decodeSlot0Tick,
  decodeTickFeeGrowthOutside,
  decodeUint,
  encodeInt24,
  encodeUint256,
} from "./abi";
import {
  FeeGrowthSnapshot,
  feesOwed,
  pctThroughRange,
  ponsUsd,
  positionAmounts,
} from "./uniV3Math";
import { fetchEthUsd } from "./ethUsd";

/**
 * READ THE LP POSITION FROM CHAIN AND BUILD THE CARD.
 *
 * The one impure module in this tree: it makes the RPC reads, then hands the
 * raw values to the pure math in uniV3Math.ts. Split that way so the card's
 * arithmetic stays fixture-testable without a network, and this file is only
 * ever responsible for reading the right slots in the right order.
 *
 * ALL READS AT ONE BLOCK. slot0, liquidity, both fee-growth globals, both tick
 * slots and the position are read at the SAME block tag, because the fee
 * formula subtracts values that must be consistent — mixing a tick's
 * feeGrowthOutside from one block with the global from another would compute a
 * fee that never existed. "latest" is pinned to a concrete block number first,
 * and every call uses that number.
 */

/** The raw chain state a card is built from — all at one block. */
export interface PositionSnapshot {
  block: bigint;
  timestampMs: number;
  currentTick: number;
  poolLiquidity: bigint;
  position: {
    liquidity: bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  };
  feeGrowth: FeeGrowthSnapshot;
}

/** Read every slot the card needs, at a single pinned block. */
export async function readPositionSnapshot(): Promise<PositionSnapshot> {
  const block = await blockNumber();
  const tag = "0x" + block.toString(16);
  const header = await blockHeader(tag);

  // Pool-level reads.
  const [slot0, liq, fg0, fg1] = await Promise.all([
    ethCall(POOL.address, SELECTORS.slot0, tag),
    ethCall(POOL.address, SELECTORS.liquidity, tag),
    ethCall(POOL.address, SELECTORS.feeGrowthGlobal0X128, tag),
    ethCall(POOL.address, SELECTORS.feeGrowthGlobal1X128, tag),
  ]);
  const currentTick = decodeSlot0Tick(slot0);
  const poolLiquidity = decodeUint(liq);
  const feeGrowthGlobal0X128 = decodeUint(fg0);
  const feeGrowthGlobal1X128 = decodeUint(fg1);

  // Tick slots and the position.
  const [lowerTick, upperTick, posRet] = await Promise.all([
    ethCall(POOL.address, SELECTORS.ticks + encodeInt24(POSITION.tickLower), tag),
    ethCall(POOL.address, SELECTORS.ticks + encodeInt24(POSITION.tickUpper), tag),
    ethCall(POSITION.npm, SELECTORS.positions + encodeUint256(POSITION.tokenId), tag),
  ]);
  const lower = decodeTickFeeGrowthOutside(lowerTick);
  const upper = decodeTickFeeGrowthOutside(upperTick);
  const position = decodePosition(posRet);

  return {
    block,
    timestampMs: header.timestampMs,
    currentTick,
    poolLiquidity,
    position,
    feeGrowth: {
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128,
      lowerOutside0X128: lower.outside0,
      lowerOutside1X128: lower.outside1,
      upperOutside0X128: upper.outside0,
      upperOutside1X128: upper.outside1,
      feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
    },
  };
}

/** The position card — every field the build order named, each derived, none guessed. */
export interface PositionCard {
  block: string;
  observedAt: string;
  chain: { chainId: number; rpc: string };
  currentTick: number;
  inRange: boolean;
  pctThroughRange: number;
  ponsUsd: number;
  ethUsd: { value: number; stamp: Stamp } | null;
  amounts: { weth: number; pons: number };
  usdValue: number | null;
  /** Fees SINCE LAST COLLECT, computed from the accumulators — never tokensOwed. */
  feesSinceCollect: { weth: number; pons: number; usd: number | null };
  shareOfActivePct: number;
  liquidity: string;
  /** Warnings the card must carry rather than swallow (missing ETH price, out of range). */
  notes: string[];
}

/** Assemble the card from a snapshot and a labelled ETH/USD reference. */
export function buildCard(snap: PositionSnapshot, eth: { value: number; stamp: Stamp } | null): PositionCard {
  const notes: string[] = [];
  const { currentTick } = snap;
  const inRange = currentTick >= POSITION.tickLower && currentTick < POSITION.tickUpper;
  if (!inRange) notes.push(`OUT OF RANGE: tick ${currentTick} is outside ${POSITION.tickLower}..${POSITION.tickUpper} — the position earns no fees here.`);

  const amounts = positionAmounts(snap.position.liquidity, currentTick, POSITION.tickLower, POSITION.tickUpper);
  const { raw0, raw1 } = feesOwed(snap.feeGrowth, currentTick, POSITION.tickLower, POSITION.tickUpper, snap.position.liquidity);
  const feeWeth = Number(raw0) / 1e18;
  const feePons = Number(raw1) / 1e18;

  const pPons = eth ? ponsUsd(currentTick, eth.value) : NaN;
  if (!eth) notes.push("ETH/USD unavailable — USD figures withheld rather than derived from a stale price.");

  // positionAmounts returns amount0 (WETH) / amount1 (PONS) — token order, not symbol.
  const weth = amounts.amount0;
  const pons = amounts.amount1;
  const usdValue = eth ? weth * eth.value + pons * pPons : null;
  const feesUsd = eth ? feeWeth * eth.value + feePons * pPons : null;
  const shareOfActivePct = snap.poolLiquidity > 0n
    ? (Number(snap.position.liquidity) / Number(snap.poolLiquidity)) * 100
    : 0;

  return {
    block: snap.block.toString(),
    observedAt: new Date(snap.timestampMs).toISOString(),
    chain: { chainId: CHAIN.chainId, rpc: CHAIN.rpcUrl },
    currentTick,
    inRange,
    pctThroughRange: pctThroughRange(currentTick, POSITION.tickLower, POSITION.tickUpper),
    ponsUsd: eth ? pPons : NaN,
    ethUsd: eth,
    amounts: { weth, pons },
    usdValue,
    feesSinceCollect: { weth: feeWeth, pons: feePons, usd: feesUsd },
    shareOfActivePct,
    liquidity: snap.position.liquidity.toString(),
    notes,
  };
}

/** Read + price + build, the one call the persist script and the API route share. */
export async function getPositionCard(): Promise<PositionCard> {
  const snap = await readPositionSnapshot();
  const eth = await fetchEthUsd(new Date().toISOString());
  return buildCard(snap, eth);
}
