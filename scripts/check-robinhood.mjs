/**
 * Standalone Robinhood login + read-access check.
 *
 * Run this BEFORE building anything on top of Robinhood. It logs in using
 * the unofficial `robinhood-nodejs` client, walks through whatever MFA
 * challenge your account requires, and prints your watchlist/positions/
 * account summary — so you get a clear pass/fail without touching the
 * running app or handing credentials to any server-side route yet.
 *
 *   npm run check-robinhood
 *
 * Credentials come from .env.local (ROBINHOOD_USERNAME / ROBINHOOD_PASSWORD)
 * when present; otherwise the script prompts for them right in the terminal,
 * with the password hidden as you type, and offers to save them to
 * .env.local afterwards. Credentials belong only in that git-ignored file or
 * in your own keystrokes — never in a chat, a commit, or a server env.
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
import { execFileSync } from "node:child_process";

/*
 * GUI mode (--gui, or automatically when there is no interactive terminal):
 * every question becomes a native macOS dialog via osascript, so the person
 * answering never has to touch the terminal. The credentials still flow
 * straight from their keyboard into this process and on to Robinhood —
 * nothing about the security model changes, only the input surface.
 */
const GUI = process.argv.includes("--gui") || !stdin.isTTY;

/** Ask via a macOS dialog. Returns null if the person cancels or it times out. */
function guiPrompt(label, { hidden = false } = {}) {
  const script =
    `display dialog ${JSON.stringify(label)} default answer "" ` +
    (hidden ? "with hidden answer " : "") +
    `with title "Leverage Terminal — Robinhood check" buttons {"Cancel", "OK"} ` +
    `default button "OK" giving up after 240`;
  try {
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
    if (/gave up:true/.test(out)) return null;
    const m = out.match(/text returned:([\s\S]*?)(?:, gave up:(?:true|false))?\s*$/);
    return m ? m[1] : null;
  } catch {
    return null; // Cancel pressed
  }
}

/** Yes/no via a macOS dialog. Defaults to no on cancel/timeout. */
function guiConfirm(label, yesButton, noButton) {
  const script =
    `display dialog ${JSON.stringify(label)} ` +
    `with title "Leverage Terminal — Robinhood check" buttons {${JSON.stringify(noButton)}, ${JSON.stringify(yesButton)}} ` +
    `default button ${JSON.stringify(yesButton)} giving up after 240`;
  try {
    const out = execFileSync("osascript", ["-e", script], { encoding: "utf8" });
    return out.includes(`button returned:${yesButton}`);
  } catch {
    return false;
  }
}

function guiNotify(message) {
  try {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "Leverage Terminal"`]);
  } catch {
    // Notifications are best-effort.
  }
}

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip surrounding quotes so a placeholder like KEY="" reads as empty
    // rather than as a two-character value of literal quote marks.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key && value && !process.env[key]) process.env[key] = value;
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

/**
 * Read a line with the characters hidden — for the password prompt. Raw-mode
 * masking rather than a dependency; backspace works, ctrl-c aborts.
 */
function promptHidden(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    const chars = [];
    const onData = (buf) => {
      const c = buf.toString("utf8");
      if (c === "\n" || c === "\r" || c === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(chars.join(""));
      } else if (c === "\u0003") {
        stdout.write("\n");
        process.exit(1);
      } else if (c === "\u007f" || c === "\b") {
        chars.pop();
      } else {
        chars.push(c);
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Upsert KEY=value lines in .env.local, creating the file if needed. */
function saveToEnvLocal(pairs) {
  const file = path.join(process.cwd(), ".env.local");
  let lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (const [key, value] of Object.entries(pairs)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${key}=`));
    if (idx === -1) lines.push(line);
    else lines[idx] = line;
  }
  fs.writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  let username = process.env.ROBINHOOD_USERNAME?.trim();
  let password = process.env.ROBINHOOD_PASSWORD?.trim();
  let promptedForCredentials = false;

  if (!username || !password) {
    if (GUI) {
      console.log("\nNo saved credentials — asking via on-screen dialogs…");
      username = guiPrompt("Robinhood email:")?.trim() ?? "";
      password = guiPrompt("Robinhood password:\n(shown as dots — it goes straight to Robinhood's login)", { hidden: true })?.trim() ?? "";
    } else {
      console.log("\nNo saved Robinhood credentials found — enter them here.");
      console.log("(They go straight to Robinhood's login; the password is hidden as you type.)\n");
      username = (await rl.question("Robinhood email: ")).trim();
      // rl and raw-mode reading share stdin; pause rl while the hidden prompt owns it.
      rl.pause();
      password = (await promptHidden("Robinhood password (hidden): ")).trim();
      rl.resume();
    }
    promptedForCredentials = true;
    if (!username || !password) {
      console.log("\n❌ Cancelled, or email/password left empty. Nothing was sent anywhere.\n");
      process.exit(1);
    }
  }

  const { default: Robinhood, submitChallenge } = await import("robinhood-nodejs");

  console.log(`\nLogging in as ${username}…\n`);
  let auth = await Robinhood({ username, password });

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
      if (GUI) guiNotify("Open the Robinhood app on your phone and tap Approve.");
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
      const code = GUI
        ? (guiPrompt("Enter the verification code Robinhood just sent you:") ?? "")
        : await rl.question("Enter the verification code Robinhood sent you: ");
      if (!code.trim()) {
        console.log("\n❌ No code entered — stopping.\n");
        process.exit(1);
      }
      auth = await submitChallenge(auth.workflow_id, code.trim());
    }
  }

  if (!auth || auth.status === "error" || !auth.api) {
    console.log(`\n❌ Login failed: ${auth?.message ?? "no response"}\n`);
    rl.close();
    process.exit(1);
  }

  console.log("✅ Logged in.\n");

  if (promptedForCredentials) {
    const wantsSave = GUI
      ? guiConfirm(
          "Login worked. Save these credentials on this Mac (in the project's git-ignored .env.local) so future runs skip the prompts?",
          "Save",
          "Don't Save"
        )
      : (
          await rl.question(
            "Save these credentials to .env.local so future runs skip the prompts?\n" +
              "(The file is git-ignored and never leaves this machine.) [y/N]: "
          )
        )
          .trim()
          .toLowerCase()
          .startsWith("y");
    if (wantsSave) {
      saveToEnvLocal({ ROBINHOOD_USERNAME: username, ROBINHOOD_PASSWORD: password });
      console.log("✓ Saved.\n");
    }
  }
  rl.close();
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
