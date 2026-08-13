import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildEquityEvidence, EquityInstrumentInput } from "../../src/lib/markets/equityEvidence";
import { buildMarketBias } from "../../src/lib/signals/marketBias";
import { MarketBias } from "../../src/lib/signals/types";
import { buildTradePlanOutcome, TradePlan, TradePlanRefusal } from "../../src/lib/signals/tradePlan";
import { earningsVeto, EarningsCalendar, EarningsVetoResult } from "../../src/lib/markets/earningsVeto";
import earningsCalendarJson from "../../src/data/earningsCalendar.json";
import {
  buildSupportResistanceZones,
  buildVolumeProfile,
  SupportResistanceZone,
} from "../../src/lib/technicals/marketStructure";
import { atr } from "../../src/lib/technicals/indicators";

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
  /** Null when the engine has no directional read — a plan for a neutral verdict would be invented. */
  plan: TradePlan | null;
  /**
   * WHY there is no plan, when the verdict WAS directional and the geometry
   * still refused. Null when a plan exists, and null when the verdict is
   * neutral — in that case the absence is explained by the verdict itself and
   * a geometric refusal would be a second, competing reason for the same
   * silence.
   */
  planRefusal: TradePlanRefusal | null;
  /** The report date/session count that fired the earnings veto, for the page to cite alongside the refusal. Null when no report is inside the window (or the calendar is unavailable — indistinguishable on purpose). */
  earnings: EarningsVetoResult | null;
  zones: SupportResistanceZone[];
  atrPct: number | null;
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
    /*
     * basis: "state" — every equity evidence module is State-role, so the
     * composite here is a CONDITIONS read, scored by the same engine on an
     * explicit state basis (equal weights; see ScoreBasis in scoring.ts).
     * This replaced the TRANSITIONAL_STATE_VOTERS exception under which
     * these modules voted in the edge composite: identical numbers (the
     * transitional weights were already equal), honest label.
     */
    const bias = buildMarketBias({
      asset: symbol, metrics, technicals: null, squeezeScore: null, previous: null, now: asOf,
      basis: "state",
    } as never);

    if (!bias) {
      // Loud, never silent. A market that cannot be scored is omitted from
      // the snapshot rather than shipped with a placeholder decision.
      console.log(`  ${symbol}: NO BIAS — ${metrics.length} metrics did not produce a score`);
      continue;
    }

    /*
     * TRADE PLAN. Same buildTradePlan the crypto side uses — structural stop
     * beyond the protective zone, targets at structure, R:R re-measured from
     * the real entry. Two honest departures for equities:
     *
     *  - `historicalWinRatePct` is NULL. There is no equity backtest, so the
     *    star rating is built without the one input that measures whether
     *    comparable trades actually finished green. Passing a crypto win rate
     *    here would be the worst kind of borrowed authority.
     *  - No plan at all for a neutral verdict. A plan needs a direction, and
     *    manufacturing one from a 52 score is exactly the false precision the
     *    engine is supposed to refuse.
     */
    /*
     * Same two calls the crypto aggregator makes, in the same order. The
     * volume profile was previously passed as null here, which silently cost
     * equities the point-of-control and value-area-edge confluence tags that
     * crypto levels carry — the ingested bars have had a volume field all
     * along. Levels confirmed by two independent methods score higher, so
     * omitting it was not neutral; it flattened the ranking.
     *
     * Both functions window their own input (90 bars for the profile, 300 for
     * the zones), so handing them the full ingested history is safe.
     */
    const volumeProfile = buildVolumeProfile(bars as never);
    const zones = buildSupportResistanceZones(bars as never, volumeProfile, "1D");
    const atrAbs = atr(bars as never);
    const lastClose = bars[bars.length - 1].close;
    const atrPct = atrAbs !== null && lastClose > 0 ? (atrAbs / lastClose) * 100 : null;

    const direction = bias.verdict === "bullish" ? "long" : bias.verdict === "bearish" ? "short" : null;
    /*
     * EARNINGS VETO (redesign step 4) — checked before any geometry, like
     * the EV gate: no arrangement of levels makes a stop meaningful across
     * an earnings gap. Absence of calendar data never vetoes (see
     * earningsVeto.ts); a veto refuses the PLAN while the read itself
     * still publishes.
     */
    const earnings = earningsVeto(symbol, earningsCalendarJson as EarningsCalendar, Date.now());
    const outcome = direction && earnings
      ? ({ plan: null, refusal: "earnings-imminent" } as const)
      : direction
      ? buildTradePlanOutcome({
          direction,
          anchorPrice: lastClose,
          atrPct,
          zones,
          quality: {
            confidence: bias.confidence,
            agreement: bias.agreement,
            historicalWinRatePct: null,
            historicalWinRateN: null,
          },
        })
      : null;

    const prev = bars[bars.length - 2]?.close ?? bars[bars.length - 1].close;
    decisions.push({
      symbol,
      name: NAMES[symbol] ?? symbol,
      bias,
      lastClose: bars[bars.length - 1].close,
      change24hPct: prev > 0 ? ((bars[bars.length - 1].close - prev) / prev) * 100 : 0,
      asOf,
      plan: outcome?.plan ?? null,
      planRefusal: outcome?.refusal ?? null,
      earnings,
      zones,
      atrPct,
    });
    console.log(
      `  ${symbol}: ${bias.verdict} ${bias.score} (conf ${bias.confidence}) from ${metrics.length} metrics` +
        `${
          outcome?.plan
            ? ` · plan ${outcome.plan.riskRewardRatio.toFixed(2)}R`
            : ` · no plan (${outcome?.refusal ?? "neutral verdict"})`
        }`
    );
  }

  const out = path.join(__dirname, "..", "..", "src", "data", "equityMarkets.json");
  fs.writeFileSync(out, JSON.stringify({ generatedAt: Date.now(), decisions }, null, 0));
  console.log(`\n[markets] wrote ${decisions.length} decisions to ${out}`);

  writeMarketContext(spy, universe, credit, duration);
}

