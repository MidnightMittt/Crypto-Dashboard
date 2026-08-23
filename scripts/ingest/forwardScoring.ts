import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  EMPTY_FORWARD_REACH,
  ForwardReachRecord,
  ReachPrediction,
  REACH_HORIZON_SESSIONS,
  prune,
  registerPredictions,
  resolvePredictions,
  summarise,
} from "../../src/lib/research/forwardReach";
import {
  CURRENT_VERDICT_ENGINE,
  EMPTY_FORWARD_VERDICT,
  expireUnresolvable,
  ForwardVerdictRecord,
  VerdictPrediction,
  pruneVerdicts,
  registerVerdicts,
  resolveVerdicts,
  summariseVerdicts,
} from "../../src/lib/research/forwardVerdict";
import {
  EquityExecutionSnapshot,
  REACH_DISTANCE_ATR_BUCKETS,
  REACH_TOUCH_BUCKETS,
  reachRateFor,
} from "../../src/lib/dossier/equityExpectations";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { Bar } from "../../src/lib/research/types";
import { nearestWatchLevels, watchEdge } from "../../src/lib/technicals/marketStructure";

/**
 * THE FORWARD RECORD — registers today's reach predictions, scores the ones
 * whose horizon has passed.
 *
 * Runs at the end of the daily pipeline, alongside appendHistory.ts, and for
 * the same reason: the record must capture what the site ACTUALLY published,
 * not a second computation that could drift from it. So the level, the
 * distance bucket and the probability are all taken from the same functions
 * the ticker page calls.
 *
 * Every number this platform prints about equities is in-sample. This is the
 * machinery that will, over months, replace one of them with an
 * out-of-sample one — and if the published rate turns out to be optimistic,
 * this is what will say so.
 *
 * Two claims are scored from ONE pass over the universe, because both read
 * the same `buildLiveAnalysis` output: the reach rate (does price get to the
 * level we named) and the VERDICT itself (does bullish actually beat the
 * market). Splitting them into two jobs would double the work and let the
 * two records drift onto different analyses of the same day.
 *
 *   npx tsx scripts/ingest/forwardScoring.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "forwardReachRecord.json");
const OUT_VERDICT = path.join(__dirname_, "..", "..", "src", "data", "forwardVerdictRecord.json");
const STATS = path.join(__dirname_, "..", "..", "src", "data", "equityExecutionStats.json");

/** Same five-year view the live page runs on — fidelity, not convenience. */
const LOOKBACK_MS = 5 * 365 * 24 * 3600 * 1000;

interface Loaded {
  symbol: string;
  assetClass: string;
  bars: Bar[];
}

function load(): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
    const symbol = (raw.meta?.displaySymbol ?? f.replace(".US.json", "")) as string;
    const bars: Bar[] = raw.bars ?? [];
    if (bars.length > 0) out.set(symbol, { symbol, assetClass: raw.meta?.assetClass ?? "unknown", bars });
  }
  return out;
}

/**
 * DRY-RUN VERIFICATION, and why it can never write.
 *
 * The resolution path has to be proven on real bars before anyone trusts a
 * record it produces — but back-registering historical predictions and
 * keeping them would be the opposite of a forward test: the outcomes already
 * existed when this code was written. So `--verify` re-plays an as-of date
 * from the past, resolves it, prints the comparison, and exits WITHOUT
 * touching the record. Proof of plumbing, never evidence.
 */
/**
 * The benchmark's closes up to the as-of instant, point-in-time. The page
 * computes relative strength from the committed market context; this job
 * must register the SAME claim the page publishes, and for its first weeks
 * it did not — it passed `benchmarkCloses: null`, so the record scored a
 * verdict with no relative-strength vote while the page showed one with it.
 */
function benchmarkClosesUpTo(all: Map<string, Loaded>, asOf: number): Array<{ t: number; close: number }> | null {
  const spy = all.get("SPY");
  if (!spy) return null;
  return spy.bars.filter((b) => b.t <= asOf).map((b) => ({ t: b.t, close: b.close }));
}

