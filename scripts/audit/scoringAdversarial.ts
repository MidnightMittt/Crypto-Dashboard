import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  VERDICT_HORIZON_SESSIONS,
  VerdictPrediction,
  expireUnresolvable,
  resolveVerdicts,
  summariseVerdicts,
} from "../../src/lib/research/forwardVerdict";

/**
 * ADVERSARIAL AUDIT OF THE SCORING PATH — run while the record is still
 * empty and a bug is free to find.
 *
 * One bug of this family has already shipped here: hits resolving faster
 * than misses, which published a 100% forward record. It was not exotic —
 * a timing asymmetry that looked like a result. This assumes a second one
 * exists and tries five specific ways to break the path, each stated as a
 * claim that can fail.
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname_, "..", "ingest", "data");
const RECORD = path.join(__dirname_, "..", "..", "src", "data", "forwardVerdictRecord.json");

const record = JSON.parse(fs.readFileSync(RECORD, "utf8")) as { predictions: VerdictPrediction[] };
const preds = record.predictions;

interface Bar { t: number; close: number }
const bars = new Map<string, Bar[]>();
for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.endsWith(".json"))) {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
  const symbol = raw.meta?.displaySymbol ?? f.replace(".US.json", "");
  bars.set(symbol, (raw.bars ?? []).map((b: Bar) => ({ t: b.t, close: b.close })));
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const entryCloseOf = (symbol: string, dateIso: string): number | null => {
  const b = bars.get(symbol);
  const bar = b?.find((x) => day(x.t) === dateIso);
  return bar && bar.close > 0 ? bar.close : null;
};
const closesAfter = (symbol: string, dateIso: string): Bar[] => {
  const b = bars.get(symbol);
  if (!b) return [];
  const c = Date.parse(`${dateIso}T23:59:59Z`);
  return b.filter((x) => x.t > c);
};

let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "**FAIL**"}  ${name}`);
  console.log(`        ${detail}`);
  if (!ok) failures++;
};

console.log(`record: ${preds.length} predictions, horizon ${VERDICT_HORIZON_SESSIONS}\n`);

// ── 1. The adjustment-basis drift, and whether scoring is immune to it ──
// The drift itself is EXPECTED and cannot be prevented: providers re-adjust
// history retroactively every time a dividend goes ex, so a price frozen at
// registration stops matching its own bar. What must be true is that
// resolution does not USE the frozen price.
{
  let checked = 0;
  let drifted = 0;
  let worst = 0;
  for (const p of preds) {
    const b = bars.get(p.symbol);
    const onDate = b?.find((x) => day(x.t) === p.date);
    if (!onDate) continue;
    checked++;
    const rel = Math.abs(onDate.close - p.closePrice) / p.closePrice;
    if (rel > 1e-6) {
      drifted++;
      worst = Math.max(worst, rel * 100);
    }
  }
  console.log(
    `1. BASIS DRIFT (expected, not a defect): ${drifted} of ${checked} rows have a frozen ` +
      `closePrice that no longer matches their own bar; worst ${worst.toFixed(3)}%.`
  );

  // The discriminating test: corrupt closePrice wildly and confirm the
  // resolved return does not move. If it moves, scoring still reads it.
  const sample = preds.slice(0, 200).map((p) => ({ ...p }));
  const corrupted = sample.map((p) => ({ ...p, closePrice: p.closePrice * 1.5 }));
  const a = resolveVerdicts(sample, closesAfter, entryCloseOf);
  const c = resolveVerdicts(corrupted, closesAfter, entryCloseOf);
  const moved = a.filter((x, i) => x.forwardReturnPct !== c[i].forwardReturnPct).length;
  const resolvedCount = a.filter((x) => x.forwardReturnPct !== null).length;
  /*
   * A pass here is only meaningful if something actually resolved. With
   * local bars short of the horizon nothing does, and "0 changed of 0
   * scored" is a vacuous green — the exact shape of a check that reports a
   * true fact that is not the needed one. So vacuity is reported as such,
   * and the non-vacuous proof lives in forwardVerdict.test.ts, which
   * resolves a constructed dividend case and asserts the 0.87pp difference.
   */
  if (resolvedCount === 0) {
    console.log(
      "**VACUOUS**  1b. scoring IGNORES the frozen closePrice\n" +
        "        0 of 200 resolvable on local bars, so nothing could have differed. This check\n" +
        "        proves NOTHING here — immunity is proven non-vacuously by the unit test\n" +
        "        'scores against the re-adjusted entry, not the frozen one'."
    );
  } else {
    check(
      "1b. scoring IGNORES the frozen closePrice — a 50% corruption moves no return",
      moved === 0,
      `${resolvedCount} of 200 resolved; ${moved} whose return changed when closePrice was corrupted`
    );
  }
}

