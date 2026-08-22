import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  CryptoSpreadObservation,
  NOMINAL_FILL_USD,
} from "../../src/lib/execution/cryptoSpreadHistory";

/**
 * THE CRYPTO BOOK RECORDER — one snapshot, three questions answered.
 *
 * /api/cost/express shipped leading with a single live book and the flaw
 * appeared within minutes: STX/USD printed 9bp on one pull and 27bp on the
 * next. The headline moved 54x -> 18x on nothing but timing. A cost number
 * that unstable cannot carry a sizing decision, and neither can a stop
 * placed against one snapshot.
 *
 * Each capture writes one row per declared pair, and that row answers three
 * separate questions that were previously three separate ideas:
 *
 *   1. THE SPREAD DISTRIBUTION.  Many samples across the clock give a
 *      median and a tail. Reported as a distribution, never a mean — on a
 *      book that swings 3x the mean describes a market that never existed.
 *
 *   2. VENUE AGREEMENT, LOGGED.  Every row carries the site's own reference
 *      price at the same instant and the gap in bp. One match proves little
 *      (two sources can share an upstream feed); a series distinguishes
 *      corroboration from a data incident.
 *
 *   3. THE DARK WINDOW.  20:00-04:00 ET and weekends, which no other feed
 *      here can see. Every row is tagged with the US equity session it
 *      falls in, so the overnight tape can be sliced out later.
 *
 * Only (3) has to accrue before it answers anything. (1) and (2) start
 * paying on the first write.
 *
 * ── What this deliberately does not record ───────────────────────────
 *
 * No returns, reach rates or expectancy. Crypto reach on this sample would
 * be drift wearing a signal's clothes — STX fell 84.5% over its available
 * history, so a down-touch rate measures the period, not the asset — and
 * the symmetric/antisymmetric decomposition that made the equity version
 * honest has not been run on crypto. Prices and books only.
 *
 * PUBLIC ENDPOINTS ONLY. No API key is used or wanted: book, ticker and
 * OHLC are unauthenticated, and a key would add only balances and orders,
 * which this site deliberately never holds.
 *
 *   npx tsx scripts/ingest/recordCryptoSpreads.ts [--samples N] [--spacing-sec S]
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "cryptoSpreadHistory.json");

/**
 * DECLARED, not scraped — a list built by enumerating whatever a venue
 * happens to list would change under us and would make two runs
 * incomparable. Each pair is here for a stated reason.
 */
const PAIRS: Array<{ pair: string; krakenPair: string; refSymbol: string; why: string }> = [
  {
    pair: "XBT/USD",
    krakenPair: "XBTUSD",
    refSymbol: "BTC-USD",
    why: "The driver of this account's entire equity book (RIOT, CIFR, BTDR, MARA) and the only informative thing trading during the 20:00-04:00 ET equity blackout.",
  },
  {
    pair: "STX/USD",
    krakenPair: "STXUSD",
    refSymbol: "STX4847-USD",
    why: "Stacks — held personally, and the pair whose 3x spread swing motivated this recorder.",
  },
  {
    pair: "ETH/USD",
    krakenPair: "ETHUSD",
    refSymbol: "ETH-USD",
    why: "Second major; the breadth check on whether a spread pattern is asset-specific or venue-wide.",
  },
  {
    pair: "SOL/USD",
    krakenPair: "SOLUSD",
    refSymbol: "SOL-USD",
    why: "The cross-asset rotation the trading session once found by hand-diffing quotes at 8pm.",
  },
];

/** Keep the store bounded, oldest first — the same discipline as the equity history. */
const MAX_OBSERVATIONS = 6000;

const arg = (flag: string, dflt: number): number => {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const SAMPLES = arg("--samples", 4);
const SPACING_SEC = arg("--spacing-sec", 300);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Which US equity session an instant falls in. The dark-window slice depends on it. */
function usSession(now: Date): CryptoSpreadObservation["usSession"] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = get("weekday");
  if (day === "Sat" || day === "Sun") return "weekend";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre-market";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after-hours";
  return "overnight";
}

interface Level {
  price: number;
  volume: number;
}

