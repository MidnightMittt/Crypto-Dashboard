import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPositionCard } from "../../src/lib/chain/lpPosition";
import { FeeSeriesRow, nextRow, parseSeries, serializeRow } from "../../src/lib/chain/feeSeries";
import { evaluateLpAlerts } from "../../src/lib/chain/lpAlerts";
import { sendDiscord } from "../../src/lib/alerts/channels/discord";

/**
 * RECORD ONE LP FEE-SERIES ROW, AND ALERT ON WHAT IT SHOWS.
 *
 * Runs on a >=6h cadence INCLUDING WEEKENDS (see the workflow) because crypto
 * does not observe weekends — PONS round-tripped -15.5% inside one weekend day,
 * and the weekday-only nightly would have missed it entirely.
 *
 * ── Append-only, and why the row is written before the alert sends ────
 *
 * The series is unreconstructable: this RPC keeps no historical state, so a
 * read not persisted now is gone. The row is therefore APPENDED to the JSONL
 * first; alert delivery is attempted second and its failure cannot erase the
 * observation. Same discipline as the watch sweep — record the fact, then try
 * to notify.
 *
 *   npx tsx scripts/ingest/recordLpFees.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "lpFeeSeries.jsonl");

async function main(): Promise<void> {
  const prior: FeeSeriesRow[] = fs.existsSync(OUT) ? parseSeries(fs.readFileSync(OUT, "utf8")) : [];

  const card = await getPositionCard();
  const row = nextRow(card, prior);

  // APPEND FIRST. A delivery failure below must not cost the observation.
  fs.appendFileSync(OUT, serializeRow(row) + "\n");
  console.log(
    `[lp] block ${row.block} tick ${row.tick} ` +
      `fees ${row.fees_usd === null ? "n/a" : "$" + row.fees_usd.toFixed(2)} ` +
      `rate ${row.fee_rate_usd_per_day === null ? "n/a" : "$" + row.fee_rate_usd_per_day.toFixed(2) + "/day"} ` +
      `share ${row.share_of_active.toFixed(4)}% kind=${row.kind}` +
      (row.gap_hours === null ? "" : ` gap=${row.gap_hours.toFixed(1)}h`)
  );
  if (row.note) console.log(`      ${row.note}`);
  for (const n of card.notes) console.log(`      NOTE: ${n}`);

  const alerts = evaluateLpAlerts(card, row, prior);
  for (const a of alerts) {
    console.log(`  ALERT [${a.severity}] ${a.key}: ${a.message}`);
    const delivered = await sendDiscord(`🟡 ${a.message}`);
    if (!delivered) console.log(`      (delivery failed — the row is persisted regardless)`);
  }
  if (alerts.length === 0) console.log("  no alerts this read");
}

main().catch((err) => {
  console.error("[lp] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
