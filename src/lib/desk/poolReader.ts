/**
 * DIRECT POOL READS — Robinhood Chain, raw eth_call, no middleman.
 *
 * The public dashboards for this pool have been caught wrong twice (a
 * wrong-pool fallback answering four different queries with the same
 * data; a 24h volume ~20x off the chain's own Swap events), so the desk
 * reads the contract itself: slot0() for the live tick, liquidity() for
 * active liquidity. One eth_call each, by pool ADDRESS — there is no
 * token-name search anywhere in this path, which is the property that
 * makes the reading's subject unambiguous.
 *
 * Price math, verified against the trading session's own conversion
 * table before this shipped: token0 is WETH, token1 is PONS, both 18
 * decimals (the table only reconciles if they are), so
 *
 *   PONS per WETH = 1.0001^tick        (rising tick = cheaper PONS)
 *   PONS in USD   = ETH_USD / 1.0001^tick
 *
 * tick 87000 -> $0.4125 at ETH $2,480 (their $0.413); tick 77640 ->
 * $1.0513 (their $1.054). The tick is the pinned quantity; every USD
 * figure derived from it must carry the ETH assumption that produced it.
 */

export const ROBINHOOD_CHAIN = {
  chainId: 4663,
  /** Public, rate-limited (429s under load, 10k-log cap). DESK_RPC_URL overrides. */
  publicRpc: "https://rpc.mainnet.chain.robinhood.com",
  ponsWethPool: "0xEd50bDeeA8aDC232f159486192a4157281D722ff",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  pons: "0x39dBED3a2bd333467115dE45665cC57F813C4571",
  positionTicks: [77640, 87000] as const,
} as const;

/** keccak4("slot0()") and keccak4("liquidity()") — standard Uniswap v3 selectors. */
const SLOT0_SELECTOR = "0x3850c7bd";
const LIQUIDITY_SELECTOR = "0x1a686502";

export interface PoolState {
  tick: number;
  /** Raw active liquidity (L), useful for later fee-yield work; decimal string. */
  activeLiquidity: string;
  observedAt: string;
  source: string;
}

async function ethCall(rpcUrl: string, to: string, data: string, timeoutMs: number): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error(`RPC error: ${body.error?.message ?? "no result"}`);
  return body.result;
}

/** int24 arrives sign-extended in a full 32-byte word; asIntN does the two's complement. */
export function decodeTickWord(word: string): number {
  return Number(BigInt.asIntN(256, BigInt("0x" + word)));
}

/**
 * Read the pool's live state. Throws on any transport or decode failure —
 * the caller renders the failure as an attempted-and-failed refusal, which
 * is a different fact from not-wired and must not be collapsed into it.
 */
export async function readPoolState(rpcUrl: string, pool: string, timeoutMs = 4000): Promise<PoolState> {
  const [slot0, liq] = await Promise.all([
    ethCall(rpcUrl, pool, SLOT0_SELECTOR, timeoutMs),
    ethCall(rpcUrl, pool, LIQUIDITY_SELECTOR, timeoutMs),
  ]);
  const hex = slot0.replace(/^0x/, "");
  if (hex.length < 128) throw new Error(`slot0 returned ${hex.length / 2} bytes; expected 7 words`);
  const tick = decodeTickWord(hex.slice(64, 128));
  // A tick outside Uniswap's global bounds means we decoded garbage, not a price.
  if (!Number.isFinite(tick) || Math.abs(tick) > 887272) {
    throw new Error(`decoded tick ${tick} is outside Uniswap's global bounds`);
  }
  return {
    tick,
    activeLiquidity: BigInt(liq).toString(),
    observedAt: new Date().toISOString(),
    source: `eth_call slot0()/liquidity() on ${pool} via ${rpcUrl}`,
  };
}

/** PONS per WETH at a tick (token1 per token0, both 18 decimals). */
export const ponsPerWeth = (tick: number): number => Math.pow(1.0001, tick);

/** PONS in USD at a tick, GIVEN an ETH price — the assumption travels with the number. */
export const ponsUsdAtTick = (tick: number, ethUsd: number): number => ethUsd / ponsPerWeth(tick);

export interface EthUsdReading {
  value: number;
  source: string;
  observedAt: string;
}

/** Kraken's public ticker — keyless, and not the account's keyed API. */
export async function fetchEthUsd(timeoutMs = 4000): Promise<EthUsdReading> {
  const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=ETHUSD", {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kraken public ticker ${res.status}`);
  const body = (await res.json()) as { result?: Record<string, { c: [string, string] }> };
  const key = body.result ? Object.keys(body.result)[0] : undefined;
  const last = key ? Number(body.result![key].c[0]) : NaN;
  if (!Number.isFinite(last) || last <= 0) throw new Error("kraken public ticker returned no usable last price");
  return {
    value: last,
    source: "Kraken public REST ticker, ETHUSD last trade",
    observedAt: new Date().toISOString(),
  };
}

/* ── Swap-event machinery, for the fee-yield falsifier ─────────────── */

