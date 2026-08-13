import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord } from "./run";
import { HoldingPeriod } from "../../src/lib/signals/hypothesis";
import { assetsPerDay, blockLengthFor, buildNullLookup, NullProbFor } from "./metrics";
import { blockBootstrapProportion } from "../../src/lib/research/overlap";
import { MIN_SAMPLE_N } from "../../src/lib/sentiment/backtestStats";

/**
 * CONJUNCTION-CELL REVALIDATION (design doc H5 / implementation step 6).
 *
 * The combination scan is a hypothesis GENERATOR: hundreds of cells, BH
 * correction across the automatic pairs, drift-adjusted nulls — but its
 * significance tests treat overlapping holding periods as independent
 * observations (a 7d cell's consecutive days share six sevenths of their
 * window), and every candidate was selected on the same data it was
 * measured on. This script is the pre-registered second hurdle:
 *
 *   1. BLOCK CORRECTION — the win rate is re-tested with the moving-block
 *      bootstrap against the exposure-weighted drift null, block length
 *      from the replay's own asset count (7d → 14 with two assets/day).
 *   2. WALK-FORWARD — occurrences split at their chronological midpoint;
 *      the edge (win rate minus that half's own exposure-weighted null)
 *      must be POSITIVE IN BOTH HALVES. One lucky stretch fails.
 *
 * SURVIVES = corrected p < 0.05 AND both halves positive. Criteria fixed
 * before running; every candidate is published either way.
 *
 * What survival MEANS is deliberately weaker than the design doc's
 * original wording ("carry more weight than any single metric"): a
 * survivor of in-sample correction still carries the selection bias of
 * having been found by scanning this same history. Survivors therefore
 * become REGISTERED FORWARD HYPOTHESES — named, frozen, and scored
 * against the daily ledger as genuinely out-of-sample days accrue — and
 * earn engine weight only when that forward record supports it. That is
 * the roadmap's validation-factory gate applied to the platform's own
 * best cells, not just to new signals.
 *
 * Run after `npm run backtest`: npx tsx scripts/backtest/conjunctionRevalidation.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const RESEARCH_PATH = path.join(__dirname, "..", "..", "src", "data", "backtestResearch.json");
/**
 * The COMMITTED registry of survivors. Append-only and frozen: an entry's
 * `registeredAt` and `frozenInSample` stats are never edited after
 * registration, because the registration date is what makes every later
 * replay day genuinely out-of-sample for that hypothesis. Re-running this
 * script re-tests the CURRENT scan's candidates and registers any NEW
 * survivor; existing entries are left untouched and their forward record
 * (occurrences after registeredAt) is reported below.
 */
const REGISTRY_PATH = path.join(__dirname, "forwardHypotheses.json");

interface ForwardHypothesis {
  metricIds: string[];
  holdingPeriod: HoldingPeriod;
  registeredAt: number;
  registeredAtIso: string;
  frozenInSample: { n: number; winRatePct: number; nullRatePct: number; blockP: number };
}

const HP_FIELD: Record<HoldingPeriod, keyof DayRecord> = {
  "1h": "forwardReturn1h",
  "4h": "forwardReturn4h",
  "24h": "forwardReturn1d",
  "7d": "forwardReturn7d",
};

interface ResearchCombo {
  label: string;
  metricIds: string[];
  holdingPeriod: HoldingPeriod;
  isNamed: boolean;
  stat: { n: number; winRate: number | null; significance: { significant: boolean; pValue: number; nullWinRate?: number } | null };
  fdr?: { significant: boolean };
}

interface HalfResult {
  n: number;
  winRate: number;
  nullWinRate: number;
  edgePP: number;
}

function halfOf(rows: Array<{ win: number; nullP: number }>): HalfResult {
  const wins = rows.reduce((s, r) => s + r.win, 0);
  const nullBar = rows.reduce((s, r) => s + r.nullP, 0) / rows.length;
  return {
    n: rows.length,
    winRate: wins / rows.length,
    nullWinRate: nullBar,
    edgePP: (wins / rows.length - nullBar) * 100,
  };
}

