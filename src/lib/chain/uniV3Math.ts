/**
 * UNISWAP V3 FEE AND AMOUNT MATH — pure, exact, and the correctness core of
 * the whole LP monitor.
 *
 * Everything here is arithmetic on values read from the chain. It touches no
 * network and no clock, so it is unit-testable against the fixtures the
 * trading session chain-verified, and every branch that depends on tick
 * position is exercised there. If the position card ever disagrees with a
 * fixture, the bug is here or in the reader — not in the fixture.
 *
 * ── Why BigInt and asUintN, not floats ────────────────────────────────
 *
 * feeGrowth values are Q128.128 fixed-point accumulators that WRAP at 2^256 by
 * design: Uniswap subtracts them mod 2^256 and relies on the wrap, so a naive
 * subtraction of two large values can be "negative" and still be the correct
 * fee. Doing this in floating point loses ~200 bits and turns a real $1.71/day
 * into noise. BigInt is exact; `BigInt.asUintN(256, x)` reduces mod 2^256
 * exactly, which is the whole trick the fee formula turns on.
 */

const Q128 = 1n << 128n;

/** Reduce to an unsigned 256-bit value — i.e. mod 2^256, matching the EVM. */
export function mod256(x: bigint): bigint {
  return BigInt.asUintN(256, x);
}

/** The six fee-growth accumulators a fee computation needs, all raw Q128.128. */
export interface FeeGrowthSnapshot {
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
  /** ticks[tickLower].feeGrowthOutside{0,1}X128 */
  lowerOutside0X128: bigint;
  lowerOutside1X128: bigint;
  /** ticks[tickUpper].feeGrowthOutside{0,1}X128 */
  upperOutside0X128: bigint;
  upperOutside1X128: bigint;
  /** positions() fields 8/9: feeGrowthInside{0,1}LastX128 at our last touch. */
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
}

/**
 * Uncollected fees for ONE token, in raw token units (before /1e18).
 *
 * The formula is Uniswap's own, transcribed from the build order verbatim and
 * done entirely mod 2^256:
 *
 *   below = outside(lower)              if currentTick >= lowerTick
 *           global - outside(lower)     otherwise
 *   above = outside(upper)             if currentTick <  upperTick
 *           global - outside(upper)     otherwise
 *   inside_now = global - below - above
 *   owed = (inside_now - insideLast) * L / 2^128
 *
 * Every subtraction can underflow a plain integer and MUST wrap — that wrap is
 * not a bug being tolerated, it is the accumulator arithmetic working as
 * designed. The final `* L / 2^128` un-scales the Q128 fixed point.
 */
export function feesOwedRaw(params: {
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  global: bigint;
  lowerOutside: bigint;
  upperOutside: bigint;
  insideLast: bigint;
  liquidity: bigint;
}): bigint {
  const { currentTick, tickLower, tickUpper, global, lowerOutside, upperOutside, insideLast, liquidity } =
    params;

  const below = currentTick >= tickLower ? lowerOutside : mod256(global - lowerOutside);
  const above = currentTick < tickUpper ? upperOutside : mod256(global - upperOutside);
  const insideNow = mod256(global - below - above);
  const delta = mod256(insideNow - insideLast);
  // delta is Q128.128 fee-per-unit-liquidity; * L then >> 128 gives token units.
  return (delta * liquidity) / Q128;
}

/** Both tokens' uncollected fees, raw units. Thin wrapper over feesOwedRaw. */
export function feesOwed(
  snap: FeeGrowthSnapshot,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint
): { raw0: bigint; raw1: bigint } {
  return {
    raw0: feesOwedRaw({
      currentTick,
      tickLower,
      tickUpper,
      global: snap.feeGrowthGlobal0X128,
      lowerOutside: snap.lowerOutside0X128,
      upperOutside: snap.upperOutside0X128,
      insideLast: snap.feeGrowthInside0LastX128,
      liquidity,
    }),
    raw1: feesOwedRaw({
      currentTick,
      tickLower,
      tickUpper,
      global: snap.feeGrowthGlobal1X128,
      lowerOutside: snap.lowerOutside1X128,
      upperOutside: snap.upperOutside1X128,
      insideLast: snap.feeGrowthInside1LastX128,
      liquidity,
    }),
  };
}

