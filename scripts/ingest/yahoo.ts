import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Bar } from "../../src/lib/research/types";
import { InstrumentConfig, instrumentsByProvider, usListing } from "../../src/lib/research/universe";
import { industryUniverse, INDUSTRIES } from "../../src/lib/markets/industries";
import { validateBars, summarizeReport } from "../../src/lib/research/validation";
import {
  adjustForCorporateActions,
  formatAdjustmentNotes,
} from "../../src/lib/research/corporateActions";

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

/**
 * Retries transient failures; never retries a validation refusal.
 *
 * Measured need, not defensive habit: a 112-instrument run saw 6 transient
 * fetch failures that all succeeded on immediate retry — at that base rate an
 * unretried daily cron would be red most days, and a pipeline that is always
 * red alerts nobody. Three attempts with a growing pause; the validator
 * downstream still refuses bad DATA loudly, because a refusal is a finding
 * and a network blip is not.
 */
async function fetchWithRetry(url: string, symbol: string): Promise<Response> {
  const delays = [0, 2_000, 8_000];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) return res;
      lastErr = new Error(`[yahoo] ${symbol}: HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchDaily(config: InstrumentConfig): Promise<Bar[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(config.source.symbol)}` +
    `?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=div%2Csplit`;

  const res = await fetchWithRetry(url, config.source.symbol);
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

/**
 * QUARANTINE THE LIVE ROW when the provider serves an impossible bar.
 *
 * Observed, not hypothesized: on 2026-08-12 Yahoo's CURRENT-SESSION row for
 * six unrelated names (DHI, ITB, LEN, SCCO, UPS, WPM) had the open ABOVE the
 * high by a few cents — e.g. DHI O=151.00, H=150.345 — in the RAW response,
 * before any adjustment. The bad open print is a live-row artifact; the same
 * series' history is clean.
 *
 * The validator refusing that bar is correct. Refusing the WHOLE INSTRUMENT
 * for it is not: it would permanently exclude six real companies and one
 * industry ETF over a one-cent artifact on a row the provider is still
 * mutating, and make the daily pipeline red on the provider's schedule
 * rather than ours.
 *
 * So: if and only if the FINAL bar violates OHLC containment, drop that one
 * bar and say so loudly. This is exclusion, not repair — no value is
 * invented, the instrument simply ends one session earlier, and the log
 * names the date and prices. Any violation in INTERIOR bars still refuses
 * the instrument outright, because corrupt history is a finding and a
 * mutable live row is a nuisance, and only one of them should stop the
 * pipeline.
 */
function quarantineBadLiveRow(bars: Bar[], id: string): Bar[] {
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  const violated =
    last.open > last.high || last.open < last.low || last.close > last.high || last.close < last.low;
  if (!violated) return bars;

  const date = new Date(last.t).toISOString().slice(0, 10);
  console.log(
    `   [quarantine] ${id}: final bar ${date} dropped — provider served O ${last.open} outside ` +
      `[L ${last.low}, H ${last.high}] on the live row. Series ends one session earlier; nothing was altered.`
  );
  return bars.slice(0, -1);
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

  /*
   * --only-us: the DAILY pipeline's scope, which is exactly WHAT THE SNAPSHOTS
   * READ — not literally the .US suffix. Those two were the same thing until
   * the industry layer declared external drivers (industries.ts): gold's
   * driver is GLD.US and already in scope, but bitcoin's is BTC-USD.SPOT, and
   * a suffix test would have left it to go stale while every other input
   * refreshed daily. Stale-by-omission is the worst failure shape here,
   * because a driver correlation computed against a frozen series still
   * renders a confident-looking number.
   *
   * Excluded, deliberately: the FX pairs, research-universe members with
   * long-standing validation findings that are a research problem rather than
   * a daily-freshness one. Without that exclusion a known-bad series would
   * fail the cron every day, and a pipeline that is always red alerts nobody.
   * The full run (no flag) remains the default for research work, refusals
   * and all.
   */
  const snapshotDriverIds = new Set(
    INDUSTRIES.map((i) => i.driver?.seriesId).filter((id): id is string => id !== undefined)
  );
  const onlyUs = process.argv.includes("--only-us");
  const all = [...research, ...industry];
  const configs = onlyUs
    ? all.filter((c) => c.meta.id.endsWith(".US") || snapshotDriverIds.has(c.meta.id))
    : all;
  console.log(`[ingest] ${research.length} research + ${industry.length} industry-layer instruments from yahoo\n`);

  let failures = 0;
  for (const config of configs) {
    try {
      const fetched = quarantineBadLiveRow(await fetchDaily(config), config.meta.id);

      /*
       * CORPORATE ACTIONS AND BROKEN PRINTS, applied before validation so the
       * validator judges the series that will actually be written.
       *
       * Yahoo back-adjusts most actions, which is why HUT's merger and CORZ's
       * Chapter 11 emergence arrive clean here and show up raw only in the
       * Robinhood feed. It does not catch everything: NVR's 1993 relisting
       * and two MARA placeholder prints survive in this data, and every ATR,
       * realised-vol and momentum figure computed across them is wrong.
       *
       * Spikes are repaired outright. Steps are repaired only against a
       * declared verdict — see corporateActions.ts for why guessing is the
       * expensive mistake here.
       */
      const symbol = config.meta.displaySymbol ?? config.meta.id.replace(/\.US$/, "");
      const adj = adjustForCorporateActions(fetched, symbol);
      const bars = adj.bars;
      for (const line of formatAdjustmentNotes(symbol, adj.notes)) console.log(`   ${line}`);
      if (adj.undeclared.length > 0) {
        console.log(
          `   [corporate-action] ${symbol}: ${adj.undeclared.length} UNDECLARED step(s) — series written UNCHANGED. ` +
            `Judge each on volume and intraday range, then add it to DECLARED_PRICE_EVENTS.`
        );
      }

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