function verify(all: Map<string, Loaded>, snapshot: EquityExecutionSnapshot, asOfIso: string): void {
  const cutoff = Date.parse(`${asOfIso}T23:59:59Z`);
  const fresh: ReachPrediction[] = [];
  const freshVerdicts: VerdictPrediction[] = [];

  for (const inst of [...all.values()].filter((x) => x.assetClass === "equity-etf")) {
    const end = inst.bars.findLastIndex((b) => b.t <= cutoff);
    if (end < 0) continue;
    const asOf = inst.bars[end].t;
    let s = end;
    while (s > 0 && inst.bars[s - 1].t >= asOf - LOOKBACK_MS) s--;
    const bars = inst.bars.slice(s, end + 1);
    if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

    const res = buildLiveAnalysis({
      symbol: inst.symbol, name: inst.symbol, assetClass: "equity", bars,
      benchmarkCloses: benchmarkClosesUpTo(all, asOf), benchmarkSymbol: "SPY", marketWide: [],
      earningsCalendar: null, hasDerivatives: false, now: asOf,
    });
    if (!res.ok) continue;
    const price = res.analysis.lastClose;
    const atrAbs = res.analysis.atrPct !== null && price > 0 ? (res.analysis.atrPct / 100) * price : 0;
    if (atrAbs <= 0) continue;

    freshVerdicts.push({
      date: new Date(asOf).toISOString().slice(0, 10),
      symbol: inst.symbol,
      verdict: res.analysis.bias.verdict === "bullish" ? "bullish" : res.analysis.bias.verdict === "bearish" ? "bearish" : "neutral",
      confidence: res.analysis.bias.confidence,
      closePrice: price,
      forwardReturnPct: null,
      resolvedDate: null,
      engine: CURRENT_VERDICT_ENGINE,
    });

    const near = nearestWatchLevels(res.analysis.zones, price);
    for (const [zone, direction] of [[near.support, "long"], [near.resistance, "short"]] as const) {
      if (!zone) continue;
      const level = watchEdge(zone, direction);
      const distanceAtr = Math.abs(price - level) / atrAbs;
      const cell = reachRateFor(distanceAtr, zone.reactionCount, snapshot, "zone");
      if (!cell) continue;
      fresh.push({
        date: new Date(asOf).toISOString().slice(0, 10),
        symbol: inst.symbol, direction, level, distanceAtr,
        distanceAtrMax: REACH_DISTANCE_ATR_BUCKETS.find((b) => distanceAtr <= b) ?? Infinity,
        touchesMin: [...REACH_TOUCH_BUCKETS].reverse().find((t) => zone.reactionCount >= t) ?? 0,
        predictedPct: cell.reachRatePct, reached: null, sessionsToReach: null, resolvedDate: null,
        sessionsObserved: 0, windowComplete: false,
      });
    }
  }

  const barsAfter = (symbol: string, dateIso: string) => {
    const inst = all.get(symbol);
    if (!inst) return [];
    const c = Date.parse(`${dateIso}T23:59:59Z`);
    return inst.bars.filter((b) => b.t > c).map((b) => ({ t: b.t, high: b.high, low: b.low }));
  };
  const closesAfter = (symbol: string, dateIso: string) => {
    const inst = all.get(symbol);
    if (!inst) return [];
    const c = Date.parse(`${dateIso}T23:59:59Z`);
    return inst.bars.filter((b) => b.t > c).map((b) => ({ t: b.t, close: b.close }));
  };
  /*
   * The ENTRY bar's close read at RESOLUTION time, so both ends of the
   * return sit on one adjustment basis. See resolveVerdicts: the frozen
   * closePrice drifts every time a dividend goes ex, unevenly across cells.
   */
  const entryCloseOf = (symbol: string, dateIso: string): number | null => {
    const inst = all.get(symbol);
    if (!inst) return null;
    const bar = inst.bars.find((b) => new Date(b.t).toISOString().slice(0, 10) === dateIso);
    return bar && bar.close > 0 ? bar.close : null;
  };

  const rv = resolveVerdicts(freshVerdicts, closesAfter, entryCloseOf);
  const vs = summariseVerdicts(rv, CURRENT_VERDICT_ENGINE);
  console.log(`[verify] VERDICT: ${vs.totals.resolved} resolved, sample baseline ${vs.baselineReturnPct?.toFixed(2)}%`);
  for (const c of vs.cells) {
    console.log(
      `  ${c.verdict.padEnd(8)} n=${String(c.n).padStart(4)} hit=${c.hitRatePct === null ? "n/a" : c.hitRatePct.toFixed(1) + "%"} ` +
        `mean=${c.meanReturnPct >= 0 ? "+" : ""}${c.meanReturnPct.toFixed(2)}% median=${c.medianReturnPct >= 0 ? "+" : ""}${c.medianReturnPct.toFixed(2)}% ` +
        `EDGE=${c.edgeVsBaselinePct === null ? "n/a" : (c.edgeVsBaselinePct >= 0 ? "+" : "") + c.edgeVsBaselinePct.toFixed(2) + "%"}`
    );
  }

  const resolved = resolvePredictions(fresh, barsAfter);
  const { calibration, totals } = summarise(resolved);

  console.log(`[verify] as-of ${asOfIso}: ${fresh.length} registered, ${totals.resolved} resolved (NOT written to the record)`);
  console.log(
    `[verify] promised ${totals.predictedPct?.toFixed(4)}% vs delivered ${totals.observedPct?.toFixed(4)}% ` +
      `(${totals.reached}/${totals.resolved} reached)`
  );
  const byBucket = new Map<string, { n: number; hit: number; promised: number }>();
  for (const p of resolved.filter((x) => x.reached !== null)) {
    const k = `${p.distanceAtrMax}|${p.touchesMin}`;
    const b = byBucket.get(k) ?? { n: 0, hit: 0, promised: 0 };
    b.n++; if (p.reached) b.hit++; b.promised += p.predictedPct;
    byBucket.set(k, b);
  }
  for (const [k, b] of [...byBucket.entries()].sort()) {
    console.log(`   bucket ${k.padEnd(12)} n=${String(b.n).padStart(3)} promised ${(b.promised / b.n).toFixed(1)}% delivered ${((b.hit / b.n) * 100).toFixed(1)}%`);
  }
  for (const c of calibration) {
    const d = c.distanceAtrMax === Infinity ? ">8" : `<=${c.distanceAtrMax}`;
    console.log(`  ${d.padStart(4)} ATR, ${c.touchesMin}+ touches: promised ${c.predictedPct.toFixed(1)}% vs delivered ${c.observedPct.toFixed(1)}% (n=${c.resolved})`);
  }
}

