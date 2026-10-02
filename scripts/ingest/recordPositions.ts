import { BOOK } from "../../src/lib/positions/book";
import { buildBookCards } from "../../src/lib/positions/cards";
import { evaluateThesis } from "../../src/lib/positions/lpHealth";
import { appendReads, loadReads, readsById } from "../../src/lib/positions/readsStore";
import { sendDiscord } from "../../src/lib/alerts/channels/discord";

/**
 * RECORD ONE READ OF EVERY LP POSITION, AND ALERT ON THESIS TRANSITIONS.
 *
 * The brief's P1, running on the rails a static page cannot have: SEND's
 * coverage thesis broke on 09-29 and the position stayed open with nothing
 * surfacing it, because the only monitoring that existed lived in a browser
 * tab. This runs on the 6h weekend-capable cron whether or not anyone is
 * looking, which is the entire point.
 *
 * ── Alert exactly on the transition into BROKEN ───────────────────────
 *
 * A thesis fires when it moves from not-broken to broken — i.e. on the
 * SECOND consecutive violating read, per the two-reads rule (one stale API
 * read produced a false signal once). It does not re-fire while it stays
 * broken; the console shows "BROKEN since <date>" for standing state.
 *
 * Append-first: the read is persisted before any delivery is attempted. A
 * webhook failure costs the notification, never the observation.
 *
 *   npx tsx scripts/ingest/recordPositions.ts
 */

async function main(): Promise<void> {
  const prior = readsById(loadReads());
  const cards = await buildBookCards(prior);

  const newRows = cards.flatMap((c) => (c.readRow ? [c.readRow] : []));
  appendReads(newRows);

  for (const card of cards) {
    if (!card.readRow) continue;
    const m = card.readRow.metrics;
    console.log(
      `[pos] ${card.id}: coverage ${fmt(m.coverage)} | oor_hours ${fmt(m.out_of_range_hours)} | ` +
        `yield6h ${fmt(m.fee_yield_daily_pct)}%/day | ${card.headline}`
    );
    for (const e of card.errors) console.log(`      ERROR: ${e}`);

    // Transition detection: state WITHOUT today's row vs WITH it.
    const pos = BOOK.find((p) => p.id === card.id);
    if (!pos || pos.kind === "posted") continue;
    const before = prior.get(card.id) ?? [];
    const after = [...before, card.readRow];
    for (const t of pos.theses) {
      const was = evaluateThesis(t, before).state;
      const now = evaluateThesis(t, after);
      if (now.state === "broken" && was !== "broken") {
        const msg =
          `🔴 THESIS BROKEN — ${card.label}: ${now.rule} failed on two consecutive reads ` +
          `(now ${now.value === null ? "n/a" : now.value.toFixed(2)}${now.brokenSince ? `, violating since ${now.brokenSince}` : ""}). ` +
          `A measurement, not an instruction — the position and the decision are the holder's.`;
        console.log(`  ALERT ${msg}`);
        const delivered = await sendDiscord(msg);
        if (!delivered) console.log("      (delivery failed — the read is persisted regardless)");
      }
      if (now.state === "breaking" && was === "ok") {
        console.log(`  note: ${card.id} ${now.rule} violated on ONE read — next read confirms or clears.`);
      }
    }
  }
  console.log(`[pos] appended ${newRows.length} read(s)`);
}

const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : x.toFixed(2));

main().catch((err) => {
  console.error("[pos] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
