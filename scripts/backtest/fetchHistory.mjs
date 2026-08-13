import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local") });

/**
 * Downloads and caches the raw historical series the backtest replay harness
 * needs, for BTC and ETH — the only two assets squeezeRisk/marketThesis
 * inputs are backtestable for (Deribit options, exchange-flow wallet
 * tracking, and Coinbase premium only exist for these two assets, and none
 * of them have historical archives anyway — see the plan doc for the full
 * data-availability audit).
 *
 * Three sources, chosen because they were the only ones confirmed (by direct
 * request, not documentation) to have real historical depth and no
 * geo-block from this environment:
 *
 *  - `data.binance.vision` — Binance's static historical-data archive.
 *    Separate infrastructure from the live trading API (which IS
 *    geo-blocked here, same 451 this app already works around elsewhere).
 *    Multi-year depth for klines and funding rate.
 *  - Coinalyze's history endpoints — used for open interest and long/short
 *    ratio. REPLACES OKX's `rubik` endpoints, which were capped at exactly
 *    180 daily points with no pagination and bounded the ENTIRE backtest
 *    window to a few months regardless of how much Binance history existed.
 *    Confirmed by a direct validation spike (not vendor marketing) before
 *    switching: Binance's perpetual on Coinalyze goes back to 2022-06-25 for
 *    open interest (~4.1 years) and 2020-05-31 for long/short ratio
 *    (~6.2 years) — both look like a rolling retention window, not a fixed
 *    archive, so re-running this fetch later will NOT reproduce the exact
 *    same earliest date. Requires `COINALYZE_API_KEY` in `.env.local`
 *    (free signup at coinalyze.net/account/api-key/).
 *  - OKX's `rubik` stats endpoint — kept ONLY for the live dashboard's
 *    current-value reads; no longer used for backtest history.
 *
 * Re-run with --refresh to force re-downloading months already cached.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const REFRESH = process.argv.includes("--refresh");
/*
 * Full months back, plus the elapsed days of the current month.
 *
 * Sized by the LONGER of two constraints, not guessed:
 *  1. Coinalyze's open-interest history — the new binding constraint on the
 *     eval window after the OKX migration (open interest reaches back to
 *     2022-06-25 as of the last check, ~49 months). Binance klines/funding
 *     must reach back AT LEAST that far, or most of that OI depth has no
 *     matching price/funding data and gets skipped by run.ts's `continue`
 *     guards — silently wasting the whole point of the migration.
 *  2. EMA200 runway: the first evaluated day needs 200 daily bars BEFORE it,
 *     ~7 months of buffer on top of constraint 1 (this was the ONLY
 *     constraint before the migration, when OKX's 180-day OI cap was
 *     already the tighter bound).
 * 49 + 7 ≈ 56, rounded up to 57 for margin — OI's own earliest date is a
 * rolling retention window, not a fixed archive (confirmed by direct check),
 * so it creeps forward on every future re-fetch; a `--refresh` run in a few
 * months should not immediately fall short again.
 */
const MONTHS_BACK = 57;

const ASSETS = [
  { asset: "BTC", symbol: "BTCUSDT", sosoType: "us-btc-spot" },
  { asset: "ETH", symbol: "ETHUSDT", sosoType: "us-eth-spot" },
];

