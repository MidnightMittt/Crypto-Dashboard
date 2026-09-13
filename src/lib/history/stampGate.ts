import fs from "fs";
import path from "path";
import { STUDY_ARTIFACTS, StudyArtifact } from "./studyArtifacts";

/**
 * DID THE STUDIES ACTUALLY RE-RUN?
 *
 * The weekly study job runs each study with `|| echo "::warning::"` behind
 * it, so one broken grid cannot cost the other three their weekly run. The
 * cost of that choice is that the job's exit code stops meaning anything:
 * every step can warn, the commit step can find no diff and exit 0 with a
 * friendly message, and the run is green with five month-old files still on
 * the site.
 *
 * So the run is judged on the only claim it makes — each declared artefact
 * carries a `generatedAt` from inside the run window.
 *
 * ── Why "stamped in the window" and not "the bytes changed" ───────────
 *
 * Both directions of a diff check are wrong on their own. A study re-run on
 * an unchanged corpus legitimately writes byte-identical output, so a diff
 * would call a correct run a failure — and the fix applied to a check that
 * fails spuriously is always to weaken it. Meanwhile a file can change for
 * reasons unrelated to the study, so a diff is not evidence the generator
 * ran either.
 *
 * This is the 2026-08-21 lesson as code: a check has to discriminate the
 * thing you changed. That earlier verification polled for a field present in
 * BOTH the old and new builds, so it matched instantly against the old one
 * and reported success before the new build existed. `since` is what makes
 * this one unable to do that — the old stamp cannot satisfy it, whatever
 * else is true of the file.
 */

export type StampReading = { ms: number } | { error: string };

/**
 * The stamp, or a reason there isn't one.
 *
 * Epoch milliseconds is what every generator in the manifest writes. An ISO
 * string is accepted because it is the other convention in this repository,
 * and anything else is an ERROR rather than a skip: a gate that treats an
 * unreadable stamp as "fine" is worse than no gate, because it reports
 * success for the exact file it failed to inspect.
 */
export function readStamp(abs: string): StampReading {
  if (!fs.existsSync(abs)) return { error: "file does not exist" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    return { error: `unreadable JSON: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "top level is not an object, so it cannot carry a stamp" };
  }
  const raw = (parsed as { generatedAt?: unknown }).generatedAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return { ms: raw };
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return { ms };
    return { error: `generatedAt is an unparseable string: ${raw}` };
  }
  return { error: "no generatedAt field" };
}

export interface StampVerdict {
  artifact: StudyArtifact;
  /** Null when the file could not be read or carried no usable stamp. */
  stampedAt: number | null;
  fresh: boolean;
  /** Why it failed, in the words the log should carry. Empty when fresh. */
  reason: string;
}

/**
 * Judge every declared artefact against the instant the run began.
 *
 * Pure over (root, since, manifest) so the failing cases can be exercised
 * without a workflow: the CLI is a printer around this.
 */
export function judgeStamps(
  root: string,
  since: number,
  artifacts: readonly StudyArtifact[] = STUDY_ARTIFACTS
): StampVerdict[] {
  return artifacts.map((artifact) => {
    const got = readStamp(path.join(root, artifact.repoPath));
    if ("error" in got) {
      return { artifact, stampedAt: null, fresh: false, reason: got.error };
    }
    if (got.ms < since) {
      const age = ((since - got.ms) / 86_400_000).toFixed(1);
      return {
        artifact,
        stampedAt: got.ms,
        fresh: false,
        reason: `stamp ${new Date(got.ms).toISOString().slice(0, 16)}Z predates the run by ${age} days`,
      };
    }
    return { artifact, stampedAt: got.ms, fresh: true, reason: "" };
  });
}
