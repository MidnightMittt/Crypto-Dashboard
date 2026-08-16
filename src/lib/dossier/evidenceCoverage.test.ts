import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * THE PROVENANCE RATCHET.
 *
 * Every module on the dossier is supposed to declare where its numbers came
 * from. Most still do not, and the number below is exactly how many — pinned
 * so it can fall and cannot climb.
 *
 * ── Why a source-reading test, which is otherwise a bad idea ──────────
 *
 * The gap used to be invisible. `undeclaredEvidence()` was `available()`'s
 * DEFAULT parameter, so `grep undeclaredEvidence` returned zero hits outside
 * its own definition while eighteen call sites were shipping reads with no
 * sourcing at all. A backlog nobody can count is not a backlog — it is a
 * thing everyone assumes somebody else is doing.
 *
 * Making the argument required turned every gap into a visible call, and this
 * test turns the visible calls into a number with a direction. Runtime tests
 * cannot do this job: they would need a fully populated dossier per asset
 * class, and they would measure what the fixtures happen to exercise rather
 * than what the code actually contains.
 *
 * ── How to change the number ──────────────────────────────────────────
 *
 * Downward, by declaring provenance at a call site and deleting its
 * `undeclaredEvidence()`. Upward only with a written reason in the commit,
 * because a new module shipping without sourcing is a decision and should
 * read like one.
 */

/** Falls as provenance is declared. Raising it requires an argued commit. */
const MAX_UNDECLARED = 15;

const SRC = path.join(process.cwd(), "src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

function undeclaredSites(): { file: string; count: number }[] {
  return walk(SRC)
    .map((file) => ({
      file: path.relative(SRC, file),
      // The definition itself is a declaration, not a use.
      count: (fs.readFileSync(file, "utf8").match(/undeclaredEvidence\(\)/g) ?? []).length,
    }))
    .filter((f) => f.count > 0 && !f.file.endsWith("types.ts"));
}

describe("provenance coverage", () => {
  it("has no more undeclared modules than the pinned maximum", () => {
    const sites = undeclaredSites();
    const total = sites.reduce((s, f) => s + f.count, 0);
    // Printed on failure so the diff is legible without re-running a grep.
    expect(total, `undeclared provenance by file:\n${sites.map((f) => `  ${f.count}  ${f.file}`).join("\n")}`)
      .toBeLessThanOrEqual(MAX_UNDECLARED);
  });

  /*
   * The ratchet is worthless if the pin drifts far above the truth: a bound of
   * fifty against an actual eleven would let fourteen new gaps land unnoticed.
   * This keeps the two within a few of each other.
   */
  it("keeps the pin close to the real count, so the ratchet still bites", () => {
    const total = undeclaredSites().reduce((s, f) => s + f.count, 0);
    expect(MAX_UNDECLARED - total).toBeLessThanOrEqual(3);
  });

  /*
   * The failure this whole exercise exists to prevent. If `evidence` ever
   * regains a default, every gap goes silent again and the count above starts
   * reading zero while nothing is actually sourced.
   */
  it("keeps `evidence` a required argument on available()", () => {
    const types = fs.readFileSync(path.join(SRC, "lib/dossier/types.ts"), "utf8");
    const signature = types.slice(types.indexOf("export const available"), types.indexOf("export const available") + 400);
    expect(signature).toContain("evidence: Evidence");
    expect(signature).not.toMatch(/evidence:\s*Evidence\s*=/);
  });
});