async function krakenBook(krakenPair: string): Promise<{ bids: Level[]; asks: Level[] } | null> {
  try {
    const res = await fetch(
      `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(krakenPair)}&count=25`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      error?: string[];
      result?: Record<string, { bids?: [string, string, number][]; asks?: [string, string, number][] }>;
    };
    if (json.error?.length) return null;
    const book = Object.values(json.result ?? {})[0];
    const map = (rows?: [string, string, number][]): Level[] =>
      (rows ?? []).map(([p, v]) => ({ price: Number(p), volume: Number(v) })).filter((l) => l.price > 0 && l.volume > 0);
    const bids = map(book?.bids);
    const asks = map(book?.asks);
    return bids.length && asks.length ? { bids, asks } : null;
  } catch {
    return null;
  }
}

/** The site's own price for the same asset, so agreement is logged rather than assumed. */
async function referencePrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } };
    const p = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * What a real order pays. Walks the book until `usd` is filled and returns
 * the size-weighted price, so the number reflects depth rather than the
 * top tick — the difference between the quoted spread and the one you are
 * actually filled at. Null when the visible book cannot fill the size.
 */
function walk(levels: Level[], usd: number): number | null {
  let remaining = usd;
  let cost = 0;
  let qty = 0;
  for (const l of levels) {
    const levelUsd = l.price * l.volume;
    const take = Math.min(levelUsd, remaining);
    cost += take;
    qty += take / l.price;
    remaining -= take;
    if (remaining <= 0) break;
  }
  return remaining > 0 || qty <= 0 ? null : cost / qty;
}

async function captureOnce(): Promise<CryptoSpreadObservation[]> {
  const now = new Date();
  const session = usSession(now);
  const rows: CryptoSpreadObservation[] = [];

  for (const { pair, krakenPair, refSymbol } of PAIRS) {
    const book = await krakenBook(krakenPair);
    if (!book) {
      console.log(`  ${pair.padEnd(9)} no book returned — skipped, not guessed`);
      continue;
    }
    const bid = book.bids[0].price;
    const ask = book.asks[0].price;
    const mid = (bid + ask) / 2;
    if (!(ask > bid && bid > 0)) continue;

    const buyAt = walk(book.asks, NOMINAL_FILL_USD);
    const sellAt = walk(book.bids, NOMINAL_FILL_USD);
    const effectiveSpreadBp =
      buyAt !== null && sellAt !== null && mid > 0 ? ((buyAt - sellAt) / mid) * 10_000 : null;

    const ref = await referencePrice(refSymbol);
    rows.push({
      t: now.toISOString(),
      venue: "kraken",
      pair,
      bid,
      ask,
      mid,
      spreadBp: ((ask - bid) / mid) * 10_000,
      effectiveSpreadBp,
      refPrice: ref,
      refGapBp: ref !== null && ref > 0 ? ((mid - ref) / ref) * 10_000 : null,
      usSession: session,
    });
    await sleep(150);
  }
  return rows;
}

async function main(): Promise<void> {
  const existing: { version: 1; generatedAt: number; observations: CryptoSpreadObservation[] } =
    fs.existsSync(OUT)
      ? JSON.parse(fs.readFileSync(OUT, "utf8"))
      : { version: 1, generatedAt: 0, observations: [] };

  const fresh: CryptoSpreadObservation[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    if (i > 0) await sleep(SPACING_SEC * 1000);
    const batch = await captureOnce();
    fresh.push(...batch);
    console.log(
      `[capture ${i + 1}/${SAMPLES}] ${batch.length} rows · ${batch
        .map((r) => `${r.pair} ${r.spreadBp.toFixed(1)}bp`)
        .join("  ")}`
    );
  }

  /*
   * Append-only. A snapshot of a book at an instant cannot be
   * reconstructed, so nothing here is ever rewritten — only added, and
   * pruned oldest-first when the store outgrows its cap.
   */
  const merged = [...existing.observations, ...fresh];
  const observations = merged.length > MAX_OBSERVATIONS ? merged.slice(merged.length - MAX_OBSERVATIONS) : merged;

  fs.writeFileSync(
    OUT,
    JSON.stringify({ version: 1, generatedAt: Date.now(), observations }, null, 0)
  );

  const bySession = new Map<string, number>();
  for (const o of observations) bySession.set(o.usSession, (bySession.get(o.usSession) ?? 0) + 1);
  console.log(
    `[crypto-spreads] +${fresh.length} rows — ${observations.length} total · sessions ` +
      [...bySession.entries()].map(([s, n]) => `${s}:${n}`).join(" ")
  );
}

main().catch((err) => {
  console.error("[crypto-spreads] failed:", err);
  process.exit(1);
});
