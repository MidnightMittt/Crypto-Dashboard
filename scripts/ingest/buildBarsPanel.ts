import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { positioningUniverse } from "../../src/lib/markets/scannerUniverse";
import { alignPanel, coverage, PANEL_SESSIONS } from "../../src/lib/research/barsPanel";
import { Bar } from "../../src/lib/research/types";

/**
 * COMMITTED, MATCHED DAILY BARS for every symbol positioning is recorded on.
 *
 * The raw bar files under scripts/ingest/data are 146MB and gitignored, so
 * nothing outside this repository's CI runner can read them — which is how a
 * cross-sectional test of positioning against next-day returns ended up
 * running on the 10 symbols that happened to have bars elsewhere, with n at
 * 32/16/8 instead of the recorded universe. This emits the small artifact
 * that closes the gap: ~300 aligned sessions for the exact 105-symbol
 * positioning universe, from the same declaration the recorder reads, so the
 * two can never cover different sets.
 *
 * Bars arrive split- and dividend-adjusted from the ingest. Alignment,
 * quorum-calendar and interpolation rules live in src/lib/research/
 * barsPanel.ts, where they are tested; this file only feeds and verifies.
 *
 * Runs in the daily workflow after the bar ingest, so the panel's last
 * session is the session the job ran for. Locally it emits whatever the
 * local bar files hold — fine, tonight's run replaces it.
 *
 *   npx tsx scripts/ingest/buildBarsPanel.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "data");
const OUT = path.join(__dirname_, "..", "..", "src", "data", "barsPanel.json");

/**
 * The brief this implements sets the floor: at least 100 of the 105 symbols
 * usable at 250+ sessions, or the artifact does not ship. Below that the
 * committed panel would recreate the same silent-join problem one layer up.
 */
const MIN_SESSIONS = 250;
const MIN_QUALIFYING = 100;

function main(): void {
  const universe = positioningUniverse();

  const seriesBySymbol: Record<string, Bar[]> = {};
  const missingFiles: string[] = [];
  for (const symbol of universe) {
    const file = path.join(DATA_DIR, `${symbol}.US.json`);
    if (!fs.existsSync(file)) {
      // Visible in the output as an all-null symbol, counted against the
      // floor below — but never silently dropped from the panel's scope.
      seriesBySymbol[symbol] = [];
      missingFiles.push(symbol);
      continue;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { bars: Bar[] };
    seriesBySymbol[symbol] = raw.bars;
  }

  const panel = alignPanel(seriesBySymbol);

  const perSymbol = universe.map((s) => ({
    symbol: s,
    usable: coverage(panel.symbols[s]),
    filled: panel.symbols[s].interpolated.length,
  }));
  const qualifying = perSymbol.filter((r) => r.usable >= MIN_SESSIONS);
  const totalFilled = perSymbol.reduce((a, r) => a + r.filled, 0);

  if (qualifying.length < MIN_QUALIFYING) {
    const worst = [...perSymbol].sort((a, b) => a.usable - b.usable).slice(0, 8);
    throw new Error(
      `only ${qualifying.length}/${universe.length} symbols have >=${MIN_SESSIONS} usable sessions ` +
        `(floor: ${MIN_QUALIFYING}). ` +
        (missingFiles.length ? `No bar file at all for: ${missingFiles.join(", ")}. ` : "") +
        `Thinnest: ${worst.map((r) => `${r.symbol}:${r.usable}`).join(", ")}. ` +
        "Shipping this panel would recreate the silent-join problem it exists to close."
    );
  }

  fs.writeFileSync(OUT, JSON.stringify(panel, null, 0));

  const bytes = fs.statSync(OUT).size;
  console.log(
    `[barsPanel] ${panel.sessions.length} sessions ` +
      `(${panel.sessions[0]} .. ${panel.sessions[panel.sessions.length - 1]}) x ` +
      `${universe.length} symbols -> ${OUT} (${(bytes / 1e6).toFixed(1)}MB). ` +
      `${qualifying.length} symbols at >=${MIN_SESSIONS} sessions, ` +
      `${totalFilled} interpolated bars` +
      (missingFiles.length ? `, NO FILE for ${missingFiles.join(", ")}` : "")
  );
}

main();
