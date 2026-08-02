import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Downloads and caches the raw historical series the backtest replay harness
 * needs, for BTC and ETH — the only two assets squeezeRisk/marketThesis
 * inputs are backtestable for (Deribit options, exchange-flow wallet
 * tracking, and Coinbase premium only exist for these two assets, and none
 * of them have historical archives anyway — see the plan doc for the full
 * data-availability audit).
 *
 * Two sources, chosen because they were the only ones confirmed (by direct
 * request, not documentation) to have real historical depth and no
 * geo-block from this environment:
 *
 *  - `data.binance.vision` — Binance's static historical-data archive.
 *    Separate infrastructure from the live trading API (which IS
 *    geo-blocked here, same 451 this app already works around elsewhere).
 *    Multi-year depth for klines and funding rate.
 *  - OKX's `rubik` stats endpoints — live, not geo-blocked, but capped at
 *    exactly 180 daily points with no pagination (`before`/`after` params
 *    are silently ignored). This is what bounds the whole backtest window.
 *
 * Re-run with --refresh to force re-downloading months already cached.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const REFRESH = process.argv.includes("--refresh");
/*
 * Full months back, plus the elapsed days of the current month.
 *
 * Sized by the LONGEST moving average the replay needs, not by the
 * evaluation window. The OKX-bounded eval window starts ~5 months back, and
 * computing EMA200 on the first evaluated day needs 200 daily bars BEFORE
 * that — so ~7 months of runway on top. At the previous value of 7 the
 * EMA200 was null across most of the replay, silently giving the backtest a
 * different technical read than the live site.
 */
const MONTHS_BACK = 14;

const ASSETS = [
  { asset: "BTC", symbol: "BTCUSDT", okxCcy: "BTC" },
  { asset: "ETH", symbol: "ETHUSDT", okxCcy: "ETH" },
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

async function fetchOkxRubik(path_, ccy, mapRow) {
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/${path_}?ccy=${ccy}&period=1D`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OKX ${path_} HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json.data ?? []).map(mapRow).sort((a, b) => a.t - b.t);
  return rows;
}

async function fetchAsset({ asset, symbol, okxCcy }) {
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

  // Spot klines: same columns, but timestamps are in MICROSECONDS in this
  // archive vintage (confirmed against the futures archive's millisecond
  // values for the same period — a factor-of-1000 mismatch that's easy to
  // miss and silently misaligns every join against it).
  const spotKlines = await fetchSeries(
    "spot klines",
    (m) => `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1h/${symbol}-1h-${m.year}-${pad2(m.month)}.zip`,
    (d) => `https://data.binance.vision/data/spot/daily/klines/${symbol}/1h/${symbol}-1h-${d.year}-${pad2(d.month)}-${pad2(d.day)}.zip`,
    (cols) => ({ t: Math.round(Number(cols[0]) / 1000), close: Number(cols[4]) })
  );

  // Funding: [calc_time, funding_interval_hours, last_funding_rate], rate as
  // a fraction — multiplied by 100 to match this app's percentage convention.
  const fundingRate = await fetchSeries(
    "funding rate",
    (m) => `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${m.year}-${pad2(m.month)}.zip`,
    (d) => `https://data.binance.vision/data/futures/um/daily/fundingRate/${symbol}/${symbol}-fundingRate-${d.year}-${pad2(d.month)}-${pad2(d.day)}.zip`,
    (cols) => ({ t: Number(cols[0]), fundingRatePct: Number(cols[2]) * 100 })
  );

  // OKX rubik: [ts, oiUsd, volUsd] and [ts, longRatio] — both hard-capped at
  // 180 daily points, no pagination possible. This is what bounds the whole
  // replay window, regardless of how much Binance history was fetched above.
  const oiHistory = await fetchOkxRubik("open-interest-volume", okxCcy, (row) => ({
    t: Number(row[0]),
    oiUsd: Number(row[1]),
  }));
  const longShortHistory = await fetchOkxRubik("long-short-account-ratio", okxCcy, (row) => ({
    t: Number(row[0]),
    ratio: Number(row[1]),
  }));
  log(`  OKX OI history: ${oiHistory.length} pts, ${oiHistory.length ? new Date(oiHistory[0].t).toISOString().slice(0, 10) : "—"} to ${oiHistory.length ? new Date(oiHistory[oiHistory.length - 1].t).toISOString().slice(0, 10) : "—"}`);
  log(`  OKX long/short history: ${longShortHistory.length} pts`);

  return { asset, futuresKlines, spotKlines, fundingRate, oiHistory, longShortHistory };
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

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
