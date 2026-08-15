import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { buildEquityEvidence, EquityInstrumentInput } from "../../src/lib/markets/equityEvidence";
import { resolveTrade, TradePlan as ExecPlan } from "../../src/lib/research/tradeExecution";
import { effectiveSampleSize } from "../../src/lib/research/overlap";
import { RollingStandardiser, standardise } from "../../src/lib/research/fingerprintInputs";
import { rawReadings } from "../../src/lib/research/fingerprintReadings";
import { DIMENSIONS, FINGERPRINT_VERSION } from "../../src/lib/research/fingerprint";

/** Positional order for the columnar library encoding. Frozen with the artefact. */
const DIMENSION_IDS = DIMENSIONS.map((d) => d.id);
import {
  volRegimeFromMetrics,
  EquityAnalogCell,
  EquityCell,
  EquityEntryStyle,
  EquityExecutionSnapshot,
  EquitySide,
  EquityVolRegime,
  equityAnalogKey,
  equityCellKey,
  ReachCell,
  REACH_DISTANCE_ATR_BUCKETS,
  REACH_TOUCH_BUCKETS,
} from "../../src/lib/dossier/equityExpectations";
import { Bar, SessionModel } from "../../src/lib/research/types";
import { MetricVerdict } from "../../src/lib/signals/types";
import { nearestWatchLevels, watchEdge } from "../../src/lib/technicals/marketStructure";

/**
 * THE EQUITY EXECUTION REPLAY.
 *
 * Every "Deepens when" footer on the research page has pointed here. Until
 * now the stock pages said, honestly, that win rate, expected drawdown, how
 * far comparable trades ran and how long they took were NOT measured for
 * equities — only for the crypto majors. This script is what earns those
 * numbers.
 *
 * ── The one rule this file exists to enforce: POINT IN TIME ────────────
 *
 * At every replayed session the engine sees EXACTLY what it would have seen
 * live on that date and nothing else:
 *
 *   - the instrument's own bars over a FIVE-YEAR trailing window, because
 *     that is precisely what fetchQuoteHistory asks Yahoo for (LOOKBACK_
 *     SECONDS = 5 * 365 days). This is fidelity, not a shortcut: replaying
 *     with more history would measure an engine the live page never runs.
 *     Verified empirically — support/resistance zones, and therefore entries
 *     and stops, genuinely differ when the window differs.
 *   - market breadth and risk appetite RECOMPUTED at that date from the same
 *     five ETFs and the same credit/duration pair the live snapshot uses,
 *     never today's committed reading. Feeding a 2010 replay today's breadth
 *     would be look-ahead of the most flattering kind.
 *   - benchmark closes truncated to the same instant.
 *
 * The evidence evaluators all read `bars[bars.length - 1]` and window their
 * percentile history to the trailing BAND_HISTORY (500) sessions, so the
 * 1000-bar view handed to them below is exactly equivalent to full history
 * while costing a fraction of the copying.
 *
 * ── Ungated by construction ───────────────────────────────────────────
 *
 * `buildLiveAnalysis` applies no planner constraints, so every plan the
 * replay records is one the geometry produced on its own merits. That
 * matters: gating the replay with an EV threshold derived from the replay
 * would starve the gate's own evidence — the circularity planConstraints.ts
 * already warns about.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "equityExecutionStats.json");
const FINGERPRINT_OUT = path.join(__dirname_, "..", "..", "src", "data", "fingerprintLibrary.json");

/*
 * The horizon every fingerprint outcome is measured over.
 *
 * Fixed rather than "until the trade resolves", because a fingerprint
 * describes an ENVIRONMENT, not a trade: it has no stop and no target to
 * resolve against. A fixed window makes every neighbour's outcome measured
 * the same way, which is what lets them be pooled at all.
 */
const FINGERPRINT_HORIZON_SESSIONS = 20;

/*
 * The library keeps one row in ten, and it costs almost nothing.
 *
 * The neighbour search accepts at most one match per instrument per 21-day
 * window, so days closer together than that were never going to be returned
 * together — sampling below that resolution discards rows the search would
 * have dropped anyway. Ten SESSIONS is about fourteen calendar days, comfortably
 * inside the window, so every window still offers at least one candidate.
 *
 * At stride 5 with verbose JSON the artefact was 44.7MB, which the server
 * would parse on every cold start to answer one lookup. Declared here rather
 * than beside its writer because main() runs at module load and would hit
 * the temporal dead zone otherwise.
 */
const LIBRARY_STRIDE_SESSIONS = 10;

/** Exactly what fetchQuoteHistory requests: 5 * 365 calendar days. */
const LOOKBACK_MS = 5 * 365 * 24 * 3600 * 1000;
/** 500 sessions of percentile history is all any evaluator reads; 1000 is slack. */
const MARKET_WIDE_VIEW = 1000;
/**
 * A daily-bar swing plan that has not resolved in six weeks has stopped
 * being the trade that was described. Fixed a priori, before any outcome was
 * seen, so it is not a parameter that was tuned until the numbers improved.
 */
const MAX_HOLD_SESSIONS = 30;
const SESSION_MS = 24 * 3600 * 1000;
/**
 * Retail equity execution: commission-free, so the cost is spread and
 * impact. 5bps per leg is deliberately pessimistic for names this liquid —
 * a cost assumption should never flatter the result.
 */
const SLIPPAGE_BPS_PER_LEG = 5;
const ROUND_TRIP_COST_PCT = (SLIPPAGE_BPS_PER_LEG * 2) / 100;

/** HYG (credit) starts 2007-04; risk appetite needs history before it is meaningful. */
const REPLAY_START = process.env.EQUITY_REPLAY_FROM
  ? Date.parse(`${process.env.EQUITY_REPLAY_FROM}T00:00:00Z`)
  : Date.UTC(2008, 5, 1);

