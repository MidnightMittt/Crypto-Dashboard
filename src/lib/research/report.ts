import { StudyResult } from "./study";
import { LedgerEntry, Ledger, findRelated } from "./ledger";

/**
 * Automatic research report generation.
 *
 * Every previous study on this project ended in a hand-written verdict, and
 * hand-written verdicts are where the overstatement crept in: the numbers
 * were correct, the prose around them was not. Generating the report from
 * the statistics removes the gap between what was measured and what was
 * claimed — there is no step at which a human phrases the conclusion.
 *
 * "Known limitations" and "Suggested next research" are derived from the
 * statistics too, not authored. A limitation an author forgets to mention
 * is precisely the one that matters.
 */

const pp = (x: number) => `${(100 * x).toFixed(1)}pp`;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** Limitations implied by the numbers. Derived, so none can be omitted by oversight. */
function deriveLimitations(result: StudyResult, entry: LedgerEntry): string[] {
  const s = result.statistics;
  const out: string[] = [];

  if (s.blockLength > 1) {
    out.push(
      `Observations overlap. ${s.n} raw observations were discounted to an effective ${s.effectiveN.toFixed(1)} using a block length of ${s.blockLength}, and to ${s.independentN} strictly non-overlapping observations. Every interval and p-value above reflects the discounted figure; the raw count is not evidence.`
    );
  }
  if (s.independentN < 100) {
    out.push(
      `Small independent sample (${s.independentN}). At this size only large effects are resolvable, so a null result should be read as "not established" rather than "not present".`
    );
  }
  if (s.walkForward.length === 0) {
    out.push("Walk-forward validation was not possible: too few independent observations to form folds. Temporal stability is therefore untested.");
  }
  if (s.outOfSampleConsistent === null) {
    out.push("In-sample/out-of-sample split was not possible at this sample size.");
  }
  if (entry.assetUniverse.length <= 2) {
    out.push(
      `Narrow asset universe (${entry.assetUniverse.join(", ")}). Results may reflect the behaviour of these specific instruments rather than a general effect, and correlated instruments contribute less independent information than their count suggests.`
    );
  }
  if (result.missingFeatures.length > 0) {
    out.push(`Ran degraded: features unavailable in some observations — ${result.missingFeatures.join(", ")}.`);
  }
  if (entry.familyCorrectedSignificant === false && s.primaryPValue < 0.05) {
    out.push(
      `Significant in isolation but NOT after correction across the ${entry.familySize} studies in the evidence ledger. Given how many questions have now been asked of this dataset, this result is within what chance would produce.`
    );
  }
  return out;
}

/** Next steps implied by whichever constraint actually bound. */
function deriveNextResearch(result: StudyResult, entry: LedgerEntry): string[] {
  const s = result.statistics;
  const out: string[] = [];

  if (s.effectiveN < result.declaration.minimumEffectiveN || s.detectableEffect > result.declaration.detectableEffectTarget) {
    const needed = Math.ceil(2 * 0.5 * (2.802 / result.declaration.detectableEffectTarget) ** 2);
    out.push(
      `Increase independent observations to roughly ${needed} before retesting — that is what the declared ${pp(result.declaration.detectableEffectTarget)} target requires. Widening the asset universe across low-correlation classes achieves this far faster than lengthening the crypto sample.`
    );
  }
  if (s.walkForward.length > 0 && !s.walkForwardConsistent) {
    out.push("Investigate why the effect changes direction across folds: a period-specific driver, or a regime the study did not condition on.");
  }
  if (s.outOfSampleConsistent === false) {
    out.push("Re-run once more out-of-sample data exists. A sign flip between in- and out-of-sample is the classic signature of an in-sample artefact.");
  }
  if (result.verdict.grade === "A" || result.verdict.grade === "B") {
    out.push("Replicate on an independent asset universe before implementing. A result that holds on one universe and not another is a property of that universe.");
  }
  if (out.length === 0) out.push("No follow-up implied by the statistics. Record the result and move on.");
  return out;
}