function log(msg) {
  console.log(`[fetchHistory] ${msg}`);
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads a zip and returns the text of the single CSV inside, or null if the archive doesn't exist yet. */
async function fetchCsvFromZip(url) {
  const buf = await fetchBuffer(url);
  if (!buf) return null;
  const tmpZip = path.join(DATA_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  fs.writeFileSync(tmpZip, buf);
  try {
    // `unzip -p` streams the single member straight to stdout — no loose
    // extracted files to clean up, and these archives only ever contain one
    // CSV each.
    return execSync(`unzip -p "${tmpZip}"`, { maxBuffer: 1024 * 1024 * 64 }).toString("utf8");
  } finally {
    fs.rmSync(tmpZip, { force: true });
  }
}

/** Rows whose first field isn't a finite number are header rows — skips them generically regardless of archive vintage. */
function parseCsvRows(csvText) {
  if (!csvText) return [];
  return csvText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(","))
    .filter((cols) => Number.isFinite(Number(cols[0])));
}

function monthsBackList(n) {
  const out = [];
  const now = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out.reverse(); // oldest first
}

function elapsedDaysThisMonth() {
  const now = new Date();
  const out = [];
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  // Archives lag live trading by roughly a day, so stop at yesterday.
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Binance's spot-kline archive silently CHANGES timestamp precision partway
 * through its history: recent months are microseconds, older months (at
 * least back to 2021) are already milliseconds — the same archive endpoint,
 * two different units, no version field to tell them apart. Discovered when
 * the backtest window was extended past ~14 months and a chunk of "recent"
 * data suddenly read as 1970 — a fixed "always divide by 1000" conversion
 * (the previous approach, confirmed correct only against the recent window)
 * silently wrecked every older row instead of erroring.
 *
 * Detected by magnitude, not by date: a millisecond Unix timestamp for any
 * real trading date is 13 digits (~1e12–1e13); the same date in microseconds
 * is 16 digits (~1e15–1e16) — three orders of magnitude apart, an
 * unambiguous split with a wide margin on either side.
 */
function normalizeToMs(rawTimestamp) {
  return rawTimestamp > 1e14 ? Math.round(rawTimestamp / 1000) : rawTimestamp;
}

function daysInMonth(year, month) {
  const out = [];
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 0); // last day of the month
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  }
  return out;
}

/**
 * Fetches monthly archives for every full month in the window plus daily
 * archives for the elapsed days of the current month, and concatenates them.
 * `urlFor` receives either `{year,month}` or `{year,month,day}`.
 *
 * A recently-completed month's monthly archive sometimes isn't posted yet
 * even though its daily archives are (confirmed: this happened for the
 * month that had just ended when this was built) — falling straight through
 * to "skip" would silently leave the most recent, most relevant month out of
 * the backtest window. Falls back to per-day archives for that month instead.
 */
