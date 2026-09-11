import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BarsPanel } from "../../src/lib/research/barsPanel";
import { SpreadObservation } from "../../src/lib/history/spreadHistory";
import { BASKETS } from "../../src/lib/markets/baskets";
import { excludeCorruptSeries, runHypothesis } from "../../src/lib/research/signalLab";
import { loadEquityPanel } from "../research/loadPanel";
import { FAMILY } from "../research/hypotheses";
import {
  PAPER_ENGINE_VERSION,
  PaperLine,
  buildPaperLine,
  paperCaveat,
} from "../../src/lib/research/paperEngine";
import {
  MARK_TO_OPEN_DECLARATION,
  MarkDrag,
  closeToOpenDeclaration,
  closeToOpenSessions,
  markDrag,
  markToOpenSessions,
} from "../../src/lib/research/overnightPaper";
import {
  HYPOTHESES_DECLARED_ON,
  momentumDeclaration,
  momentumSessions,
} from "../../src/lib/research/momentumPaper";

/**
 * THE PAPER LINES — every declared strategy's result, recomputed every night.
 *
 * ── What this is for ──────────────────────────────────────────────────
 *
 * The overnight premium's LIVE series is stuck at n=2 because a scheduler
 * died, not because the edge did. Every missed window was an observation that
 * could never be recovered, and the consequence was that two live fills were
 * being asked to prove both that the effect exists AND that we can execute
 * it. Those are different questions.
 *
 * A paper line separates them. The site computes the declared strategy every
 * session whether or not anybody traded it, so "is the edge alive" runs on a
 * series that cannot be interrupted, and the live fills only have to answer
 * "did we get the paper price" — which is a question two fills can begin to
 * speak to, because it is about cost rather than about expectancy.
 *
 * ── A projection, not a store ─────────────────────────────────────────
 *
 * Every input is already committed: `barsPanel.json`, `spreadHistory.json`,
 * and the bar files the lab reads on this runner. Nothing here holds state.
 * Delete the output and the next run rebuilds it identically, which is why
 * this step is a WARNING and not a red run — unlike the CBOE capture, a
 * session missed here costs a stale artefact for a day and never an
 * observation.
 *
 * The cost of that choice is that changing the arithmetic silently rewrites
 * every past number, so each line carries its declaration's fingerprint. A
 * redefinition shows up in the committed diff as a changed hash rather than
 * as a history that quietly improved overnight.
 *
 * ── THE THING A READER MUST NOT MISREAD ───────────────────────────────
 *
 * Most of what is in this file is BACKFILL, and backfill over a window the
 * strategy was chosen on is a backtest. Every line is therefore split at its
 * declaration date: `full` is everything computable, `sinceDeclared` is the
 * paper record. For the momentum line `sinceDeclared` is currently EMPTY —
 * the register was declared 2026-08-15 and its periods step 21 sessions — and
 * that empty record is the honest one. None of this feeds a forecast: the
 * forward record is out-of-sample by construction and a recomputable line is
 * not, however long it gets.
 *
 *   npx tsx scripts/ingest/buildPaperLines.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");
const BARS = path.join(ROOT, "src", "data", "barsPanel.json");
const SPREADS = path.join(ROOT, "src", "data", "spreadHistory.json");
const OUT = path.join(ROOT, "src", "data", "paperLines.json");

const MOMENTUM_ID = "momentum-12-1-long-only-broad-up";

export interface PaperLineEntry {
  id: string;
  /** Short label for the producer, so a reader knows what built the numbers. */
  source: "close-to-open" | "mark-to-open" | "momentum";
  line: PaperLine;
  /** Generated from the record, never written by hand. Null means no caveat is owed. */
  caveatFull: string | null;
  caveatSinceDeclared: string | null;
}

