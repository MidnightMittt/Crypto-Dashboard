import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar } from "../../src/lib/research/types";
import { buildRotation, RotationInput, RotationRead, describeRotation } from "../../src/lib/markets/rotation";
import { REGIME_PAIRS, evaluateRegimePair, buildRegime, RegimeRead } from "../../src/lib/markets/riskRegime";

/**
 * Builds the MARKET INTELLIGENCE snapshot — the top three levels of the
 * hierarchy (global market, risk regime, capital rotation) precomputed into
 * one bundled JSON the homepage reads.
 *
 * Same delivery decision as the Markets snapshot, for the same reason: the
 * ingested bar files live under scripts/ and are not guaranteed to be in a
 * serverless bundle, so a route reading them would work locally and 500 in
 * production. Inputs are daily bars refreshed by a manual ingest run, so
 * nothing is lost by computing at build time — and the page states its as-of
 * date so staleness is visible rather than implied.
 *
 * Run: npx tsx scripts/ingest/buildIntelligence.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

/**
 * The eleven GICS sectors, by their SPDR proxies, plus semiconductors.
 *
 * Semis are not a GICS sector — they are an industry inside Technology. They
 * are included anyway and labelled honestly, because they are the single most
 * decision-relevant industry in this market and the first place rotation
 * shows up. Listing them alongside sectors is a display choice; nothing in
 * the ranking treats them differently.
 */
const SECTORS: Array<{ symbol: string; name: string }> = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
  { symbol: "XLV", name: "Health Care" },
  { symbol: "XLI", name: "Industrials" },
  { symbol: "XLY", name: "Consumer Discretionary" },
  { symbol: "XLP", name: "Consumer Staples" },
  { symbol: "XLE", name: "Energy" },
  { symbol: "XLU", name: "Utilities" },
  { symbol: "XLB", name: "Materials" },
  { symbol: "XLRE", name: "Real Estate" },
  { symbol: "XLC", name: "Communication Services" },
  { symbol: "SMH", name: "Semiconductors" },
];

const BENCHMARK = { symbol: "SPY", name: "S&P 500" };

function load(symbol: string): Bar[] | null {
  const f = path.join(DATA_DIR, `${symbol}.US.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8")).bars as Bar[];
}

export interface IntelligenceSnapshot {
  generatedAt: number;
  regime: RegimeRead | null;
  rotation: RotationRead | null;
  rotationNarrative: string | null;
}

function main() {
  const benchBars = load(BENCHMARK.symbol);
  if (!benchBars) throw new Error("SPY is the benchmark and is required — run scripts/ingest/yahoo.ts first");

  // ── Risk regime ──────────────────────────────────────────────────────
  const asOf = benchBars[benchBars.length - 1].t;
  const regimeMetrics = REGIME_PAIRS.flatMap((pair) => {
    const on = load(pair.riskOn);
    const off = load(pair.riskOff);
    if (!on || !off) {
      // Loud, never silent. A missing leg drops the PAIR rather than
      // substituting a neutral reading that would dilute the others.
      console.log(`  regime: SKIPPED ${pair.label} — missing ${!on ? pair.riskOn : pair.riskOff}`);
      return [];
    }
    const metric = evaluateRegimePair(pair, on, off, asOf);
    return metric ? [metric] : [];
  });
  const regime = buildRegime(regimeMetrics, asOf);
  console.log(
    regime
      ? `  regime: ${regime.regime.toUpperCase()} (${regime.agreeing}/${regime.total} pairs)`
      : "  regime: NONE — no pair could be evaluated"
  );

  // ── Capital rotation ─────────────────────────────────────────────────
  const inputs: RotationInput[] = [];
  for (const s of SECTORS) {
    const bars = load(s.symbol);
    if (!bars) {
      console.log(`  rotation: SKIPPED ${s.symbol} — not ingested`);
      continue;
    }
    inputs.push({ symbol: s.symbol, name: s.name, bars });
  }

  const rotation = buildRotation(inputs, { ...BENCHMARK, bars: benchBars });
  if (rotation) {
    console.log(`  rotation: ${rotation.sectors.length} sectors, dispersion ${rotation.dispersionPct.toFixed(1)}pp`);
    for (const s of rotation.sectors) {
      console.log(
        `    ${s.symbol.padEnd(5)} ${s.state.padEnd(10)} 1m ${s.shortRelPct >= 0 ? "+" : ""}${s.shortRelPct.toFixed(1)}pp  6m ${s.longRelPct >= 0 ? "+" : ""}${s.longRelPct.toFixed(1)}pp`
      );
    }
  }

  const out: IntelligenceSnapshot = {
    generatedAt: Date.now(),
    regime,
    rotation,
    rotationNarrative: rotation ? describeRotation(rotation) : null,
  };

  const outPath = path.join(__dirname, "..", "..", "src", "data", "marketIntelligence.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 0));
  console.log(`\n[intelligence] wrote ${outPath}`);
}

main();