/**
 * THE SHARED MARKET CONTEXT — what every equity has in common.
 *
 * Breadth and risk appetite are properties of the MARKET, not of a ticker:
 * the reading is byte-identical for AAPL and for SPY, because neither is
 * computed from the instrument at all. So they are computed once here and
 * committed, which is what lets the live ticker search score an arbitrary
 * symbol without refetching six index ETFs and two bond funds on every
 * request.
 *
 * The benchmark series ships alongside them because relative strength — the
 * single most load-bearing equity read — is meaningless without something to
 * be relative TO. Only `t` and `close` are kept (that is all the evaluator
 * reads) and only the trailing window the percentile bands actually reach,
 * which keeps this to a few tens of kilobytes rather than shipping years of
 * OHLCV into the bundle.
 */
function writeMarketContext(
  spy: EquityInstrumentInput,
  universe: EquityInstrumentInput[],
  credit: EquityInstrumentInput | undefined,
  duration: EquityInstrumentInput | undefined
) {
  const asOf = spy.bars[spy.bars.length - 1].t;

  /*
   * Built by asking for SPY's own evidence and keeping only the market-wide
   * modules. Deliberately not a second code path: if these were recomputed
   * differently here, a searched ticker and a snapshot page could disagree
   * about the same market on the same day.
   */
  const spyEvidence = buildEquityEvidence({
    instrument: spy, benchmark: spy, universe, credit, duration, asOf,
  });
  const MARKET_WIDE_IDS = new Set(["equityBreadth", "equityRiskAppetite"]);
  const marketWide = spyEvidence.filter((m) => MARKET_WIDE_IDS.has(m.id));

  /** 60 sessions for the relative-strength window + 500 of percentile history, plus slack. */
  const KEEP = 600;
  const benchmarkCloses = spy.bars.slice(-KEEP).map((b) => ({ t: b.t, close: b.close }));

  const out = path.join(__dirname, "..", "..", "src", "data", "marketContext.json");
  fs.writeFileSync(
    out,
    JSON.stringify({ generatedAt: Date.now(), asOf, benchmarkSymbol: "SPY", benchmarkCloses, marketWide }, null, 0)
  );
  console.log(
    `[context] ${marketWide.length} market-wide readings (${marketWide.map((m) => m.label).join(", ")}) ` +
      `+ ${benchmarkCloses.length} benchmark closes -> ${out}`
  );
}

main();
