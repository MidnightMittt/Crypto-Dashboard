import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * EVERY ARTEFACT THE NIGHTLY JOB WRITES MUST ALSO BE COMMITTED.
 *
 * The daily job regenerates a dozen files and then stages an EXPLICIT list of
 * paths — deliberately, because a blanket `git add` in a repository several
 * agents work in commits whatever happened to be on disk. The cost of that
 * choice is that adding a generator and forgetting to add its output to the
 * list produces the quietest possible failure:
 *
 *   the script runs, the step is green, the file is written on the runner,
 *   the commit step does not stage it, the runner is destroyed, and
 *   production goes on serving whatever was committed months ago.
 *
 * Nothing is red. Nothing is missing. The number is just old, and it is old
 * beside a dozen numbers that are fresh, which is the worst version — a stale
 * input is far more dangerous when everything around it refreshed.
 *
 * This is not hypothetical. `src/data/marketContext.json` is written by
 * buildMarketsSnapshot.ts on every run and was last committed 2026-08-15. It
 * is imported by analyseTicker.ts, so for 26 days every ticker analysis on
 * the live site ran against a market context from 2026-08-13 while the rest
 * of the snapshot updated nightly. This test is what found it.
 *
 * ── Why it distinguishes written from read ────────────────────────────
 *
 * Some scripts READ a committed artefact as an input — forwardScoring reads
 * equityExecutionStats, buildIvRvHistory reads positioningHistory and
 * barsPanel. Those must NOT be required in the staged list on their own
 * account, or the test becomes noise and gets relaxed. So it keys on whether
 * the path is handed to `writeFileSync`.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "daily-intelligence.yml");

interface DataFile {
  script: string;
  repoPath: string;
  constName: string;
  written: boolean;
}

function workflowSource(): string {
  return fs.readFileSync(WORKFLOW, "utf8");
}

/** The paths the commit step stages, parsed from the workflow's own variable. */
function stagedPaths(yml: string): Set<string> {
  const m = yml.match(/DATA_PATHS="([^"]+)"/);
  if (!m) throw new Error("could not find DATA_PATHS in the daily workflow");
  return new Set(m[1].split(/\s+/).filter(Boolean));
}

/** Every script the workflow actually invokes. */
function invokedScripts(yml: string): string[] {
  return [...new Set([...yml.matchAll(/npx tsx (scripts\/[\w/.-]+\.ts)/g)].map((m) => m[1]))];
}

/**
 * Data files each script names, and whether it writes them.
 *
 * TWO FORMS, because the scripts use both and an incomplete parser makes the
 * assertions below weaker than they read. The single-step form is
 *
 *   const OUT = path.join(__dirname, "..", "..", "src", "data", "x.json")
 *
 * and the two-step form, which appendHistory.ts uses and which the first
 * version of this file missed entirely, is
 *
 *   const DATA = path.join(__dirname, "..", "..", "src", "data")
 *   const LEDGER_PATH = path.join(DATA, "signalLedger.json")
 *
 * Missing the second form does not fail loudly — it silently shrinks the set
 * of files considered "written", which is exactly the direction that makes a
 * staging test pass while the thing it guards is broken.
 */
function dataFilesOf(script: string): DataFile[] {
  const src = fs.readFileSync(path.join(ROOT, script), "utf8");
  const out: DataFile[] = [];
  const add = (constName: string, file: string) =>
    out.push({
      script,
      repoPath: `src/data/${file}`,
      constName,
      written: new RegExp(`writeFileSync\\(\\s*${constName}\\b`).test(src),
    });

  for (const m of src.matchAll(
    /const\s+(\w+)\s*=\s*path\.join\([^)]*?"src",\s*"data",\s*"([\w.-]+\.json)"\s*\)/g
  )) {
    add(m[1], m[2]);
  }

  // Directory constants pointing at src/data, then files joined onto them.
  const dirs = [...src.matchAll(/const\s+(\w+)\s*=\s*path\.join\([^)]*?"src",\s*"data"\s*\)/g)].map(
    (m) => m[1]
  );
  for (const dir of dirs) {
    for (const m of src.matchAll(
      new RegExp(`const\\s+(\\w+)\\s*=\\s*path\\.join\\(\\s*${dir}\\s*,\\s*"([\\w.-]+\\.json)"\\s*\\)`, "g")
    )) {
      add(m[1], m[2]);
    }
  }
  return out;
}

describe("the daily pipeline commits what it generates", () => {
  const yml = workflowSource();
  const scripts = invokedScripts(yml);
  const files = scripts.flatMap(dataFilesOf);

  it("invokes scripts that exist", () => {
    for (const s of scripts) {
      expect(fs.existsSync(path.join(ROOT, s)), `${s} is invoked but not present`).toBe(true);
    }
  });

  /*
   * THE LOAD-BEARING ONE. A generated file absent from DATA_PATHS reaches
   * nobody, and does so without a single failing check.
   */
  it("stages every data file it writes", () => {
    const staged = stagedPaths(yml);
    const unstaged = files
      .filter((f) => f.written && !staged.has(f.repoPath))
      .map((f) => `${f.repoPath} (written by ${f.script})`);
    expect(
      unstaged,
      `generated on the runner and never committed, so production keeps the old copy:\n  ${unstaged.join("\n  ")}`
    ).toEqual([]);
  });

  /*
   * The other direction. A path staged but no longer produced is a leftover
   * that makes the list look more complete than it is, and it is what a
   * reader would check to answer "is this file fresh".
   */
  it("does not stage a path nothing in the pipeline writes", () => {
    const written = new Set(files.filter((f) => f.written).map((f) => f.repoPath));
    const orphans = [...stagedPaths(yml)].filter((p) => !written.has(p));
    expect(orphans, `staged but no invoked script writes it: ${orphans.join(", ")}`).toEqual([]);
  });

  /*
   * Guards the parser rather than the pipeline. If a refactor moves the
   * scripts off the `path.join(..., "src", "data", ...)` form, the two
   * assertions above would pass vacuously by finding nothing at all — the
   * failure mode where a test keeps reporting green because it stopped
   * looking.
   */
  it("still recognises the shape the generators are written in", () => {
    expect(files.filter((f) => f.written).length).toBeGreaterThanOrEqual(12);
    const contributing = new Set(files.map((f) => f.script));
    expect(contributing.size, "no invoked script matched the data-file pattern").toBeGreaterThanOrEqual(8);
  });
});
