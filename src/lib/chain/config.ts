/**
 * THE LP MONITOR'S ONE CONFIG FILE.
 *
 * Every chain address, selector and THRESHOLD the monitor uses lives here, by
 * the trading session's explicit rule: "All thresholds (85596, 0.90, 4-sigma,
 * 5%, $150) in ONE config file; changes logged." A threshold hard-coded at a
 * call site is a threshold nobody can find when it needs to change, and a
 * silent change is one nobody can audit. So they are declared once, named, and
 * any edit here is the logged change.
 *
 * READ-ONLY by construction: this file holds addresses and numbers, never a
 * key, never a signer, never anything that can move value. The whole module
 * tree under src/lib/chain reads chain state and computes; it cannot write to
 * the chain.
 *
 * ── The chain ────────────────────────────────────────────────────────
 *
 * Robinhood Chain mainnet. The canonical mainnet Uniswap addresses have NO
 * code here — this is a separate deployment (our pool's factory() is
 * 0x1f7d…2efa, not the Ethereum-mainnet factory), so every address below was
 * given by the trading session and chain-verified, not assumed from an
 * Ethereum deployment.
 */

/** Chain, verified live: eth_chainId returns 0x1237 = 4663. */
export const CHAIN = {
  chainId: 4663,
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  /**
   * The RPC 403s on Python urllib's default User-Agent and 200s with one set.
   * Declared here so every request in this tree carries it — a request without
   * a UA is the single most common way this monitor would silently stop
   * reading. Measured: ~10.4 blocks/second.
   */
  userAgent: "leverage-terminal/1.0 (+lp-monitor)",
  blocksPerSecond: 10.4,
} as const;

/**
 * THE POOL. UniV3, fee tier 3000 = 0.30%, read from fee() on the contract —
 * NEVER from an aggregator label, which was 10x wrong for another pool on this
 * chain (GeckoTerminal said "0.05%" where fee() returned 51 = 0.0051%).
 */
export const POOL = {
  address: "0xEd50bDeeA8aDC232f159486192a4157281D722ff",
  feePips: 3000,
  /** token0 = WETH, token1 = PONS. Both 18 decimals. Order is not cosmetic:
   *  every amount0/amount1 branch below depends on it. */
  token0: { symbol: "WETH", address: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", decimals: 18 },
  token1: { symbol: "PONS", address: "0x39dbed3a2bd333467115de45665cc57f813c4571", decimals: 18 },
} as const;

/** OUR position, held in the NonfungiblePositionManager. */
export const POSITION = {
  npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  tokenId: 1109566n,
  tickLower: 77640,
  tickUpper: 87000,
  /** Range width in ticks, for "% through range". Derived, not re-typed. */
  get tickSpan(): number {
    return this.tickUpper - this.tickLower;
  },
} as const;

/**
 * Function selectors and event topics, all verified against this deployment.
 *
 * positions(uint256) word layout: field 7 = L, fields 8/9 =
 * feeGrowthInside{0,1}LastX128, fields 10/11 = tokensOwed{0,1}. tokensOwed
 * ONLY updates when a burn/collect touches the position, so it is NEVER
 * "current fees" — the fee formula computes those instead. See uniV3Math.ts.
 *
 * ticks(int24) storage: feeGrowthOutside0X128 is field 2, feeGrowthOutside1X128
 * is field 3.
 */
export const SELECTORS = {
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  feeGrowthGlobal0X128: "0xf3058399",
  feeGrowthGlobal1X128: "0x46141319",
  ticks: "0xf30dba93", // ticks(int24)
  positions: "0x99fbab88", // positions(uint256)
  fee: "0x0e256d68", // fee(), read rather than trusting an aggregator label
} as const;

/**
 * EVENT TOPICS — absent in P0 (given only as prefixes then), now present and
 * VERIFIED AGAINST REAL LOGS ON THIS CHAIN, 2026-09-20:
 *
 *  - Collect and IncreaseLiquidity: fetched at the trading session's fixture
 *    blocks 66,527,317 / 66,527,788 filtered by our tokenId; the decoded
 *    amounts reconcile to the wei (0.002926302071638665 WETH +
 *    11.632329911972367 PONS collected; +1,534,987,224,755,938,629 L added,
 *    implying L_before 19,174,394,115,016,096,486 — matching the
 *    independently recorded pre-compound 1.9174e19).
 *  - Swap: 247 logs in a 20k-block window on our pool, 5 data words as the ABI
 *    says, amount0/amount1 opposite-signed int256, tick agreeing with slot0.
 *
 * A CORRECTION CAUGHT DURING THAT VERIFICATION: the trading session's brief
 * gave the tokenId filter as 0x…0010ef3e, which decodes to 1109822 — the wrong
 * position. 1109566 is 0x10EE3E. Encode the DECIMAL id (encodeUint256), never
 * paste a pre-encoded topic; the pasted constant returned zero events and
 * looked like an empty history.
 *
 * Swap amount0/amount1 are int256 two's complement — abs() each before summing
 * volume, or buys and sells net to ~zero.
 */
export const TOPICS = {
  /** Pool: Swap(sender idx, recipient idx, amount0, amount1, sqrtPriceX96, liquidity, tick) */
  swap: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  /** NPM, all carrying tokenId as topics[1]: */
  collect: "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01",
  increaseLiquidity: "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f",
  decreaseLiquidity: "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4",
} as const;

/**
 * ALL TUNABLE THRESHOLDS. The list the trading session named, plus the alert
 * rails. Everything a reader might want to change without touching logic.
 */
export const THRESHOLDS = {
  /** Review level: tick at which PONS is ~$0.50 and the position is 85% through
   *  its range ((85596-77640)/9360 = 0.85). A REVIEW prompt, never a sell. */
  reviewTick: 85596,
  /** FPS option T1: ARM when contract IV <= this multiple of post-gap RV21. */
  armIvToRvRatio: 0.9,
  /** Post-gap outlier rule: drop a bar only when its GAP component exceeds this
   *  many sigma, sigma = 1.4826 * MAD. NOT a 3x-median rule on the whole bar. */
  gapSigmaCut: 4,
  /** Cross-venue divergence flag: a venue's last vs the median of the others. */
  venueDivergencePct: 5,
  /** Sunday waterfall: weekly budget, per-sleeve cap, in dollars. */
  weeklyBudgetUsd: 200,
  perSleeveCapUsd: 150,
  /** Alert: fee-series gap beyond this many hours (the watcher-watching-watcher). */
  seriesGapAlertHours: 12,
  /** Cadence floor: the series must have a row at least this often, weekends
   *  included. Crypto does not observe weekends; the weekday-only nightly does
   *  not cover this, which is why the monitor gets its own schedule. */
  cadenceHours: 6,
  /** Posted (un-chain-readable) balances shown STALE past this age. */
  postedStaleHours: 48,
  /**
   * A posted option IV older than this is STALE and the T1 card says so
   * rather than evaluating on it — "~1 session" per the agreed post contract:
   * a session plus the overnight, not a calendar convenience.
   */
  t1PostMaxAgeHours: 30,
} as const;

/** ISO-ish provenance stamp shape carried by every number this tree emits. */
export interface Stamp {
  /** When the value was observed, ISO 8601 UTC. */
  ts: string;
  /** Where it came from — a chain address, an RPC, a venue name. Never absent. */
  source: string;
}