function main() {
  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8")).sort(
    (a: DayRecord, b: DayRecord) => a.t - b.t
  );
  const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, "utf8")) as { metricCombinations: ResearchCombo[] };
  const perDay = assetsPerDay(records);

  /*
   * Candidate rule, fixed a priori: automatic pairs must be significant
   * under BOTH the drift-adjusted test and the scan's own BH correction;
   * named (pre-registered) combos need only the drift-adjusted test, since
   * they were never part of a scan to correct for.
   */
  const candidates = research.metricCombinations.filter((c) => {
    const raw = c.stat.significance?.significant === true;
    return c.isNamed ? raw : raw && c.fdr?.significant === true;
  });

  const nullLookups = new Map<HoldingPeriod, NullProbFor>();
  for (const hp of ["1h", "4h", "24h", "7d"] as const) {
    nullLookups.set(hp, buildNullLookup(records, (r) => r[HP_FIELD[hp]] as number | null));
  }

  const lines: string[] = [];
  const say = (l = "") => {
    lines.push(l);
    console.log(l);
  };

  say("# Conjunction revalidation — block correction + walk-forward (H5)");
  say("");
  say(
    "Second hurdle for every conjunction cell the scan flagged significant (drift-adjusted, and " +
      "BH-corrected for automatic pairs). SURVIVES requires the block-bootstrapped p against the " +
      "exposure-weighted drift null to stay under 0.05 AND a positive edge in both chronological " +
      "halves. Criteria fixed before running. Survivors become registered FORWARD hypotheses scored " +
      "against the daily ledger — not immediate engine weight; in-sample survivors still carry the " +
      "selection bias of having been found in this same history."
  );
  say("");
  say("| Conjunction | HP | N | Win | Null | Scan p | Block p | H1 edge (n) | H2 edge (n) | Verdict |");
  say("|---|---|---|---|---|---|---|---|---|---|");

  const survivors: string[] = [];

  for (const c of candidates.sort((a, b) => (b.stat.winRate ?? 0) - (a.stat.winRate ?? 0))) {
    const field = HP_FIELD[c.holdingPeriod];
    const nullFor = nullLookups.get(c.holdingPeriod)!;

    const rows = records
      .filter(
        (r) =>
          r[field] !== null && c.metricIds.every((id) => r.metrics.find((m) => m.id === id)?.verdict === "bullish")
      )
      .map((r) => {
        const ret = r[field] as number;
        return {
          win: ret > 0 ? 1 : 0,
          nullP: nullFor({ t: r.t, verdict: "bullish", forwardReturnPct: ret, asset: r.asset }),
        };
      });

    if (rows.length < MIN_SAMPLE_N) continue;

    const nullBar = rows.reduce((s, r) => s + r.nullP, 0) / rows.length;
    const corrected = blockBootstrapProportion(
      rows.map((r) => r.win),
      blockLengthFor(c.holdingPeriod, perDay),
      nullBar
    )!;

    const mid = Math.floor(rows.length / 2);
    const h1 = halfOf(rows.slice(0, mid));
    const h2 = halfOf(rows.slice(mid));

    const survives = corrected.pValue < 0.05 && h1.edgePP > 0 && h2.edgePP > 0;
    if (survives) survivors.push(`${c.metricIds.join("+")} @ ${c.holdingPeriod}`);

    say(
      `| ${c.metricIds.join("+")}${c.isNamed ? " (named)" : ""} | ${c.holdingPeriod} | ${rows.length} | ` +
        `${(100 * corrected.point).toFixed(1)}% | ${(100 * nullBar).toFixed(1)}% | ` +
        `${c.stat.significance!.pValue.toFixed(4)} | ${corrected.pValue.toFixed(4)} | ` +
        `${h1.edgePP >= 0 ? "+" : ""}${h1.edgePP.toFixed(1)}pp (${h1.n}) | ` +
        `${h2.edgePP >= 0 ? "+" : ""}${h2.edgePP.toFixed(1)}pp (${h2.n}) | ` +
        `${survives ? "**SURVIVES**" : "fails"} |`
    );
  }

  /*
   * REGISTRY: append new survivors, never touch existing entries, then
   * score every registered hypothesis on its post-registration days only.
   */
  const registry: ForwardHypothesis[] = fs.existsSync(REGISTRY_PATH)
    ? JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"))
    : [];
  const keyOf = (ids: string[], hp: string) => `${[...ids].sort().join("+")}@${hp}`;
  const known = new Set(registry.map((h) => keyOf(h.metricIds, h.holdingPeriod)));
  let added = 0;
  for (const c of candidates) {
    const field = HP_FIELD[c.holdingPeriod];
    const nullFor = nullLookups.get(c.holdingPeriod)!;
    const rows = records
      .filter((r) => r[field] !== null && c.metricIds.every((id) => r.metrics.find((m) => m.id === id)?.verdict === "bullish"))
      .map((r) => ({ win: (r[field] as number) > 0 ? 1 : 0, nullP: nullFor({ t: r.t, verdict: "bullish", forwardReturnPct: r[field] as number, asset: r.asset }) }));
    if (rows.length < MIN_SAMPLE_N) continue;
    const nullBar = rows.reduce((s2, r) => s2 + r.nullP, 0) / rows.length;
    const corrected = blockBootstrapProportion(rows.map((r) => r.win), blockLengthFor(c.holdingPeriod, perDay), nullBar)!;
    const mid = Math.floor(rows.length / 2);
    const h1 = halfOf(rows.slice(0, mid));
    const h2 = halfOf(rows.slice(mid));
    const survives = corrected.pValue < 0.05 && h1.edgePP > 0 && h2.edgePP > 0;
    if (!survives || known.has(keyOf(c.metricIds, c.holdingPeriod))) continue;
    registry.push({
      metricIds: c.metricIds,
      holdingPeriod: c.holdingPeriod,
      registeredAt: Date.now(),
      registeredAtIso: new Date().toISOString(),
      frozenInSample: {
        n: rows.length,
        winRatePct: 100 * corrected.point,
        nullRatePct: 100 * nullBar,
        blockP: corrected.pValue,
      },
    });
    known.add(keyOf(c.metricIds, c.holdingPeriod));
    added++;
  }
  if (added > 0) fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));

  say("");
  say("## Forward record — out-of-sample days since registration");
  say("");
  say(
    "Each registered hypothesis scored ONLY on replay days after its registration timestamp. " +
      "This is the number that eventually earns (or denies) engine weight; the frozen in-sample " +
      "stats above never update."
  );
  say("");
  say("| Hypothesis | Registered | OOS n | OOS win | OOS null | OOS edge |");
  say("|---|---|---|---|---|---|");
  for (const h of registry) {
    const field = HP_FIELD[h.holdingPeriod];
    const nullFor = nullLookups.get(h.holdingPeriod)!;
    const rows = records
      .filter(
        (r) =>
          r.t > h.registeredAt &&
          r[field] !== null &&
          h.metricIds.every((id) => r.metrics.find((m) => m.id === id)?.verdict === "bullish")
      )
      .map((r) => ({ win: (r[field] as number) > 0 ? 1 : 0, nullP: nullFor({ t: r.t, verdict: "bullish", forwardReturnPct: r[field] as number, asset: r.asset }) }));
    if (rows.length === 0) {
      say(`| ${h.metricIds.join("+")} @ ${h.holdingPeriod} | ${h.registeredAtIso.slice(0, 10)} | 0 | — | — | accruing |`);
      continue;
    }
    const wins = rows.reduce((s2, r) => s2 + r.win, 0);
    const nullBar = rows.reduce((s2, r) => s2 + r.nullP, 0) / rows.length;
    say(
      `| ${h.metricIds.join("+")} @ ${h.holdingPeriod} | ${h.registeredAtIso.slice(0, 10)} | ${rows.length} | ` +
        `${((100 * wins) / rows.length).toFixed(1)}% | ${(100 * nullBar).toFixed(1)}% | ` +
        `${(((wins / rows.length) - nullBar) * 100).toFixed(1)}pp |`
    );
  }

  say("");
  if (survivors.length === 0) {
    say(
      "**No conjunction cell survives both hurdles.** That is a publishable result, not a failure of " +
        "the exercise: the scan's remaining significance was living in overlapping 7d windows and " +
        "single lucky stretches, and the platform now says so instead of quoting it."
    );
  } else {
    say(`**${survivors.length} cell(s) survive:** ${survivors.map((s) => `\`${s}\``).join(", ")}.`);
    say("");
    say(
      "Next step for survivors (tracked): freeze each as a named forward hypothesis and score it " +
        "against the daily signal ledger as out-of-sample days accrue. Engine weight only after the " +
        "forward record supports it — the validation-factory gate, applied to our own best cells."
    );
  }

  const outPath = path.join(__dirname, "conjunctionRevalidation.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[conjunctions] wrote ${outPath}`);
}

main();