function main() {
  const all = load();
  const snapshot = JSON.parse(fs.readFileSync(STATS, "utf8")) as EquityExecutionSnapshot;
  const verifyAsOf = process.argv.includes("--verify") ? process.argv[process.argv.indexOf("--verify") + 1] : null;
  if (verifyAsOf) {
    verify(all, snapshot, verifyAsOf);
    return;
  }

  const record: ForwardReachRecord = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as ForwardReachRecord)
    : EMPTY_FORWARD_REACH;

  const verdictRecord: ForwardVerdictRecord = fs.existsSync(OUT_VERDICT)
    ? (JSON.parse(fs.readFileSync(OUT_VERDICT, "utf8")) as ForwardVerdictRecord)
    : EMPTY_FORWARD_VERDICT;

  const equities = [...all.values()].filter((x) => x.assetClass === "equity-etf");
  const fresh: ReachPrediction[] = [];
  const freshVerdicts: VerdictPrediction[] = [];

  for (const inst of equities) {
    const end = inst.bars.length - 1;
    const asOf = inst.bars[end].t;
    const dateIso = new Date(asOf).toISOString().slice(0, 10);

    let s = end;
    while (s > 0 && inst.bars[s - 1].t >= asOf - LOOKBACK_MS) s--;
    const bars = inst.bars.slice(s, end + 1);
    if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

    const res = buildLiveAnalysis({
      symbol: inst.symbol,
      name: inst.symbol,
      assetClass: "equity",
      bars,
      benchmarkCloses: benchmarkClosesUpTo(all, asOf),
      benchmarkSymbol: "SPY",
      marketWide: [],
      earningsCalendar: null,
      hasDerivatives: false,
      now: asOf,
    });
    if (!res.ok) continue;

    const price = res.analysis.lastClose;
    const atrAbs = res.analysis.atrPct !== null && price > 0 ? (res.analysis.atrPct / 100) * price : 0;
    if (atrAbs <= 0) continue;

    /*
     * The SAME rule the dossier's watch levels use — now literally the same
     * function, not a copy with a warning comment attached to it.
     */
    /*
     * THE HEADLINE CLAIM. Registered for every instrument, including neutral
     * — a verdict record that only kept the confident calls would measure a
     * different engine from the one the page runs.
     */
    freshVerdicts.push({
      date: dateIso,
      symbol: inst.symbol,
      verdict: res.analysis.bias.verdict === "bullish" ? "bullish" : res.analysis.bias.verdict === "bearish" ? "bearish" : "neutral",
      confidence: res.analysis.bias.confidence,
      closePrice: price,
      forwardReturnPct: null,
      resolvedDate: null,
      engine: CURRENT_VERDICT_ENGINE,
    });

    const near = nearestWatchLevels(res.analysis.zones, price);

    const register = (zone: typeof near.support, direction: "long" | "short") => {
      if (!zone) return;
      const level = watchEdge(zone, direction);
      const distanceAtr = Math.abs(price - level) / atrAbs;
      const cell = reachRateFor(distanceAtr, zone.reactionCount, snapshot, "zone");
      if (!cell) return; // No published rate means nothing was promised to score.
      fresh.push({
        date: dateIso,
        symbol: inst.symbol,
        direction,
        level,
        distanceAtr,
        distanceAtrMax: REACH_DISTANCE_ATR_BUCKETS.find((b) => distanceAtr <= b) ?? Infinity,
        touchesMin: [...REACH_TOUCH_BUCKETS].reverse().find((t) => zone.reactionCount >= t) ?? 0,
        predictedPct: cell.reachRatePct,
        reached: null,
        sessionsToReach: null,
        resolvedDate: null,
        sessionsObserved: 0,
        windowComplete: false,
      });
    };
    register(near.support, "long");
    register(near.resistance, "short");
  }

  const registered = registerPredictions(record.predictions, fresh);

  // Resolve anything whose window has now closed.
  const barsAfter = (symbol: string, dateIso: string) => {
    const inst = all.get(symbol);
    if (!inst) return [];
    const cutoff = Date.parse(`${dateIso}T23:59:59Z`);
    return inst.bars.filter((b) => b.t > cutoff).map((b) => ({ t: b.t, high: b.high, low: b.low }));
  };
  const resolved = resolvePredictions(registered, barsAfter);
  const { calibration, totals } = summarise(resolved);

  const out: ForwardReachRecord = {
    version: 1,
    horizonSessions: REACH_HORIZON_SESSIONS,
    generatedAt: Date.now(),
    predictions: prune(resolved),
    calibration,
    totals,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));

  // ── The verdict record, same horizon, same discipline ──
  /*
   * Both ends of the return on ONE adjustment basis. The frozen closePrice
   * drifts every time a dividend goes ex — measured at up to 1.59%, and
   * unevenly across the three cells — so the entry is re-read here from the
   * same series the exit comes from.
   */
  const entryCloseOf = (symbol: string, dateIso: string): number | null => {
    const inst = all.get(symbol);
    if (!inst) return null;
    const bar = inst.bars.find((b) => new Date(b.t).toISOString().slice(0, 10) === dateIso);
    return bar && bar.close > 0 ? bar.close : null;
  };
  const closesAfter = (symbol: string, dateIso: string) => {
    const inst = all.get(symbol);
    if (!inst) return [];
    const c = Date.parse(`${dateIso}T23:59:59Z`);
    return inst.bars.filter((b) => b.t > c).map((b) => ({ t: b.t, close: b.close }));
  };
  const resolvedVerdicts = expireUnresolvable(
    resolveVerdicts(registerVerdicts(verdictRecord.predictions, freshVerdicts), closesAfter, entryCloseOf),
    new Date().toISOString().slice(0, 10)
  );
  /*
   * Cells NEVER mix engines. The headline summary describes the current
   * engine — the one whose calls the pages actually publish — and the
   * engine-1 rows (registered while the record and the page ran different
   * computations) keep their own labelled summary rather than polluting it
   * or being thrown away.
   */
  const vSummary = summariseVerdicts(resolvedVerdicts, CURRENT_VERDICT_ENGINE);
  const legacySummary = summariseVerdicts(resolvedVerdicts, 1);

  /*
   * The EXTERNAL baseline: mean SPY return over the same windows as each
   * engine's resolved rows. The cohort baseline answers "did this call beat
   * the register"; this answers "did the register's windows beat the
   * index" — and a reader needs both, because a cohort of mostly-bullish
   * calls in a rising tape can beat its own mean while every call merely
   * rode the market.
   */
  const vHorizon = verdictRecord.horizonSessions || 10;
  const spyReturnOver = (dateIso: string): number | null => {
    const spy = all.get("SPY");
    if (!spy) return null;
    const c = Date.parse(`${dateIso}T23:59:59Z`);
    const entry = spy.bars.filter((b) => b.t <= c).at(-1)?.close;
    const end = spy.bars.filter((b) => b.t > c)[vHorizon - 1]?.close;
    return entry && end ? ((end - entry) / entry) * 100 : null;
  };
  const marketBaselineFor = (engine: number): number | null => {
    const rets = resolvedVerdicts
      .filter((p) => (p.engine ?? 1) === engine && p.forwardReturnPct !== null)
      .map((p) => spyReturnOver(p.date))
      .filter((v): v is number => v !== null);
    return rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  };
  const verdictOut: ForwardVerdictRecord = {
    version: 1,
    horizonSessions: verdictRecord.horizonSessions || 10,
    generatedAt: Date.now(),
    predictions: pruneVerdicts(resolvedVerdicts),
    cells: vSummary.cells,
    baselineReturnPct: vSummary.baselineReturnPct,
    marketBaselineReturnPct: marketBaselineFor(CURRENT_VERDICT_ENGINE),
    finding: vSummary.finding,
    cannotYetAnswer: vSummary.cannotYetAnswer,
    totals: vSummary.totals,
    engine: CURRENT_VERDICT_ENGINE,
    ...(legacySummary.totals.resolved + legacySummary.totals.open > 0
      ? {
          legacy: {
            engine: 1,
            note:
              "Scored on the retired chart-only engine: registered with no relative-strength vote " +
              "while the pages published a backdrop-voting composite. Adjacent evidence about a " +
              "similar engine, not the current one's record.",
            cells: legacySummary.cells,
            baselineReturnPct: legacySummary.baselineReturnPct,
            marketBaselineReturnPct: marketBaselineFor(1),
            totals: legacySummary.totals,
          },
        }
      : {}),
  };
  fs.writeFileSync(OUT_VERDICT, JSON.stringify(verdictOut, null, 0));

  console.log(
    `[verdict] ${freshVerdicts.length} registered today · ${vSummary.totals.resolved} resolved · ${vSummary.totals.open} open`
  );
  if (vSummary.baselineReturnPct !== null) {
    console.log(`[verdict] sample baseline (all calls, same window): ${vSummary.baselineReturnPct >= 0 ? "+" : ""}${vSummary.baselineReturnPct.toFixed(2)}%`);
    for (const c of vSummary.cells) {
      console.log(
        `  ${c.verdict.padEnd(8)} n=${String(c.n).padStart(5)} ` +
          `hit=${c.hitRatePct === null ? "n/a" : c.hitRatePct.toFixed(1) + "%"} ` +
          `mean=${c.meanReturnPct >= 0 ? "+" : ""}${c.meanReturnPct.toFixed(2)}% ` +
          `median=${c.medianReturnPct >= 0 ? "+" : ""}${c.medianReturnPct.toFixed(2)}% ` +
          `EDGE=${c.edgeVsBaselinePct === null ? "n/a" : (c.edgeVsBaselinePct >= 0 ? "+" : "") + c.edgeVsBaselinePct.toFixed(2) + "%"}`
      );
    }
  }

  const open = resolved.filter((p) => p.reached === null).length;
  console.log(
    `[forward] ${fresh.length} registered today · ${resolved.length} tracked · ${open} awaiting their horizon`
  );
  if (totals.resolved === 0) {
    console.log(`[forward] nothing resolved yet — first scores land ${REACH_HORIZON_SESSIONS} sessions after the first registration.`);
  } else {
    console.log(
      `[forward] RESOLVED ${totals.resolved.toLocaleString()}: promised ${totals.predictedPct?.toFixed(1)}%, ` +
        `delivered ${totals.observedPct?.toFixed(1)}%`
    );
    for (const c of calibration) {
      const d = c.distanceAtrMax === Infinity ? ">8" : `<=${c.distanceAtrMax}`;
      console.log(
        `  ${d.padStart(4)} ATR, ${c.touchesMin}+ touches: promised ${c.predictedPct.toFixed(1)}% ` +
          `vs delivered ${c.observedPct.toFixed(1)}% (n=${c.resolved})`
      );
    }
  }
  console.log(`[forward] -> ${OUT}`);
}

main();
