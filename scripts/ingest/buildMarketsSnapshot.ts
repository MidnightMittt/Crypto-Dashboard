import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildEquityEvidence, EquityInstrumentInput } from "../../src/lib/markets/equityEvidence";
import { buildMarketBias } from "../../src/lib/signals/marketBias";
import { MarketBias } from "../../src/lib/signals/types";

/**
 * Precomputes the equity decisions into a bundled JSON snapshot.
 *
 * WHY A SNAPSHOT rather than a request-time read. The ingested bar files live
 * under scripts/, which is not guaranteed to be included in a serverless
 * deployment bundle — a route reading them would work locally and 500 in
 * production, the worst possible failure shape. The inputs are daily bars
 * refreshed by a manual ingest run, so nothing is lost by computing at build
 * time, and the page states its as-of date so the staleness is visible rather
 * than implied.
 *
 * Run: npx tsx scripts/ingest/buildMarketsSnapshot.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

/*
 * EQUITY INDICES ONLY, deliberately.
 *
 * GLD and TLT were in this list and produced "bullish 96"-type reads that do
 * not survive scrutiny: they were being scored partly on EQUITY breadth and
 * on a credit-vs-duration spread, neither of which is evidence about gold or
 * about Treasuries themselves. For TLT it is close to inverted — a risk-on
 * equity tape is a headwind for long duration, not a tailwind.
 *
 * The evidence modules are correct; applying them outside the asset class
 * they were built for is not. Cross-asset instruments return once they have
 * evidence modules of their own (real yields, DXY, term structure).
 */
const MARKETS = ["SPY", "QQQ", "DIA", "IWM"];
/** The equity complex breadth is measured over. */
const BREADTH_SET = ["SPY", "QQQ", "DIA", "IWM", "XLF"];

function load(symbol: string): EquityInstrumentInput | null {
  const f = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(f)) return null;
  return { symbol, bars: JSON.parse(fs.readFileSync(f, "utf8")).bars };
}

export interface MarketDecision {
  symbol: string;
  name: string;
  bias: MarketBias;
  lastClose: number;
  change24hPct: number;
  asOf: number;
}

const NAMES: Record<string, string> = {
  SPY: "S&P 500", QQQ: "Nasdaq 100", DIA: "Dow Jones",
  IWM: "Russell 2000",
};

function main() {
  const spy = load("SPY");
  if (!spy) throw new Error("SPY is the benchmark and is required — run scripts/ingest/yahoo.ts first");

  const universe = BREADTH_SET.map(load).filter((x): x is EquityInstrumentInput => x !== null);
  const credit = load("HYG") ?? undefined;
  const duration = load("TLT") ?? undefined;

  const decisions: MarketDecision[] = [];
  for (const symbol of MARKETS) {
    const instrument = load(symbol);
    if (!instrument) {
      console.log(`  ${symbol}: SKIPPED — not ingested`);
      continue;
    }
    const bars = instrument.bars;
    const asOf = bars[bars.length - 1].t;

    const metrics = buildEquityEvidence({ instrument, benchmark: spy, universe, credit, duration, asOf });
    const bias = buildMarketBias({
      asset: symbol, metrics, technicals: null, squeezeScore: null, previous: null, now: asOf,
    } as never);

    if (!bias) {
      // Loud, never silent. A market that cannot be scored is omitted from
      // the snapshot rather than shipped with a placeholder decision.
      console.log(`  ${symbol}: NO BIAS — ${metrics.length} metrics did not produce a score`);
      continue;
    }

    const prev = bars[bars.length - 2]?.close ?? bars[bars.length - 1].close;
    decisions.push({
      symbol,
      name: NAMES[symbol] ?? symbol,
      bias,
      lastClose: bars[bars.length - 1].close,
      change24hPct: prev > 0 ? ((bars[bars.length - 1].close - prev) / prev) * 100 : 0,
      asOf,
    });
    console.log(`  ${symbol}: ${bias.verdict} ${bias.score} (conf ${bias.confidence}) from ${metrics.length} metrics`);
  }

  const out = path.join(__dirname, "..", "..", "src", "data", "equityMarkets.json");
  fs.writeFileSync(out, JSON.stringify({ generatedAt: Date.now(), decisions }, null, 0));
  console.log(`\n[markets] wrote ${decisions.length} decisions to ${out}`);
}

main();