const BREADTH_SET = ["SPY", "QQQ", "DIA", "IWM", "XLF"];
/** The real US equity session: it gaps, and the resolver must know. */
const EQUITY_SESSION: SessionModel = {
  kind: "session-based",
  gapsPossible: true,
  barsPerYear: 252,
  timezone: "America/New_York",
  label: "US equity RTH",
};

/**
 * How long a resting entry stays live before the setup is abandoned.
 *
 * A plan whose pullback never arrives is not a losing trade — it is no trade
 * at all, and counting it as either would be wrong. Fixed a priori at ten
 * sessions; the share that never fill is published as the reach rate, which
 * is the number that says whether these plans are actually takeable.
 */
const ENTRY_VALID_SESSIONS = 10;

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
    const bars: Bar[] = (raw.bars ?? []).map((b: Bar) => ({
      t: b.t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
    }));
    if (bars.length > 0) out.set(symbol, { symbol, assetClass: raw.meta?.assetClass ?? "unknown", bars });
  }
  return out;
}

/**
 * First index with bar.t > t, by binary search.
 *
 * The resolution pass touches every recorded plan, and a linear filter over
 * an 11,000-bar series per plan turns an 18-minute job into an overnight one.
 */
function firstIndexAfter(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t > t) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Index of the last bar at or before `t`, walking forward from `from`. */
function advance(bars: Bar[], from: number, t: number): number {
  let i = from;
  while (i + 1 < bars.length && bars[i + 1].t <= t) i++;
  return i;
}

interface PendingTrade {
  symbol: string;
  side: EquitySide;
  volRegime: EquityVolRegime;
  /** When the plan was PRINTED — not necessarily when it was filled. */
  signalT: number;
  entryLow: number;
  entryHigh: number;
  stopPrice: number;
  target1Price: number;
  target2Price: number;
  /** At-market plans fill on the signal bar; pullbacks must be reached. */
  atMarket: boolean;
  anchorPrice: number;
  /** How far the level sat from price when printed, in ATR — a pre-trade fact. */
  distanceAtr: number;
  /** Swing touches on the zone being traded against — also pre-trade. */
  zoneTouches: number;
}

interface ResolvedRow {
  symbol: string;
  side: EquitySide;
  volRegime: EquityVolRegime;
  entryT: number;
  netReturnPct: number;
  maePct: number;
  mfePct: number;
  holdSessions: number;
  win: boolean;
  outcome: "target" | "stop" | "timeout";
  entryStyle: EquityEntryStyle;
}

interface ZoneWatch {
  symbol: string;
  t: number;
  level: number;
  dir: "up" | "down";
  distanceAtr: number;
  touches: number;
}

/** Ten sessions is the same window the planned-entry card quotes. */
const ZONE_REACH_SESSIONS = 10;

function buildZoneReachCells(watches: ZoneWatch[], all: Map<string, Loaded>): ReachCell[] {
  const rows: ReachRow[] = [];
  for (const w of watches) {
    const bars = all.get(w.symbol)!.bars;
    const from = firstIndexAfter(bars, w.t);
    let reached = false;
    let sessions: number | null = null;
    for (let i = from; i < Math.min(bars.length, from + ZONE_REACH_SESSIONS); i++) {
      const hit = w.dir === "down" ? bars[i].low <= w.level : bars[i].high >= w.level;
      if (hit) { reached = true; sessions = i - from + 1; break; }
    }
    const distanceAtrMax = REACH_DISTANCE_ATR_BUCKETS.find((b) => w.distanceAtr <= b);
    if (distanceAtrMax === undefined) continue;
    const touchesMin = [...REACH_TOUCH_BUCKETS].reverse().find((t) => w.touches >= t) ?? 0;
    rows.push({ distanceAtrMax, touchesMin, reached, sessions });
  }
  return buildReachCells(rows).map((c) => ({ ...c, source: "zone" as const }));
}

/** One market day as a standardised vector, plus what happened next. */
interface FingerprintRow {
  symbol: string;
  date: string;
  values: Record<string, number>;
  forwardReturnPct: number;
  maxAdversePct: number;
  maxFavourablePct: number;
}

interface ReachRow {
  distanceAtrMax: number;
  touchesMin: number;
  reached: boolean;
  sessions: number | null;
}

/**
 * At-market plans are excluded: they fill by construction, and folding a
 * guaranteed fill into a reach rate would inflate every bucket it touches.
 */
function recordReach(out: ReachRow[], p: PendingTrade, reached: boolean, sessions: number | null): void {
  if (p.atMarket) return;
  const distanceAtrMax = REACH_DISTANCE_ATR_BUCKETS.find((b) => p.distanceAtr <= b);
  if (distanceAtrMax === undefined) return;
  const touchesMin = [...REACH_TOUCH_BUCKETS].reverse().find((t) => p.zoneTouches >= t) ?? 0;
  out.push({ distanceAtrMax, touchesMin, reached, sessions });
}

/** Fewer attempts than this and the bucket is not published. */
const MIN_REACH_N = 300;

function buildReachCells(rows: ReachRow[]): ReachCell[] {
  const cells: ReachCell[] = [];
  for (const d of REACH_DISTANCE_ATR_BUCKETS) {
    for (const t of REACH_TOUCH_BUCKETS) {
      const bucket = rows.filter((r) => r.distanceAtrMax === d && r.touchesMin === t);
      if (bucket.length < MIN_REACH_N) continue;
      const hit = bucket.filter((r) => r.reached);
      const sessions = hit.map((r) => r.sessions).filter((x): x is number => x !== null);
      cells.push({
        distanceAtrMax: d,
        touchesMin: t,
        attempts: bucket.length,
        reached: hit.length,
        reachRatePct: (hit.length / bucket.length) * 100,
        medianSessionsToReach: sessions.length ? Math.round(quantile(sessions, 0.5)) : null,
      });
    }
  }
  return cells;
}