export function generateReport(result: StudyResult, entry: LedgerEntry, ledger: Ledger): string {
  const s = result.statistics;
  const d = result.declaration;
  const L: string[] = [];
  const say = (line = "") => L.push(line);

  say(`# Study Report — ${d.id}`);
  say("");
  say(`Generated from statistics, not authored. Grade assigned mechanically by \`gradeEvidence\`.`);
  say("");

  say("## Hypothesis");
  say("");
  say(`**Research hypothesis.** ${d.hypothesis}`);
  say("");
  say(`**Null hypothesis.** ${d.nullHypothesis}`);
  say("");
  say(`**Primary metric.** ${d.primaryMetric}`);
  if (d.secondaryMetrics.length > 0) say(`**Secondary metrics.** ${d.secondaryMetrics.join(", ")}`);
  say("");
  say(`**Declared before running:** minimum effective N ${d.minimumEffectiveN}, target detectable effect ${pp(d.detectableEffectTarget)}.`);
  say("");
  say(`**Success criteria.** ${d.successCriteria}`);
  say("");
  say(`**Failure criteria.** ${d.failureCriteria}`);
  say("");

  say("## Dataset");
  say("");
  say("| Property | Value |");
  say("|---|---|");
  say(`| Asset universe | ${entry.assetUniverse.join(", ")} |`);
  say(`| Timeframe | ${entry.timeframe} |`);
  say(`| Raw observations | ${s.n} |`);
  say(`| Overlap block length | ${s.blockLength} |`);
  say(`| **Effective N** | **${s.effectiveN.toFixed(1)}** |`);
  say(`| **Strictly independent N** | **${s.independentN}** |`);
  say(`| Dataset version | ${entry.reproducibility.datasetVersion} |`);
  say(`| Code version | ${entry.reproducibility.codeVersion} |`);
  say(`| Seed | ${entry.reproducibility.seed} |`);
  say("");

  say("## Result");
  say("");
  say("| Group | N | Success rate | 95% CI |");
  say("|---|---|---|---|");
  for (const [name, g] of Object.entries(s.groups)) {
    say(`| ${name} | ${g.n} | ${pct(g.point)} | ${pct(g.lower)}–${pct(g.upper)} |`);
  }
  say("");
  if (s.difference) {
    say(`**Difference:** ${pp(s.difference.value)} (95% CI ${pp(s.difference.lower)} to ${pp(s.difference.upper)}).`);
    say("");
  }
  say(`**Observed effect** ${pp(s.observedEffect)} against a **detectable floor** of ${pp(s.detectableEffect)}.`);
  say("");
  say(`**Overlap-corrected p-value:** ${s.primaryPValue.toFixed(4)}.`);
  if (entry.familyCorrectedSignificant !== null) {
    say("");
    say(
      `**After correction across all ${entry.familySize} studies in the ledger:** ` +
        (entry.familyCorrectedSignificant ? "still significant." : "**not** significant.")
    );
  }
  say("");

  say("## Walk-forward");
  say("");
  if (s.walkForward.length === 0) {
    say("Not evaluated — insufficient independent observations to form folds.");
  } else {
    say("| Fold | N | Success rate |");
    say("|---|---|---|");
    for (const f of s.walkForward) say(`| ${f.index} | ${f.n} | ${pct(f.successRate)} |`);
    say("");
    say(s.walkForwardConsistent ? "Folds agree in direction." : "**Folds disagree in direction** — the effect is not temporally stable.");
  }
  say("");

  say("## In-sample / out-of-sample");
  say("");
  if (!s.inSample || !s.outOfSample) {
    say("Not evaluated — insufficient independent observations to split.");
  } else {
    say(`In-sample (first 70%): ${pct(s.inSample.successRate)} on N=${s.inSample.n}.`);
    say("");
    say(`Out-of-sample (last 30%): ${pct(s.outOfSample.successRate)} on N=${s.outOfSample.n}.`);
    say("");
    say(s.outOfSampleConsistent ? "Consistent in direction." : "**Inconsistent in direction.**");
  }
  say("");

  say(`## Evidence grade: ${result.verdict.grade}`);
  say("");
  for (const r of result.verdict.reasons) say(`- ${r}`);
  say("");
  say(`**Recommendation.** ${result.verdict.recommendation}`);
  say("");

  say("## Known limitations");
  say("");
  const limitations = deriveLimitations(result, entry);
  if (limitations.length === 0) say("None implied by the statistics.");
  for (const l of limitations) say(`- ${l}`);
  say("");

  say("## Suggested next research");
  say("");
  for (const n of deriveNextResearch(result, entry)) say(`- ${n}`);
  say("");

  const related = findRelated(ledger, d).filter((e) => e.studyId !== d.id);
  if (related.length > 0) {
    say("## Prior related work in the ledger");
    say("");
    say("| Study | Grade | p | Recommendation |");
    say("|---|---|---|---|");
    for (const r of related) say(`| ${r.studyId} | ${r.grade} | ${r.primaryPValue.toFixed(4)} | ${r.recommendation.slice(0, 60)}… |`);
    say("");
  }

  return L.join("\n");
}