/**
 * sqrt price at a tick: sp(x) = 1.0001^(x/2). A float is correct here — this
 * feeds a USD display, not the fee accumulator, and the token amounts it
 * produces are checked against the fixture card to the cent.
 */
export function sqrtPriceAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

/**
 * Token amounts an in-range position holds at the current tick, in whole tokens
 * (already divided by 1e18 for two 18-decimal tokens).
 *
 *   WETH (token0) = L * (1/sp(t) - 1/sp(upper)) / 1e18
 *   PONS (token1) = L * (sp(t) - sp(lower))     / 1e18
 *
 * Clamped at the range edges: below the range the position is all token0, above
 * it all token1. Uses Number(L) — L here is ~2e19, well inside the 2^53 exact
 * range once we accept the display is a float, and the result is checked
 * against the fixture.
 */
export function positionAmounts(
  liquidity: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number
): { amount0: number; amount1: number } {
  const L = Number(liquidity);
  const spLower = sqrtPriceAtTick(tickLower);
  const spUpper = sqrtPriceAtTick(tickUpper);
  const t = Math.min(Math.max(currentTick, tickLower), tickUpper);
  const spT = sqrtPriceAtTick(t);
  const amount0 = (L * (1 / spT - 1 / spUpper)) / 1e18;
  const amount1 = (L * (spT - spLower)) / 1e18;
  return { amount0, amount1 };
}

/**
 * PONS price in USD from the tick and an ETH/USD reference.
 *
 *   PONS_usd = ETH_usd / 1.0001^tick
 *
 * The ETH/USD source is the caller's and MUST be labelled on the card — this
 * function cannot know where the price came from, so it takes the number, not
 * responsibility for its provenance.
 */
export function ponsUsd(currentTick: number, ethUsd: number): number {
  return ethUsd / Math.pow(1.0001, currentTick);
}

/** Fraction of the range traversed, 0 at the lower tick, 1 at the upper. */
export function pctThroughRange(currentTick: number, tickLower: number, tickUpper: number): number {
  return (currentTick - tickLower) / (tickUpper - tickLower);
}

/**
 * USD/day fee rate BETWEEN two consecutive reads.
 *
 * Returns null rather than a number when the two reads cannot be compared:
 *
 *  - a non-positive time gap (clock skew or a duplicate block), and
 *  - a DROP in cumulative fees, which is the fee clock RESETTING (a
 *    collect/compound). A reset is a series break, not a negative rate — the
 *    caller writes a break row and starts a fresh clock rather than dividing
 *    across it. This is the "never a negative rate" rule made structural.
 */
export function feeRatePerDay(
  prev: { feesUsd: number; ts: number },
  curr: { feesUsd: number; ts: number }
): number | null {
  const days = (curr.ts - prev.ts) / 86_400_000;
  if (days <= 0) return null;
  if (curr.feesUsd < prev.feesUsd) return null; // reset — the caller handles the break
  return (curr.feesUsd - prev.feesUsd) / days;
}

/**
 * LVR coverage: does the fee rate cover loss-versus-rebalancing?
 *
 *   LVR (daily, as a fraction of position value) = sigma^2 / 8
 *   coverage = feeRatePerDay / (LVR_fraction * positionValue)
 *
 * sigma is PONS's daily volatility from the pool's OWN tick series (the window
 * must be stated by the caller). Coverage below 1.0 means the fees are not
 * paying for the impermanent loss the volatility implies — an ALERT, never a
 * recommendation. Returns null when any input is missing rather than implying
 * coverage from absent data.
 */
export function lvrCoverage(params: {
  feeRateUsdPerDay: number | null;
  dailySigma: number | null;
  positionValueUsd: number | null;
}): { lvrUsdPerDay: number; coverage: number } | null {
  const { feeRateUsdPerDay, dailySigma, positionValueUsd } = params;
  if (feeRateUsdPerDay === null || dailySigma === null || positionValueUsd === null) return null;
  if (positionValueUsd <= 0) return null;
  const lvrFraction = (dailySigma * dailySigma) / 8;
  const lvrUsdPerDay = lvrFraction * positionValueUsd;
  if (lvrUsdPerDay <= 0) return null;
  return { lvrUsdPerDay, coverage: feeRateUsdPerDay / lvrUsdPerDay };
}
