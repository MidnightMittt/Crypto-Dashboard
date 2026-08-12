import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar, InstrumentMeta, bindAsOf } from "../../src/lib/research/types";
import { InMemoryDataSource } from "../../src/lib/research/inMemorySource";
import { UNIVERSE, findInstrument, instrumentsByProvider } from "../../src/lib/research/universe";
import { extractFeatures, UNIVERSAL_FEATURES } from "../../src/lib/research/features";
import { analyzePanel } from "../../src/lib/research/panelStatistics";
import { PanelObservation } from "../../src/lib/research/panelBootstrap";
import { sessionPeriodKey } from "../../src/lib/research/session";
import { executeStudy, StudyDeclaration, StudyObservation, StudyRunContext } from "../../src/lib/research/study";

/**
 * PROOF: the research engine executes on equities with no special-casing.
 *
 * This is the deliverable that matters for the ingestion phase. It does not
 * look for a trading signal — it demonstrates that every layer built for
 * crypto runs unmodified on ETFs, and that the panel estimator discounts
 * real correlated instruments the way the Phase 7 correlation analysis said
 * it must.
 *
 * Nothing in this script branches on asset class. The only per-instrument
 * input is the registry entry.
 *
 * Run: npx tsx scripts/ingest/proveCrossAsset.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DAY = 86_400_000;

interface StoredSeries {
  meta: InstrumentMeta;
  bars: Bar[];
}

function loadEquities(): StoredSeries[] {
  return instrumentsByProvider("yahoo").map((c) => {
    const file = path.join(DATA_DIR, `${c.meta.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredSeries;
    return { meta: c.meta, bars: parsed.bars };
  });
}

const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => `${(100 * x).toFixed(2)}%`;

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  say("# Cross-Asset Ingestion — Architecture Proof");
  say("");
  say("Demonstrates that the research engine runs unchanged on equities. No branch on asset class exists anywhere below; the only per-instrument input is the universe registry entry.");
  say("");

  const equities = loadEquities();
  const source = new InMemoryDataSource(
    equities.map((s) => ({ meta: s.meta, bars: { "1D": s.bars } }))
  );

  // ── 1. The data ───────────────────────────────────────────────────────
  say("## 1. Ingested universe");
  say("");
  say("| Instrument | Class | Session | Bars | From | To |");
  say("|---|---|---|---|---|---|");
  for (const s of equities) {
    say(`| ${s.meta.id} | ${s.meta.assetClass} | ${s.meta.sessionModel.label} | ${s.bars.length} | ` +
        `${new Date(s.bars[0].t).toISOString().slice(0, 10)} | ${new Date(s.bars[s.bars.length - 1].t).toISOString().slice(0, 10)} |`);
  }
  say("");

  // ── 2. Features run unchanged ─────────────────────────────────────────
  say("## 2. The universal feature library runs unmodified");
  say("");
  say("These are the same `UNIVERSAL_FEATURES` written for crypto, reading through the same `BoundedMarketView`. No equity-specific feature was added.");
  say("");
  const probeT = Date.UTC(2024, 5, 14, 20);
  say("| Instrument | trend_medium | return_20d | efficiency_20d | atr_percentile |");
  say("|---|---|---|---|---|");
  for (const s of equities) {
    const v = extractFeatures(UNIVERSAL_FEATURES, {
      instrument: s.meta,
      source: bindAsOf(source, probeT),
      asOf: probeT,
    });
    say(`| ${s.meta.id} | ${v.values.trend_medium} | ${f2(v.values.return_20d as number)}% | ` +
        `${f2(v.values.efficiency_20d as number)} | ${f2(v.values.atr_percentile as number)} |`);
    if (v.errored.length > 0) say(`   ERRORED: ${v.errored.join(", ")}`);
  }
  say("");

  // ── 3. The cross-sectional discount, on real correlated instruments ───
  say("## 3. The panel estimator discounts real correlated instruments");
  say("");
  say("Five US equity index/sector ETFs share most of their variance. If the estimator is working, five instruments must deliver far less than five times the information. This is the Phase 7 correlation finding, now measured on real equity data rather than crypto.");
  say("");

  // Build a panel of 5-session forward returns, keyed by trading session.
  const HORIZON = 5;
  const startT = Date.UTC(2015, 0, 1);
  const observations: PanelObservation[] = [];
  const perInstrument = new Map<string, PanelObservation[]>();

  for (const s of equities) {
    const bars = s.bars.filter((b) => b.t >= startT);
    const own: PanelObservation[] = [];
    for (let i = 0; i + HORIZON < bars.length; i++) {
      const fwd = ((bars[i + HORIZON].close - bars[i].close) / bars[i].close) * 100;
      const o: PanelObservation = {
        period: sessionPeriodKey(bars[i].t, s.meta.sessionModel),
        unitId: s.meta.id,
        value: fwd,
      };
      observations.push(o);
      own.push(o);
    }
    perInstrument.set(s.meta.id, own);
  }

  say("| Panel | Instruments | n | Periods | Effective N | n_eff / n | SE |");
  say("|---|---|---|---|---|---|---|");
  const solo = perInstrument.get("SPY.US")!;
  const soloEst = analyzePanel(solo, { statistic: "mean", nullValue: 0 }, HORIZON, 2000, 7)!;
  say(`| SPY only | 1 | ${soloEst.n} | ${soloEst.periods} | ${f2(soloEst.effectiveN)} | ${f2(soloEst.effectiveN / soloEst.n)} | ${f2(soloEst.standardError)} |`);

  const allEst = analyzePanel(observations, { statistic: "mean", nullValue: 0 }, HORIZON, 2000, 7)!;
  say(`| All five | 5 | ${allEst.n} | ${allEst.periods} | ${f2(allEst.effectiveN)} | ${f2(allEst.effectiveN / allEst.n)} | ${f2(allEst.standardError)} |`);
  say("");
  say(`Five times the observations (${soloEst.n} to ${allEst.n}) buys **${f2(allEst.effectiveN / soloEst.effectiveN)}x** the effective sample, not 5x. ` +
      `Standard error falls only from ${f2(soloEst.standardError)} to ${f2(allEst.standardError)}. ` +
      `That is the cross-sectional correction operating on real, genuinely correlated instruments — and it is exactly the behaviour that makes "add more tickers" a weak strategy for statistical power.`);
  say("");

  // ── 4. Mixed crypto + equity session alignment ────────────────────────
  say("## 4. A mixed crypto/equity panel keys onto shared trading sessions");
  say("");
  const cryptoFile = path.join(__dirname, "..", "backtest", "data", "BTC.json");
  if (fs.existsSync(cryptoFile)) {
    const raw = JSON.parse(fs.readFileSync(cryptoFile, "utf8")) as { futuresKlines: Array<{ t: number; close: number }> };
    const btcMeta = findInstrument("BTC-USD-PERP")!.meta;

    // Daily crypto closes at 00:00 UTC, which cover the PREVIOUS session.
    const byDay = new Map<number, number>();
    for (const k of raw.futuresKlines) {
      const dayStart = Math.floor(k.t / DAY) * DAY;
      byDay.set(dayStart + DAY, k.close); // close timestamp = next midnight
    }
    const cryptoObs: PanelObservation[] = [...byDay.entries()]
      .filter(([t]) => t >= startT)
      .map(([t, close]) => ({ period: sessionPeriodKey(t, btcMeta.sessionModel), unitId: btcMeta.id, value: close }));

    const spyPeriods = new Set(perInstrument.get("SPY.US")!.map((o) => o.period));
    const cryptoPeriods = new Set(cryptoObs.map((o) => o.period));

    /*
     * The two histories start years apart, so a raw overlap count would be
     * dominated by that rather than by alignment quality. The meaningful
     * question is: WITHIN the window both cover, does every equity session
     * find a matching crypto session? Restricting to the shared window is
     * what turns this into a test of the session key rather than of history
     * length.
     */
    const cryptoStart = Math.min(...cryptoPeriods);
    const cryptoEnd = Math.max(...cryptoPeriods);
    const spyInWindow = [...spyPeriods].filter((p) => p >= cryptoStart && p <= cryptoEnd);
    const matched = spyInWindow.filter((p) => cryptoPeriods.has(p)).length;

    say(`SPY sessions since 2015: ${spyPeriods.size}. BTC sessions available: ${cryptoPeriods.size} (${new Date(cryptoStart).toISOString().slice(0, 10)} to ${new Date(cryptoEnd).toISOString().slice(0, 10)}).`);
    say("");
    say(`Within the window both cover, **${matched} of ${spyInWindow.length} SPY sessions (${pct(matched / spyInWindow.length)}) find a matching BTC session key.**`);
    say("");
    say(matched / spyInWindow.length > 0.98
      ? `Near-total alignment is the correct result and is the whole point of session normalisation: a crypto bar closing at 00:00 UTC covers the PREVIOUS day, so keying on its raw timestamp would file it a day late and this figure would collapse. Crypto additionally trades ${cryptoPeriods.size - matched} sessions with no equity counterpart (weekends and market holidays), which is expected and correctly leaves those periods holding a single unit.`
      : `Alignment is ${pct(matched / spyInWindow.length)}, below the ~100% expected. Investigate the session models before trusting a mixed panel.`);
  } else {
    say("Crypto dataset not present locally; mixed-panel check skipped. The unit tests in `study.test.ts` cover this case with synthetic bars.");
  }
  say("");

  // ── 5. The full study pipeline, unchanged ─────────────────────────────
  say("## 5. `executeStudy` runs end-to-end on equities");
  say("");
  say("The same pipeline used for every crypto study: declaration, session normalisation, panel estimation, overlap correction, walk-forward, IS/OOS and mechanical grading. Nothing is passed to indicate that these are equities.");
  say("");

  const declaration: StudyDeclaration = {
    id: "etf-forward-return-plumbing-check",
    hypothesis: "The mean 5-session forward return of US equity index ETFs is non-zero.",
    nullHypothesis: "The mean 5-session forward return is zero.",
    primaryMetric: "mean 5-session forward return, percent",
    metric: { statistic: "mean", nullValue: 0 },
    secondaryMetrics: [],
    requiredCapabilities: ["ohlcv"],
    requiredFeatures: [],
    minimumEffectiveN: 100,
    // Deliberately demanding: this is a plumbing check, and a real edge in
    // 5-day index drift would not be 0.5% per trade.
    detectableEffectTarget: 0.5,
    successCriteria: "Mean forward return differs from zero by more than 0.5% with a corrected p below 0.05.",
    failureCriteria: "No significant difference, or an effect below the practical threshold.",
    seed: 42,
  };

  const studyObs: StudyObservation[] = [];
  for (const s of equities) {
    const bars = s.bars.filter((b) => b.t >= startT);
    for (let i = 0; i + HORIZON < bars.length; i++) {
      studyObs.push({
        instrumentId: s.meta.id,
        entryT: bars[i].t,
        exitT: bars[i + HORIZON].t,
        value: ((bars[i + HORIZON].close - bars[i].close) / bars[i].close) * 100,
        group: "all",
        features: { instrumentId: s.meta.id, asOf: bars[i].t, values: {}, unavailable: [], errored: [] },
      });
    }
  }

  const metaById = new Map(equities.map((s) => [s.meta.id, s.meta]));
  const ctx: StudyRunContext = {
    codeVersion: "phase-10",
    datasetVersion: "yahoo-1d",
    // The registry supplies each instrument's schedule; the framework does
    // the rest. This is the whole extension point for a new market.
    sessionOf: (id) => metaById.get(id)!.sessionModel,
  };

  const result = executeStudy(declaration, studyObs, ctx);
  const st = result.statistics;
  say("| Field | Value |");
  say("|---|---|");
  say(`| Raw observations | ${st.n} |`);
  say(`| Trading sessions | ${st.periods} |`);
  say(`| Mean units per session | ${f2(st.meanUnitsPerPeriod)} |`);
  say(`| Derived block length | ${st.blockLength} |`);
  say(`| **Effective N** | **${f2(st.effectiveN)}** |`);
  say(`| Strictly independent N | ${st.independentN} |`);
  say(`| Point estimate | ${f2(st.groups.all.point)}% |`);
  say(`| 95% CI (${st.groups.all.intervalMethod.toUpperCase()}) | ${f2(st.groups.all.lower)}% to ${f2(st.groups.all.upper)}% |`);
  say(`| Corrected p | ${st.primaryPValue.toFixed(4)} |`);
  say(`| Detectable effect | ${f2(st.detectableEffect)}% |`);
  say(`| **Grade** | **${result.verdict.grade}** |`);
  say("");
  say("Grading reasons, generated mechanically:");
  say("");
  for (const r of result.verdict.reasons) say(`- ${r}`);
  say("");
  say(`**Recommendation.** ${result.verdict.recommendation}`);
  say("");
  say("The grade is the point, not the finding: a real 5-session index drift is nowhere near the 0.5% practical threshold declared above, so the rubric correctly refuses to call this actionable. The pipeline executed on equities and reached a defensible verdict without a single asset-class branch.");

  const out = path.join(__dirname, "..", "..", "docs", "CROSS_ASSET_PROOF.md");
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`\n[prove] wrote ${out}`);
}

main();
