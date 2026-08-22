import barsPanelJson from "../../src/data/barsPanel.json";
import { BENCHMARK_SYMBOL } from "../../src/lib/research/benchmark";
import { regressOnMarket, DatedReturn } from "../../src/lib/research/alphaBeta";

const panel = barsPanelJson as any;
function returns(sym: string): DatedReturn[] {
  const sp = panel.symbols[sym];
  const out: DatedReturn[] = [];
  for (let i = 1; i < panel.sessions.length; i++) {
    const a = sp.bars[i - 1], b = sp.bars[i];
    if (!a || !b || a[3] <= 0) continue;
    out.push({ date: panel.sessions[i], netBp: (b[3] / a[3] - 1) * 10_000 });
  }
  return out;
}
console.log("panel benchmark:", BENCHMARK_SYMBOL, "| sessions:", panel.sessions.length);
for (const s of ["CIFR", "BTDR", "RIOT"]) {
  for (const bench of [BENCHMARK_SYMBOL, "SPY"]) {
    if (!panel.symbols[bench]) { console.log(`${s} vs ${bench}: benchmark not in panel`); continue; }
    const r = regressOnMarket(returns(s), returns(bench));
    console.log(`${s} vs ${bench}: beta ${r ? r.beta.toFixed(3) : "null"}`);
  }
}
