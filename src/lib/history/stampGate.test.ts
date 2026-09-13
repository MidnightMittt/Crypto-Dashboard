import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { judgeStamps, readStamp } from "./stampGate";
import { STUDY_ARTIFACTS, StudyArtifact } from "./studyArtifacts";

/**
 * The gate is the only thing standing between "every step warned" and "the
 * run is green", so its failure cases matter more than its success case.
 * Each test below is a way a weekly run could be broken while looking fine.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stampgate-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, body: unknown): string {
  const dir = path.join(tmp, "src", "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  return `src/data/${name}`;
}

function artifact(repoPath: string): StudyArtifact {
  return { repoPath, generator: "scripts/fake.ts", serves: "a test" };
}

const NOON = Date.parse("2026-09-12T12:00:00Z");

describe("readStamp", () => {
  it("reads epoch milliseconds, which is what every generator writes", () => {
    const p = write("epoch.json", { generatedAt: NOON, rows: [] });
    expect(readStamp(path.join(tmp, p))).toEqual({ ms: NOON });
  });

  it("reads an ISO stamp too, since that is the other convention here", () => {
    const p = write("iso.json", { generatedAt: "2026-09-12T12:00:00Z" });
    expect(readStamp(path.join(tmp, p))).toEqual({ ms: NOON });
  });

  /*
   * The dangerous cases. Each of these is a file the gate cannot judge, and
   * the only safe answer is to fail — a gate that waves through what it could
   * not inspect reports success for precisely the file it did not check.
   */
  it("refuses a file with no stamp rather than assuming it is fine", () => {
    const p = write("unstamped.json", { rows: [1, 2, 3] });
    expect(readStamp(path.join(tmp, p))).toEqual({ error: "no generatedAt field" });
  });

  it("refuses a top-level array, which cannot carry a stamp at all", () => {
    const p = write("array.json", [{ a: 1 }]);
    expect(readStamp(path.join(tmp, p))).toMatchObject({ error: expect.stringContaining("not an object") });
  });

  it("refuses a stamp that does not parse, instead of silently reading NaN", () => {
    const p = write("garbage.json", { generatedAt: "last Tuesday" });
    expect(readStamp(path.join(tmp, p))).toMatchObject({ error: expect.stringContaining("unparseable") });
  });

  it("refuses a missing file", () => {
    expect(readStamp(path.join(tmp, "src/data/absent.json"))).toEqual({ error: "file does not exist" });
  });

  it("refuses truncated JSON, which is what a killed writer leaves behind", () => {
    const dir = path.join(tmp, "src", "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "half.json"), '{"generatedAt": 178917');
    expect(readStamp(path.join(dir, "half.json"))).toMatchObject({
      error: expect.stringContaining("unreadable JSON"),
    });
  });
});

describe("judgeStamps", () => {
  it("passes a stamp written inside the run", () => {
    const p = write("fresh.json", { generatedAt: NOON + 60_000 });
    const [v] = judgeStamps(tmp, NOON, [artifact(p)]);
    expect(v.fresh).toBe(true);
    expect(v.stampedAt).toBe(NOON + 60_000);
  });

  /*
   * THE CASE THE GATE EXISTS FOR. The study soft-failed, the old file is
   * still on disk, the commit step found no diff and exited 0. Nothing else
   * in the run can tell this apart from success.
   */
  it("fails a file left untouched by a study that warned instead of running", () => {
    const p = write("stale.json", { generatedAt: NOON - 26 * 86_400_000 });
    const [v] = judgeStamps(tmp, NOON, [artifact(p)]);
    expect(v.fresh).toBe(false);
    expect(v.reason).toContain("predates the run by 26.0 days");
  });

  /*
   * A stamp one millisecond old still predates the run, and that is the
   * whole point: no pre-existing value can satisfy the gate. This is the
   * 2026-08-21 failure — a check that matched the OLD build instantly —
   * pinned as a test.
   */
  it("is not satisfied by a stamp from just before the run began", () => {
    const p = write("nearly.json", { generatedAt: NOON - 1 });
    expect(judgeStamps(tmp, NOON, [artifact(p)])[0].fresh).toBe(false);
    const q = write("exactly.json", { generatedAt: NOON });
    expect(judgeStamps(tmp, NOON, [artifact(q)])[0].fresh).toBe(true);
  });

  it("judges every artefact rather than stopping at the first failure", () => {
    const a = write("a.json", { generatedAt: NOON + 1 });
    const b = write("b.json", { generatedAt: NOON - 1 });
    const c = write("c.json", { rows: [] });
    const vs = judgeStamps(tmp, NOON, [artifact(a), artifact(b), artifact(c)]);
    expect(vs.map((v) => v.fresh)).toEqual([true, false, false]);
  });

  it("carries the generator's name into the failure, so the log names a fix", () => {
    const p = write("named.json", { generatedAt: NOON - 1000 });
    const [v] = judgeStamps(tmp, NOON, [{ repoPath: p, generator: "scripts/x.ts", serves: "y" }]);
    expect(v.artifact.generator).toBe("scripts/x.ts");
  });
});

/*
 * Against the real repository, not a fixture. These are the two statements
 * the manifest makes about files that exist right now.
 */
describe("the committed study artefacts", () => {
  it("all carry a readable stamp, so the gate can judge every one of them", () => {
    for (const a of STUDY_ARTIFACTS) {
      const got = readStamp(path.join(ROOT, a.repoPath));
      expect("ms" in got, `${a.repoPath}: ${"error" in got ? got.error : ""}`).toBe(true);
    }
  });

  /*
   * Not vacuous against the real files. Judged against this instant, every
   * committed artefact is by definition older than the run, so a gate that
   * cannot fail would show up here as a pass. It is the same shape as the
   * check the workflow performs, aimed at a window nothing can satisfy.
   */
  it("rejects every committed artefact when the window is now, so the gate can bite", () => {
    const verdicts = judgeStamps(ROOT, Date.now());
    expect(verdicts.length).toBe(STUDY_ARTIFACTS.length);
    expect(verdicts.filter((v) => v.fresh).map((v) => v.artifact.repoPath)).toEqual([]);
  });
});
