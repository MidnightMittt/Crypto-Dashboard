/**
 * Standalone Drift on-chain check.
 *
 * Run this BEFORE enabling Drift in the dashboard. It reads Drift's perp
 * market accounts straight from Solana and prints what it found, so you get
 * a clear pass/fail without touching the running app.
 *
 *   node scripts/check-drift.mjs
 *
 * Needs one of these in .env.local:
 *   HELIUS_API_KEY=...
 *   SOLANA_RPC_URL=https://...
 */

import fs from "fs";
import path from "path";

// Minimal .env.local reader — avoids adding a dotenv dependency.
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

const FUNDING_RATE_PRECISION = 1e9;
const BASE_PRECISION = 1e9;
const PRICE_PRECISION = 1e6;
const MARKETS = { SOL: 0, BTC: 1, ETH: 2 };

function rpcUrl() {
  if (process.env.SOLANA_RPC_URL?.trim()) return process.env.SOLANA_RPC_URL.trim();
  const helius = process.env.HELIUS_API_KEY?.trim();
  if (helius) return `https://mainnet.helius-rpc.com/?api-key=${helius}`;
  return null;
}

async function main() {
  const rpc = rpcUrl();
  if (!rpc) {
    console.log("\n❌ No RPC configured.\n");
    console.log("Add ONE of these to .env.local, then run this again:\n");
    console.log("   HELIUS_API_KEY=your-key      (get free at helius.dev)");
    console.log("   SOLANA_RPC_URL=https://...   (any Solana RPC)\n");
    process.exit(1);
  }

  console.log(`\nRPC: ${rpc.split("?")[0]}`);
  console.log("Connecting to Solana and loading Drift markets…\n");

  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { DriftClient, Wallet, initialize } = await import("@drift-labs/sdk");

  const connection = new Connection(rpc, "confirmed");

  // Sanity-check the RPC before involving the SDK, so a bad key produces a
  // clear message rather than an opaque SDK stack trace.
  try {
    const slot = await connection.getSlot();
    console.log(`✓ RPC reachable — current slot ${slot}\n`);
  } catch (err) {
    console.log(`❌ RPC unreachable: ${err.message}\n`);
    console.log("   Check that your key is valid and has mainnet access.\n");
    process.exit(1);
  }

  const sdkConfig = initialize({ env: "mainnet-beta" });
  const client = new DriftClient({
    connection,
    wallet: new Wallet(Keypair.generate()), // read-only, signs nothing
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    env: "mainnet-beta",
  });

  await client.subscribe();

  let ok = 0;
  for (const [asset, index] of Object.entries(MARKETS)) {
    const market = client.getPerpMarketAccount(index);
    if (!market) {
      console.log(`❌ ${asset}: market index ${index} not found`);
      continue;
    }

    const amm = market.amm;
    const oracleTwap = amm.historicalOracleData.lastOraclePriceTwap.toNumber() / PRICE_PRECISION;
    const longBase = amm.baseAssetAmountLong.toNumber() / BASE_PRECISION;
    const shortBase = Math.abs(amm.baseAssetAmountShort.toNumber()) / BASE_PRECISION;
    const oi = (longBase + shortBase) * oracleTwap;
    const rawFunding = amm.lastFundingRate.toNumber() / FUNDING_RATE_PRECISION;
    const fundingPct = oracleTwap ? (rawFunding / oracleTwap) * 100 : 0;
    const ratio = shortBase > 0 ? longBase / shortBase : null;

    console.log(`✓ ${asset}-PERP`);
    console.log(`    oracle price   $${oracleTwap.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    console.log(`    open interest  $${(oi / 1e6).toFixed(2)}M`);
    console.log(`    funding        ${(fundingPct * 100).toFixed(2)} bps/hr`);
    console.log(`    long/short     ${ratio ? ratio.toFixed(3) : "—"}`);
    console.log(`    longs ${longBase.toFixed(1)} / shorts ${shortBase.toFixed(1)} ${asset}`);
    console.log("");

    // Plausibility warnings — catches precision mistakes immediately.
    if (oracleTwap < 0.01 || oracleTwap > 1_000_000) {
      console.log(`    ⚠️  price looks wrong — suspect PRICE_PRECISION\n`);
    } else if (Math.abs(fundingPct) > 1) {
      console.log(`    ⚠️  funding >1%/hr is implausible — suspect precision\n`);
    } else {
      ok++;
    }
  }

  await client.unsubscribe();

  console.log("─".repeat(50));
  if (ok === Object.keys(MARKETS).length) {
    console.log(`\n✅ All ${ok} markets returned plausible values.\n`);
    console.log("Drift is ready. It will appear on the dashboard automatically");
    console.log("on the next poll — no further configuration needed.\n");
  } else {
    console.log(`\n⚠️  ${ok} of ${Object.keys(MARKETS).length} markets looked correct.`);
    console.log("Paste this output back and it can be corrected.\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.log(`\n❌ Failed: ${err.message}\n`);
  console.log(err.stack?.split("\n").slice(0, 5).join("\n"));
  console.log("\nPaste this output back for help.\n");
  process.exit(1);
});
