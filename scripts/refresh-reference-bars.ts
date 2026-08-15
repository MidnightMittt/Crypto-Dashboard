import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * REFRESHES scripts/fixtures/referenceBars.json — the independent price
 * snapshot that check-dossier.ts measures the rendered pages against.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * The fixture was assembled by hand from Robinhood, so check-dossier could
 * only warn that it had gone stale and leave a human to fix it. Two things
 * followed from that: it drifted, and it was uneven — IREN and HUT carried
 * 64 bars while CIFR and WULF carried 252, which is not enough history for a
 * 50-period EMA to converge, so the moving-average check could only ever
 * report WARN on half the panel. A check that cannot reach a verdict is not
 * a check.
 *
 * ── Why Nasdaq, and not the obvious alternative ───────────────────────
 *
 * NEVER refill this from Yahoo. src/lib/search/fetchQuoteHistory.ts reads
 * Yahoo, so a Yahoo-sourced fixture would compare the app against its own
 * inputs and every external check would pass by construction — the exact
 * failure the cross-validation exists to prevent.
 *
 * Nasdaq is a separate feed and needs no credentials, which also matters:
 * the previous source required an authenticated session, and nothing in this
 * repo should be reaching for one.
 *
 * A caveat worth stating rather than discovering later. Nasdaq's OHLC agrees
 * with the old Robinhood snapshot to the cent on high and low, because
 * consolidated-tape prices are the same prices everywhere — unlike, say, an
 * implied vol, which is a computed opinion and where two venues agreeing
 * would be evidence of a shared upstream rather than corroboration. So this
 * fixture validates the app's ARITHMETIC (ATR, EMA, spot) against an
 * independent implementation of the same bars. That is what the external
 * checks actually test. It is not, and does not claim to be, a check on
 * whether Yahoo's prices are right.
 *
 * Usage:
 *   npm run refresh-reference-bars              # every symbol already in the fixture
 *   npm run refresh-reference-bars -- IREN HUT  # just these
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "referenceBars.json");

/**
 * 252 trading days ≈ one year, and comfortably past the 200 bars an EMA50
 * needs to converge — see EMA_CONVERGED_BARS in check-dossier.ts.
 */
const TARGET_BARS = 252;
/** Calendar days to request. Weekends and holidays cost ~30%, so ask wide. */
const LOOKBACK_DAYS = 420;

const SOURCE_LABEL = "Nasdaq api.nasdaq.com/api/quote/{symbol}/historical (day, split-adjusted)";

/** open, high, low, close — matching check-dossier's Bar tuple. */
type Bar = [number, number, number, number];

interface Fixture {
  as_of: string;
  source: string;
  bars: Record<string, Bar[]>;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "application/json",
};

interface NasdaqRow {
  date?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
}

/** "$44.06" / "1,234.5" → 44.06 / 1234.5. Returns null on anything unparseable. */
function money(raw: string | undefined): number | null {
  if (typeof raw !== "string") return null;
  const n = Number(raw.replace(/[$,]/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "08/14/2026" → "2026-08-14". Null on anything else. */
function nasdaqDate(raw: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((raw ?? "").trim());
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

async function fetchBars(symbol: string): Promise<{ bars: Bar[]; newest: string | null }> {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86_400_000);
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical` +
    `?assetclass=stocks&fromdate=${isoDate(from)}&todate=${isoDate(to)}&limit=9999`;

  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { tradesTable?: { rows?: NasdaqRow[] } } };
  const rows = json.data?.tradesTable?.rows ?? [];
  if (rows.length === 0) throw new Error("no rows returned");

  /*
   * Nasdaq returns newest-first; the fixture and every consumer expect
   * oldest-first. Reversing is not optional — an ATR computed backwards is
   * still a plausible-looking number, which is the worst kind of wrong.
   */
  const chronological = [...rows].reverse();

  const bars: Bar[] = [];
  let dropped = 0;
  for (const r of chronological) {
    const o = money(r.open);
    const h = money(r.high);
    const l = money(r.low);
    const c = money(r.close);
    // A bar missing any leg cannot contribute a true range; skip, don't zero-fill.
    if (o === null || h === null || l === null || c === null || h < l) {
      dropped++;
      continue;
    }
    bars.push([o, h, l, c]);
  }
  if (dropped > 0) console.log(`    (${dropped} incomplete row${dropped === 1 ? "" : "s"} skipped)`);

  return { bars: bars.slice(-TARGET_BARS), newest: nasdaqDate(rows[0]?.date) };
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-")).map((s) => s.toUpperCase());

  let existing: Fixture | null = null;
  try {
    existing = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;
  } catch {
    existing = null;
  }

  const symbols = requested.length > 0 ? requested : Object.keys(existing?.bars ?? {}).sort();
  if (symbols.length === 0) {
    console.error("No symbols. Pass them as arguments, or provide an existing fixture to refresh.");
    process.exit(1);
  }

  console.log(`Refreshing reference bars from Nasdaq for ${symbols.join(", ")}\n`);

  // Start from what is already there so a partial failure cannot silently
  // shrink the fixture — a symbol we could not fetch keeps its old bars.
  const bars: Record<string, Bar[]> = { ...(existing?.bars ?? {}) };
  const newestDates: string[] = [];
  let failures = 0;

  for (const symbol of symbols) {
    try {
      const { bars: fetched, newest } = await fetchBars(symbol);
      const before = existing?.bars[symbol]?.length ?? 0;
      bars[symbol] = fetched;
      if (newest) newestDates.push(newest);
      const last = fetched[fetched.length - 1];
      console.log(
        `  ${symbol.padEnd(6)} ${String(before).padStart(3)} -> ${String(fetched.length).padStart(3)} bars` +
          `   last close $${last[3].toFixed(2)}` +
          (newest ? `   through ${newest}` : "") +
          (fetched.length < TARGET_BARS ? `   (only ${fetched.length} available)` : "")
      );
    } catch (err) {
      failures++;
      console.log(`  ${symbol.padEnd(6)} FAILED: ${(err as Error).message} — keeping existing bars`);
    }
    // Be polite to a free endpoint.
    await new Promise((r) => setTimeout(r, 400));
  }

  /*
   * as_of is the date of the NEWEST BAR, not the clock at fetch time. The
   * staleness warning in check-dossier asks "how old is this data", and the
   * two answers diverge: re-running on a Sunday would advance a fetch-time
   * stamp while the data stood still, resetting the warning without
   * refreshing anything. Using the data's own date also sidesteps a UTC
   * rollover stamping the file a day ahead of the last session it contains.
   *
   * Oldest across symbols, so one lagging feed cannot hide behind three
   * current ones.
   */
  const as_of =
    newestDates.length > 0 ? newestDates.sort()[0] : (existing?.as_of ?? isoDate(new Date()));

  const out: Fixture = { as_of, source: SOURCE_LABEL, bars };
  fs.writeFileSync(FIXTURE, `${JSON.stringify(out, null, 2)}\n`);

  const shallow = Object.entries(bars).filter(([, b]) => b.length < 200);
  console.log(`\nWrote ${FIXTURE} (as_of ${out.as_of})`);
  if (shallow.length > 0) {
    console.log(
      `Note: ${shallow.map(([s, b]) => `${s} has ${b.length}`).join(", ")} — under 200 bars, so ` +
        `check-dossier's EMA50 comparison stays a WARN for those. Usually means a recent listing.`
    );
  }

  // Exit non-zero on failure so this cannot quietly no-op inside a pipeline.
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
