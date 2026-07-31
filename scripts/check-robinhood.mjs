/**
 * Standalone Robinhood login + read-access check.
 *
 * Run this BEFORE building anything on top of Robinhood. It logs in using
 * the unofficial `robinhood-nodejs` client, walks through whatever MFA
 * challenge your account requires, and prints your watchlist/positions/
 * account summary — so you get a clear pass/fail without touching the
 * running app or handing credentials to any server-side route yet.
 *
 *   node scripts/check-robinhood.mjs
 *
 * Needs in .env.local:
 *   ROBINHOOD_USERNAME=...
 *   ROBINHOOD_PASSWORD=...
 *
 * ── READ THIS BEFORE RUNNING ─────────────────────────────────────────────
 *
 * robinhood-nodejs is an UNOFFICIAL, reverse-engineered client. Using it
 * violates Robinhood's Terms of Service. That risk was accepted knowingly
 * when this integration was scoped — see the phased plan.
 *
 * Reading its source (src/auth.js) turned up something worth knowing before
 * you rely on this: the library only correctly implements TWO challenge
 * paths —
 *   - an SMS code, submitted via /challenge/{id}/respond/
 *   - a device-approval PUSH, polled via /push/{id}/get_prompts_status/
 *       (this requires tapping "approve" in the Robinhood mobile app —
 *       it cannot be automated, by design, on Robinhood's end)
 *
 * There is no third path for an authenticator-app (TOTP) CODE distinct from
 * SMS. If your account's 2FA is set to an authenticator app, this script
 * will very likely misclassify the challenge as a device-approval push and
 * sit there waiting for a phone tap that has nothing to approve. This
 * script prints Robinhood's ACTUAL challenge type/message as soon as it
 * receives one, specifically so that failure mode is diagnosable instead of
 * a silent hang. If that happens, the answer is either: switch your
 * account's 2FA to SMS, or treat this integration as unreliable and use the
 * manual-entry AccountProvider instead (see lib/options/types.ts).
 */

import fs from "fs";
import path from "path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

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

// How long to wait for a device-approval push before giving up rather than
// hanging forever on something that (per the note above) may never resolve.
const DEVICE_APPROVAL_TIMEOUT_MS = 90_000;

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const username = process.env.ROBINHOOD_USERNAME?.trim();
  const password = process.env.ROBINHOOD_PASSWORD?.trim();

  if (!username || !password) {
    console.log("\n❌ ROBINHOOD_USERNAME and/or ROBINHOOD_PASSWORD not set.\n");
    console.log("Add both to .env.local, then run this again.\n");
    process.exit(1);
  }

  const { default: Robinhood, submitChallenge } = await import("robinhood-nodejs");

  console.log(`\nLogging in as ${username}…\n`);
  let auth = await Robinhood({ username, password });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (auth?.status === "awaiting_input") {
    console.log(`⚠️  Robinhood requested additional verification.`);
    console.log(`    Message from Robinhood: "${auth.message}"`);
    console.log(`    Detected type: ${auth.authType}\n`);

    if (auth.authType === "device_confirmation") {
      console.log(
        "This will poll for a push approval in the Robinhood mobile app. If your\n" +
          "2FA is actually an authenticator-app CODE (not a push notification),\n" +
          "this will time out — that's the exact gap described at the top of this\n" +
          "script, not a bug in your credentials.\n"
      );
      console.log(`Waiting up to ${DEVICE_APPROVAL_TIMEOUT_MS / 1000}s for approval…`);
      try {
        auth = await withTimeout(
          submitChallenge(auth.workflow_id, null),
          DEVICE_APPROVAL_TIMEOUT_MS,
          "Device approval"
        );
      } catch (err) {
        console.log(`\n❌ ${err.message}\n`);
        console.log("This is the known limitation, not necessarily a dead end — see the");
        console.log("note at the top of this script for what to try next.\n");
        rl.close();
        process.exit(1);
      }
    } else {
      const code = await rl.question("Enter the verification code Robinhood sent you: ");
      auth = await submitChallenge(auth.workflow_id, code.trim());
    }
  }

  rl.close();

  if (!auth || auth.status === "error" || !auth.api) {
    console.log(`\n❌ Login failed: ${auth?.message ?? "no response"}\n`);
    process.exit(1);
  }

  console.log("✅ Logged in.\n");
  console.log(
    "Save this access token to skip interactive login next time (expires per Robinhood's\n" +
      "session policy — re-run this script fresh when it does):\n"
  );
  console.log(`   ROBINHOOD_SESSION_TOKEN=${auth.tokenData.access_token}\n`);

  const api = auth.api;

  console.log("Fetching watchlists…");
  const watchlists = await api.watchlists().catch((err) => {
    console.log(`❌ watchlists() failed: ${err.message}`);
    return null;
  });
  const watchlistCount = watchlists?.results?.length ?? 0;
  console.log(`✓ ${watchlistCount} watchlist(s)\n`);

  console.log("Fetching positions…");
  const positions = await api.nonzero_positions().catch((err) => {
    console.log(`❌ nonzero_positions() failed: ${err.message}`);
    return null;
  });
  console.log(`✓ ${positions?.results?.length ?? 0} open equity position(s)\n`);

  console.log("Fetching options positions…");
  const optionsPositions = await api.options_positions().catch((err) => {
    console.log(`❌ options_positions() failed: ${err.message}`);
    return null;
  });
  console.log(`✓ ${optionsPositions?.results?.length ?? 0} options position(s)\n`);

  console.log("Fetching account summary…");
  const accounts = await api.accounts().catch((err) => {
    console.log(`❌ accounts() failed: ${err.message}`);
    return null;
  });
  const account = accounts?.results?.[0];
  if (account) {
    console.log(`✓ buying power   $${account.buying_power ?? account.cash ?? "—"}`);
    console.log(`✓ portfolio cash $${account.portfolio_cash ?? "—"}\n`);
  } else {
    console.log("❌ No account data returned.\n");
  }

  console.log("─".repeat(50));
  console.log("\n✅ Read access confirmed. Raw response shapes above are Robinhood's own");
  console.log("   (undocumented) field names — Phase 1's AccountProvider maps these onto");
  console.log("   this app's own AccountSnapshot type rather than exposing them directly.\n");
  process.exit(0);
}

main().catch((err) => {
  console.log(`\n❌ Failed: ${err.message}\n`);
  console.log(err.stack?.split("\n").slice(0, 5).join("\n"));
  console.log("\nPaste this output back for help.\n");
  process.exit(1);
});
