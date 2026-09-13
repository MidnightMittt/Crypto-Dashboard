import fs from "fs";
import path from "path";

/**
 * Reading a workflow's own promises back out of it.
 *
 * Two facts are asserted against in this repository: which scripts a job
 * actually invokes, and which paths its commit step actually stages. Both
 * tests that check those — dailyPipeline.test.ts and studyRefresh.test.ts —
 * need the same two readings, and a second copy of a regex is exactly how the
 * two would drift into disagreeing about what a workflow says.
 *
 * These parse the YAML as text on purpose. The point is to read what the
 * shell line will really run, and a YAML parse would still leave the `run:`
 * block as a string to be picked apart by hand.
 */

export const WORKFLOW_DIR = path.join(__dirname, "..", "..", "..", ".github", "workflows");

export function workflowSource(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
}

/** The paths a commit step stages, read from the job's own DATA_PATHS variable. */
export function stagedPaths(yml: string): Set<string> {
  const m = yml.match(/DATA_PATHS="([^"]+)"/);
  if (!m) throw new Error("could not find DATA_PATHS in the workflow");
  return new Set(m[1].split(/\s+/).filter(Boolean));
}

/** Every script the workflow actually invokes, deduplicated, in first-seen order. */
export function invokedScripts(yml: string): string[] {
  return [...new Set([...yml.matchAll(/npx tsx (scripts\/[\w/.-]+\.ts)/g)].map((m) => m[1]))];
}
