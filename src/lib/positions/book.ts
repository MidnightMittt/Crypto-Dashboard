/**
 * THE BOOK — every position held, declared in one place, across five venues.
 *
 * This file is the answer to the brief's core finding: two weeks of P&L showed
 * both losses came from BROKEN EXITS ON POSITIONS ALREADY HELD, not from
 * missed opportunities. A $67.79 LP loss ran for days after its thesis broke
 * because no single view held the position AND its exit condition. So the
 * position and its thesis live in the same declaration: a position without a
 * written reason and a number that must stay true cannot be entered here.
 *
 * ── Verified vs posted, field by field ────────────────────────────────
 *
 * Chain-readable facts (ticks, liquidity, fee tiers) were VERIFIED against the
 * contracts before being written down — fee() returned 10000 where a venue UI
 * might say anything, because fee tiers in pool names are wrong by up to 200x
 * on some venues. Broker-side facts (cost basis, option targets) are POSTED:
 * the site cannot read Robinhood, Xverse or Coinbase, and pretending otherwise
 * would put an invented number where an honest "posted, as of <date>" belongs.
 * Every consumer labels which is which.
 */

/** Where a holding lives. The book's venues are facts, not an abstraction. */
export type Venue =
  | "robinhood-brokerage"
  | "metamask-mainnet"
  | "robinhood-chain"
  | "xverse"
  | "coinbase";

/** A thesis: one number that must stay true, and what reading it means. */
export interface Thesis {
  /** The written reason the position is held. Prose, from the holder. */
  reason: string;
  /** The metric the rule reads, e.g. "coverage" | "in_range_hours" | "fee_rate_daily". */
  metric: "coverage" | "out_of_range_hours" | "fee_yield_daily_pct";
  /** Comparator and threshold: the rule is `value OP threshold`. */
  op: ">=" | "<=";
  threshold: number;
  /**
   * Breaks fire only on TWO CONSECUTIVE READS — never one. A single stale
   * API read produced a false signal once already; this rule is the scar.
   */
  consecutiveReads: 2;
}

export interface LpV3Position {
  kind: "lp-v3";
  id: string;
  venue: Venue;
  label: string;
  chain: { rpcUrl: string; chainId: number; name: string };
  pool: string;
  npm: string;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  /** token1-per-token0 orientation note, so a ratio is never read upside down. */
  tokens: { token0: string; token1: string };
  /** VERIFIED on-chain (fee() selector 0xddca3f43), never from a display name. */
  feePips: number;
  /** slot0().feeProtocol — 102 means a 1/6 protocol take, LPs keep 5/6. */
  feeProtocol: number;
  /** GeckoTerminal network/pool for volume windows and token-ratio OHLCV. */
  gecko: { network: string; pool: string };
  /** POSTED: broker/holder-side figures the chain cannot provide. */
  posted: { basisUsd: number; asOf: string };
  theses: Thesis[];
}

export interface LpV4Position {
  kind: "lp-v4";
  id: string;
  venue: Venue;
  label: string;
  chain: { rpcUrl: string; chainId: number; name: string };
  /** v4 pools are ids, not contracts; reads go through the StateView lens. */
  poolId: `0x${string}`;
  stateView: string;
  positionTokenId: bigint;
  tickLower: number;
  tickUpper: number;
  tokens: { token0: string; token1: string };
  feePips: number;
  gecko: { network: string; pool: string };
  posted: { basisUsd: number; asOf: string };
  theses: Thesis[];
}

/** A simple holding the chain cannot see — posted entirely. */
export interface PostedHolding {
  kind: "posted";
  id: string;
  venue: Venue;
  label: string;
  /** `units` null when never posted — an absent count is absent, not estimated. */
  posted: { units: number | null; asset: string; basisUsd: number; asOf: string };
  /**
   * Volatility drag, sigma^2/2 annualised — the one metric from the holder's
   * own DCA study that survived a shuffled null. Posted with its source; a
   * drag of 69%/yr means the asset must ~triple annually to tread water, and
   * that belongs on screen next to the position, not in a research file.
   */
  volDragAnnualPct: number | null;
  notes?: string;
}

