import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { LabSeries } from "../../src/lib/research/signalLab";
import { EQUITY_PANEL, isPanelMember, unclassified } from "../../src/lib/markets/equityPanel";

/**
 * Loads the DECLARED equity panel from the daily ingest.
 *
 * One loader, because the lab and the cross-section builder previously each
 * had their own — both of which read the whole directory. Two copies of
 * "which instruments are the panel" is two answers waiting to diverge, and
 * the cross-section is the artifact that has to agree with the study it
 * quotes.
 *
 *   `scripts/ingest/data` is the refresh SCOPE, not the panel.
 *   `EQUITY_PANEL` is the panel. See src/lib/markets/equityPanel.ts.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");

/** Below this many bars an instrument cannot support a 12-month lookback plus a hold. */
const MIN_BARS = 300;

export interface PanelLoad {
  series: LabSeries[];
  /** Declared members with no usable file, so a shrinking panel is visible. */
  missing: string[];
  /** Declared members present but too short to rank. */
  tooShort: string[];
  /** Files skipped because they are funds or non-equities. */
  skipped: number;
}

export function loadEquityPanel(): PanelLoad {
  const files = fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"));
  const symbolOf = (f: string) => f.split(".")[0];

  /*
   * FAIL LOUDLY ON THE UNKNOWN. A newly ingested instrument is a decision
   * someone has to make, and defaulting either way hides it — see
   * `unclassified` for why both defaults are wrong. This is the ingest
   * validator's "no silent repairs" rule applied to composition rather than
   * to values.
   */
  const unknown = unclassified(files.map(symbolOf));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} instrument(s) in the ingest are not classified as panel member, ` +
        `fund, non-equity or tracked-outside-panel: ${unknown.join(", ")}. Add each to ` +
        `src/lib/markets/equityPanel.ts before running research over this directory — ` +
        `the panel is a claim and it has to stay one.`
    );
  }

  const series: LabSeries[] = [];
  const tooShort: string[] = [];
  const found = new Set<string>();
  let skipped = 0;

  for (const f of files) {
    const symbol = symbolOf(f);
    if (!isPanelMember(symbol)) {
      skipped++;
      continue;
    }
    found.add(symbol);

    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as {
      bars?: Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }>;
    };
    const bars = (raw.bars ?? []).filter((b) => Number.isFinite(b.close) && b.close > 0);
    if (bars.length < MIN_BARS) {
      tooShort.push(symbol);
      continue;
    }
    series.push({
      symbol,
      t: bars.map((b) => b.t),
      close: bars.map((b) => b.close),
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      volume: bars.map((b) => b.volume),
    });
  }

  return {
    series,
    missing: EQUITY_PANEL.filter((s) => !found.has(s)),
    tooShort,
    skipped,
  };
}

/** One line, printed by every consumer, so the composition is never implicit. */
export function describeLoad(load: PanelLoad): string {
  const parts = [
    `${load.series.length} of ${EQUITY_PANEL.length} declared companies`,
    `${load.skipped} funds and non-equities excluded by kind`,
  ];
  if (load.missing.length) parts.push(`MISSING FILES: ${load.missing.join(", ")}`);
  if (load.tooShort.length) parts.push(`too short: ${load.tooShort.join(", ")}`);
  return parts.join(" · ");
}
