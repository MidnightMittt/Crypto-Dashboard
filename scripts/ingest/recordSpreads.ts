import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CAPTURE_MINUTES,
  EMPTY_SPREAD_HISTORY,
  ExecutionWindow,
  SpreadHistory,
  SpreadObservation,
  appendObservations,
  observe,
  pruneObservations,
} from "../../src/lib/history/spreadHistory";
import { resolveUniverse } from "../../src/lib/markets/scannerUniverse";

/**
 * EXECUTION-WINDOW SPREAD RECORDER.
 *
 * Captures bid, ask, mid, spread and last for every tracked symbol at
 * specific US/Eastern wall-clock minutes, and persists each observation with
 * its timestamp. This is the only data here that cannot be recovered later at
 * any price — see spreadHistory.ts for why the usual estimator is not a
 * substitute on these names.
 *
 * ── Why this job sleeps instead of trusting its schedule ──────────────
 *
 * GitHub's scheduled workflows are best-effort and drift badly under load,
 * and this repository has the receipts: the daily job's cron is `15 22 * * 1-5`
 * and its 2026-08-14 runs actually fired at 04:30 and 22:58. Hours, not
 * minutes. A cron aimed at 15:50 ET would routinely capture 16:30 ET and
 * label it as the entry window — quotes from a closed book, stamped as if
 * they were the last minutes of trading. That is worse than no data, because
 * it is wrong in a way nothing downstream could detect.
 *
 * So the workflow starts this job EARLY and the job waits for the wall clock
 * itself. Cron drift then only has to be smaller than the head start, and
 * every capture lands on its intended minute or is skipped and reported.
 *
 * ── Never fabricate a missed minute ───────────────────────────────────
 *
 * If the job starts after a target has passed, that target is SKIPPED and
 * counted, never captured late and back-stamped. A capture's whole value is
 * that its timestamp is true.
 *
 *   npx tsx scripts/ingest/recordSpreads.ts --window entry
 *   npx tsx scripts/ingest/recordSpreads.ts --window entry --now   (capture immediately, for smoke tests)
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "spreadHistory.json");

/** Past this much lateness a target is missed rather than captured. */
const MAX_LATENESS_MS = 90_000;

/**
 * Longest the job will sit waiting for its first target.
 *
 * Two UTC crons cover the window because the US switches DST and the runner
 * does not: one fires in the right half of the year and the other lands an
 * hour early. Rather than encode which is which — a rule that would silently
 * rot at the next DST change — whichever invocation finds itself more than
 * this far ahead simply exits. The correct one proceeds, and no calendar
 * arithmetic has to be maintained.
 */
const MAX_HEAD_START_MS = 45 * 60_000;

function tradierBase(): string {
  return process.env.TRADIER_ENV === "production"
    ? "https://api.tradier.com"
    : "https://sandbox.tradier.com";
}

/** ET wall-clock parts for an instant, DST handled by the runtime's tz database. */
function easternParts(d: Date): { date: string; hh: number; mm: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hh: Number(parts.hour) % 24,
    mm: Number(parts.minute),
  };
}

/** Milliseconds from now until the next occurrence of an ET wall-clock minute today. */
function msUntilEastern(target: string, now: Date): number {
  const [th, tm] = target.split(":").map(Number);
  const { hh, mm } = easternParts(now);
  const nowMin = hh * 60 + mm;
  const targetMin = th * 60 + tm;
  // Seconds within the current minute, so the wait lands ON the minute boundary.
  const secs = now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  return (targetMin - nowMin) * 60_000 - secs * 1000;
}

interface Quote {
  symbol: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
}

