import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Ledger, LedgerEntry, appendEntry, emptyLedger, guardEntry } from "../../src/lib/markets/historyLedger";

/**
 * Appends today's intelligence reads to the signal history ledger.
 *
 * Runs LAST in the daily pipeline, after both snapshot builders, and reads
 * their OUTPUTS rather than recomputing anything — the ledger must record
 * what the site actually published, not a second computation that could
 * drift from it.
 *
 * Idempotent by date: a re-run replaces today's entry (see historyLedger.ts
 * for why that rule is load-bearing).
 *
 * Run: npx tsx scripts/ingest/appendHistory.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, "..", "..", "src", "data");
const LEDGER_PATH = path.join(DATA, "signalLedger.json");

function main() {
  const intelligence = JSON.parse(fs.readFileSync(path.join(DATA, "marketIntelligence.json"), "utf8"));
  const markets = JSON.parse(fs.readFileSync(path.join(DATA, "equityMarkets.json"), "utf8"));

  /*
   * The entry is dated by the DATA's as-of date, not the wall clock. A
   * pipeline run at 22:15 UTC records the session that just closed; a manual
   * re-run at 9am the next morning must land on the same entry, or weekend
   * re-runs would fabricate trading days that never happened.
   */
  const asOf: number = intelligence.regime?.asOf ?? intelligence.generatedAt;
  const date = new Date(asOf).toISOString().slice(0, 10);

  const entry: LedgerEntry = {
    date,
    regime: intelligence.regime
      ? {
          regime: intelligence.regime.regime,
          agreeing: intelligence.regime.agreeing,
          total: intelligence.regime.total,
        }
      : null,
    rotation: (intelligence.rotation?.sectors ?? []).map(
      (s: { symbol: string; state: string; shortRelPct: number }) => ({
        symbol: s.symbol,
        state: s.state,
        shortRelPct: Number(s.shortRelPct.toFixed(2)),
      })
    ),
    dispersionPct:
      intelligence.rotation?.dispersionPct != null
        ? Number(intelligence.rotation.dispersionPct.toFixed(2))
        : null,
    industries: (intelligence.industries ?? []).map(
      (i: { slug: string; rotation: { state: string; shortRelPct: number }; breadthPct: number | null }) => ({
        slug: i.slug,
        state: i.rotation.state,
        shortRelPct: Number(i.rotation.shortRelPct.toFixed(2)),
        breadthPct: i.breadthPct,
      })
    ),
    equity: (markets.decisions ?? []).map(
      (d: { symbol: string; bias: { verdict: string; score: number; confidence: number } }) => ({
        symbol: d.symbol,
        verdict: d.bias.verdict,
        score: d.bias.score,
        confidence: d.bias.confidence,
      })
    ),
  };

  const ledger: Ledger = fs.existsSync(LEDGER_PATH)
    ? JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"))
    : emptyLedger();

  /*
   * Staleness and ordering are decided by `guardEntry`, which is pure and
   * tested. This script's only job is to refuse loudly on a refusal — see
   * historyLedger.ts for why a silent no-op here left the platform's memory
   * frozen for three days behind a green pipeline.
   */
  const guard = guardEntry(ledger, entry, asOf, Date.now());
  if (!guard.ok) throw new Error(`[ledger] ${guard.reason}`);

  const next = appendEntry(ledger, entry);
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(next, null, 0));

  console.log(
    `[ledger] ${guard.kind} ${date} — ${next.entries.length} entr${next.entries.length === 1 ? "y" : "ies"}, ` +
      `regime=${entry.regime?.regime ?? "none"}, ${entry.rotation.length} sectors, ${entry.industries.length} industries, ${entry.equity.length} equities`
  );
  if (guard.kind === "replaced") {
    console.log(
      `[ledger] this was a RE-RUN of ${date}, so the ledger did not grow. That is expected on a manual re-dispatch ` +
        `and is not expected on a scheduled run — if the schedule keeps reporting this, the ingest has stopped advancing.`
    );
  }
}

main();
