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
  EquityExecutionSnapshot,
  REACH_DISTANCE_ATR_BUCKETS,
  REACH_TOUCH_BUCKETS,
  reachRateFor,
} from "../../src/lib/dossier/equityExpectations";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { Bar } from "../../src/lib/research/types";

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
 *   npx tsx scripts/ingest/forwardReach.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "forwardReachRecord.json");
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
function verify(all: Map<string, Loaded>, snapshot: EquityExecutionSnapshot, asOfIso: string): void {
  const cutoff = Date.parse(`${asOfIso}T23:59:59Z`);
  const fresh: ReachPrediction[] = [];

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
      benchmarkCloses: null, benchmarkSymbol: "SPY", marketWide: [],
      earningsCalendar: null, hasDerivatives: false, now: asOf,
    });
    if (!res.ok) continue;
    const price = res.analysis.lastClose;
    const atrAbs = res.analysis.atrPct !== null && price > 0 ? (res.analysis.atrPct / 100) * price : 0;
    if (atrAbs <= 0) continue;

    const below = res.analysis.zones.filter((z) => z.kind === "support" && z.priceHigh < price).sort((a, b) => b.priceHigh - a.priceHigh)[0];
    const above = res.analysis.zones.filter((z) => z.kind === "resistance" && z.priceLow > price).sort((a, b) => a.priceLow - b.priceLow)[0];
    for (const [zone, direction] of [[below, "long"], [above, "short"]] as const) {
      if (!zone) continue;
      const level = direction === "long" ? zone.priceHigh : zone.priceLow;
      const distanceAtr = Math.abs(price - level) / atrAbs;
      const cell = reachRateFor(distanceAtr, zone.reactionCount, snapshot, "zone");
      if (!cell) continue;
      fresh.push({
        date: new Date(asOf).toISOString().slice(0, 10),
        symbol: inst.symbol, direction, level, distanceAtr,
        distanceAtrMax: REACH_DISTANCE_ATR_BUCKETS.find((b) => distanceAtr <= b) ?? Infinity,
        touchesMin: [...REACH_TOUCH_BUCKETS].reverse().find((t) => zone.reactionCount >= t) ?? 0,
        predictedPct: cell.reachRatePct, reached: null, sessionsToReach: null, resolvedDate: null,
      });
    }
  }

  const barsAfter = (symbol: string, dateIso: string) => {
    const inst = all.get(symbol);
    if (!inst) return [];
    const c = Date.parse(`${dateIso}T23:59:59Z`);
    return inst.bars.filter((b) => b.t > c).map((b) => ({ t: b.t, high: b.high, low: b.low }));
  };
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

  const equities = [...all.values()].filter((x) => x.assetClass === "equity-etf");
  const fresh: ReachPrediction[] = [];

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
      benchmarkCloses: null,
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
     * The SAME nearest-structure rule the dossier's watch levels use. If
     * these two ever diverge the record stops describing what was shown,
     * which would make the whole exercise decorative.
     */
    const below = res.analysis.zones
      .filter((z) => z.kind === "support" && z.priceHigh < price)
      .sort((a, b) => b.priceHigh - a.priceHigh)[0];
    const above = res.analysis.zones
      .filter((z) => z.kind === "resistance" && z.priceLow > price)
      .sort((a, b) => a.priceLow - b.priceLow)[0];

    const register = (zone: typeof below, direction: "long" | "short") => {
      if (!zone) return;
      const level = direction === "long" ? zone.priceHigh : zone.priceLow;
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
      });
    };
    register(below, "long");
    register(above, "short");
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