// ── 2. Can a prediction be scored against a bar that predates it? ─────
{
  let violations = 0;
  let checked = 0;
  for (const p of preds.slice(0, 400)) {
    const after = closesAfter(p.symbol, p.date);
    if (after.length === 0) continue;
    checked++;
    if (Date.parse(`${day(after[0].t)}T00:00:00Z`) <= Date.parse(`${p.date}T00:00:00Z`)) violations++;
  }
  check(
    "2. every scoring bar is strictly AFTER the registration date",
    violations === 0,
    `${checked} checked, ${violations} that would score on or before their own date`
  );
}

// ── 3. Do the three cells resolve under the same rule? ────────────────
// Structural test: flip every verdict label, resolve both ways, and the
// returns must be identical. If resolution reads the label anywhere, this
// diverges.
{
  const sample = preds.slice(0, 300);
  const flipped = sample.map((p) => ({
    ...p,
    verdict: (p.verdict === "bullish" ? "bearish" : p.verdict === "bearish" ? "neutral" : "bullish") as VerdictPrediction["verdict"],
  }));
  const a = resolveVerdicts(sample, closesAfter, entryCloseOf);
  const b = resolveVerdicts(flipped, closesAfter, entryCloseOf);
  const differs = a.filter((x, i) => x.forwardReturnPct !== b[i].forwardReturnPct).length;
  check(
    "3. resolution is verdict-BLIND — relabelling changes no outcome",
    differs === 0,
    `300 sampled, ${differs} whose return changed when the label changed`
  );
}

// ── 4. Does failing to resolve correlate with the CALL? ───────────────
// The survivorship question. If bullish rows resolve at a different rate
// than bearish ones, the published record is selected rather than measured.
{
  const byVerdict = new Map<string, { total: number; resolvable: number }>();
  for (const p of preds) {
    const e = byVerdict.get(p.verdict) ?? { total: 0, resolvable: 0 };
    e.total++;
    if (closesAfter(p.symbol, p.date).length >= VERDICT_HORIZON_SESSIONS) e.resolvable++;
    byVerdict.set(p.verdict, e);
  }
  const rates = [...byVerdict.entries()].map(([v, e]) => ({
    v,
    rate: e.total ? (e.resolvable / e.total) * 100 : 0,
    ...e,
  }));
  const spread = Math.max(...rates.map((r) => r.rate)) - Math.min(...rates.map((r) => r.rate));
  check(
    "4. resolvability does not depend on the direction called",
    spread < 5,
    rates.map((r) => `${r.v} ${r.resolvable}/${r.total} (${r.rate.toFixed(1)}%)`).join("  ") +
      `  — spread ${spread.toFixed(1)}pp`
  );
}

// ── 5. Is `expired` distinct from resolved-as-wrong? ─────────────────
{
  const withExpiry = expireUnresolvable(preds, "2026-12-31");
  const expired = withExpiry.filter((p) => p.expired).length;
  const s = summariseVerdicts(withExpiry, 1);
  const leaked = expired > 0 && s.totals.resolved + s.totals.open === withExpiry.length;
  check(
    "5. expired rows count as neither resolved nor open",
    !leaked && expired > 0,
    `${expired} expired; totals resolved=${s.totals.resolved} open=${s.totals.open} of ${withExpiry.length}` +
      (leaked ? " — LEAKED into the counts" : " — correctly excluded")
  );
  // And they must never contribute a return.
  const scored = withExpiry.filter((p) => p.expired && p.forwardReturnPct !== null).length;
  check(
    "5b. an expired row never carries a forward return",
    scored === 0,
    `${scored} expired rows carrying a return`
  );
}

// ── 6. WHEN does the 08-13 cohort actually resolve? ──────────────────
{
  const cohort = preds.filter((p) => p.date === "2026-08-13");
  const spy = bars.get("SPY") ?? [];
  const after = spy.filter((b) => b.t > Date.parse("2026-08-13T23:59:59Z"));
  const tenth = after[VERDICT_HORIZON_SESSIONS - 1];
  console.log(
    `\n6. TIMING — 08-13 cohort is ${cohort.length} predictions. SPY has ${after.length} sessions after 08-13 locally` +
      (tenth ? `; the 10th is ${day(tenth.t)}.` : `; the 10th does not exist yet locally (needs ${VERDICT_HORIZON_SESSIONS}).`)
  );
  const dist = new Map<string, number>();
  for (const p of cohort) dist.set(p.verdict, (dist.get(p.verdict) ?? 0) + 1);
  console.log(`   cohort shape: ${[...dist.entries()].map(([k, v]) => `${k} ${v}`).join(" / ")}`);
}

console.log(`\n${failures === 0 ? "No failures." : `${failures} FAILURE(S) — do not ship the record until these are explained.`}`);
