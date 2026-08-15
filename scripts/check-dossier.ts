import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * DOSSIER CROSS-VALIDATION.
 *
 * Checks the rendered asset dossier pages against reality. Findings from the
 * first run are written up in docs/DATA_INTEGRITY_AUDIT.md.
 *
 * Two classes of check, and the distinction matters operationally:
 *
 *   INTERNAL — the page contradicting itself. An analyst count that does not
 *              equal its own breakdown is wrong without reference to any
 *              outside source. These need no credentials and no fixture, so
 *              they are safe to run in CI on every deploy.
 *
 *   EXTERNAL — the page disagreeing with an independent measurement. Needs
 *              scripts/fixtures/referenceBars.json, a snapshot of daily OHLCV
 *              pulled from Robinhood. This script cannot refresh that itself;
 *              it warns when the snapshot is stale.
 *
 * ── Why the indicator maths below is deliberately duplicated ───────────
 *
 * src/lib/technicals/indicators.ts already exports `atr` and `ema`. This file
 * pointedly does NOT import them, and that is not an oversight.
 *
 * The charter's single-source-of-truth rule exists to stop two pieces of
 * product code forming competing opinions. This is not product code. It is a
 * measuring instrument, and an instrument calibrated against the thing it
 * measures measures nothing. If this file imported the app's `atr`, then a bug
 * in `atr` would shift the page and the expectation by the same amount and the
 * check would pass while the number on screen was wrong.
 *
 * So: independent reimplementation, on purpose. If you are here to refactor
 * this into the shared helpers, that change silently deletes the value of
 * every external check in this file. Please don't.
 *
 * Usage:
 *   npm run check-dossier
 *   npm run check-dossier -- IREN WULF
 *   npm run check-dossier -- --base http://localhost:3000
 *
 * Exits 1 if any check fails, so it can gate a deploy.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "referenceBars.json");
const DEFAULT_BASE = "https://crypto-dashboard-qvs6.vercel.app";

/** Tolerances. Deliberately tight — these compare a number against itself. */
const TOL_PRICE_PCT = 0.5; // spot, percent
const TOL_ATR_PP = 0.5; // ATR, percentage points
const IV_RV_MAX = 1.8; // implied/realised above this is implausible
const BARS_MAX_AGE_DAYS = 5;
/** Below this many bars an EMA50 is still under-converged; see checkMovingAverage. */
const EMA_CONVERGED_BARS = 200;

/** open, high, low, close */
type Bar = [number, number, number, number];

interface Fixture {
  as_of: string;
  source: string;
  bars: Record<string, Bar[]>;
}

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";

interface CheckResult {
  symbol: string;
  kind: "internal" | "external" | "fetch";
  name: string;
  status: Status;
  detail: string;
}

const results: CheckResult[] = [];

function record(
  symbol: string,
  kind: CheckResult["kind"],
  name: string,
  status: Status,
  detail: string
): void {
  results.push({ symbol, kind, name, status, detail });
  const badge = { PASS: "  ok  ", FAIL: " FAIL ", WARN: " warn ", SKIP: " skip " }[status];
  console.log(`  [${badge}] ${name.padEnd(34)} ${detail}`);
}

// ─────────────────────────── extraction ───────────────────────────
//
// These match the server-rendered RSC payload. When page copy changes, the
// affected check reports SKIP rather than PASS — a check that can no longer
// find what it measures must say so, never go quietly green.

