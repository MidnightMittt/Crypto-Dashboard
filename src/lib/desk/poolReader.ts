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