export interface PaperLines {
  version: 1;
  generatedAt: number;
  engineVersion: number;
  lines: PaperLineEntry[];
  /** The measured cost of marking at 15:50 instead of the close. Null below n=2. */
  markDrag: MarkDrag | null;
  /**
   * Strategies that did NOT produce a line this run, with the reason.
   *
   * Present as an explicit list rather than an absence. A line that quietly
   * stopped being emitted would look identical to one that was never declared,
   * and the committed diff would show a shrinking array with nothing to say
   * why. This is the same reasoning as recordPositioning's per-row coverage.
   */
  refusals: { id: string; reason: string }[];
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function main(): void {
  const bars = readJson<BarsPanel>(BARS);
  const spreads = readJson<{ observations: SpreadObservation[] }>(SPREADS).observations;

  const lines: PaperLineEntry[] = [];
  const refusals: { id: string; reason: string }[] = [];

  /**
   * Each strategy is produced independently and a failure costs only that
   * strategy. The alternative — one throw taking the artefact down — means a
   * single bad basket hides three good lines, and the reader cannot tell a
   * broken producer from a retired one.
   */
  const produce = (id: string, source: PaperLineEntry["source"], build: () => PaperLine): void => {
    try {
      const line = build();
      if (line.full.n === 0) {
        refusals.push({ id, reason: "no sessions computable from the committed inputs" });
        return;
      }
      lines.push({
        id,
        source,
        line,
        caveatFull: paperCaveat(line.full),
        caveatSinceDeclared: paperCaveat(line.sinceDeclared),
      });
    } catch (err) {
      refusals.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  };

  /*
   * ALL FOUR BASKETS, control included and not optional. The benchmark basket
   * returned +7.0bp a night at t=1.80 against the scanned cohort's +32.2bp at
   * t=1.88 — the same Sharpe at a quarter of the magnitude, which is
   * volatility-scaled market drift and not a cohort edge. Publishing the
   * cohort line without the control line beside it would reproduce exactly
   * that error, nightly and automatically.
   */
  const c2oByBasket = new Map<string, ReturnType<typeof closeToOpenSessions>>();
  for (const basket of BASKETS) {
    const declaration = closeToOpenDeclaration(basket.name, basket.note);
    produce(declaration.id, "close-to-open", () => {
      const sessions = closeToOpenSessions(bars, basket.symbols);
      // Kept so the drag below pairs against the SAME series that was
      // published, rather than a second call that could differ if the
      // producer ever became order- or cache-dependent.
      c2oByBasket.set(basket.name, sessions);
      return buildPaperLine(declaration, sessions);
    });
  }

  const scanned = BASKETS.find((b) => b.name === "scanned");
  let markSessions: ReturnType<typeof markToOpenSessions> = [];
  if (!scanned) {
    refusals.push({ id: MARK_TO_OPEN_DECLARATION.id, reason: "the scanned basket is not declared" });
  } else {
    markSessions = markToOpenSessions(bars, scanned.symbols, spreads);
    produce(MARK_TO_OPEN_DECLARATION.id, "mark-to-open", () =>
      buildPaperLine(MARK_TO_OPEN_DECLARATION, markSessions)
    );
  }

  /*
   * The drag is paired on dates both legs produced, so it is computed against
   * the scanned close-to-open leg specifically rather than whichever line
   * happened to be built last.
   */
  const scannedC2O = c2oByBasket.get("scanned") ?? [];
  const drag =
    markSessions.length && scannedC2O.length ? markDrag(markSessions, scannedC2O) : null;

  /*
   * THE MOMENTUM LEG runs the lab rather than re-implementing 12-1 momentum.
   * A second implementation of a validated signal is a second definition of
   * it, and the two drift silently because both look right. It must run HERE
   * because the bar files it reads are 146MB and gitignored — nothing outside
   * this runner can see them.
   */
  const momentum = FAMILY.find((h) => h.id === MOMENTUM_ID);
  if (!momentum) {
    refusals.push({ id: `${MOMENTUM_ID}-paper`, reason: "the hypothesis is no longer declared" });
  } else {
    const declaration = momentumDeclaration(momentum, HYPOTHESES_DECLARED_ON);
    produce(declaration.id, "momentum", () => {
      const { clean } = excludeCorruptSeries(loadEquityPanel().series);
      const result = runHypothesis(clean, momentum);
      return buildPaperLine(declaration, momentumSessions(result.periods, momentum.leg));
    });
  }

  /*
   * Every strategy refusing is a broken input, not a quiet day. Going red
   * there is the difference between "the pipeline told me" and "the page
   * stopped updating and nobody noticed for 26 days", which this repository
   * has already paid for once.
   */
  if (!lines.length) {
    throw new Error(
      `No paper line could be produced. Refusals:\n  ` +
        refusals.map((r) => `${r.id}: ${r.reason}`).join("\n  ")
    );
  }

  const out: PaperLines = {
    version: 1,
    generatedAt: Date.now(),
    engineVersion: PAPER_ENGINE_VERSION,
    lines,
    markDrag: drag,
    refusals,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));

  const bp = (x: number | null | undefined) =>
    x === null || x === undefined ? "   --" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;

  console.log(`[paper] ${lines.length} line(s), engine v${PAPER_ENGINE_VERSION}`);
  for (const e of lines) {
    const f = e.line.full;
    const s = e.line.sinceDeclared;
    console.log(
      `  ${e.id.padEnd(40)} ${f.definitionFingerprint}  ` +
        `full n=${String(f.n).padStart(4)} net=${bp(f.net?.meanBp).padStart(8)}bp ` +
        `t=${(f.net?.tStat ?? 0).toFixed(2).padStart(5)}  |  ` +
        `since ${f.declaration.declaredOn} n=${String(s.n).padStart(3)} ` +
        `net=${bp(s.net?.meanBp).padStart(8)}bp t=${(s.net?.tStat ?? 0).toFixed(2).padStart(5)}`
    );
    /*
     * The in-sample count printed on its own line, because it is the number
     * that decides what the t beside it means.
     */
    if (e.line.inSampleSessions > 0) {
      console.log(
        `      ${e.line.inSampleSessions} of ${f.n} sessions are IN-SAMPLE (before the declaration)` +
          (s.n === 0 ? " — the paper record has not started" : "")
      );
    }
    if (e.caveatSinceDeclared) console.log(`      since: ${e.caveatSinceDeclared}`);
  }
  if (drag) {
    console.log(
      `  mark drag (15:50 vs close), paired on ${drag.n} dates: ` +
        `net ${bp(drag.net?.meanBp)}bp t=${(drag.net?.tStat ?? 0).toFixed(2)}, ` +
        `detectable at t=3: ${bp(drag.detectableAtT3Bp)}bp`
    );
  } else {
    console.log(`  mark drag: not computable — the two legs share no dates yet`);
  }
  for (const r of refusals) console.log(`  REFUSED ${r.id}: ${r.reason}`);
  console.log(`[paper] wrote ${OUT}`);
}

main();