const PATTERNS = {
  price: /font-mono text-sm text-ink">\$(\d+\.\d+)</,
  moveNarrative: /typically moves (\d+\.\d+)% in a day/,
  moveStopSizing: /Typical daily move · <\/span>(\d+\.\d+)% of price/,
  /*
   * Copy changed under this check on 2026-08-14; both quantities below are now
   * named, so these patterns measure what they claim to.
   *
   * The count leading the analyst line used to come from Nasdaq's ratings
   * survey while the breakdown came from the targetprice endpoint — different
   * panels, so the line read "5 analysts (15 buy · 0 hold · 0 sell)". It now
   * leads with the covering count, which is the breakdown's own sum.
   */
  analysts: /(\d+) analysts publish price targets on it \((\d+) buy · (\d+) hold · (\d+) sell\)/,
  /*
   * This never matched the dossier — there is no "Implied move (ATM IV)"
   * <dt>/<dd> pair in it — so the IV/RV check reported SKIP on every symbol
   * and the 0DTE contamination underneath it went unseen. A pattern that
   * cannot match is worse than one that fails: it looks like coverage.
   *
   * The dossier states ATM IV in prose, with its tenor, in the CBOE panel.
   */
  impliedVol: /expiry imply (\d+)% annualised volatility/,
  /*
   * This check was comparing a chain CONTRACT COUNT against per-strike OPEN
   * INTEREST, because the page called both "contracts" — hence chain 1,348 vs
   * largest strike 49,937 on CIFR and a FAIL on all four symbols. The
   * arithmetic was never wrong; the noun was overloaded. The page now renders
   * the real chain open-interest total, which is what this invariant needs.
   */
  chainOpenInterest: /out of ([\d,]+) open across the chain/,
  strikeContracts: /open interest ([\d,]+),/g,
  earningsDate: /Next earnings report: (\d{4}-\d{2}-\d{2})/,
  noEarnings: /(No (?:known )?earnings|no report (?:known|scheduled))/,
  maClaim: /(above|below) (?:its |all )?(?:20,? 50,? and 200|20\/50\/200)[- ]day/,
} as const;

