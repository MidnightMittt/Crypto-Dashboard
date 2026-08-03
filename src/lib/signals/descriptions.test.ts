import { describe, it, expect } from "vitest";
import { METRIC_DESCRIPTIONS, CATEGORY_DESCRIPTIONS } from "./descriptions";
import { METRIC_WEIGHTS } from "./scoring";
import { CATEGORY_ORDER } from "./categories";

describe("tooltip coverage", () => {
  it("has a description for every metric id the engine actually scores", () => {
    // Regression guard: a metric added to scoring.ts without a matching
    // entry here would silently ship an empty tooltip.
    for (const id of Object.keys(METRIC_WEIGHTS)) {
      expect(METRIC_DESCRIPTIONS[id], `missing description for metric "${id}"`).toBeTruthy();
    }
  });

  it("has a description for every category", () => {
    for (const category of CATEGORY_ORDER) {
      expect(CATEGORY_DESCRIPTIONS[category]).toBeTruthy();
    }
  });
});