/** keccak("Swap(address,address,int256,int256,uint160,uint128,int24)"). */
export const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export interface SwapDecoded {
  /** |amount0| — the WETH leg, raw wei. Absolute: direction does not matter to fees. */
  absAmount0Wei: bigint;
  /** Active liquidity AT THE SWAP, raw. The air-pocket-proof denominator. */
  liquidity: bigint;
}

/**
 * Swap event data words: amount0 int256, amount1 int256, sqrtPriceX96,
 * liquidity uint128, tick int24. Each swap carries the liquidity that was
 * active when it happened, so fee-per-unit-L is summed per swap rather
 * than divided by one end-of-day snapshot — the trading session watched
 * active liquidity move 297k -> 260k -> 308k in six hours, and a
 * snapshot denominator would hand the reading to whichever air-pocket
 * the scan happened to land on.
 */
export function decodeSwapData(data: string): SwapDecoded {
  const hex = data.replace(/^0x/, "");
  if (hex.length < 320) throw new Error(`swap data ${hex.length / 2} bytes; expected 5 words`);
  const amount0 = BigInt.asIntN(256, BigInt("0x" + hex.slice(0, 64)));
  const liquidity = BigInt("0x" + hex.slice(192, 256));
  if (liquidity <= 0n) throw new Error("swap carried zero liquidity — decode misalignment");
  return { absAmount0Wei: amount0 < 0n ? -amount0 : amount0, liquidity };
}

/**
 * Value of one unit of liquidity for a position on [tickLower, tickUpper],
 * in WETH terms at the given tick. Standard v3 amounts-for-liquidity, both
 * tokens 18 decimals, PONS leg converted at the tick's own price. Units
 * cancel against fee-per-unit-L computed from raw wei over raw L.
 */
export function valuePerLiquidityWeth(tick: number, tickLower: number, tickUpper: number): number {
  const sqrtP = Math.pow(1.0001, tick / 2);
  const sqrtPl = Math.pow(1.0001, tickLower / 2);
  const sqrtPu = Math.pow(1.0001, tickUpper / 2);
  const wethPerPons = 1 / Math.pow(1.0001, tick);
  if (tick < tickLower) return 1 / sqrtPl - 1 / sqrtPu; // all WETH
  if (tick >= tickUpper) return (sqrtPu - sqrtPl) * wethPerPons; // all PONS
  return 1 / sqrtP - 1 / sqrtPu + (sqrtP - sqrtPl) * wethPerPons;
}

export interface LogEntry {
  data: string;
  blockNumber: string;
}

export async function getSwapLogs(
  rpcUrl: string,
  pool: string,
  fromBlock: number,
  toBlock: number,
  timeoutMs = 15000
): Promise<LogEntry[]> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: pool,
          topics: [SWAP_TOPIC],
          fromBlock: "0x" + fromBlock.toString(16),
          toBlock: "0x" + toBlock.toString(16),
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: LogEntry[]; error?: { message?: string } };
  if (!Array.isArray(body.result)) throw new Error(`getLogs: ${body.error?.message ?? "no result"}`);
  return body.result;
}

export async function blockNumber(rpcUrl: string, timeoutMs = 8000): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: string };
  if (!body.result) throw new Error("eth_blockNumber returned nothing");
  return Number(BigInt(body.result));
}

export async function blockTimestamp(rpcUrl: string, block: number, timeoutMs = 8000): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBlockByNumber",
      params: ["0x" + block.toString(16), false],
    }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: { timestamp?: string } };
  if (!body.result?.timestamp) throw new Error(`no timestamp for block ${block}`);
  return Number(BigInt(body.result.timestamp)) * 1000;
}

/**
 * The LP's share of the swap fee, from slot0's feeProtocol byte. When the
 * protocol takes 1/n of fees, LPs keep 1 - 1/n. The two nibbles are
 * per-direction; the LARGER protocol cut is used for both, because for a
 * FALSIFIER the dangerous error is overstating yield — a kill line that
 * misses is worse than one that fires a reading early.
 */
export function lpFeeShareFromSlot0(slot0Hex: string): number {
  const hex = slot0Hex.replace(/^0x/, "");
  const word = hex.slice(64 * 5, 64 * 6);
  const packed = Number(BigInt("0x" + word));
  const n0 = packed & 0x0f;
  const n1 = (packed >> 4) & 0x0f;
  /*
   * The cut is 1/nibble, so the SMALLER nonzero nibble is the LARGER cut.
   * The first version took Math.max — the flattering direction — and the
   * test built to pin conservatism is what caught it.
   */
  const cuts = [n0, n1].filter((n) => n > 0).map((n) => 1 / n);
  return cuts.length > 0 ? 1 - Math.max(...cuts) : 1;
}

/** Raw slot0 hex, for callers needing more than the tick. */
export async function rawSlot0(rpcUrl: string, pool: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: pool, data: "0x3850c7bd" }, "latest"],
    }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: string };
  if (!body.result) throw new Error("slot0 returned nothing");
  return body.result;
}
