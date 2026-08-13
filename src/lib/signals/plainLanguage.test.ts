import { describe, expect, it } from "vitest";
import {
  agreementLevel,
  define,
  describeAgreement,
  describeConviction,
  describeEvidence,
  evidenceLevel,
  GLOSSARY,
  strengthStars,
} from "./plainLanguage";

describe("evidenceLevel", () => {
  it("uses the same boundaries the engine's own prose has always used", () => {
    expect(evidenceLevel(65)).toBe("strong");
    expect(evidenceLevel(64)).toBe("moderate");
    expect(evidenceLevel(40)).toBe("moderate");
    expect(evidenceLevel(39)).toBe("thin");
    expect(evidenceLevel(0)).toBe("thin");
    expect(evidenceLevel(100)).toBe("strong");
  });

  it("never softens a thin reading into an encouraging one", () => {
    // The whole point: plain words, identical severity.
    expect(describeEvidence(28)).toContain("Thin");
    expect(describeEvidence(28)).toContain("not a signal");
  });
});

describe("agreementLevel", () => {
  it("reserves unanimous for actual unanimity", () => {
    expect(agreementLevel(100)).toBe("unanimous");
    expect(agreementLevel(99)).toBe("mostly-agree");
    expect(agreementLevel(67)).toBe("mostly-agree");
    expect(agreementLevel(66)).toBe("split");
    expect(agreementLevel(34)).toBe("split");
    expect(agreementLevel(33)).toBe("conflicting");
  });

  it("describes each level without a percentage", () => {
    expect(describeAgreement(100)).toBe("Every signal points the same way.");
    expect(describeAgreement(20)).toContain("contradict");
    for (const pct of [0, 33, 34, 67, 100]) {
      expect(describeAgreement(pct)).not.toMatch(/\d/);
    }
  });
});

describe("describeConviction", () => {
  it("names the trap case: unanimous agreement on thin evidence", () => {
    // This is SPY's live shape (28% evidence, 100% agreement) and the exact
    // situation two bare percentages fail to communicate.
    const text = describeConviction(28, 100);
    expect(text).toContain("looks like certainty and is not");
  });

  it("names the opposite trap: good evidence that disagrees with itself", () => {
    const text = describeConviction(80, 25);
    expect(text).toContain("disagrees with itself");
    expect(text).toContain("compromise");
  });

  it("calls out the genuinely reliable combination", () => {
    expect(describeConviction(80, 100)).toContain("most reliable");
  });

  it("falls back to the two plain sentences when no special case applies", () => {
    const text = describeConviction(50, 50);
    expect(text).toContain("partial picture");
    expect(text).toContain("split");
  });
});

describe("GLOSSARY", () => {
  it("explains every term without using another jargon term inside it", () => {
    // A definition that needs its own definition has not defined anything.
    const jargon = ["ATR", "R:R", "MAE", "MFE", "basis", "beta", "rho", "percentile"];
    for (const [term, definition] of Object.entries(GLOSSARY)) {
      for (const j of jargon) {
        // "ATR" may appear in its own entry, spelled out.
        if (term === j) continue;
        expect(definition, `${term} leaks "${j}"`).not.toContain(j);
      }
    }
  });

  it("keeps every definition to something a reader takes in at a glance", () => {
    for (const [term, definition] of Object.entries(GLOSSARY)) {
      expect(definition.length, `${term} is too long`).toBeLessThan(260);
    }
  });

  it("looks up case-insensitively and returns null for unknown terms", () => {
    expect(define("atr")).toBe(GLOSSARY.ATR);
    expect(define("Stop")).toBe(GLOSSARY.stop);
    expect(define("gamma")).toBeNull();
  });
});

describe("strengthStars", () => {
  it("maps distance from neutral to five coarse buckets", () => {
    expect(strengthStars(50)).toBe(1);
    expect(strengthStars(56)).toBe(2);
    expect(strengthStars(62)).toBe(3);
    expect(strengthStars(70)).toBe(4);
    expect(strengthStars(80)).toBe(5);
  });

  it("is symmetric — a bearish read is as strong as its bullish mirror", () => {
    for (const distance of [0, 6, 12, 20, 30, 50]) {
      expect(strengthStars(50 + distance)).toBe(strengthStars(50 - distance));
    }
  });
});
