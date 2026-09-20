import { describe, expect, it } from "vitest";
import { GAP_SIGMA_CUT, MIN_RETAINED, postGapRv } from "./postGapRv";

/**
 * Build aligned OHLC-ish arrays from (gapPct, intradayPct) per session, so a
 * test can inject a known earnings gap and check it is the one dropped.
 * open_t = prevClose*(1+gap), close_t = open_t*(1+intraday).
 */
function series(moves: { gap: number; intra: number }[], startClose = 100) {
  const opens: number[] = [startClose];
  const closes: number[] = [startClose];
  const dates: string[] = ["2026-01-01"];
  let prevClose = startClose;
  for (let i = 0; i < moves.length; i++) {
    const open = prevClose * (1 + moves[i].gap);
    const close = open * (1 + moves[i].intra);
    opens.push(open);
    closes.push(close);
    dates.push(`2026-02-${String(i + 1).padStart(2, "0")}`);
    prevClose = close;
  }
  return { opens, closes, dates };
}

describe("postGapRv", () => {
  it("refuses below MIN_RETAINED usable sessions rather than estimating thin", () => {
    const { opens, closes, dates } = series(Array(MIN_RETAINED - 2).fill({ gap: 0.001, intra: 0.001 }));
    expect(postGapRv(opens, closes, dates)).toBeNull();
  });

  it("drops a single large earnings gap and keeps the ordinary sessions", () => {
    // 20 quiet sessions, then one +25% overnight gap (an earnings jump).
    const quiet = Array.from({ length: 20 }, (_, i) => ({ gap: (i % 2 ? 1 : -1) * 0.004, intra: 0.003 }));
    const withGap = [...quiet, { gap: 0.25, intra: 0.0 }];
    const { opens, closes, dates } = series(withGap);
    const res = postGapRv(opens, closes, dates)!;
    expect(res).not.toBeNull();
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0].gapPct).toBeGreaterThan(20);
  });

  it("does NOT drop ordinary intraday volatility — the retired 3x-median trap", () => {
    // Big INTRADAY moves, tiny gaps: a volatile-but-continuous tape. The gap
    // rule must keep every session — none is an overnight outlier.
    const moves = Array.from({ length: 21 }, (_, i) => ({ gap: 0.0005 * (i % 2 ? 1 : -1), intra: 0.05 * (i % 2 ? 1 : -1) }));
    const { opens, closes, dates } = series(moves);
    const res = postGapRv(opens, closes, dates)!;
    expect(res.dropped).toHaveLength(0);
    expect(res.rvPct).toBeGreaterThan(0);
  });

  it("post-gap RV is materially lower than RV that keeps the gap", () => {
    const quiet = Array.from({ length: 20 }, (_, i) => ({ gap: (i % 2 ? 1 : -1) * 0.004, intra: 0.002 }));
    const withGap = [...quiet, { gap: 0.25, intra: 0.0 }];
    const { opens, closes, dates } = series(withGap);
    const post = postGapRv(opens, closes, dates)!;
    // A naive RV over the same closes (no dropping) using the same convention:
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const win = rets.slice(-21);
    const naive = Math.sqrt(win.reduce((a, r) => a + r * r, 0) / win.length) * Math.sqrt(252) * 100;
    expect(post.rvPct).toBeLessThan(naive * 0.7); // the gap dominated the naive number
  });

  it("keeps everything when gaps have no dispersion (sigma 0)", () => {
    const moves = Array.from({ length: 21 }, () => ({ gap: 0.002, intra: 0.01 }));
    const { opens, closes, dates } = series(moves);
    const res = postGapRv(opens, closes, dates)!;
    expect(res.dropped).toHaveLength(0);
  });

  it("does NOT strip a tight bimodal gap distribution (the MAD-degeneracy trap)", () => {
    // Alternating ±0.05% gaps: two near-identical clusters. Naive MAD collapses
    // to float noise and a 4-sigma test would drop half the sample. The MeanAD
    // fallback must keep them — none is a real jump.
    const moves = Array.from({ length: 21 }, (_, i) => ({ gap: 0.0005 * (i % 2 ? 1 : -1), intra: 0.05 * (i % 2 ? 1 : -1) }));
    const { opens, closes, dates } = series(moves);
    const res = postGapRv(opens, closes, dates)!;
    expect(res.dropped).toHaveLength(0);
  });

  it("STILL drops a lone earnings gap in an otherwise dead-flat stock (MAD=0 case)", () => {
    // 20 identical tiny gaps + one 25% jump: MAD is 0, but the MeanAD fallback
    // must still catch the jump — the case we most want to remove.
    const flat = Array.from({ length: 20 }, () => ({ gap: 0.0001, intra: 0.0 }));
    const withGap = [...flat, { gap: 0.25, intra: 0.0 }];
    const { opens, closes, dates } = series(withGap);
    const res = postGapRv(opens, closes, dates)!;
    expect(res.dropped).toHaveLength(1);
    expect(res.dropped[0].gapPct).toBeGreaterThan(20);
  });

  it("states the window it measured over", () => {
    const moves = Array.from({ length: 25 }, (_, i) => ({ gap: 0.003 * (i % 2 ? 1 : -1), intra: 0.004 }));
    const { opens, closes, dates } = series(moves);
    const res = postGapRv(opens, closes, dates, 21)!;
    expect(res.window.sessions).toBeLessThanOrEqual(21);
    expect(res.window.from < res.window.to).toBe(true);
    expect(GAP_SIGMA_CUT).toBe(4); // the specified cut, pinned
  });
});
