import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar } from "../../src/lib/research/types";
import { InstrumentConfig, instrumentsByProvider, usListing } from "../../src/lib/research/universe";
import { industryUniverse } from "../../src/lib/markets/industries";
import { validateBars, summarizeReport } from "../../src/lib/research/validation";

/**
 * YAHOO PROVIDER ADAPTER — one of possibly many, deliberately isolated.
 *
 * A provider adapter is the ONLY place allowed to know a market's
 * conventions: which symbol string the vendor uses, whether timestamps mark
 * the open or the close, how prices are adjusted. Everything downstream sees
 * only `Bar` and `InstrumentMeta`, so adding a provider never touches the
 * engine.
 *
 * Run: npx tsx scripts/ingest/yahoo.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

interface YahooResponse {
  chart: {
    result: Array<{
      meta: {
        exchangeTimezoneName: string;
        currentTradingPeriod?: { regular?: { start: number; end: number } };
      };
      timestamp: number[];
      indicators: {
        quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }> | null;
    error: unknown;
  };
}

/**
 * US regular trading hours run 09:30-16:00 local, a constant 6.5 hours. The
 * epoch difference is therefore constant across DST too, because both
 * endpoints move together. Used only as a fallback — the session length is
 * read from the response when the vendor supplies it, so this adapter
 * describes the market rather than assuming it.
 */
const FALLBACK_SESSION_MS = 6.5 * 3_600_000;

async function fetchDaily(config: InstrumentConfig): Promise<Bar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(config.source.symbol)}` +
    `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%2Csplit`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`[yahoo] ${config.source.symbol}: HTTP ${res.status}`);
  const json = (await res.json()) as YahooResponse;

  const result = json.chart.result?.[0];
  if (!result) throw new Error(`[yahoo] ${config.source.symbol}: no result in response`);

  const quote = result.indicators.quote[0];
  const adjclose = result.indicators.adjclose?.[0]?.adjclose;
  const regular = result.meta.currentTradingPeriod?.regular;
  const sessionMs = regular && regular.end > regular.start ? (regular.end - regular.start) * 1000 : FALLBACK_SESSION_MS;

  /*
   * The still-forming bar must be excluded.
   *
   * Our Bar contract defines `t` as the CLOSE timestamp, so a bar whose
   * close lies in the future has not closed and its OHLC is a snapshot
   * mid-session — which is why crypto's newest bar arrives with a close
   * outside its own high/low range. Including it would also inject an
   * unclosed price into every point-in-time read.
   *
   * The rule is asset-agnostic by construction: "has this bar's close
   * happened yet". It needs no market calendar and no per-class branch, and
   * it is the same discipline okxCandles.ts already applies by dropping
   * rows whose `confirm` flag is 0.
   */
  const now = Date.now();

  const bars: Bar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    const v = quote.volume[i];

    // A row with any missing price is DROPPED, never interpolated. Yahoo
    // emits nulls for halted or untraded sessions; inventing a price there
    // would be exactly the silent repair the validation layer forbids. The
    // resulting gap is then visible to continuity validation, which is the
    // correct place for it to surface.
    if (o === null || h === null || l === null || c === null) continue;

    /*
     * Yahoo's daily timestamp marks the session OPEN. Our Bar contract
     * defines `t` as the CLOSE, because every point-in-time guard in the
     * platform asks "was this knowable yet" and a bar is knowable at its
     * close. Converting here is what keeps that invariant true for equities.
     */
    const t = result.timestamp[i] * 1000 + sessionMs;
    if (t > now) continue; // unclosed

    /*
     * Adjust the whole bar by the close's adjustment factor, not just the
     * close. Mixing an adjusted close with unadjusted OHLC would break
     * high/low containment and silently corrupt any range-based feature.
     */
    const adj = adjclose?.[i];
    const factor = adj !== null && adj !== undefined && c > 0 ? adj / c : 1;

    bars.push({
      t,
      open: o * factor,
      high: h * factor,
      low: l * factor,
      close: c * factor,
      volume: v ?? null,
    });
  }
  /*
   * Yahoo reports 0 volume for instruments that have no consolidated tape —
   * spot FX most notably. Zero is a lie a volume filter could act on, so it
   * is normalised to null, which the feature layer reports as UNAVAILABLE
   * rather than computing against a fabricated value.
   *
   * This is a provider convention, which is exactly the kind of knowledge an
   * adapter is allowed to hold. It is applied by observation (every volume
   * is zero) rather than by asset class, so no market assumption leaks in.
   */
  const allZeroVolume = bars.length > 0 && bars.every((b) => b.volume === 0 || b.volume === null);
  return allZeroVolume ? bars.map((b) => ({ ...b, volume: null })) : bars;
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  /*
   * Two sources, one adapter. The research universe is an evidence decision
   * documented in universe.ts; the industry layer is a membership list in
   * industries.ts. They are kept separate because they answer different
   * questions — but both go through the identical fetch, validate and refuse
   * path below, so an industry constituent is held to the same standard as a
   * backtested instrument.
   */
  const research = instrumentsByProvider("yahoo");
  const industry = industryUniverse()
    .filter((sym) => !research.some((c) => c.meta.displaySymbol === sym))
    .map((sym) => usListing(sym, sym));
  const configs = [...research, ...industry];
  console.log(`[ingest] ${research.length} research + ${industry.length} industry-layer instruments from yahoo\n`);

  let failures = 0;
  for (const config of configs) {
    try {
      const bars = await fetchDaily(config);
      const report = validateBars(config.meta, bars, "1D");
      console.log(summarizeReport(report));

      for (const f of report.findings.slice(0, 5)) {
        console.log(`   [${f.severity}] ${f.check}: ${f.message.slice(0, 140)}`);
      }
      if (report.findings.length > 5) console.log(`   ...and ${report.findings.length - 5} more findings`);

      if (!report.passed) {
        // Loud refusal. A failing instrument is NOT written, so it cannot be
        // picked up by a later run that forgot this one failed.
        failures++;
        console.log(`   REFUSED — not written to disk.\n`);
        continue;
      }

      const first = new Date(bars[0].t).toISOString().slice(0, 10);
      const last = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
      fs.writeFileSync(
        path.join(DATA_DIR, `${config.meta.id}.json`),
        JSON.stringify({ meta: config.meta, timeframe: "1D", bars }, null, 0)
      );
      console.log(`   written: ${first} to ${last}\n`);
    } catch (err) {
      failures++;
      console.log(`${config.meta.id}: FETCH FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // Courtesy delay; this is a free public endpoint.
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(failures === 0 ? "[ingest] all instruments validated and written" : `[ingest] ${failures} instrument(s) failed`);
  if (failures > 0) process.exitCode = 1;
}

main();
