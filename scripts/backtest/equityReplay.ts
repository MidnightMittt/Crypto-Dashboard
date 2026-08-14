import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildLiveAnalysis, MIN_BARS_FOR_ANALYSIS } from "../../src/lib/search/liveAnalysis";
import { buildEquityEvidence, EquityInstrumentInput } from "../../src/lib/markets/equityEvidence";
import { resolveTrade, TradePlan as ExecPlan } from "../../src/lib/research/tradeExecution";
import { effectiveSampleSize } from "../../src/lib/research/overlap";
import { volRegimeFromMetrics, EquityCell, EquityExecutionSnapshot, EquitySide, EquityVolRegime, equityCellKey } from "../../src/lib/dossier/equityExpectations";
import { Bar, SessionModel } from "../../src/lib/research/types";
import { MetricVerdict } from "../../src/lib/signals/types";

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
      if (!res.ok || !res.analysis.plan) continue;

      const vol = volRegimeFromMetrics(res.analysis.bias.metrics);
      if (!vol) continue;

      /*
       * Direction is the bias verdict, exactly as liveAnalysis derives it —
       * the plan itself carries geometry, not a side.
       */
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
  const maxHoldMs = MAX_HOLD_SESSIONS * 5 * SESSION_MS; // calendar slack for weekends/holidays
  let neverFilled = 0;
  let unresolved = 0;

  for (const p of pending) {
    const inst = all.get(p.symbol)!;

    let entryPrice: number | null = null;
    let entryT = p.signalT;

    if (p.atMarket) {
      // Bracketing the close means the plan was takeable that session.
      entryPrice = p.anchorPrice;
    } else {
      // The near edge is what price reaches first coming back.
      const limit = p.side === "long" ? p.entryHigh : p.entryLow;
      const from = firstIndexAfter(inst.bars, p.signalT);
      const window = inst.bars.slice(from, from + ENTRY_VALID_SESSIONS);
      for (const b of window) {
        if (p.side === "long" && b.low <= limit) {
          entryPrice = Math.min(b.open, limit); // gapped below = filled better
          entryT = b.t;
          break;
        }
        if (p.side === "short" && b.high >= limit) {
          entryPrice = Math.max(b.open, limit);
          entryT = b.t;
          break;
        }
      }
    }

    if (entryPrice === null || entryPrice <= 0) { neverFilled++; continue; }

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
    });
  }

  const reachRatePct = pending.length > 0 ? ((pending.length - neverFilled) / pending.length) * 100 : 0;
  console.log(`[replay] ${neverFilled.toLocaleString()} plans never filled (reach rate ${reachRatePct.toFixed(1)}%)`);

  console.log(`[replay] ${rows.length.toLocaleString()} resolved trades (${unresolved} unresolved), ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);

  const mix = { target: 0, stop: 0, timeout: 0 };
  for (const r of rows) mix[r.outcome]++;
  const pct = (x: number) => ((x / Math.max(1, rows.length)) * 100).toFixed(1);
  console.log(`[replay] outcomes: target ${pct(mix.target)}%  stop ${pct(mix.stop)}%  timeout ${pct(mix.timeout)}%`);

  const snapshot = aggregate(rows, dates, equities, pending.length, reachRatePct);
  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 0));
  console.log(`[replay] -> ${OUT}`);
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
const MIN_WINNERS = 40;

function aggregate(
  rows: ResolvedRow[],
  dates: number[],
  instruments: Loaded[],
  plansPrinted: number,
  reachRatePct: number
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
  const drift = driftNullByHorizon(instruments, REPLAY_START, [...holdsNeeded]);

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