function main() {
  const t0 = Date.now();
  const all = load();
  const spy = all.get("SPY");
  if (!spy) throw new Error("SPY is required as the benchmark and breadth anchor.");

  let equities = [...all.values()].filter(
    (x) => x.assetClass === "equity-etf" && !BREADTH_SET.includes(x.symbol)
  );
  // Smoke-test knobs, so a bug costs seconds rather than a full run.
  const limit = Number(process.env.EQUITY_REPLAY_SYMBOLS ?? 0);
  if (limit > 0) equities = equities.slice(0, limit);
  console.log(`[replay] ${equities.length} equity instruments, benchmark SPY, breadth ${BREADTH_SET.join("/")}`);

  // Market-wide inputs, all truncated per date below.
  const breadthInstruments = BREADTH_SET.map((s) => all.get(s)).filter((x): x is Loaded => !!x);
  const credit = all.get("HYG");
  const duration = all.get("TLT");

  // The trading calendar is SPY's own session dates.
  const dates = spy.bars.filter((b) => b.t >= REPLAY_START).map((b) => b.t);
  console.log(
    `[replay] ${dates.length} sessions ${new Date(dates[0]).toISOString().slice(0, 10)} -> ` +
      `${new Date(dates[dates.length - 1]).toISOString().slice(0, 10)}`
  );

  // Forward-walking pointers, so truncation is O(1) amortised rather than a
  // scan of every series on every date.
  const ptr = new Map<string, number>();
  for (const k of all.keys()) ptr.set(k, 0);

  const pending: PendingTrade[] = [];
  const zonePending: ZoneWatch[] = [];

  /*
   * FINGERPRINTS. One standardiser per instrument, because every dimension
   * is z-scored against THAT instrument's own past — which is what makes a
   * biotech and a utility comparable at all. The standardiser enforces
   * read-before-write internally, so walking dates forward here is the only
   * discipline this loop has to keep.
   */
  const scalers = new Map<string, RollingStandardiser>();
  const fingerprintsPending: Array<{ symbol: string; t: number; values: Record<string, number> }> = [];
  const unknownDimensions = new Set<string>();
  let evaluated = 0;

  for (let d = 0; d < dates.length; d++) {
    const asOf = dates[d];
    for (const [sym, inst] of all) ptr.set(sym, advance(inst.bars, ptr.get(sym)!, asOf));

    // ── Market-wide readings, recomputed AT this date ──
    const view = (l: Loaded): EquityInstrumentInput => {
      const end = ptr.get(l.symbol)!;
      return { symbol: l.symbol, bars: l.bars.slice(Math.max(0, end + 1 - MARKET_WIDE_VIEW), end + 1) };
    };
    const spyView = view(spy);
    if (spyView.bars.length < 60) continue;

    const marketWide: MetricVerdict[] = buildEquityEvidence({
      instrument: spyView,
      benchmark: spyView,
      universe: breadthInstruments.map(view),
      credit: credit ? view(credit) : undefined,
      duration: duration ? view(duration) : undefined,
      asOf,
    }).filter((m) => m.id === "equityBreadth" || m.id === "equityRiskAppetite");

    const benchmarkCloses = spyView.bars.slice(-600).map((b) => ({ t: b.t, close: b.close }));

    // ── Every instrument, as the live page would have seen it ──
    for (const inst of equities) {
      const end = ptr.get(inst.symbol)!;
      if (inst.bars[end].t !== asOf) continue; // not trading that session
      const windowStart = asOf - LOOKBACK_MS;
      let s = end;
      while (s > 0 && inst.bars[s - 1].t >= windowStart) s--;
      const bars = inst.bars.slice(s, end + 1);
      if (bars.length < MIN_BARS_FOR_ANALYSIS) continue;

      evaluated++;
      const close = bars[bars.length - 1].close;
      const res = buildLiveAnalysis({
        symbol: inst.symbol,
        name: inst.symbol,
        assetClass: "equity",
        bars,
        benchmarkCloses,
        benchmarkSymbol: "SPY",
        marketWide,
        // Historical earnings dates are not available offline; see caveats.
        earningsCalendar: null,
        hasDerivatives: false,
        now: asOf,
      });
      if (!res.ok) continue;
      const atrAbsAt = res.analysis.atrPct !== null ? (res.analysis.atrPct / 100) * close : 0;

      /*
       * The fingerprint for this (instrument, date), from the analysis just
       * built. Recorded for EVERY evaluated session, not only the ones that
       * produced a plan — the library describes environments, and restricting
       * it to days the planner liked would select the sample on the very
       * property the neighbourhood is later asked about.
       */
      {
        let scaler = scalers.get(inst.symbol);
        if (!scaler) {
          scaler = new RollingStandardiser();
          scalers.set(inst.symbol, scaler);
        }
        const raw = rawReadings({
          closes: bars.map((b) => b.close),
          volumes: bars.map((b) => b.volume ?? 0),
          metrics: [...res.analysis.bias.metrics, ...marketWide],
          zones: res.analysis.zones,
          atrPct: res.analysis.atrPct,
        });
        const { values, unknown } = standardise(raw, scaler);
        for (const u of unknown) unknownDimensions.add(u);
        // A vector too thin to be compared is not worth storing.
        if (Object.keys(values).length >= 6) {
          fingerprintsPending.push({ symbol: inst.symbol, t: asOf, values: values as Record<string, number> });
        }
      }

      /*
       * ZONE REACH, measured for its own sake. The planner only prices
       * levels within 1.5 ATR, so a reach table built from plans alone can
       * never answer "will price get to that level six ATR away" — and that
       * is exactly the question a reader has when nothing is close. So every
       * nearest support and resistance is recorded here at every distance,
       * whether or not it produced a plan.
       */
      if (atrAbsAt > 0) {
        const near = nearestWatchLevels(res.analysis.zones, close);
        if (near.support) {
          const lvl = watchEdge(near.support, "long");
          zonePending.push({ symbol: inst.symbol, t: asOf, level: lvl, dir: "down", distanceAtr: (close - lvl) / atrAbsAt, touches: near.support.reactionCount });
        }
        if (near.resistance) {
          const lvl = watchEdge(near.resistance, "short");
          zonePending.push({ symbol: inst.symbol, t: asOf, level: lvl, dir: "up", distanceAtr: (lvl - close) / atrAbsAt, touches: near.resistance.reactionCount });
        }
      }

      const vol = volRegimeFromMetrics(res.analysis.bias.metrics);
      if (!vol) continue;

      /*
       * Direction is the bias verdict, exactly as liveAnalysis derives it —
       * the plan itself carries geometry, not a side.
       */
      if (!res.analysis.plan) continue;
      const verdict = res.analysis.bias.verdict;
      if (verdict !== "bullish" && verdict !== "bearish") continue;
      const side: EquitySide = verdict === "bullish" ? "long" : "short";

      const p = res.analysis.plan;
      /*
       * An at-market plan brackets the anchor close (see buildEntryZone);
       * a pullback plan sits away from it and only becomes a trade if price
       * comes back. Inferred from the geometry rather than a flag, because
       * the plan does not carry `kind` across the boundary.
       */
      const atMarket = p.anchorPrice >= p.entryLow && p.anchorPrice <= p.entryHigh;

      pending.push({
        symbol: inst.symbol,
        side,
        volRegime: vol,
        signalT: asOf,
        entryLow: p.entryLow,
        entryHigh: p.entryHigh,
        stopPrice: p.stopPrice,
        target1Price: p.target1Price,
        target2Price: p.target2Price,
        atMarket,
        anchorPrice: p.anchorPrice,
        distanceAtr: (() => {
          if (atMarket || !p.atrAbs || p.atrAbs <= 0) return 0;
          const edge = side === "long" ? p.entryHigh : p.entryLow;
          return Math.abs(p.anchorPrice - edge) / p.atrAbs;
        })(),
        zoneTouches: (side === "long" ? p.supportZone : p.resistanceZone)?.reactionCount ?? 0,
      });
    }

    if (d % 500 === 0) {
      console.log(
        `[replay] ${new Date(asOf).toISOString().slice(0, 10)}  evaluated=${evaluated.toLocaleString()} ` +
          `plans=${pending.length.toLocaleString()}  ${((Date.now() - t0) / 1000).toFixed(0)}s`
      );
    }
  }

  console.log(`[replay] ${pending.length.toLocaleString()} plans from ${evaluated.toLocaleString()} evaluated sessions`);

  if (unknownDimensions.size > 0) {
    /*
     * A dimension renamed in the readings module but not in the definition
     * would silently never match, which reads as "no similar days" rather
     * than as a bug. Loud on purpose.
     */
    throw new Error(
      `[replay] readings produced dimensions the fingerprint definition does not know: ${[...unknownDimensions].join(", ")}`
    );
  }

  /*
   * ── Fingerprint outcomes ──────────────────────────────────────────────
   *
   * A fixed 20-session window, measured the same way for every environment
   * so they can be pooled. Anything without a full window ahead of it is
   * DROPPED rather than measured over a shorter one: the most recent months
   * would otherwise be scored on partial horizons and, being the days most
   * like today, would dominate exactly the neighbourhoods a live reader
   * sees.
   */
  const fingerprintRows: FingerprintRow[] = [];
  let unresolvedFingerprints = 0;
  for (const f of fingerprintsPending) {
    const inst = all.get(f.symbol)!;
    const from = firstIndexAfter(inst.bars, f.t);
    const window = inst.bars.slice(from, from + FINGERPRINT_HORIZON_SESSIONS);
    if (window.length < FINGERPRINT_HORIZON_SESSIONS) {
      unresolvedFingerprints++;
      continue;
    }
    const entry = inst.bars[from - 1]?.close ?? window[0].open;
    if (!(entry > 0)) continue;

    let low = window[0].low;
    let high = window[0].high;
    for (const b of window) {
      if (b.low < low) low = b.low;
      if (b.high > high) high = b.high;
    }
    fingerprintRows.push({
      symbol: f.symbol,
      date: new Date(f.t).toISOString().slice(0, 10),
      values: f.values,
      forwardReturnPct: ((window[window.length - 1].close - entry) / entry) * 100,
      /*
       * Clamped so the field names stay true. A stock that gaps up and never
       * trades back to the entry close has a lowest low ABOVE it — a real
       * situation, and one where the adverse excursion is zero rather than
       * positive. Left unclamped, a consumer taking the magnitude would
       * report a drawdown that never happened, which is precisely what
       * `summariseNeighbourhood` was doing on 9% of rows.
       */
      maxAdversePct: Math.min(0, ((low - entry) / entry) * 100),
      maxFavourablePct: Math.max(0, ((high - entry) / entry) * 100),
    });
  }
  console.log(
    `[replay] ${fingerprintRows.length.toLocaleString()} fingerprints resolved ` +
      `(${unresolvedFingerprints.toLocaleString()} dropped for want of a full ${FINGERPRINT_HORIZON_SESSIONS}-session window)`
  );
  writeFingerprintLibrary(fingerprintRows, scalers);

  /*
   * ── FILL, then resolve ────────────────────────────────────────────────
   *
   * The step most replays skip. A pullback plan is a resting limit order: it
   * becomes a trade only if price actually returns to the zone, and pretending
   * otherwise books entries that were never available at prices that never
   * traded. Fills follow limit-order semantics — a gap through the level fills
   * at the open, which is the price that genuinely existed.
   */
  const rows: ResolvedRow[] = [];
  const reachRows: ReachRow[] = [];
  const maxHoldMs = MAX_HOLD_SESSIONS * 5 * SESSION_MS; // calendar slack for weekends/holidays
  let neverFilled = 0;
  let unresolved = 0;

  for (const p of pending) {
    const inst = all.get(p.symbol)!;

    let entryPrice: number | null = null;
    let entryT = p.signalT;
    let sessionsToFill: number | null = null;

    if (p.atMarket) {
      // Bracketing the close means the plan was takeable that session.
      entryPrice = p.anchorPrice;
    } else {
      // The near edge is what price reaches first coming back.
      const limit = p.side === "long" ? p.entryHigh : p.entryLow;
      const from = firstIndexAfter(inst.bars, p.signalT);
      const window = inst.bars.slice(from, from + ENTRY_VALID_SESSIONS);
      for (let wi = 0; wi < window.length; wi++) {
        const b = window[wi];
        if (p.side === "long" && b.low <= limit) {
          entryPrice = Math.min(b.open, limit); // gapped below = filled better
          entryT = b.t;
          sessionsToFill = wi + 1;
          break;
        }
        if (p.side === "short" && b.high >= limit) {
          entryPrice = Math.max(b.open, limit);
          entryT = b.t;
          sessionsToFill = wi + 1;
          break;
        }
      }
    }

    if (entryPrice === null || entryPrice <= 0) {
      neverFilled++;
      recordReach(reachRows, p, false, null);
      continue;
    }
    recordReach(reachRows, p, true, sessionsToFill);

    const from = firstIndexAfter(inst.bars, entryT);
    const future: Bar[] = [];
    for (let i = from; i < inst.bars.length && inst.bars[i].t <= entryT + maxHoldMs; i++) {
      future.push(inst.bars[i]);
    }
    if (future.length === 0) { unresolved++; continue; }

    const r = resolveTrade(
      {
        side: p.side,
        entryPrice,
        stopPrice: p.stopPrice,
        targetPrice: p.target1Price,
        target2Price: p.target2Price,
        entryT,
      } satisfies ExecPlan,
      future,
      maxHoldMs,
      EQUITY_SESSION
    );
    if (!r) { unresolved++; continue; }

    const net = r.grossReturnPct - ROUND_TRIP_COST_PCT;
    let holdSessions = 0;
    for (const b of future) { if (b.t <= r.exitT) holdSessions++; else break; }
    rows.push({
      symbol: p.symbol,
      side: p.side,
      volRegime: p.volRegime,
      entryT,
      netReturnPct: net,
      maePct: r.maePct,
      mfePct: r.mfePct,
      holdSessions,
      win: net > 0,
      outcome: r.outcome,
      entryStyle: p.atMarket ? "at-market" : "pullback",
    });
  }

  /*
   * Reach rate must be computed PER ENTRY STYLE: at-market plans fill by
   * construction, so blending them into one number would hide the only place
   * the question is live — how often a resting pullback actually gets hit.
   */
  const printedByStyle = new Map<string, number>();
  const filledByStyle = new Map<string, number>();
  for (const p of pending) {
    const k = equityAnalogKey(p.side, p.volRegime, p.atMarket ? "at-market" : "pullback");
    printedByStyle.set(k, (printedByStyle.get(k) ?? 0) + 1);
  }
  for (const r of rows) {
    const k = equityAnalogKey(r.side, r.volRegime, r.entryStyle);
    filledByStyle.set(k, (filledByStyle.get(k) ?? 0) + 1);
  }

  const reachRatePct = pending.length > 0 ? ((pending.length - neverFilled) / pending.length) * 100 : 0;
  console.log(`[replay] ${neverFilled.toLocaleString()} plans never filled (reach rate ${reachRatePct.toFixed(1)}%)`);

  console.log(`[replay] ${rows.length.toLocaleString()} resolved trades (${unresolved} unresolved), ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);

  const mix = { target: 0, stop: 0, timeout: 0 };
  for (const r of rows) mix[r.outcome]++;
  const pct = (x: number) => ((x / Math.max(1, rows.length)) * 100).toFixed(1);
  console.log(`[replay] outcomes: target ${pct(mix.target)}%  stop ${pct(mix.stop)}%  timeout ${pct(mix.timeout)}%`);

  const reachCells = [
    ...buildReachCells(reachRows).map((c) => ({ ...c, source: "plan" as const })),
    ...buildZoneReachCells(zonePending, all),
  ];
  console.log(`[replay] ${zonePending.length.toLocaleString()} zone-watch observations`);
  console.log("\n[replay] REACH — does price actually get to a resting level?");
  for (const c of reachCells) {
    const d = c.distanceAtrMax === Infinity ? ">8" : `<=${c.distanceAtrMax}`;
    console.log(
      `  [${c.source ?? "plan"}] ${d.padStart(4)} ATR away, ${String(c.touchesMin).padStart(1)}+ touches: ` +
        `${c.reachRatePct.toFixed(1)}% reached (${c.reached.toLocaleString()}/${c.attempts.toLocaleString()}) ` +
        `median ${c.medianSessionsToReach ?? "-"} sessions`
    );
  }
  console.log("");

  const snapshot = aggregate(rows, dates, equities, pending.length, reachRatePct, printedByStyle, filledByStyle, reachCells);
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 0));
  console.log(`[replay] -> ${OUT}`);
  console.log("\n[replay] ENTRY STYLE — chase it, or wait for the retest?");
  for (const [k, a] of Object.entries(snapshot.analogs ?? {})) {
    if (!a) continue;
    console.log(
      `  ${k.padEnd(28)} n=${String(a.occurrences).padStart(6)} win=${a.winRatePct.toFixed(1)}% ` +
        `avg=${a.averageReturnPct >= 0 ? "+" : ""}${a.averageReturnPct.toFixed(2)}% ` +
        `excess=${a.excessReturnPct === null ? "-" : (a.excessReturnPct >= 0 ? "+" : "") + a.excessReturnPct.toFixed(2) + "%"} ` +
        `reach=${a.reachRatePct.toFixed(0)}% hold=${a.medianHoldSessions ?? "-"}`
    );
  }
  console.log("");
  for (const [k, c] of Object.entries(snapshot.cells)) {
    if (!c) continue;
    console.log(
      `  ${k.padEnd(18)} n=${String(c.n).padStart(6)} eff=${String(c.effectiveN).padStart(5)} ` +
        `win=${c.winRatePct.toFixed(1)}% (wilson ${c.winRateWilsonLowPct.toFixed(1)}%) ` +
        `ev=${c.evPointPct >= 0 ? "+" : ""}${c.evPointPct.toFixed(2)}% ` +
        `drift=${c.driftNullPct === null ? "-" : (c.driftNullPct >= 0 ? "+" : "") + c.driftNullPct.toFixed(2) + "%"} ` +
        `EXCESS=${c.excessEvPct === null ? "-" : (c.excessEvPct >= 0 ? "+" : "") + c.excessEvPct.toFixed(2) + "%"} ` +
        `hold=${c.medianHoldSessions ?? "-"}`
    );
  }
}

/**
 * THE DRIFT NULL, measured on the same universe and window.
 *
 * A positive expectancy proves nothing on its own: US equities rose over this
 * period, so ANY long held for a few weeks made money on average. The only
 * meaningful question is what the signal added ON TOP of that, and answering
 * it requires the baseline every session provides for free — the average
 * forward return with no signal at all.
 *
 * Measured here rather than assumed, because the number is large enough to
 * reverse a conclusion: over eleven sessions it is +0.82%, which is most of
 * what a naive reading would have called the engine's edge.
 */
function driftNullByHorizon(instruments: Loaded[], from: number, horizons: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const h of horizons) {
    let sum = 0, n = 0;
    for (const inst of instruments) {
      const b = inst.bars;
      for (let i = 0; i < b.length - h; i++) {
        if (b[i].t < from) continue;
        sum += ((b[i + h].close - b[i].close) / b[i].close) * 100;
        n++;
      }
    }
    out.set(h, n > 0 ? sum / n : 0);
  }
  return out;
}

/** Wilson score lower bound at 95%, the same interval the crypto path uses. */
function wilsonLower(wins: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, ((centre - margin) / d) * 100);
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Fewer than this and the cell is not published — thin cells mislead. */
const MIN_CELL_N = 100;
/** Analog cells split three ways, so they get their own floor. */
const MIN_ANALOG_N = 200;
const MIN_WINNERS = 40;

function aggregate(
  rows: ResolvedRow[],
  dates: number[],
  instruments: Loaded[],
  plansPrinted: number,
  reachRatePct: number,
  printedByStyle: Map<string, number>,
  filledByStyle: Map<string, number>,
  reach: ReachCell[]
): EquityExecutionSnapshot {
  const cells: Record<string, EquityCell | undefined> = {};
  const symbolCount = instruments.length;

  // Horizons actually needed: each published cell's own median hold.
  const holdsNeeded = new Set<number>();
  for (const side of ["long", "short"] as EquitySide[]) {
    for (const vol of ["high-vol", "normal-vol", "low-vol"] as EquityVolRegime[]) {
      const c = rows.filter((r) => r.side === side && r.volRegime === vol);
      if (c.length < MIN_CELL_N) continue;
      const h = c.map((r) => r.holdSessions).filter((x) => x > 0);
      if (h.length) holdsNeeded.add(Math.round(quantile(h, 0.5)));
    }
  }
  // Analog cells need their own holding periods too.
  for (const side of ["long", "short"] as EquitySide[]) {
    for (const vol of ["high-vol", "normal-vol", "low-vol"] as EquityVolRegime[]) {
      for (const st of ["at-market", "pullback"] as EquityEntryStyle[]) {
        const c = rows.filter((r) => r.side === side && r.volRegime === vol && r.entryStyle === st);
        if (c.length < MIN_ANALOG_N) continue;
        const h = c.map((r) => r.holdSessions).filter((x) => x > 0);
        if (h.length) holdsNeeded.add(Math.round(quantile(h, 0.5)));
      }
    }
  }
  const drift = driftNullByHorizon(instruments, REPLAY_START, [...holdsNeeded]);

  const analogs: Record<string, EquityAnalogCell | undefined> = {};
  for (const side of ["long", "short"] as EquitySide[]) {
    for (const vol of ["high-vol", "normal-vol", "low-vol"] as EquityVolRegime[]) {
      for (const st of ["at-market", "pullback"] as EquityEntryStyle[]) {
        const c = rows.filter((r) => r.side === side && r.volRegime === vol && r.entryStyle === st);
        if (c.length < MIN_ANALOG_N) continue;

        const rets = c.map((r) => r.netReturnPct);
        const holds = c.map((r) => r.holdSessions).filter((x) => x > 0);
        const medianHoldSessions = holds.length ? Math.round(quantile(holds, 0.5)) : null;
        const rawDrift = medianHoldSessions !== null ? (drift.get(medianHoldSessions) ?? null) : null;
        const driftNullPct = rawDrift === null ? null : side === "long" ? rawDrift : -rawDrift;
        const averageReturnPct = rets.reduce((a, b) => a + b, 0) / rets.length;

        const key = equityAnalogKey(side, vol, st);
        const printed = printedByStyle.get(key) ?? 0;
        const filled = filledByStyle.get(key) ?? 0;

        analogs[key] = {
          side,
          volRegime: vol,
          entryStyle: st,
          occurrences: c.length,
          effectiveN: Math.round(effectiveSampleSize(c.length, Math.max(1, medianHoldSessions ?? 1))),
          winRatePct: (c.filter((r) => r.win).length / c.length) * 100,
          medianReturnPct: quantile(rets, 0.5),
          averageReturnPct,
          averageDrawdownPct:
            c.reduce((a, r) => a + Math.abs(Math.min(0, r.maePct)), 0) / c.length,
          medianHoldSessions,
          driftNullPct,
          excessReturnPct: driftNullPct === null ? null : averageReturnPct - driftNullPct,
          reachRatePct: printed > 0 ? (filled / printed) * 100 : 0,
        };
      }
    }
  }

  for (const side of ["long", "short"] as EquitySide[]) {
    for (const vol of ["high-vol", "normal-vol", "low-vol"] as EquityVolRegime[]) {
      const cell = rows.filter((r) => r.side === side && r.volRegime === vol);
      if (cell.length < MIN_CELL_N) continue;

      const wins = cell.filter((r) => r.win);
      const losses = cell.filter((r) => !r.win);
      const winRatePct = (wins.length / cell.length) * 100;
      const winRateWilsonLowPct = wilsonLower(wins.length, cell.length);
      const avgWinPct = wins.length ? wins.reduce((s, r) => s + r.netReturnPct, 0) / wins.length : 0;
      const avgLossPct = losses.length ? losses.reduce((s, r) => s + r.netReturnPct, 0) / losses.length : 0;

      const evPointPct = (winRatePct / 100) * avgWinPct + (1 - winRatePct / 100) * avgLossPct;
      const evLowerPct = (winRateWilsonLowPct / 100) * avgWinPct + (1 - winRateWilsonLowPct / 100) * avgLossPct;

      const holds = cell.map((r) => r.holdSessions).filter((h) => h > 0);
      const medianHoldSessions = holds.length ? Math.round(quantile(holds, 0.5)) : null;

      /*
       * Overlap correction. Concurrent trades are not independent draws, so
       * the honest sample size is smaller than the trade count. The block
       * length is the median hold: trades entered within one hold window of
       * each other share most of their price path.
       */
      const effectiveN = Math.round(effectiveSampleSize(cell.length, Math.max(1, medianHoldSessions ?? 1)));

      /*
       * A short's null is MINUS the drift: standing short a market that rose
       * loses that drift before the signal says anything.
       */
      const rawDrift = medianHoldSessions !== null ? (drift.get(medianHoldSessions) ?? null) : null;
      const driftNullPct = rawDrift === null ? null : side === "long" ? rawDrift : -rawDrift;
      const excessEvPct = driftNullPct === null ? null : evPointPct - driftNullPct;

      const winnerMae = wins.map((r) => Math.abs(Math.min(0, r.maePct)));
      const winnerMfe = wins.map((r) => Math.max(0, r.mfePct));

      cells[equityCellKey(side, vol)] = {
        side,
        volRegime: vol,
        n: cell.length,
        effectiveN,
        winRatePct,
        winRateWilsonLowPct,
        avgWinPct,
        avgLossPct,
        evPointPct,
        evLowerPct,
        medianHoldSessions,
        driftNullPct,
        excessEvPct,
        winners:
          wins.length >= MIN_WINNERS
            ? {
                n: wins.length,
                maeP50Pct: quantile(winnerMae, 0.5),
                maeP80Pct: quantile(winnerMae, 0.8),
                mfeP50Pct: quantile(winnerMfe, 0.5),
                mfeP75Pct: quantile(winnerMfe, 0.75),
              }
            : null,
      };
    }
  }

  return {
    generatedAt: Date.now(),
    method: {
      engine: "buildLiveAnalysis, 5-year trailing window, point-in-time breadth and risk appetite",
      lookbackYears: 5,
      maxHoldSessions: MAX_HOLD_SESSIONS,
      costBpsRoundTrip: SLIPPAGE_BPS_PER_LEG * 2,
      barsPerYear: 252,
    },
    coverage: {
      symbols: symbolCount,
      firstDate: new Date(dates[0]).toISOString().slice(0, 10),
      lastDate: new Date(dates[dates.length - 1]).toISOString().slice(0, 10),
      sessionsEvaluated: dates.length,
      plansPrinted,
      reachRatePct,
      trades: rows.length,
    },
    cells,
    analogs,
    reach,
    caveats: [
      "Trades overlap in time and across correlated names, so even the overlap-corrected effective sample is optimistic — the temporal correction does not remove cross-sectional correlation between simultaneous positions.",
      "Historical earnings dates were not available offline, so the replay could not apply the live engine's earnings veto. Some replayed trades are ones the live page would refuse to plan, which makes these numbers if anything noisier than the gated engine's.",
      "The universe is 125 large and mid-cap US instruments that exist TODAY. Companies that failed and delisted are not represented, so the sample carries survivorship bias in the optimistic direction.",
      "Costs are modelled as 10 basis points round trip (spread and impact, commission-free). Real fills on thinner names would be worse.",
      "Expectancy is reported beside its DRIFT NULL — the average return of a random entry over the same holding period. US equities rose across this window, so most of any positive long expectancy is the market rather than the signal; the excess is the only number that describes edge.",
      "These are in-sample statistics over one fixed history, not a forward-tested record. They describe how this engine's plans resolved historically; they are not a promise about the next one.",
    ],
  };
}

main();

/**
 * THE FINGERPRINT LIBRARY, on disk.
 *
 * Emitted as its own artefact rather than folded into the execution stats:
 * it is a different KIND of thing (one row per market day, not per trade),
 * it is far larger, and the page loads it for a different purpose. Keeping
 * them separate means a change to one never silently invalidates the other.
 *
 * ── Why the panel is thinned ──────────────────────────────────────────
 *
 * Every evaluated session across 120 instruments and eighteen years is on
 * the order of half a million rows — a JSON file the Next bundle would have
 * to parse on every request to serve one neighbourhood lookup. So the
 * library is SUBSAMPLED by date, and the reason it costs nothing is the
 * de-clustering already built into the search: neighbours are limited to one
 * per instrument per 21-day window, so days closer together than that were
 * never going to be returned together anyway. Sampling below that resolution
 * removes rows the search would have discarded.
 */
function writeFingerprintLibrary(rows: FingerprintRow[], scalers: Map<string, RollingStandardiser>): void {
  /*
   * Thinned per instrument, not globally — a global stride would keep every
   * instrument's rows on the same dates and destroy the cross-sectional
   * variety that makes a neighbourhood span different names.
   */
  const bySymbol = new Map<string, FingerprintRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol) ?? [];
    list.push(r);
    bySymbol.set(r.symbol, list);
  }

  const kept: FingerprintRow[] = [];
  for (const list of bySymbol.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i += LIBRARY_STRIDE_SESSIONS) kept.push(list[i]);
  }
  kept.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  const returns = kept.map((r) => r.forwardReturnPct);
  /*
   * The drift null. Every neighbourhood's median is later reported against
   * this, never against zero — a +6% median in a library that returned +6%
   * anyway is not an edge, and this is the number that says so.
   */
  const baselineReturnPct = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;

  /*
   * Per-instrument moments, so the LIVE page can standardise today's reading
   * without replaying that instrument's whole history on every request. They
   * are the moments as of the ingest's last session — strictly before any
   * live date — so using them to score today is not a leak.
   */
  const moments: Record<string, Record<string, { mean: number; sd: number; n: number }>> = {};
  for (const symbol of bySymbol.keys()) {
    const m = scalers.get(symbol)?.moments();
    if (m && Object.keys(m).length > 0) moments[symbol] = m;
  }

  /*
   * COLUMNAR, NOT VERBOSE. Repeating nine dimension names and a symbol
   * string on 50,000 rows is most of the file; the numbers are a minority of
   * it. Rows become positional arrays against a declared `dimensions` order,
   * symbols become indices, and every figure is rounded — three decimals on
   * a z-score and two on a percent are far below the resolution any of this
   * supports, so the precision being dropped was noise being stored.
   */
  const symbols = [...bySymbol.keys()].sort();
  const symbolIndex = new Map(symbols.map((s2, i) => [s2, i]));
  const dimensionOrder = DIMENSION_IDS;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const r2 = (x: number) => Math.round(x * 100) / 100;

  const encoded = kept.map((row) => [
    symbolIndex.get(row.symbol)!,
    row.date,
    // null holds the slot for a dimension this row never measured.
    dimensionOrder.map((d) => (row.values[d] === undefined ? null : r3(row.values[d]))),
    r2(row.forwardReturnPct),
    r2(row.maxAdversePct),
    r2(row.maxFavourablePct),
  ]);

  const payload = {
    generatedAt: Date.now(),
    version: FINGERPRINT_VERSION,
    horizonSessions: FINGERPRINT_HORIZON_SESSIONS,
    strideSessions: LIBRARY_STRIDE_SESSIONS,
    baselineReturnPct: r2(baselineReturnPct),
    instruments: bySymbol.size,
    symbols,
    dimensions: dimensionOrder,
    moments,
    rows: encoded,
    notes: [
      "One row per sampled market day, per instrument. Dimensions are z-scores against that instrument's own trailing history, computed strictly before the row's own date (see RollingStandardiser).",
      "Nine of the eleven declared dimensions are present: the replay loads price series, not the sector and industry membership map, so sectorLeadership and industryLeadership are absent rather than approximated.",
      "macroBackdrop here is the volatility-regime reading, narrower than the live page's volatility/rates/dollar/credit backdrop.",
      "moments holds each instrument's per-dimension mean and spread as of the last ingested session, so the live page can score today's reading without replaying its history. Absent for an instrument means no fingerprint can be built for it live.",
      `Outcomes are measured over a fixed ${FINGERPRINT_HORIZON_SESSIONS}-session window. Rows without a full window ahead of them are dropped, so the most recent months are absent by design rather than measured on a partial horizon.`,
    ],
  };

  fs.writeFileSync(FINGERPRINT_OUT, JSON.stringify(payload));
  const mb = (fs.statSync(FINGERPRINT_OUT).size / 1e6).toFixed(1);
  console.log(
    `[replay] fingerprint library: ${kept.length.toLocaleString()} rows from ${rows.length.toLocaleString()} ` +
      `(1 in ${LIBRARY_STRIDE_SESSIONS}), ${bySymbol.size} instruments, baseline ${baselineReturnPct.toFixed(2)}%, ${mb}MB`
  );
}