export type BookPosition = LpV3Position | LpV4Position | PostedHolding;

const RH_CHAIN = {
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  chainId: 4663,
  name: "robinhood-chain",
};
const ETH_MAINNET = {
  rpcUrl: "https://ethereum-rpc.publicnode.com",
  chainId: 1,
  name: "ethereum",
};

/** The default LP theses, per the brief: coverage, range residence, fee rate. */
const LP_THESES = (reason: string): Thesis[] => [
  { reason, metric: "coverage", op: ">=", threshold: 1.0, consecutiveReads: 2 },
  { reason, metric: "out_of_range_hours", op: "<=", threshold: 12, consecutiveReads: 2 },
  { reason, metric: "fee_yield_daily_pct", op: ">=", threshold: 2.0, consecutiveReads: 2 },
];

export const BOOK: readonly BookPosition[] = [
  {
    kind: "lp-v4",
    id: "send-eth-lp",
    venue: "metamask-mainnet",
    label: "SEND/ETH 1% v4 #418014",
    chain: ETH_MAINNET,
    poolId: "0xfd1c4559ad314e035e2440d88574ce44ff10ab05cfc90e4c8591b2fae7c73a6f",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    positionTokenId: 418014n,
    tickLower: 123800,
    tickUpper: 137600,
    tokens: { token0: "SEND", token1: "ETH" },
    feePips: 10000,
    gecko: { network: "eth", pool: "0xfd1c4559ad314e035e2440d88574ce44ff10ab05cfc90e4c8591b2fae7c73a6f" },
    posted: { basisUsd: 223.53, asOf: "2026-10-02" },
    theses: LP_THESES("fee yield covers LVR on a volatile pair while in range"),
  },
  {
    kind: "lp-v3",
    id: "priors-weth-lp",
    venue: "robinhood-chain",
    label: "PRIORS/WETH 1% v3 #1363060",
    chain: RH_CHAIN,
    pool: "0xdf36b1014675b5b931b69c15c8b4358ef0b4a972",
    npm: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
    tokenId: 1363060n,
    tickLower: 122000,
    tickUpper: 132800,
    tokens: { token0: "PRIORS", token1: "WETH" },
    feePips: 10000, // fee() verified on-chain 2026-10-02; the name says 1%, the chain agrees.
    feeProtocol: 102, // 1/6 protocol take → LPs keep 5/6 of the tier.
    gecko: { network: "robinhood", pool: "0xdf36b1014675b5b931b69c15c8b4358ef0b4a972" },
    posted: { basisUsd: 76.75, asOf: "2026-10-02" },
    theses: LP_THESES("fee yield covers LVR; 4.2x at entry"),
  },
  {
    kind: "posted",
    id: "stx-stacked",
    venue: "xverse",
    label: "STX (stacked)",
    posted: { units: 707.23, asset: "STX", basisUsd: 548, asOf: "2026-09-19" },
    volDragAnnualPct: null,
    notes:
      "Stacked + liquid both count. Can also sit on an exchange invisible to a chain read — " +
      "the off-wallet/unconfirmed bucket exists because a chain-looking total was $103 wrong once.",
  },
  {
    kind: "posted",
    id: "jto-brokerage",
    venue: "robinhood-brokerage",
    label: "JTO",
    posted: { units: null, asset: "JTO", basisUsd: 657, asOf: "2026-09-19" },
    volDragAnnualPct: 69,
    notes: "Vol drag 69%/yr (sigma^2/2, from the DCA study that survived its shuffled null): must ~triple annually to tread water.",
  },
];

export function positionById(id: string): BookPosition | undefined {
  return BOOK.find((p) => p.id === id);
}
