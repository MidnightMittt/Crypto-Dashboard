import { describe, expect, it } from "vitest";
import { TOKEN_ID_TOPIC, decodePositionEvent, sumSwapVolumeWeth } from "./lpEvents";
import { TOPICS } from "./config";
import { RawLog } from "./rpc";

/**
 * THE FIXTURE LOGS, byte-for-byte as this chain returned them on 2026-09-20.
 *
 * These are the real Collect and IncreaseLiquidity from the 09-18 compound the
 * trading session reconciled by hand ($15.68 reported ≈ $15.69 decoded), pinned
 * raw so the decoders are tested against the chain's actual bytes, not against
 * a re-encoding of what we believe they mean.
 */
const COLLECT_LOG: RawLog = {
  address: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  topics: [TOPICS.collect, TOKEN_ID_TOPIC],
  data:
    "0x000000000000000000000000db48906603515a434b567c88ec5ae83c1f9cf4fd" +
    "000000000000000000000000000000000000000000000000000a6574cb7c4a89" +
    "000000000000000000000000000000000000000000000000a16e566c99438c76",
  blockNumber: "0x3f72055", // 66,527,317
};

const INCREASE_LOG: RawLog = {
  address: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  topics: [TOPICS.increaseLiquidity, TOKEN_ID_TOPIC],
  data:
    "0x000000000000000000000000000000000000000000000000154d5ebf8a572545" +
    "0000000000000000000000000000000000000000000000000011c37937e08000" +
    "0000000000000000000000000000000000000000000000011c3ae9b621e580af",
  blockNumber: "0x3f7222c", // 66,527,788
};

describe("TOKEN_ID_TOPIC — the trap that returned zero events", () => {
  it("encodes tokenId 1109566 as …10ee3e, NOT the brief's pasted …10ef3e", () => {
    expect(TOKEN_ID_TOPIC.endsWith("10ee3e")).toBe(true);
    expect(TOKEN_ID_TOPIC.endsWith("10ef3e")).toBe(false);
    // The wrong constant decodes to a different position entirely.
    expect(0x10ef3e).toBe(1109822);
    expect(0x10ee3e).toBe(1109566);
  });
});

describe("decodePositionEvent — against the chain's own bytes", () => {
  it("decodes the 09-18 Collect to the wei-exact fixture amounts", () => {
    const ev = decodePositionEvent(COLLECT_LOG)!;
    expect(ev.kind).toBe("collect");
    expect(ev.block).toBe(66527317);
    expect(ev.amount0).toBeCloseTo(0.002926302071638665, 15);
    expect(ev.amount1).toBeCloseTo(11.632329911972367478, 12);
    expect(ev.liquidityDelta).toBe(0n);
    // The by-hand reconciliation: at ETH ~$2500, PONS ~$0.72 this is ~$15.69.
    expect(ev.amount0 * 2500 + ev.amount1 * 0.72).toBeCloseTo(15.69, 1);
  });

  it("decodes the 09-18 IncreaseLiquidity and reproduces the pre-compound L", () => {
    const ev = decodePositionEvent(INCREASE_LOG)!;
    expect(ev.kind).toBe("increase");
    expect(ev.block).toBe(66527788);
    expect(ev.liquidityDelta).toBe(1534987224755938629n);
    expect(ev.amount0).toBeCloseTo(0.005, 12);
    expect(ev.amount1).toBeCloseTo(20.480939223882760367, 12);
    // Post-compound L minus the delta = the independently recorded 1.9174e19.
    expect(20709381339772035115n - ev.liquidityDelta).toBe(19174394115016096486n);
  });

  it("returns null for a topic it does not know rather than misfiling it", () => {
    expect(decodePositionEvent({ ...COLLECT_LOG, topics: ["0x" + "ab".repeat(32), TOKEN_ID_TOPIC] })).toBeNull();
  });
});

describe("sumSwapVolumeWeth", () => {
  const swapLog = (amount0: bigint): RawLog => ({
    address: "0xpool",
    topics: [TOPICS.swap],
    data:
      "0x" +
      BigInt.asUintN(256, amount0).toString(16).padStart(64, "0") +
      BigInt.asUintN(256, -amount0).toString(16).padStart(64, "0") + // amount1 opposite sign
      "0".repeat(64 * 3),
    blockNumber: "0x1",
  });

  it("abs()es int256 amounts so buys and sells do not net to zero", () => {
    // +0.3 WETH swap and -0.3 WETH swap → volume 0.6, not 0.
    const logs = [swapLog(300000000000000000n), swapLog(-300000000000000000n)];
    expect(sumSwapVolumeWeth(logs)).toBeCloseTo(0.6, 12);
  });

  it("is zero on no logs", () => {
    expect(sumSwapVolumeWeth([])).toBe(0);
  });
});
