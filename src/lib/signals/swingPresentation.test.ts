import { describe, expect, it } from "vitest";
import { buildSwingView, ageLabel, shortTermCondition } from "./swingPresentation";
import { emptySwingStore, SwingThesisState, SwingThesisStore } from "./swingThesis";

const DAY = 86_400_000;
const NOW = 10 * DAY;

function state(overrides: Partial<SwingThesisState> = {}): SwingThesisState {
  return {
    version: 1,
    direction: "long",
    status: "active",
    health: "confirmed",
    activatedAt: 7 * DAY,
    lastDailyCloseAt: 9 * DAY,
    reasons: [],
    weakeningCloses: 0,
    reversalCloses: 0,
    missedCloses: 0,
    plan: {
      entryLow: 92,
      entryHigh: 96,
      entryBasis: "Pullback into the support zone (3 touches)",
      stopPrice: 91.25,
      stopBasis: "Beyond the support zone being retested",
      target1Price: 110,
      target1Basis: "",
      target2Price: 118,
      target2Basis: "",
      riskRewardRatio: 5.8,
      riskRewardRatio2: 8.7,
      stars: 4,
      starRationale: "",
      atrAbs: 3,
      missedDistance: 3,
      activationPrice: 100,
      supportZone: null,
      resistanceZone: null,
    },
    ...overrides,
  };
}

function storeWith(active: SwingThesisState | null, extra: Partial<SwingThesisStore> = {}): SwingThesisStore {
  return { ...emptySwingStore(), active, ...extra };
}

describe("buildSwingView", () => {
  it("distinguishes 'no thesis' from 'could not check' — they are different claims", () => {
    const missing = buildSwingView(null, NOW);
    const unavailable = buildSwingView({ available: false, store: emptySwingStore() }, NOW);

    expect(missing.label).toBe("NO SWING SETUP");
    expect(unavailable.label).toBe("PLAN STATE UNAVAILABLE");
    expect(unavailable.detail).toContain("couldn't check");
    // Neither may imply a plan exists.
    expect(missing.chip).toBeNull();
    expect(unavailable.chip).toBeNull();
  });

  it("calls the entry only when price is actually in the zone", () => {
    const available = buildSwingView({ available: true, store: storeWith(state({ status: "entry-available" })) }, NOW);
    expect(available.label).toBe("ENTER LONG");

    // Plan live but price elsewhere: still a standing plan, NOT a call to act.
    const waiting = buildSwingView({ available: true, store: storeWith(state({ status: "active" })) }, NOW);
    expect(waiting.label).toBe("LONG PLAN ACTIVE");
    expect(waiting.detail).toContain("92.00–96.00");
  });

  it("says do-not-chase rather than re-pricing a missed entry", () => {
    const view = buildSwingView({ available: true, store: storeWith(state({ status: "missed" })) }, NOW);
    expect(view.label).toBe("MISSED — DO NOT CHASE");
    expect(view.tone).toBe("warn");
    expect(view.detail).toContain("thesis still stands");
  });

  it("shows the plan's age and version, so a standing thesis reads as standing", () => {
    const view = buildSwingView({ available: true, store: storeWith(state({ version: 2 })) }, NOW);
    expect(view.chip).toBe("PLAN ACTIVE · v2 · 3d");
  });

  it("keeps weakening on a SEPARATE tactical line, never in the action", () => {
    // The whole point of §19: deterioration must not read as "the trade is off".
    const view = buildSwingView(
      { available: true, store: storeWith(state({ health: "weakening", weakeningCloses: 2 })) },
      NOW
    );
    expect(view.label).toBe("LONG PLAN ACTIVE");
    expect(view.tactical).toContain("2 daily closes");
    expect(view.tactical).toContain("still stands");
  });

  it("has no tactical line when nothing is deteriorating", () => {
    expect(buildSwingView({ available: true, store: storeWith(state()) }, NOW).tactical).toBeNull();
  });

  it("says COLD START rather than claiming nothing qualifies before it has ever looked", () => {
    // An engine that has folded in zero daily closes has rejected nothing.
    const view = buildSwingView({ available: true, store: emptySwingStore() }, NOW);
    expect(view.label).toBe("ESTABLISHING SWING THESIS");
    expect(view.detail).toContain("cold start, not a verdict");
  });

  it("switches to a real 'nothing qualifies' read once closes have been observed", () => {
    const view = buildSwingView({ available: true, store: storeWith(null, { lastCloseAt: 9 * DAY }) }, NOW);
    expect(view.label).toBe("NO SWING SETUP");
    expect(view.detail).toContain("haven't lined up");
  });

  it("reports a forming setup honestly rather than as a signal", () => {
    const view = buildSwingView(
      {
        available: true,
        store: storeWith(null, {
          lastCloseAt: 9 * DAY,
          pending: { direction: "short", closes: 1, firstSeenAt: 9 * DAY },
        }),
      },
      NOW
    );
    expect(view.label).toBe("NO SWING SETUP");
    expect(view.detail).toContain("1 qualifying daily close");
    expect(view.state).toBeNull();
  });

  it("explains WHY the last thesis ended, quoting the recorded reason", () => {
    const store = storeWith(null, {
      lastCloseAt: 9 * DAY,
      events: [
        {
          t: 9 * DAY,
          version: 1,
          kind: "retired",
          materiality: "material",
          reason: "Daily structure reversed to bearish and held for 2 consecutive daily closes.",
        },
      ],
    });
    expect(buildSwingView({ available: true, store }, NOW).detail).toContain("Daily structure reversed");
  });

  it("marks an invalidated plan as danger and names the level", () => {
    const view = buildSwingView({ available: true, store: storeWith(state({ status: "invalidated" })) }, NOW);
    expect(view.tone).toBe("danger");
    expect(view.detail).toContain("91.25");
  });
});

describe("shortTermCondition", () => {
  it("never restates the fast read as a second call to action", () => {
    // The stateless engine changed ~7x/day. Rendering its imperative
    // beside a multi-day plan would invite acting on exactly the signal
    // this refactor demoted.
    for (const action of ["enter-long", "enter-short", "wait-long-confirmation", "wait-short-confirmation", "no-trade"]) {
      const text = shortTermCondition(action);
      expect(text).not.toMatch(/^enter\b/i);
      expect(text.toUpperCase()).not.toBe(text);
    }
  });

  it("still carries the real directional information", () => {
    expect(shortTermCondition("enter-long")).toContain("long side");
    expect(shortTermCondition("enter-short")).toContain("short side");
    expect(shortTermCondition("no-trade")).toContain("no short-term directional edge");
  });
});

describe("ageLabel", () => {
  it("reads in days once past one, hours below that", () => {
    expect(ageLabel(0, 3 * DAY)).toBe("3d");
    expect(ageLabel(0, 5 * 3_600_000)).toBe("5h");
    expect(ageLabel(0, 60_000)).toBe("just now");
  });
});
