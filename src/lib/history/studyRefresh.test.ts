import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { BLOCKED_ON_BACKTEST_CORPUS, STUDY_ARTIFACTS, studyGenerators } from "./studyArtifacts";
import { invokedScripts, stagedPaths, workflowSource } from "./workflowParse";

/**
 * THE WEEKLY STUDY JOB DOES WHAT THE MANIFEST SAYS IT DOES.
 *
 * dailyPipeline.test.ts guards the nightly job against writing a file it
 * never commits. This guards the weekly job against a second failure the
 * nightly one cannot have: not invoking the generator at all. Both end the
 * same way — a stale number sitting beside fresh ones, with nothing red.
 *
 * Three things have to agree, and the point of the manifest is that only one
 * of them is authored by hand:
 *
 *   src/lib/history/studyArtifacts.ts   what should be refreshed  (the truth)
 *   the workflow's study steps          what actually runs
 *   the workflow's DATA_PATHS           what actually gets committed
 *
 * So every assertion below reads the workflow and checks it against the
 * manifest, in both directions.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const WORKFLOW = "refresh-studies.yml";

describe("the weekly study refresh", () => {
  const yml = workflowSource(WORKFLOW);
  const invoked = invokedScripts(yml);
  const staged = stagedPaths(yml);

  it("invokes every generator the manifest declares", () => {
    const missing = studyGenerators().filter((g) => !invoked.includes(g));
    expect(missing, `declared in the manifest but never run by the job: ${missing.join(", ")}`).toEqual([]);
  });

  it("invokes scripts that exist", () => {
    for (const s of invoked) {
      expect(fs.existsSync(path.join(ROOT, s)), `${s} is invoked but not present`).toBe(true);
    }
  });

  /*
   * THE LOAD-BEARING ONE, and the same one as in the daily job. A file
   * regenerated on the runner and left off DATA_PATHS is destroyed with the
   * runner while production keeps serving the old copy — green all the way.
   */
  it("stages every artefact the manifest declares", () => {
    const unstaged = STUDY_ARTIFACTS.filter((a) => !staged.has(a.repoPath)).map(
      (a) => `${a.repoPath} (written by ${a.generator})`
    );
    expect(unstaged, `refreshed on the runner and never committed:\n  ${unstaged.join("\n  ")}`).toEqual([]);
  });

  it("does not stage a path the manifest does not claim", () => {
    const declared = new Set(STUDY_ARTIFACTS.map((a) => a.repoPath));
    const orphans = [...staged].filter((p) => !declared.has(p));
    expect(orphans, `staged but not a declared study output: ${orphans.join(", ")}`).toEqual([]);
  });

  /*
   * The manifest could name a generator that no longer writes the file, and
   * every assertion above would still pass — the job would run, the path
   * would be staged, and the diff would be empty forever. So check the claim
   * at its source.
   */
  it("names generators that really write what they are credited with", () => {
    for (const a of STUDY_ARTIFACTS) {
      const src = fs.readFileSync(path.join(ROOT, a.generator), "utf8");
      const file = a.repoPath.replace("src/data/", "");
      const declaresPath = new RegExp(`"${file.replace(".", "\\.")}"`).test(src);
      expect(declaresPath, `${a.generator} does not mention ${file}`).toBe(true);
      expect(/writeFileSync\(/.test(src), `${a.generator} writes nothing`).toBe(true);
    }
  });

  /*
   * Two jobs staging the same path would race: whichever pushes second
   * rebases onto the other and re-commits a file the other just wrote. The
   * nightly job's own comment records that overnightPremium.json was removed
   * from its list for a version of this reason, and nothing has stopped it
   * being added back.
   */
  it("shares no staged path with the nightly job", () => {
    const nightly = stagedPaths(workflowSource("daily-intelligence.yml"));
    const both = [...staged].filter((p) => nightly.has(p));
    expect(both, `staged by both workflows, which will race: ${both.join(", ")}`).toEqual([]);
  });

  /*
   * Soft per step is a deliberate choice, not an accident, and it is only
   * safe because the gate is hard. If someone removes the gate, the job
   * becomes incapable of failing.
   */
  it("lets each study warn rather than fail, and then gates on the stamps", () => {
    for (const g of studyGenerators()) {
      const line = yml.split("\n").find((l) => l.includes(g));
      expect(line, `${g} is not invoked on any line`).toBeDefined();
      expect(line, `${g} must soft-fail so one study cannot cost the others their run`).toContain(
        '|| echo "::warning::'
      );
    }
    expect(yml).toContain("scripts/ci/assertStampsMoved.ts --since");
  });

  /*
   * The ingest is the exception and must stay one. Without the bar files
   * every study either crashes or, worse, quietly measures whatever partial
   * universe did download — and a soft failure would let that through.
   */
  it("fails hard when the bars do not arrive", () => {
    const line = yml.split("\n").find((l) => l.includes("scripts/ingest/yahoo.ts"));
    expect(line).toBeDefined();
    expect(line).not.toContain("||");
  });

  /*
   * The refusal has to stay a decision. If the backtest corpus ever becomes
   * buildable here, these files should move into STUDY_ARTIFACTS — and until
   * then they must not be silently staged by a job that cannot produce them,
   * which would gate on a stamp that can never move.
   */
  it("keeps the corpus-blocked artefacts out of the job that cannot rebuild them", () => {
    const declared = new Set(STUDY_ARTIFACTS.map((a) => a.repoPath));
    for (const b of BLOCKED_ON_BACKTEST_CORPUS) {
      expect(staged.has(b.repoPath), `${b.repoPath} is staged but nothing here writes it`).toBe(false);
      expect(declared.has(b.repoPath), `${b.repoPath} is in two lists at once`).toBe(false);
      expect(invoked).not.toContain(b.generator);
    }
  });

  /*
   * Guards the parser, not the pipeline. If the workflow is rewritten into a
   * shape these regexes miss, the assertions above pass by finding nothing —
   * the failure where a test keeps reporting green because it stopped
   * looking.
   */
  it("still recognises the shape the workflow is written in", () => {
    expect(STUDY_ARTIFACTS.length).toBeGreaterThanOrEqual(5);
    expect(invoked.length).toBeGreaterThanOrEqual(studyGenerators().length + 1); // + the ingest
    expect(staged.size).toBe(STUDY_ARTIFACTS.length);
  });

  it("runs on its own clock, clear of the nightly job", () => {
    expect(yml).toMatch(/cron: "30 6 \* \* 6"/);
    expect(yml).toContain("workflow_dispatch");
    expect(yml).toContain("group: refresh-studies");
  });
});

describe("the manifest itself", () => {
  it("says what each artefact serves, so a stale one has a named consequence", () => {
    for (const a of STUDY_ARTIFACTS) {
      expect(a.repoPath.startsWith("src/data/")).toBe(true);
      expect(a.serves.length, `${a.repoPath} has no stated consumer`).toBeGreaterThan(30);
    }
  });

  it("declares no artefact twice", () => {
    const paths = STUDY_ARTIFACTS.map((a) => a.repoPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("points at files that exist in the repository", () => {
    for (const a of [...STUDY_ARTIFACTS, ...BLOCKED_ON_BACKTEST_CORPUS]) {
      expect(fs.existsSync(path.join(ROOT, a.repoPath)), `${a.repoPath} is missing`).toBe(true);
    }
  });
});
