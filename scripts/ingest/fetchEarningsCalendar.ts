import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { industryUniverse } from "../../src/lib/markets/industries";
import { instrumentsByProvider } from "../../src/lib/research/universe";
import { positioningUniverse } from "../../src/lib/markets/scannerUniverse";
import { EarningsCalendar } from "../../src/lib/markets/earningsVeto";

/**
 * EARNINGS CALENDAR FETCH — Nasdaq's public calendar endpoint, keyless,
 * queried per date for the next ~4 weeks and filtered down to this
 * platform's own equity universe. Output: src/data/earningsCalendar.json,
 * consumed by the trade-plan earnings veto (earningsVeto.ts).
 *
 * DEGRADE, DON'T FAIL. This endpoint is known to reject some datacenter
 * IPs, so a failed run must neither break the daily pipeline nor zero the
 * veto's data: on any error the existing committed file is left exactly
 * as it was, and its entries expire naturally by date (the veto ignores
 * past dates). A stale calendar therefore fails SAFE in both directions —
 * it never invents an earnings date, and a missing one never blocks a
 * plan (absence-of-evidence rule in earningsVeto.ts).
 *
 * Run: npx tsx scripts/ingest/fetchEarningsCalendar.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "..", "src", "data", "earningsCalendar.json");

/** Four calendar weeks of coverage — comfortably past the 3-session veto window plus fetch cadence slack. */
const LOOKAHEAD_DAYS = 28;

interface NasdaqRow {
  symbol: string;
}

async function fetchDay(dateIso: string): Promise<string[]> {
  const res = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${dateIso}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`nasdaq calendar ${dateIso}: HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { rows?: NasdaqRow[] | null } | null };
  return (json.data?.rows ?? []).map((r) => r.symbol).filter(Boolean);
}

async function main() {
  /*
   * The universe this veto protects: every symbol the equity surfaces can
   * build a plan for — industry constituents, the research universe's US
   * listings, and the positioning universe. ETFs in the list simply never
   * appear in the earnings calendar, which costs nothing.
   *
   * Because the sweep visits every day in the window, this set also defines
   * what a COMPLETED sweep can speak to: a symbol in here with no entry has
   * no report before `throughDate`, and one outside it was never asked
   * about. That distinction is recorded in the output.
   */
  const universe = new Set<string>([
    ...industryUniverse(),
    ...instrumentsByProvider("yahoo").map((c) => c.meta.displaySymbol),
    /*
     * The positioning universe, which is NOT a subset of the two above.
     *
     * Six actively-traded names — APLD, CLSK, CORZ, IONQ, OKLO, RIOT — are
     * TRACKED_OUTSIDE_PANEL: ingested for bars, never registered as research
     * instruments. So the sweep never asked about them, and the event veto
     * has consequently never fired for any of them. That is a safety hole,
     * not a coverage nicety: they are among the highest-volatility names the
     * scanner surfaces, and a plan into an unflagged earnings print is
     * exactly what the veto exists to refuse.
     *
     * Reading the declaration rather than repeating a list also means a
     * symbol added to the scanner acquires earnings coverage automatically.
     */
    ...positioningUniverse(),
  ]);

  const entries: EarningsCalendar["entries"] = [];
  const today = new Date();
  /*
   * The last day actually swept. Recorded because a COMPLETED sweep is the
   * only thing that makes a symbol's ABSENCE informative: this loop visits
   * every day in the window, so a covered symbol with no entry genuinely has
   * no report before this date. Consumers that must distinguish "no earnings"
   * from "we never found out" — /api/asset's three-state earnings_status —
   * cannot do it from the entry list alone.
   */
  let throughDate: string | null = null;

  try {
    for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
      const day = d.getUTCDay();
      if (day === 0 || day === 6) continue;
      const dateIso = d.toISOString().slice(0, 10);
      const symbols = await fetchDay(dateIso);
      for (const s of symbols) {
        if (universe.has(s)) entries.push({ symbol: s, date: dateIso });
      }
      // Only after the day's fetch SUCCEEDS. A throw leaves this at the last
      // good day, so a partial sweep claims only what it actually covered.
      throughDate = dateIso;
      // Courtesy delay; this is a free public endpoint.
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    console.warn(
      `[earnings] fetch failed (${err instanceof Error ? err.message : String(err)}) — keeping the existing calendar; ` +
        `its entries expire by date and a stale calendar fails safe. Not failing the pipeline.`
    );
    process.exit(0);
  }

  const calendar: EarningsCalendar = {
    generatedAt: Date.now(),
    entries,
    ...(throughDate ? { sweep: { throughDate, universe: [...universe].sort() } } : {}),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(calendar, null, 2));
  console.log(
    `[earnings] ${entries.length} in-universe report date(s) over the next ${LOOKAHEAD_DAYS} days -> src/data/earningsCalendar.json`
  );
  for (const e of entries.slice(0, 12)) console.log(`   ${e.date}  ${e.symbol}`);
  if (entries.length > 12) console.log(`   ...and ${entries.length - 12} more`);
}

main();
