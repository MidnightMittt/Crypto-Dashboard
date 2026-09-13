/**
 * The gate that decides whether a refresh-studies run worked.
 *
 * A thin printer around judgeStamps() — the reasoning for why the check is on
 * the stamp rather than on the diff lives with the logic, in
 * src/lib/history/stampGate.ts, and is exercised by stampGate.test.ts.
 *
 * Usage:
 *   npx tsx scripts/ci/assertStampsMoved.ts --since <epoch-ms>
 *
 * Exit 0 only when every artefact in STUDY_ARTIFACTS is present, carries a
 * readable stamp, and that stamp is at or after `--since`.
 */

import path from "path";
import { fileURLToPath } from "url";
import { STUDY_ARTIFACTS } from "../../src/lib/history/studyArtifacts";
import { judgeStamps } from "../../src/lib/history/stampGate";

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");

const i = process.argv.indexOf("--since");
const since = i >= 0 ? Number(process.argv[i + 1]) : NaN;
if (!Number.isFinite(since) || since <= 0) {
  console.error("::error::assertStampsMoved needs --since <epoch-ms> naming when the run began");
  process.exit(2);
}

const now = Date.now();
console.log(`Judging ${STUDY_ARTIFACTS.length} study artefacts against a run that began`);
console.log(`${new Date(since).toISOString()} (${((now - since) / 60_000).toFixed(1)} minutes ago).\n`);

const verdicts = judgeStamps(ROOT, since);
for (const v of verdicts) {
  const name = v.artifact.repoPath.replace("src/data/", "").padEnd(28);
  if (v.fresh) console.log(`  ok    ${name} ${new Date(v.stampedAt!).toISOString().slice(0, 16)}Z`);
  else console.log(`  FAIL  ${name} ${v.reason}`);
}

const stale = verdicts.filter((v) => !v.fresh);
if (stale.length === 0) {
  console.log(`\nAll ${STUDY_ARTIFACTS.length} studies re-ran and stamped inside this run.`);
  process.exit(0);
}

console.log("");
for (const v of stale) {
  console.log(
    `::error::${v.artifact.repoPath} — ${v.reason}. Written by ${v.artifact.generator}; serves ${v.artifact.serves}`
  );
}
console.error(
  `\n${stale.length} of ${verdicts.length} study artefacts did not re-stamp. The warning above each ` +
    `failing generator names the cause; the job is red because the site is still serving the old ` +
    `numbers, which is the condition this job exists to end.`
);
process.exit(1);
