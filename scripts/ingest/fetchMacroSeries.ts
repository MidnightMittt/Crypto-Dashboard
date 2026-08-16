import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readVolTermStructure, DatedValue } from "../../src/lib/markets/volTermStructure";

/**
 * FRED MACRO SERIES — Roadmap Phase 3's free-data wave.
 *
 * ── Why FRED and not Yahoo, measured rather than assumed ──────────────
 *
 * Yahoo serves ^VIX and ^VIX3M and the obvious move is to take both from the
 * endpoint the price history already uses. Checked on 2026-08-15, that would
 * have been a silent disaster: ^VIX ran to 2026-08-14 while ^VIX3M stopped at
 * 2026-07-17 — four weeks stale, with 96% coverage over the two years before
 * that, so nothing about the series LOOKED broken. A ratio of a fresh
 * near-dated print to a month-old far-dated one is a confident number
 * describing nothing, and it is exactly the "stale-by-omission" failure the
 * ingest already warns about for driver series.
 *
 * FRED's VIXCLS and VXVCLS both ran to 2026-08-13 — same date, both legs —
 * with history to 1990 and 2007 respectively. VXVCLS covers 2008, which is
 * when this curve actually inverts and therefore the only period that makes
 * the percentile meaningful.
 *
 * No key: fredgraph.csv is public. The FRED_API_KEY the crypto research fetch
 * uses is a different endpoint and is deliberately not required here, so this
 * can run in the daily job alongside the other keyless sources.
 *
 *   npm run ingest:macro
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "macroSeries.json");

/**
 * Declared series. Adding one is a deliberate act, the same discipline the
 * equity panel enforces — a macro read whose inputs drift is worse than one
 * that does not exist.
 */
const SERIES = {
  /** CBOE VIX, spot. 1990-. */
  vix: "VIXCLS",
  /** CBOE 3-month VIX. 2007-, so it spans 2008. */
  vix3m: "VXVCLS",
} as const;

/**
 * Past this, a leg is stale enough that pairing it with a fresh one would
 * misdescribe the market. FRED publishes on a one-session lag, so a long
 * weekend plus a holiday is the honest allowance.
 */
const MAX_LEG_AGE_DAYS = 6;

async function fetchSeries(id: string): Promise<DatedValue[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`, {
    headers: { "User-Agent": "leverage-terminal/1.0" },
  });
  if (!res.ok) throw new Error(`[macro] FRED refused ${id}: ${res.status}`);

  const rows = (await res.text()).split("\n").slice(1);
  const out: DatedValue[] = [];
  for (const row of rows) {
    const [date, raw] = row.split(",");
    if (!date || !raw) continue;
    // FRED writes "." for a missing observation. Dropping is correct;
    // carrying the previous value forward would invent a print.
    const value = Number(raw.trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({ date: date.trim(), value });
  }
  return out;
}

async function main(): Promise<void> {
  const [vix, vix3m] = await Promise.all([fetchSeries(SERIES.vix), fetchSeries(SERIES.vix3m)]);

  const today = Date.now();
  for (const [name, s] of [["vix", vix], ["vix3m", vix3m]] as const) {
    if (s.length === 0) throw new Error(`[macro] ${name} came back empty`);
    const ageDays = Math.floor((today - Date.parse(`${s[s.length - 1].date}T00:00:00Z`)) / 86_400_000);
    if (ageDays > MAX_LEG_AGE_DAYS) {
      /*
       * LOUD, not quiet. This is the check that would have caught Yahoo's
       * ^VIX3M. A stale leg must fail the job rather than produce a ratio
       * whose numerator and denominator describe different weeks.
       */
      throw new Error(
        `[macro] ${name} (${SERIES[name]}) last prints ${s[s.length - 1].date}, ${ageDays} days ago — past the ` +
          `${MAX_LEG_AGE_DAYS}-day limit. Refusing to write: a term structure built from legs of different ages ` +
          `is a confident number about nothing.`
      );
    }
  }

  const read = readVolTermStructure(vix, vix3m);
  if (!read) throw new Error("[macro] not enough shared history to rank the term structure");

  /*
   * The RATIO SERIES is committed, not the two legs. The page needs today's
   * reading and its own distribution; shipping two full histories to compute
   * one number in the browser would be paying bandwidth for arithmetic that
   * belongs here.
   */
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        source: "FRED fredgraph.csv (keyless)",
        series: SERIES,
        volTermStructure: read,
        legs: { vix: vix.length, vix3m: vix3m.length },
      },
      null,
      2
    )
  );

  console.log(`[macro] ${SERIES.vix} ${vix.length} obs, ${SERIES.vix3m} ${vix3m.length} obs`);
  console.log(`[macro] term structure as of ${read.asOf}: ${read.ratio.toFixed(3)} (${read.state}), ` +
    `${read.percentile.toFixed(0)}th percentile of ${read.historyLength} sessions`);
  console.log(`[macro] wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