async function fetchPage(symbol: string, base: string): Promise<string> {
  const res = await fetch(`${base}/asset/${symbol}`, {
    headers: { "User-Agent": "check-dossier/1.0" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  return raw.replace(/\\"/g, '"').replace(/\\u0026/g, "&");
}

function first(html: string, pattern: RegExp): RegExpMatchArray | null {
  return html.match(pattern);
}

function toNumber(s: string): number {
  return Number(s.replace(/,/g, ""));
}

// ─────────────────────────── independent recompute ───────────────────────────
// See the header note. Do not replace these with the shared helpers.

/*
 * INDEPENDENT OF THE IMPLEMENTATION, NOT OF THE DEFINITION.
 *
 * This used to average the last 14 true ranges. That is a real estimator,
 * but it is not the one the page computes — the app uses Wilder's smoothing,
 * which the charter settled on as the single ATR after measuring both across
 * 60 instruments (c1c221c). Comparing a simple mean against a Wilder mean
 * measures the gap between two definitions, and reports it as a defect in
 * the page. It failed CIFR by 0.89pp and HUT by 0.65pp on exactly that,
 * while IREN and WULF happened to fall inside tolerance.
 *
 * The header note above still stands: do not import the app's `atr`. The
 * point of an independent instrument is that a bug in the app's arithmetic
 * cannot hide by moving both sides. But independence has to be of the CODE,
 * not of the quantity — otherwise every run reports a difference that no
 * change to the page could ever fix, and a real regression would be
 * indistinguishable from the permanent offset.
 *
 * So: Wilder, reimplemented here from the definition, sharing nothing with
 * src/lib/technicals/indicators.ts.
 */
function atrPercent(bars: Bar[], period = 14): number {
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const [, high, low] = bars[i];
    const prevClose = bars[i - 1][3];
    trueRanges.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    );
  }
  if (trueRanges.length < period) {
    const all = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    return (all / bars[bars.length - 1][3]) * 100;
  }
  // Seed with the mean of the first `period` ranges, then smooth by 1/period.
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return (atr / bars[bars.length - 1][3]) * 100;
}

function realisedVolPercent(bars: Bar[]): number {
  const closes = bars.map((b) => b[3]);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const w = values.slice(-period);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) acc = values[i] * k + acc * (1 - k);
  return acc;
}

// ─────────────────────────── internal checks ───────────────────────────

function checkAnalystCount(symbol: string, html: string): void {
  const m = first(html, PATTERNS.analysts);
  if (!m) {
    record(symbol, "internal", "analyst count == breakdown", "SKIP", "pattern not found");
    return;
  }
  const [, stated, buy, hold, sell] = m.map(Number) as unknown as number[];
  const sum = buy + hold + sell;
  record(
    symbol,
    "internal",
    "analyst count == breakdown",
    stated === sum ? "PASS" : "FAIL",
    `stated ${stated}, breakdown ${buy}+${hold}+${sell}=${sum}`
  );
}

function checkOpenInterest(symbol: string, html: string): void {
  const totalMatch = first(html, PATTERNS.chainOpenInterest);
  const strikeMatches = [...html.matchAll(PATTERNS.strikeContracts)].map((m) =>
    toNumber(m[1])
  );
  if (!totalMatch || strikeMatches.length === 0) {
    record(symbol, "internal", "chain OI >= max strike OI", "SKIP", "pattern not found");
    return;
  }
  const total = toNumber(totalMatch[1]);
  const others = strikeMatches.filter((n) => n !== total);
  const largest = others.length > 0 ? Math.max(...others) : 0;
  record(
    symbol,
    "internal",
    "chain OI >= max strike OI",
    total >= largest ? "PASS" : "FAIL",
    `chain ${total.toLocaleString()} vs largest strike ${largest.toLocaleString()}`
  );
}

function checkTypicalMove(symbol: string, html: string): void {
  const a = first(html, PATTERNS.moveNarrative);
  const b = first(html, PATTERNS.moveStopSizing);
  if (!a || !b) {
    record(symbol, "internal", "single typical-move value", "SKIP", "pattern not found");
    return;
  }
  const narrative = Number(a[1]);
  const stopSizing = Number(b[1]);
  const delta = Math.abs(narrative - stopSizing);
  record(
    symbol,
    "internal",
    "single typical-move value",
    delta < 0.05 ? "PASS" : "FAIL",
    `narrative ${narrative}% vs stop-sizing ${stopSizing}% (delta ${delta.toFixed(2)}pp)`
  );
}

function checkEarningsGate(symbol: string, html: string): void {
  const date = first(html, PATTERNS.earningsDate);
  const claimsNone = first(html, PATTERNS.noEarnings);
  if (date) {
    record(symbol, "internal", "earnings gate has real data", "PASS", `date known: ${date[1]}`);
  } else if (claimsNone) {
    record(
      symbol,
      "internal",
      "earnings gate has real data",
      "WARN",
      "claims no earnings, but no date was retrieved — cannot distinguish " +
        "'confirmed none' from 'lookup failed'"
    );
  } else {
    record(symbol, "internal", "earnings gate has real data", "SKIP", "pattern not found");
  }
}

// ─────────────────────────── external checks ───────────────────────────

function checkSpotPrice(symbol: string, html: string, bars: Bar[]): void {
  const m = first(html, PATTERNS.price);
  if (!m) {
    record(symbol, "external", "spot price vs reference", "SKIP", "pattern not found");
    return;
  }
  const page = Number(m[1]);
  const ref = bars[bars.length - 1][3];
  const drift = (Math.abs(page - ref) / ref) * 100;
  record(
    symbol,
    "external",
    "spot price vs reference",
    drift <= TOL_PRICE_PCT ? "PASS" : "FAIL",
    `page $${page.toFixed(2)} vs ref $${ref.toFixed(2)} (${drift.toFixed(2)}%)`
  );
}

function checkAtr(symbol: string, html: string, bars: Bar[]): void {
  const m = first(html, PATTERNS.moveNarrative);
  if (!m) {
    record(symbol, "external", "ATR vs reference", "SKIP", "pattern not found");
    return;
  }
  const page = Number(m[1]);
  const ref = atrPercent(bars);
  const delta = Math.abs(page - ref);
  record(
    symbol,
    "external",
    "ATR vs reference",
    delta <= TOL_ATR_PP ? "PASS" : "FAIL",
    `page ${page.toFixed(2)}% vs ref ${ref.toFixed(2)}% (delta ${delta.toFixed(2)}pp)`
  );
}

function checkImpliedVol(symbol: string, html: string, bars: Bar[]): void {
  const m = first(html, PATTERNS.impliedVol);
  if (!m) {
    record(symbol, "external", "IV/RV ratio plausible", "SKIP", "pattern not found");
    return;
  }
  const iv = Number(m[1]);
  const rv = realisedVolPercent(bars);
  const ratio = iv / rv;
  record(
    symbol,
    "external",
    "IV/RV ratio plausible",
    ratio <= IV_RV_MAX ? "PASS" : "FAIL",
    `IV ${iv.toFixed(0)}% / RV ${rv.toFixed(0)}% = ${ratio.toFixed(2)}x (max ${IV_RV_MAX})`
  );
}

/**
 * The app seeds EMA with the SMA of the first `period` values and iterates over
 * 200+ bars. With a shallower fixture our EMA50 runs too few iterations past
 * seed to be independent of our SMA50 — so the two agreeing is one piece of
 * evidence, not two, and a disagreement with the page can only be a WARN.
 */
function checkMovingAverage(symbol: string, html: string, bars: Bar[]): void {
  const claim = first(html, PATTERNS.maClaim);
  const closes = bars.map((b) => b[3]);
  const s50 = sma(closes, 50);
  const e50 = ema(closes, 50);
  if (!claim || s50 === null || e50 === null) {
    record(
      symbol,
      "external",
      "MA direction vs reference",
      "SKIP",
      !claim ? "pattern not found" : "need 50+ bars"
    );
    return;
  }
  const spot = closes[closes.length - 1];
  const bySma = spot > s50 ? "above" : "below";
  const byEma = spot > e50 ? "above" : "below";
  const detail =
    `page says ${claim[1]}; ref SMA50 ${bySma} ($${s50.toFixed(2)}), ` +
    `EMA50 ${byEma} ($${e50.toFixed(2)})`;

  if (bySma === byEma && byEma === claim[1]) {
    record(symbol, "external", "MA direction vs reference", "PASS", detail);
  } else if (bySma === byEma) {
    const converged = bars.length >= EMA_CONVERGED_BARS;
    record(
      symbol,
      "external",
      "MA direction vs reference",
      converged ? "FAIL" : "WARN",
      detail +
        (converged
          ? "  <- both conventions disagree with the page"
          : `  <- disagrees, but only ${bars.length} bars; EMA50 under-converged. ` +
            `Deepen the fixture to ${EMA_CONVERGED_BARS}+ to make this decisive.`)
    );
  } else {
    record(
      symbol,
      "external",
      "MA direction vs reference",
      "WARN",
      detail + "  <- conventions split; check the app's own EMA"
    );
  }
}

// ─────────────────────────── main ───────────────────────────

function loadFixture(): Fixture | null {
  if (!fs.existsSync(FIXTURE)) return null;
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : DEFAULT_BASE;
  const symbols = argv.filter((a, i) => !a.startsWith("--") && i !== baseIdx + 1);

  const fixture = loadFixture();
  if (!fixture) {
    console.log(`! ${FIXTURE} not found — internal checks only.\n`);
  } else {
    const ageDays = Math.floor(
      (Date.now() - Date.parse(fixture.as_of)) / 86_400_000
    );
    if (ageDays > BARS_MAX_AGE_DAYS) {
      console.log(
        `! Reference bars are ${ageDays} days old (as_of ${fixture.as_of}). ` +
          `External checks compare against stale data — refresh the fixture.\n`
      );
    }
  }

  const targets = symbols.length > 0 ? symbols : fixture ? Object.keys(fixture.bars).sort() : [];
  if (targets.length === 0) {
    console.log("No symbols. Pass them as arguments or provide a fixture.");
    return 2;
  }

  console.log(`Cross-validating ${base}\n`);

  for (const symbol of targets) {
    console.log(symbol);
    let html: string;
    try {
      html = await fetchPage(symbol, base);
    } catch (err) {
      record(symbol, "fetch", "page fetch", "FAIL", String(err));
      console.log();
      continue;
    }

    checkAnalystCount(symbol, html);
    checkOpenInterest(symbol, html);
    checkTypicalMove(symbol, html);
    checkEarningsGate(symbol, html);

    const bars = fixture?.bars[symbol];
    if (bars && bars.length > 0) {
      checkSpotPrice(symbol, html, bars);
      checkAtr(symbol, html, bars);
      checkImpliedVol(symbol, html, bars);
      checkMovingAverage(symbol, html, bars);
    } else {
      record(symbol, "external", "reference bars", "SKIP", "no fixture entry");
    }
    console.log();
  }

  const fails = results.filter((r) => r.status === "FAIL");
  const warns = results.filter((r) => r.status === "WARN");
  const skips = results.filter((r) => r.status === "SKIP");
  const passes = results.length - fails.length - warns.length - skips.length;

  console.log("─".repeat(72));
  console.log(
    `${results.length} checks   ${passes} pass   ${fails.length} FAIL   ` +
      `${warns.length} warn   ${skips.length} skip`
  );

  if (fails.length > 0) {
    console.log("\nFailures:");
    for (const f of fails) {
      console.log(`  ${f.symbol.padEnd(6)} ${f.name.padEnd(34)} ${f.detail}`);
    }
  }
  if (skips.length > 0) {
    console.log(
      "\nSkipped (pattern drift — page copy likely changed; update PATTERNS " +
        "rather than ignoring):"
    );
    for (const s of skips) console.log(`  ${s.symbol.padEnd(6)} ${s.name}`);
  }

  return fails.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  }
);
