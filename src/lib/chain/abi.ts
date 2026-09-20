/**
 * JUST ENOUGH ABI CODEC for the six read calls this monitor makes.
 *
 * Not a general ABI library — it decodes fixed 32-byte words at known offsets,
 * because that is the entire shape of slot0/liquidity/feeGrowth/ticks/positions
 * returns. Keeping it this small means the word offsets the build order
 * specified (positions field 7 = L, ticks field 2/3 = feeGrowthOutside) are
 * visible and testable rather than buried in a decoder's generic machinery.
 */

/** Strip 0x and assert the hex is whole 32-byte words. */
function hexBody(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 64 !== 0) {
    throw new Error(`ABI hex is not a whole number of 32-byte words: ${h.length} nibbles`);
  }
  return h;
}

/** The i-th 32-byte word as an unsigned bigint. */
export function wordAt(hex: string, i: number): bigint {
  const h = hexBody(hex);
  const start = i * 64;
  if (start + 64 > h.length) {
    throw new Error(`word ${i} out of range: hex has ${h.length / 64} words`);
  }
  return BigInt("0x" + h.slice(start, start + 64));
}

/** Interpret an unsigned 256-bit word as a signed two's-complement int (for ticks). */
export function asSigned(word: bigint): number {
  return Number(BigInt.asIntN(256, word));
}

/**
 * ABI-encode an int24 argument as a 32-byte, sign-extended word — how
 * ticks(int24) wants its tick. Our ticks are positive, but negative ticks are
 * valid in v3 and a plain hex of the magnitude would silently query the wrong
 * slot, so the sign extension is done properly.
 */
export function encodeInt24(tick: number): string {
  return BigInt.asUintN(256, BigInt(tick)).toString(16).padStart(64, "0");
}

/** ABI-encode a uint256 argument (e.g. a tokenId) as a 32-byte word. */
export function encodeUint256(value: bigint): string {
  return BigInt.asUintN(256, value).toString(16).padStart(64, "0");
}

/**
 * slot0() → the current tick. Word 0 is sqrtPriceX96, word 1 is the int24 tick
 * sign-extended to 256 bits.
 */
export function decodeSlot0Tick(hex: string): number {
  return asSigned(wordAt(hex, 1));
}

/** slot0() → sqrtPriceX96 (word 0), kept for callers that want the raw price. */
export function decodeSlot0SqrtPriceX96(hex: string): bigint {
  return wordAt(hex, 0);
}

/** A single uint (liquidity, feeGrowthGlobal, fee) — the whole return is one word. */
export function decodeUint(hex: string): bigint {
  return wordAt(hex, 0);
}

/**
 * ticks(int24) → the two fee-growth-outside accumulators. Field 2 and field 3
 * (0-indexed words 2 and 3), exactly as the build order specifies.
 */
export function decodeTickFeeGrowthOutside(hex: string): { outside0: bigint; outside1: bigint } {
  return { outside0: wordAt(hex, 2), outside1: wordAt(hex, 3) };
}

/**
 * positions(uint256) → the fields the fee math needs. Field 7 = L, fields 8/9 =
 * feeGrowthInside{0,1}LastX128, fields 10/11 = tokensOwed{0,1}.
 *
 * tokensOwed is decoded and RETURNED but must never be shown as "current fees":
 * it only updates on a burn/collect. It is here so a caller can DETECT a
 * collect (tokensOwed reset to 0) and cross-check, never to display.
 */
export function decodePosition(hex: string): {
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
} {
  return {
    liquidity: wordAt(hex, 7),
    feeGrowthInside0LastX128: wordAt(hex, 8),
    feeGrowthInside1LastX128: wordAt(hex, 9),
    tokensOwed0: wordAt(hex, 10),
    tokensOwed1: wordAt(hex, 11),
  };
}