async function fetchQuotes(symbols: string[]): Promise<Quote[] | null> {
  const key = process.env.TRADIER_API_KEY;
  if (!key) {
    console.log("[spreads] TRADIER_API_KEY not set — cannot capture quotes.");
    return null;
  }
  try {
    const res = await fetch(
      `${tradierBase()}/v1/markets/quotes?symbols=${encodeURIComponent(symbols.join(","))}`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }
    );
    if (!res.ok) {
      console.log(`[spreads] Tradier refused: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { quotes?: { quote?: unknown } };
    const raw = json.quotes?.quote;
    const arr = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>;
    return arr.map((q) => ({
      symbol: String(q.symbol ?? ""),
      bid: typeof q.bid === "number" ? q.bid : null,
      ask: typeof q.ask === "number" ? q.ask : null,
      last: typeof q.last === "number" ? q.last : null,
    }));
  } catch (err) {
    console.log(`[spreads] Tradier fetch threw: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function captureAt(
  window: ExecutionWindow,
  targetMinute: string,
  symbols: string[]
): Promise<SpreadObservation[]> {
  const now = new Date();
  const { date } = easternParts(now);
  const quotes = await fetchQuotes(symbols);
  if (!quotes) return [];

  const out: SpreadObservation[] = [];
  let refused = 0;
  for (const q of quotes) {
    const o = observe({
      t: now, session: date, symbol: q.symbol, window, targetMinute,
      bid: q.bid, ask: q.ask, last: q.last,
    });
    if (o) out.push(o);
    else refused++;
  }
  console.log(
    `[spreads] ${targetMinute} ET — captured ${out.length}/${quotes.length}` +
      (refused > 0 ? `, ${refused} refused (crossed or missing side)` : "")
  );
  return out;
}

async function main(): Promise<void> {
  const wIdx = process.argv.indexOf("--window");
  const window = (wIdx >= 0 ? process.argv[wIdx + 1] : "entry") as ExecutionWindow;
  if (window !== "entry" && window !== "exit") throw new Error(`unknown window "${window}"`);
  const immediate = process.argv.includes("--now");

  const symbols = [...resolveUniverse()];
  const record: SpreadHistory = fs.existsSync(OUT)
    ? (JSON.parse(fs.readFileSync(OUT, "utf8")) as SpreadHistory)
    : EMPTY_SPREAD_HISTORY;

  const fresh: SpreadObservation[] = [];
  let missed = 0;

  if (immediate) {
    /*
     * Smoke path: proves the plumbing without waiting for a market minute,
     * and DOES NOT PERSIST. A capture taken at an arbitrary time carries no
     * window semantics, and letting one into the store would pull the entry
     * median toward whatever the book looked like when someone ran a test.
     * The measurement is only worth having if every row in it was taken at a
     * minute that means something.
     */
    const probe = await captureAt(window, "smoke-test", symbols);
    for (const o of probe.slice(0, 5)) {
      console.log(`   ${o.symbol.padEnd(6)} ${o.bid} / ${o.ask}  ${o.spreadBp.toFixed(2)}bp`);
    }
    console.log(`[spreads] smoke test only — ${probe.length} quotes read, nothing written.`);
    return;
  }
  {
    const firstWait = msUntilEastern(CAPTURE_MINUTES[window][0], new Date());
    if (firstWait > MAX_HEAD_START_MS) {
      /*
       * Too early to be this window's invocation. In the workflow that means
       * the other DST half's cron; run by hand it just means the wrong time
       * of day. The message does not guess which — it states what was
       * measured and what the job did about it.
       */
      console.log(
        `[spreads] ${Math.round(firstWait / 60_000)} min ahead of ${CAPTURE_MINUTES[window][0]} ET, ` +
          `beyond the ${MAX_HEAD_START_MS / 60_000}-min head start. Exiting without capturing.`
      );
      return;
    }
    for (const target of CAPTURE_MINUTES[window]) {
      const wait = msUntilEastern(target, new Date());
      if (wait < -MAX_LATENESS_MS) {
        /*
         * Skipped, not captured late. A quote taken at 16:30 and labelled
         * 15:50 would be indistinguishable downstream from a real one, and
         * every statistic built on it would be wrong with no way to tell.
         */
        console.log(`[spreads] ${target} ET already passed by ${Math.round(-wait / 1000)}s — SKIPPED, not back-stamped.`);
        missed++;
        continue;
      }
      if (wait > 0) {
        console.log(`[spreads] waiting ${Math.round(wait / 1000)}s for ${target} ET`);
        await new Promise((r) => setTimeout(r, wait));
      }
      fresh.push(...(await captureAt(window, target, symbols)));
    }
  }

  if (fresh.length === 0) {
    console.log(`[spreads] nothing captured (${missed} target(s) missed) — writing nothing.`);
    // Exit 0: a missed window is a lost session, not a broken pipeline.
    return;
  }

  const observations = pruneObservations(appendObservations(record.observations, fresh));
  fs.writeFileSync(
    OUT,
    JSON.stringify({ version: 1, generatedAt: Date.now(), observations } satisfies SpreadHistory, null, 0)
  );

  const sessions = new Set(observations.map((o) => `${o.session}|${o.window}`)).size;
  console.log(
    `[spreads] +${fresh.length} captures (${missed} missed) — ${observations.length} total ` +
      `across ${sessions} session-windows -> ${OUT}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
