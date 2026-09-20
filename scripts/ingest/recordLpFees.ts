import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPositionCard } from "../../src/lib/chain/lpPosition";
import { EventWindow, FeeSeriesRow, nextRow, parseSeries, serializeRow } from "../../src/lib/chain/feeSeries";
import { evaluateLpAlerts } from "../../src/lib/chain/lpAlerts";
import { sweepPositionEvents, swapVolumeWeth } from "../../src/lib/chain/lpEvents";
import { CHAIN } from "../../src/lib/chain/config";
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

  /*
   * EVENT SWEEP — the primary reset signal. From the previous row's block to
   * now; a failure downgrades to the state heuristic rather than aborting the
   * run, and says so (swept:false is "the sweep failed", never "no events").
   */
  const prevRow = prior[prior.length - 1];
  let events: EventWindow | undefined;
  if (prevRow) {
    try {
      const evs = await sweepPositionEvents(BigInt(prevRow.block) + 1n, BigInt(card.block));
      events = {
        swept: true,
        collects: evs.filter((e) => e.kind === "collect").length,
        netLiquidityDelta: evs.reduce((s, e) => s + e.liquidityDelta, 0n),
      };
      if (evs.length) console.log(`[lp] ${evs.length} position event(s) in window:`, evs.map((e) => `${e.kind}@${e.block}`).join(" "));
    } catch (err) {
      events = { swept: false, collects: 0, netLiquidityDelta: 0n };
      console.log(`[lp] event sweep FAILED (${err instanceof Error ? err.message : err}) — state heuristic in effect`);
    }
  }

  const row = nextRow(card, prior, events);

  // vol_2h: the pool's trailing 2h swap volume, priced on the WETH side.
  // Best-effort — a failed sweep leaves it null (an absence, never a zero).
  try {
    const wethVol = await swapVolumeWeth(BigInt(card.block), 2, CHAIN.blocksPerSecond);
    row.vol_2h = card.ethUsd ? Number((wethVol * card.ethUsd.value).toFixed(2)) : null;
  } catch (err) {
    console.log(`[lp] vol_2h sweep failed (${err instanceof Error ? err.message : err}) — recorded null`);
  }

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
