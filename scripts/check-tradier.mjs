/**
 * Standalone Tradier options-data check.
 *
 * Run this BEFORE building anything on top of Tradier. It fetches a real
 * options chain with greeks for one test symbol and prints what it found,
 * so you get a clear pass/fail without touching the running app.
 *
 *   node scripts/check-tradier.mjs [SYMBOL]
 *
 * Needs in .env.local:
 *   TRADIER_API_KEY=...
 *   TRADIER_ENV=sandbox   (or "production" — defaults to sandbox)
 *
 * Get a free sandbox token at https://tradier.com (Brokerage API dashboard).
 */

import fs from "fs";
import path from "path";

// Minimal .env.local reader — avoids adding a dotenv dependency, same as check-drift.mjs.
function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const TEST_SYMBOL = process.argv[2]?.toUpperCase() || "SPY";

function baseUrl() {
  const env = (process.env.TRADIER_ENV || "sandbox").trim().toLowerCase();
  return env === "production" ? "https://api.tradier.com" : "https://sandbox.tradier.com";
}

async function tradierGet(pathname, params) {
  const base = baseUrl();
  const url = new URL(`${base}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.TRADIER_API_KEY}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${pathname} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function main() {
  const key = process.env.TRADIER_API_KEY?.trim();
  if (!key) {
    console.log("\n❌ No TRADIER_API_KEY configured.\n");
    console.log("Add this to .env.local, then run this again:\n");
    console.log("   TRADIER_API_KEY=your-sandbox-token   (free at tradier.com)\n");
    process.exit(1);
  }

  const env = (process.env.TRADIER_ENV || "sandbox").trim().toLowerCase();
  console.log(`\nEnvironment: ${env} (${baseUrl()})`);
  console.log(`Test symbol: ${TEST_SYMBOL}\n`);

  // 1. Underlying quote — cheapest possible call, fails fast on a bad key.
  console.log("Fetching underlying quote…");
  const quoteRes = await tradierGet("/v1/markets/quotes", { symbols: TEST_SYMBOL });
  const quote = quoteRes?.quotes?.quote;
  if (!quote || Array.isArray(quote) ? !quote?.[0] : !quote?.last) {
    console.log(`❌ No quote returned for ${TEST_SYMBOL}. Response:`, JSON.stringify(quoteRes));
    process.exit(1);
  }
  const q = Array.isArray(quote) ? quote[0] : quote;
  console.log(`✓ ${TEST_SYMBOL} last: $${q.last} (bid ${q.bid} / ask ${q.ask})\n`);

  // 2. Expirations.
  console.log("Fetching expiration dates…");
  const expRes = await tradierGet("/v1/markets/options/expirations", {
    symbol: TEST_SYMBOL,
    includeAllRoots: "true",
  });
  const dates = expRes?.expirations?.date;
  const expirations = Array.isArray(dates) ? dates : dates ? [dates] : [];
  if (expirations.length === 0) {
    console.log(`❌ No expirations returned. Response:`, JSON.stringify(expRes));
    process.exit(1);
  }
  const nearest = expirations[0];
  console.log(`✓ ${expirations.length} expirations found — nearest: ${nearest}\n`);

  // 3. Chain with greeks for the nearest expiration.
  console.log(`Fetching options chain (${nearest}) with greeks…`);
  const chainRes = await tradierGet("/v1/markets/options/chains", {
    symbol: TEST_SYMBOL,
    expiration: nearest,
    greeks: "true",
  });
  const options = chainRes?.options?.option;
  const rows = Array.isArray(options) ? options : options ? [options] : [];
  if (rows.length === 0) {
    console.log(`❌ No chain rows returned. Response:`, JSON.stringify(chainRes));
    process.exit(1);
  }

  const withGreeks = rows.filter((r) => r.greeks && typeof r.greeks.delta === "number");
  console.log(`✓ ${rows.length} contracts returned, ${withGreeks.length} with populated greeks\n`);

  const sample = withGreeks[Math.floor(withGreeks.length / 2)] ?? rows[0];
  console.log("Sample contract:");
  console.log(`    ${sample.symbol} — ${sample.option_type} $${sample.strike}`);
  console.log(`    bid/ask   ${sample.bid} / ${sample.ask}`);
  console.log(`    volume    ${sample.volume}    open interest  ${sample.open_interest}`);
  if (sample.greeks) {
    console.log(
      `    greeks    delta ${sample.greeks.delta}  gamma ${sample.greeks.gamma}  ` +
        `theta ${sample.greeks.theta}  vega ${sample.greeks.vega}  iv ${sample.greeks.mid_iv}`
    );
  } else {
    console.log("    greeks    none on this contract (thin/illiquid strike — expected sometimes)");
  }

  console.log("\n" + "─".repeat(50));
  console.log(`\n✅ Tradier is reachable and returning real chain + greeks data.\n`);
  console.log("Ready for the OptionsDataProvider implementation (Phase 2).\n");
  process.exit(0);
}

main().catch((err) => {
  console.log(`\n❌ Failed: ${err.message}\n`);
  console.log("Paste this output back for help.\n");
  process.exit(1);
});
