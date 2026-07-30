/**
 * Known, currently-active exchange wallet addresses for BTC and ETH.
 *
 * ── Why this list is short ──────────────────────────────────────────────
 *
 * Services like CryptoQuant and Glassnode compute "exchange netflow" from
 * thousands of labeled addresses maintained by paid forensics teams. This
 * app has no such labeling budget, so instead of guessing at a large list
 * (and risking a stale or wrong address silently corrupting the signal —
 * the one thing this codebase never does), each address here was verified
 * individually before being added:
 *
 *   BTC — bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h
 *     Confirmed as a Binance-controlled address via Binance's own published
 *     proof-of-reserves documentation and cross-checked against independent
 *     on-chain explorers. Checked live during development: balance in the
 *     hundreds of thousands of BTC, transaction count in the hundreds of
 *     thousands — unambiguously a real, currently active exchange wallet,
 *     not an abandoned one.
 *
 *   ETH — 0xf977814e90da44bfa03b6295a0616a897441acec
 *     Etherscan's own public label: "Binance: Hot Wallet 20". Checked live
 *     during development: tens of billions of dollars in balance across
 *     chains, tens of thousands of transactions. Also unambiguous.
 *
 * A first pass pulled candidate addresses from a older, commonly-shared
 * community list. Several no longer held any balance — abandoned years ago
 * when the exchange rotated wallets — and were DISCARDED rather than kept,
 * because a drained address contributes silent, misleading zero-flow noise
 * to what's supposed to be a live signal. Only addresses independently
 * confirmed both by an authoritative label AND current on-chain activity
 * made the cut.
 *
 * ── What this means for the signal ──────────────────────────────────────
 *
 * Every address below is Binance. That's not a design choice — it's simply
 * the only exchange whose address could be verified to this standard in the
 * time available. The resulting netflow figure describes "what Binance's
 * largest known wallet did", not "what exchanges in aggregate did". This is
 * disclosed explicitly in the UI, not left for the reader to assume.
 *
 * Expanding this list is straightforward and welcome — the bar for adding
 * an address is the same two checks applied above: an authoritative label
 * (exchange's own disclosure, or a reputable explorer's tag) AND a live
 * balance/transaction-count check confirming it's still in active use.
 */

export interface TrackedAddress {
  address: string;
  exchange: string;
}

export const BTC_ADDRESSES: TrackedAddress[] = [
  { address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h", exchange: "Binance" },
];

export const ETH_ADDRESSES: TrackedAddress[] = [
  { address: "0xf977814e90da44bfa03b6295a0616a897441acec", exchange: "Binance" },
];

export function trackedVenues(addresses: TrackedAddress[]): string[] {
  return Array.from(new Set(addresses.map((a) => a.exchange)));
}
