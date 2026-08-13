import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { industryUniverse } from "../../src/lib/markets/industries";
import { instrumentsByProvider } from "../../src/lib/research/universe";
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
   * build a plan for — industry constituents plus the research universe's
   * US listings. ETFs in the list simply never appear in the earnings
   * calendar, which costs nothing.
   */
  const universe = new Set<string>([
    ...industryUniverse(),
    ...instrumentsByProvider("yahoo").map((c) => c.meta.displaySymbol),
  ]);

  const entries: EarningsCalendar["entries"] = [];
  const today = new Date();

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

  const calendar: EarningsCalendar = { generatedAt: Date.now(), entries };
  fs.writeFileSync(OUT_PATH, JSON.stringify(calendar, null, 2));
  console.log(
    `[earnings] ${entries.length} in-universe report date(s) over the next ${LOOKAHEAD_DAYS} days -> src/data/earningsCalendar.json`
  );
  for (const e of entries.slice(0, 12)) console.log(`   ${e.date}  ${e.symbol}`);
  if (entries.length > 12) console.log(`   ...and ${entries.length - 12} more`);
}

main();