async function fetchSeries(label, monthlyUrlFor, dailyUrlFor, parseRow) {
  const rows = [];
  for (const m of monthsBackList(MONTHS_BACK)) {
    const url = monthlyUrlFor(m);
    const csv = await fetchCsvFromZip(url);
    if (!csv) {
      log(`  ${label}: no monthly archive for ${m.year}-${pad2(m.month)} yet — falling back to daily archives`);
      let dailyRows = 0;
      for (const d of daysInMonth(m.year, m.month)) {
        const dailyCsv = await fetchCsvFromZip(dailyUrlFor(d));
        if (!dailyCsv) continue;
        for (const cols of parseCsvRows(dailyCsv)) rows.push(parseRow(cols));
        dailyRows++;
      }
      log(`    recovered ${dailyRows} daily archives for ${m.year}-${pad2(m.month)}`);
      continue;
    }
    for (const cols of parseCsvRows(csv)) rows.push(parseRow(cols));
  }
  for (const d of elapsedDaysThisMonth()) {
    const url = dailyUrlFor(d);
    const csv = await fetchCsvFromZip(url);
    if (!csv) continue;
    for (const cols of parseCsvRows(csv)) rows.push(parseRow(cols));
  }
  rows.sort((a, b) => a.t - b.t);
  log(`  ${label}: ${rows.length} rows, ${rows.length ? new Date(rows[0].t).toISOString().slice(0, 10) : "—"} to ${rows.length ? new Date(rows[rows.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  return rows;
}

const COINALYZE_BASE = "https://api.coinalyze.net/v1";

function coinalyzeApiKey() {
  const key = process.env.COINALYZE_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "COINALYZE_API_KEY not set in .env.local — required to fetch OI/long-short history. Free key at https://coinalyze.net/account/api-key/"
    );
  }
  return key;
}

async function coinalyzeCall(path_, params) {
  const qs = new URLSearchParams({ ...params, api_key: coinalyzeApiKey() });
  const res = await fetch(`${COINALYZE_BASE}${path_}?${qs}`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Coinalyze ${path_} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

let coinalyzeMarketsCache = null;

/** Fetched once, shared across both assets — the market directory doesn't change per-asset. */
async function coinalyzeMarkets() {
  if (!coinalyzeMarketsCache) coinalyzeMarketsCache = await coinalyzeCall("/future-markets", {});
  return coinalyzeMarketsCache;
}

/**
 * Binance's USDT perpetual for this asset — chosen deliberately, not the
 * first match found. Binance is the longest-running major venue Coinalyze
 * redistributes, confirmed by direct check (scripts/backtest/coinalyzeSpike.ts,
 * since deleted) to have the deepest OI/long-short history of any venue
 * tested. Exchange code "A" is Coinalyze's own directory id for Binance,
 * read back from the SAME /future-markets response the live coinalyze.ts
 * provider already resolves symbols from — never hardcoded independently.
 */
async function coinalyzeBinancePerpSymbol(asset) {
  const markets = await coinalyzeMarkets();
  const match = markets.find(
    (m) => m.is_perpetual && m.base_asset.toUpperCase() === asset && m.quote_asset.toUpperCase() === "USDT" && m.exchange === "A"
  );
  if (!match) throw new Error(`No Binance ${asset}/USDT perpetual found in Coinalyze's /future-markets`);
  return match.symbol;
}

/**
 * `from` is set far earlier than any exchange's real history (2016, before
 * perpetual futures existed) so the response's own earliest point reveals
 * the TRUE retention limit, rather than us guessing a start date and simply
 * getting back exactly what we asked for — the same principle the OKX
 * `before`/`after`-ignoring bug was caught with.
 */
async function fetchCoinalyzeHistory(path_, symbol, extraParams = {}) {
  const fromSec = Math.floor(new Date("2016-01-01T00:00:00Z").getTime() / 1000);
  const toSec = Math.floor(Date.now() / 1000);
  const rows = await coinalyzeCall(path_, {
    symbols: symbol,
    interval: "daily",
    from: String(fromSec),
    to: String(toSec),
    ...extraParams,
  });
  const row = rows.find((r) => r.symbol === symbol);
  return row?.history ?? [];
}

/**
 * Fear & Greed history — alternative.me, keyless, 3,100+ daily points back
 * to 2018-02-01. Market-wide (one crowd-sentiment index, not per-asset),
 * so this is fetched once and shared across BTC and ETH rather than
 * duplicated into each asset's cache file.
 */
async function fetchFearGreedHistory() {
  const res = await fetch("https://api.alternative.me/fng/?limit=0&format=json");
  if (!res.ok) throw new Error(`Fear & Greed HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json.data ?? [])
    .map((row) => ({ t: Number(row.timestamp) * 1000, value: Number(row.value) }))
    .sort((a, b) => a.t - b.t);
  log(`Fear & Greed: ${rows.length} pts, ${rows.length ? new Date(rows[0].t).toISOString().slice(0, 10) : "—"} to ${rows.length ? new Date(rows[rows.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  return rows;
}

/**
 * Total stablecoin supply history — DefiLlama's `stablecoincharts/all`,
 * keyless, back to 2017. Also market-wide: the live evaluator (see
 * providers/stablecoins.ts) reads TOTAL circulating supply across every
 * stablecoin, not a per-asset figure, so this is one shared series too.
 */
async function fetchStablecoinHistory() {
  const res = await fetch("https://stablecoins.llama.fi/stablecoincharts/all");
  if (!res.ok) throw new Error(`DefiLlama stablecoins HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json ?? [])
    .map((row) => ({ t: Number(row.date) * 1000, totalUsd: Number(row.totalCirculatingUSD?.peggedUSD) }))
    .filter((row) => Number.isFinite(row.totalUsd) && row.totalUsd > 0)
    .sort((a, b) => a.t - b.t);
  log(`Stablecoin supply: ${rows.length} pts, ${rows.length ? new Date(rows[0].t).toISOString().slice(0, 10) : "—"} to ${rows.length ? new Date(rows[rows.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  return rows;
}

/**
 * FRED macro liquidity series — the same 5 series providers/macroLiquidity.ts
 * uses live (NFCI, T10Y2Y, RRPONTSYD, WTREGEN, EFFR). FRED has real
 * multi-year history for all 5, confirmed live before building this.
 * Market-wide, shared like fearGreed/stablecoins. Requires FRED_API_KEY
 * in .env.local (free signup at fred.stlouisfed.org/docs/api/api_key.html).
 */
async function fetchFredSeriesHistory(seriesId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    log(`  FRED ${seriesId}: no FRED_API_KEY, skipping`);
    return [];
  }
  const res = await fetch(
    `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=asc&limit=100000`
  );
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for ${seriesId}`);
  const json = await res.json();
  const rows = (json.observations ?? [])
    .map((row) => ({ t: Date.parse(`${row.date}T00:00:00Z`), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.value))
    .sort((a, b) => a.t - b.t);
  log(`  FRED ${seriesId}: ${rows.length} pts, ${rows.length ? new Date(rows[0].t).toISOString().slice(0, 10) : "—"} to ${rows.length ? new Date(rows[rows.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  return rows;
}

/**
 * US spot ETF net flows — SoSoValue, the same keyless endpoint
 * providers/etfFlows.ts already uses live. 300 daily points back to
 * 2025-05-21, BTC and ETH only (no US spot ETF complex exists for the
 * other assets, live or historically).
 */
async function fetchEtfFlowsHistory(sosoType) {
  const res = await fetch("https://api.sosovalue.xyz/openapi/v2/etf/historicalInflowChart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: sosoType }),
  });
  if (!res.ok) throw new Error(`SoSoValue HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json.data ?? [])
    .map((row) => ({
      t: Date.parse(`${row.date}T00:00:00Z`),
      netFlowUsd: Number(row.totalNetInflow),
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.netFlowUsd))
    .sort((a, b) => a.t - b.t);
  log(`  ETF flows (${sosoType}): ${rows.length} pts, ${rows.length ? new Date(rows[0].t).toISOString().slice(0, 10) : "—"} to ${rows.length ? new Date(rows[rows.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  return rows;
}

async function fetchAsset({ asset, symbol, sosoType }) {
  log(`${asset}:`);

  /*
   * Futures klines: [open_time, open, high, low, close, volume, close_time,
   * quote_volume, ...], ms timestamps.
   *
   * Full OHLCV is kept, not just the close: ATR, ADX, VWAP and the volume
   * ratio all need high/low/volume, and index 7 (quote_volume) is the
   * USD-denominated figure — index 5 is base-asset units, which would make
   * the volume ratio incomparable across assets.
   */
  const futuresKlines = await fetchSeries(
    "futures klines",
    (m) => `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${m.year}-${pad2(m.month)}.zip`,
    (d) => `https://data.binance.vision/data/futures/um/daily/klines/${symbol}/1h/${symbol}-1h-${d.year}-${pad2(d.month)}-${pad2(d.day)}.zip`,
    (cols) => ({
      t: Number(cols[0]),
      open: Number(cols[1]),
      high: Number(cols[2]),
      low: Number(cols[3]),
      close: Number(cols[4]),
      volumeUsd: Number(cols[7]),
    })
  );

  // Spot klines: same columns, but the timestamp UNIT changes partway
  // through history (microseconds recently, milliseconds further back) —
  // see normalizeToMs's doc comment. Detected per-row, not assumed from a
  // single "confirmed" period, since that's exactly what broke once the
  // window extended past the vintage boundary.
  const spotKlines = await fetchSeries(
    "spot klines",
    (m) => `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1h/${symbol}-1h-${m.year}-${pad2(m.month)}.zip`,
    (d) => `https://data.binance.vision/data/spot/daily/klines/${symbol}/1h/${symbol}-1h-${d.year}-${pad2(d.month)}-${pad2(d.day)}.zip`,
    // volumeUsd (index 7, quote-denominated) added alongside close so the
    // backtest can compute spot-vs-perp turnover, the same way the live
    // spotVolume.ts provider reads a spot ticker's quote volume.
    (cols) => ({ t: normalizeToMs(Number(cols[0])), close: Number(cols[4]), volumeUsd: Number(cols[7]) })
  );

  // Funding: [calc_time, funding_interval_hours, last_funding_rate], rate as
  // a fraction — multiplied by 100 to match this app's percentage convention.
  const fundingRate = await fetchSeries(
    "funding rate",
    (m) => `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${m.year}-${pad2(m.month)}.zip`,
    (d) => `https://data.binance.vision/data/futures/um/daily/fundingRate/${symbol}/${symbol}-fundingRate-${d.year}-${pad2(d.month)}-${pad2(d.day)}.zip`,
    (cols) => ({ t: Number(cols[0]), fundingRatePct: Number(cols[2]) * 100 })
  );

  // Coinalyze: replaces OKX's rubik OI/long-short endpoints (180-day hard
  // cap). Daily granularity, retention confirmed multi-year by direct check
  // — see the header comment for the exact confirmed depths.
  const coinalyzeSymbol = await coinalyzeBinancePerpSymbol(asset);

  /*
   * /open-interest-history returns an OHLC-of-OI-value struct per day, with
   * `t` stamping the interval's START. CLOSE is this day's OI reading — but
   * a close is only KNOWN at the interval's END, so the row must be stamped
   * t + 24h, not t.
   *
   * This is not pedantry; it was a measured look-ahead. The original
   * mapping ({t: row.t*1000, oiUsd: row.c}) handed every replay evaluation
   * at time t the OI level from 24 hours in its own future, and because
   * USD-denominated OI is contracts × price, the day's OI change embedded
   * the day's price move: recorded oiChange24hPct correlated 0.70 with the
   * FORWARD day's return and 0.01 with the past day's — the exact inverse
   * of point-in-time. Every OI-touching statistic (openInterest and
   * squeezeRisk census rows, leverage heat, the 80%+ OI conjunction cells)
   * was contaminated. The long/short series from the same provider was
   * measured CLEAN (its `r` reading correlates with the PAST day, as honest
   * positioning data should), so only this mapping shifts. report.ts now
   * carries a standing leak tripwire so a regression here fails the
   * pipeline loudly instead of minting a fake 82%-precision signal.
   */
  const oiHistoryRaw = await fetchCoinalyzeHistory("/open-interest-history", coinalyzeSymbol, {
    convert_to_usd: "true",
  });
  const oiHistory = oiHistoryRaw
    .filter((row) => Number.isFinite(row.c))
    .map((row) => ({ t: row.t * 1000 + 24 * 3_600_000, oiUsd: row.c }))
    .sort((a, b) => a.t - b.t);

  // /long-short-ratio-history returns `r` (the ratio) directly per row, no
  // OHLC struct — same field the live coinalyze.ts provider already reads
  // (`latestLs?.r`) for its own long/short reading, so this can't drift from
  // what "ratio" means on the live dashboard.
  const longShortHistoryRaw = await fetchCoinalyzeHistory("/long-short-ratio-history", coinalyzeSymbol);
  const longShortHistory = longShortHistoryRaw
    .filter((row) => Number.isFinite(row.r))
    .map((row) => ({ t: row.t * 1000, ratio: row.r }))
    .sort((a, b) => a.t - b.t);

  log(`  Coinalyze OI history: ${oiHistory.length} pts, ${oiHistory.length ? new Date(oiHistory[0].t).toISOString().slice(0, 10) : "—"} to ${oiHistory.length ? new Date(oiHistory[oiHistory.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  log(`  Coinalyze long/short history: ${longShortHistory.length} pts, ${longShortHistory.length ? new Date(longShortHistory[0].t).toISOString().slice(0, 10) : "—"} to ${longShortHistory.length ? new Date(longShortHistory[longShortHistory.length - 1].t).toISOString().slice(0, 10) : "—"}`);

  const etfFlows = await fetchEtfFlowsHistory(sosoType);

  // Marker consumed by the one-time cache-repair guard (and by humans): OI
  // rows are stamped at interval END, the moment their close value is known.
  return { asset, futuresKlines, spotKlines, fundingRate, oiHistory, longShortHistory, etfFlows, oiTimestampConvention: "interval-end" };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Market-wide series — fetched once, shared by both assets' replays,
  // rather than duplicated into BTC.json/ETH.json.
  const marketPath = path.join(DATA_DIR, "MARKET.json");
  if (!fs.existsSync(marketPath) || REFRESH) {
    const fearGreed = await fetchFearGreedHistory();
    const stablecoins = await fetchStablecoinHistory();
    const nfci = await fetchFredSeriesHistory("NFCI");
    const t10y2y = await fetchFredSeriesHistory("T10Y2Y");
    const rrp = await fetchFredSeriesHistory("RRPONTSYD");
    const tga = await fetchFredSeriesHistory("WTREGEN");
    const effr = await fetchFredSeriesHistory("EFFR");
    fs.writeFileSync(marketPath, JSON.stringify({ fearGreed, stablecoins, nfci, t10y2y, rrp, tga, effr }));
    log(`wrote ${marketPath}`);
  } else {
    log("MARKET.json already cached — skipping (pass --refresh to re-fetch)");
  }

  for (const cfg of ASSETS) {
    const outPath = path.join(DATA_DIR, `${cfg.asset}.json`);
    if (fs.existsSync(outPath) && !REFRESH) {
      log(`${cfg.asset}.json already cached — skipping (pass --refresh to re-fetch)`);
      continue;
    }
    const data = await fetchAsset(cfg);
    fs.writeFileSync(outPath, JSON.stringify(data));
    log(`wrote ${outPath}`);
  }

  log("done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
