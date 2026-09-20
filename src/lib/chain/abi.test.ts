import { describe, expect, it } from "vitest";
import {
  asSigned,
  decodePosition,
  decodeSlot0Tick,
  decodeTickFeeGrowthOutside,
  encodeInt24,
  wordAt,
} from "./abi";

/** Build a return hex from an array of bigint words — the shape eth_call gives back. */
const words = (...xs: bigint[]) => "0x" + xs.map((x) => BigInt.asUintN(256, x).toString(16).padStart(64, "0")).join("");

describe("wordAt", () => {
  it("slices the i-th 32-byte word", () => {
    const hex = words(1n, 2n, 3n);
    expect(wordAt(hex, 0)).toBe(1n);
    expect(wordAt(hex, 2)).toBe(3n);
  });
  it("rejects hex that is not whole words", () => {
    expect(() => wordAt("0xabc", 0)).toThrow(/whole number/);
  });
  it("rejects an out-of-range word index", () => {
    expect(() => wordAt(words(1n), 3)).toThrow(/out of range/);
  });
});

describe("signed tick decoding", () => {
  it("reads a positive tick straight", () => {
    expect(asSigned(82555n)).toBe(82555);
  });
  it("sign-extends a negative int24 from its 256-bit two's complement", () => {
    // -100 as a uint256 word, as slot0 would return it.
    const w = BigInt.asUintN(256, -100n);
    expect(asSigned(w)).toBe(-100);
  });
  it("decodes the tick from slot0's second word", () => {
    const slot0 = words(79228162514264337593543950336n /* sqrtPriceX96 */, BigInt.asUintN(256, 84344n));
    expect(decodeSlot0Tick(slot0)).toBe(84344);
  });
});

describe("encodeInt24", () => {
  it("encodes a positive tick as a 32-byte word", () => {
    expect(encodeInt24(77640)).toBe(BigInt(77640).toString(16).padStart(64, "0"));
  });
  it("sign-extends a negative tick rather than querying the wrong slot", () => {
    expect(encodeInt24(-100)).toBe(BigInt.asUintN(256, -100n).toString(16).padStart(64, "0"));
    expect(encodeInt24(-100)).toContain("ffff");
  });
});

describe("ticks() fee-growth-outside layout", () => {
  it("reads feeGrowthOutside0 from field 2 and outside1 from field 3", () => {
    // liquidityGross(0), liquidityNet(1), outside0(2), outside1(3), ...
    const tickReturn = words(500n, 600n, 12345n, 67890n, 0n, 0n, 0n, 0n);
    const { outside0, outside1 } = decodeTickFeeGrowthOutside(tickReturn);
    expect(outside0).toBe(12345n);
    expect(outside1).toBe(67890n);
  });
});

describe("positions() layout", () => {
  it("reads L from field 7 and feeGrowthInsideLast from 8/9, tokensOwed from 10/11", () => {
    // 12 fields: nonce,operator,token0,token1,fee,tickLower,tickUpper,
    //            L(7),inside0(8),inside1(9),owed0(10),owed1(11)
    const L = 20709381339772035115n;
    const pos = words(0n, 0n, 0n, 0n, 3000n, 77640n, 87000n, L, 111n, 222n, 333n, 444n);
    const d = decodePosition(pos);
    expect(d.liquidity).toBe(L);
    expect(d.feeGrowthInside0LastX128).toBe(111n);
    expect(d.feeGrowthInside1LastX128).toBe(222n);
    expect(d.tokensOwed0).toBe(333n);
    expect(d.tokensOwed1).toBe(444n);
  });
});
