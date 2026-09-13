import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  LiveLedger,
  RawRoundTrip,
  buildLiveLedger,
  unavailableLedger,
} from "../../src/lib/validation/roundTrips";

/**
 * THE ROUND-TRIP LOG, READ FROM OUTSIDE THE REPO AND REDUCED TO COUNTS.
 *
 * ── Why the raw log does not come into the repository ─────────────────
 *
 * `~/trading/roundtrips.jsonl` is the trading session's artefact and it is
 * personal brokerage history: symbols, sizes, timestamps and realised dollars,
 * trade by trade. The site needs none of that. Everything rung 3 says is a
 * count — how many trips, how many carry a join key, how many fail each
 * predicate — so only counts are written here.
 *
 * That is not only a privacy preference. A copy of an append-only log in a
 * second place is a copy that can drift from the original, and the original is
 * the one with the audit trail. One writer, one home.
 *
 * ── Why this is not in daily-intelligence ─────────────────────────────
 *
 * The source lives on Mitchell's laptop, not in CI. A nightly job on GitHub
 * would find nothing every night and either fail loudly forever or learn to
 * ignore its own absence, and the second is worse. So this runs locally and
 * the output records WHICH it was: `source: "read"` versus `"unavailable"`.
 *
 * That distinction is the whole point of the soft-fail below. "No fills exist"
 * and "no fills were visible from here" render as different sentences, because
 * treating the second as the first is how an environment problem gets
 * published as a finding.
 *
 *   npx tsx scripts/ingest/buildLiveLedger.ts
 *   ROUNDTRIP_LOG=/some/other/path.jsonl npx tsx scripts/ingest/buildLiveLedger.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");
const OUT = path.join(ROOT, "src", "data", "liveLedger.json");
const SOURCE = process.env.ROUNDTRIP_LOG ?? path.join(os.homedir(), "trading", "roundtrips.jsonl");

export interface LiveLedgerArtifact {
  version: 1;
  generatedAt: number;
  /**
   * Where the log was read from, as a path RELATIVE TO HOME — never absolute.
   * The absolute path names the operator's account, and this file is committed.
   */
  sourceHint: string;
  ledger: LiveLedger;
}

function readTrips(file: string): RawRoundTrip[] | null {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const rows: RawRoundTrip[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      rows.push(JSON.parse(trimmed) as RawRoundTrip);
    } catch {
      /*
       * A malformed line is reported and skipped rather than aborting. An
       * append-only log written by another process can be caught mid-write,
       * and refusing the whole file over one torn tail would turn a transient
       * race into a page that says no fills exist.
       */
      console.warn(`  ! line ${i + 1} is not JSON — skipped`);
    }
  });
  return rows;
}

function main(): void {
  const rows = readTrips(SOURCE);
  const hint = SOURCE.startsWith(os.homedir())
    ? `~${SOURCE.slice(os.homedir().length)}`
    : path.basename(SOURCE);

  if (rows === null) {
    console.log(`round-trip log not found at ${hint}`);
    if (fs.existsSync(OUT)) {
      /*
       * The committed ledger stays. Overwriting a real reading with
       * "unavailable" because this run happened on a machine without the log
       * would make the page forget something it knew.
       */
      console.log("  keeping the committed ledger — this environment cannot see the source");
      return;
    }
    const artifact: LiveLedgerArtifact = {
      version: 1,
      generatedAt: Date.now(),
      sourceHint: hint,
      ledger: unavailableLedger(),
    };
    fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
    console.log("  wrote an unavailable ledger so the page can say so explicitly");
    return;
  }

  const ledger = buildLiveLedger(rows);
  const artifact: LiveLedgerArtifact = {
    version: 1,
    generatedAt: Date.now(),
    sourceHint: hint,
    ledger,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`live ledger <- ${hint}`);
  console.log(`  ${ledger.statement}`);
  console.log(
    `  trips ${ledger.trips}  joinable ${ledger.joinable}  ` +
      `in declared names ${ledger.inDeclaredNames}  ` +
      `window ${ledger.window?.from ?? "—"} → ${ledger.window?.to ?? "—"}`
  );
  console.log(
    `  fill-time scan: best UTC${ledger.fillTimes.bestOffsetHours >= 0 ? "+" : ""}` +
      `${ledger.fillTimes.bestOffsetHours} at ${(ledger.fillTimes.bestRthFraction * 100).toFixed(0)}% RTH ` +
      `(chance ${(ledger.fillTimes.chanceFraction * 100).toFixed(0)}%, need ` +
      `${(ledger.fillTimes.threshold * 100).toFixed(0)}%) — ` +
      `${ledger.fillTimes.credible ? "credible" : "NOT fill times"}`
  );
  for (const b of ledger.blockers) {
    console.log(`  blocks ${b.blocks.padEnd(18)} ${b.id.padEnd(32)} ${b.count}/${b.of}`);
  }
}

main();
