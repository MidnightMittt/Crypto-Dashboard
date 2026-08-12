import { describe, expect, it } from "vitest";
import { CONTINUOUS_SESSION, US_EQUITY_SESSION } from "@/lib/research/types";
import {
  applyDailyClose,
  applyTick,
  buildEntryZone,
  DEFAULT_SWING_CONFIG,
  DailyCloseEvidence,
  emptySwingStore,
  SwingThesisStore,
} from "./swingThesis";
import { SupportResistanceZone } from "@/lib/technicals/marketStructure";

/**
 * The brief's §32 scenario list, written as executable tests.
 *
 * The load-bearing property under test throughout is the one the whole
 * module exists for: intraday movement of ANY kind cannot change a swing
 * thesis, and only confirmed higher-timeframe structural evidence can.
 */

const DAY = 24 * 60 * 60 * 1000;

function zone(kind: "support" | "resistance", priceLow: number, priceHigh: number): SupportResistanceZone {
  return {
    priceLow,
    priceHigh,
    kind,
    strength: 70,
    reactionCount: 3,
    confluence: [],
    status: "inactive",
    mostRecentTouchBarsAgo: 10,
    source: "swing-cluster",
    timeframe: "1D",
  };
}

/**
 * A bullish setup at 100 with support at 92-96 and resistance at 108-110.
 * ATR 3% (= 3.0 absolute) puts the 4-point stop distance inside
 * entryQuality's [0.5, 4] x ATR structural window, so the stop resolves to
 * the real zone edge rather than the ATR fallback.
 *
 * The support zone is deliberately 4 points wide. A retest entry sits at the
 * zone's midpoint with its stop below the zone, so a narrow zone leaves no
 * room for a stop that isn't inside the noise — which the reducer correctly
 * refuses to build a plan from.
 */
const LONG_ZONES = [zone("support", 92, 96), zone("resistance", 108, 110)];
const SHORT_ZONES = [zone("resistance", 104, 108), zone("support", 88, 92)];

function bullishClose(t: number, overrides: Partial<DailyCloseEvidence> = {}): DailyCloseEvidence {
  return {
    t,
    closePrice: 100,
    biasScore: 62,
    biasVerdict: "bullish",
    dailyAgreement: "confirms",
    dailyDirection: "bullish",
    fourHourAgreement: "confirms",
    planInputs: {
      verdict: "bullish",
      confidence: 70,
      agreement: 70,
      price: 100,
      atrPct: 3,
      supportResistance: LONG_ZONES,
      historicalWinRatePct: 55,
      historicalWinRateN: 40,
    },
    reasons: ["Spot demand is absorbing supply"],
    ...overrides,
  };
}

/** Runs consecutive daily closes until a thesis activates. Returns the store. */
function activateLong(config = DEFAULT_SWING_CONFIG): SwingThesisStore {
  let store = emptySwingStore();
  for (let i = 1; i <= config.sustainCloses; i++) {
    store = applyDailyClose(store, bullishClose(i * DAY), config);
  }
  return store;
}

describe("swing thesis — activation", () => {
  it("requires sustained confirmation: one qualifying close is not a thesis", () => {
    const store = applyDailyClose(emptySwingStore(), bullishClose(DAY));
    expect(store.active).toBeNull();
    expect(store.pending).toEqual({ direction: "long", closes: 1, firstSeenAt: DAY });
  });

  it("activates after the required consecutive closes, freezing a complete plan", () => {
    const store = activateLong();
    const state = store.active!;

    expect(state.direction).toBe("long");
    expect(state.version).toBe(1);
    expect(state.health).toBe("confirmed");

    // Entry is a ZONE derived from support, never the tick price.
    expect(state.plan.entryLow).toBe(92);
    expect(state.plan.entryHigh).toBe(96);
    expect(state.plan.entryBasis).toContain("Pullback");

    // Because the plan enters INTO support, the stop sits below that zone
    // (92 - 0.25 ATR = 91.25), not at its upper edge where entryQuality
    // would place an at-market stop — otherwise the fill would trigger it.
    expect(state.plan.stopPrice).toBeCloseTo(91.25, 5);
    expect(state.plan.target1Price).toBe(110);

    // R:R is measured from the WORST fill in the zone (96 for a long), not
    // the close and not the midpoint — so the ratio shown is a floor.
    expect(state.plan.entryRef).toBe(96);
    expect(state.plan.riskRewardRatio).toBeCloseTo((110 - 96) / (96 - 91.25), 5);
    expect(state.reasons).toEqual(["Spot demand is absorbing supply"]);
  });

  it("resets the candidate when a close fails the gate — closes must be CONSECUTIVE", () => {
    let store = applyDailyClose(emptySwingStore(), bullishClose(DAY));
    store = applyDailyClose(store, bullishClose(2 * DAY, { dailyAgreement: "contradicts" }));
    expect(store.pending).toBeNull();

    // The next qualifying close starts counting from one again.
    store = applyDailyClose(store, bullishClose(3 * DAY));
    expect(store.active).toBeNull();
    expect(store.pending?.closes).toBe(1);
  });

  it("blocks activation when 4H contradicts, even with a strong composite and confirming daily", () => {
    let store = emptySwingStore();
    for (let i = 1; i <= 4; i++) {
      store = applyDailyClose(store, bullishClose(i * DAY, { fourHourAgreement: "contradicts" }));
    }
    expect(store.active).toBeNull();
    expect(store.pending).toBeNull();
  });

  it("does not activate on a score inside the hysteresis gap", () => {
    // 55 clears the OLD directional threshold of 6 but not the activation band.
    let store = emptySwingStore();
    for (let i = 1; i <= 4; i++) store = applyDailyClose(store, bullishClose(i * DAY, { biasScore: 55 }));
    expect(store.active).toBeNull();
  });

  it("allows activation when 4H is simply unavailable — absent data is not evidence either way", () => {
    let store = emptySwingStore();
    for (let i = 1; i <= DEFAULT_SWING_CONFIG.sustainCloses; i++) {
      store = applyDailyClose(store, bullishClose(i * DAY, { fourHourAgreement: null }));
    }
    expect(store.active?.direction).toBe("long");
  });
});

describe("§32.1-4 — intraday movement never changes the thesis", () => {
  it("1. small intraday price movement leaves direction, plan and version untouched", () => {
    const store = activateLong();
    const before = store.active!;

    let after = store;
    for (const price of [100.4, 99.6, 100.9, 98.7, 101.2, 99.1]) {
      after = applyTick(after, { t: 3 * DAY, price }, CONTINUOUS_SESSION);
    }

    expect(after.active!.direction).toBe(before.direction);
    expect(after.active!.version).toBe(before.version);
    expect(after.active!.plan).toEqual(before.plan);
    expect(after.active!.health).toBe("confirmed");
  });

  it("2-4. RSI, funding and OI moves cannot reach the machine between daily closes", () => {
    // Those inputs only ever enter through DailyCloseEvidence. A tick
    // carries price and nothing else, so this is structural, not a
    // threshold that could be tuned wrong.
    const store = activateLong();
    const ticked = applyTick(store, { t: 2 * DAY + 3600_000, price: 100.2 }, CONTINUOUS_SESSION);
    expect(ticked.active).toEqual(store.active);
  });

  it("2-4. a daily close whose score merely drifts inside the hysteresis gap keeps the thesis confirmed", () => {
    let store = activateLong();
    // 56 would have been "bullish" under the old bare threshold and 55
    // "neutral" — the exact 1-point flip that produced 7.4 verdict changes
    // a day. Here both sit above the deactivation band, so nothing happens.
    store = applyDailyClose(store, bullishClose(3 * DAY, { biasScore: 56 }));
    expect(store.active!.health).toBe("confirmed");
    store = applyDailyClose(store, bullishClose(4 * DAY, { biasScore: 55 }));
    expect(store.active!.health).toBe("confirmed");
    expect(store.active!.version).toBe(1);
  });
});

describe("§32.5 — lower timeframe cannot override higher", () => {
  it("stays long when the daily and 4H both confirm, whatever a shorter timeframe says", () => {
    // 1H has no entry point into this reducer at all — the only timeframes
    // that can speak are the daily close and the 4H agreement carried with
    // it. That is the timeframe hierarchy, enforced by the type.
    let store = activateLong();
    store = applyDailyClose(store, bullishClose(3 * DAY));
    expect(store.active!.direction).toBe("long");
    expect(store.active!.health).toBe("confirmed");
  });
});

describe("§32.6 — confirmed 4H deterioration weakens without reversing", () => {
  it("marks the thesis weakening but keeps it standing, and logs why", () => {
    let store = activateLong();
    store = applyDailyClose(store, bullishClose(3 * DAY, { fourHourAgreement: "contradicts" }));

    const state = store.active!;
    expect(state.direction).toBe("long");
    expect(state.status).not.toBe("invalidated");
    expect(state.health).toBe("weakening");
    expect(state.weakeningCloses).toBe(1);

    const event = store.events.at(-1)!;
    expect(event.kind).toBe("weakened");
    expect(event.materiality).toBe("meaningful");
    expect(event.reason).toContain("4H structure contradicts");
  });

  it("recovers to confirmed when the evidence comes back", () => {
    let store = activateLong();
    store = applyDailyClose(store, bullishClose(3 * DAY, { fourHourAgreement: "weakens" }));
    expect(store.active!.health).toBe("weakening");

    store = applyDailyClose(store, bullishClose(4 * DAY));
    expect(store.active!.health).toBe("confirmed");
    expect(store.active!.weakeningCloses).toBe(0);
    expect(store.events.at(-1)!.kind).toBe("reconfirmed");
  });

  it("retires the thesis only after sustained weakening without recovery", () => {
    let store = activateLong();
    for (let i = 0; i < DEFAULT_SWING_CONFIG.maxWeakeningCloses; i++) {
      store = applyDailyClose(store, bullishClose((3 + i) * DAY, { fourHourAgreement: "contradicts" }));
    }
    expect(store.active).toBeNull();
    const retirement = store.events.find((e) => e.kind === "retired")!;
    expect(retirement.materiality).toBe("material");
    expect(retirement.reason).toContain("consecutive daily closes without recovering");
  });
});

describe("§32.7 — confirmed daily structural reversal ends the thesis", () => {
  it("needs the reversal to hold for consecutive closes, not a single day", () => {
    let store = activateLong();
    store = applyDailyClose(store, bullishClose(3 * DAY, { dailyDirection: "bearish", dailyAgreement: "contradicts" }));
    expect(store.active).not.toBeNull();
    expect(store.active!.reversalCloses).toBe(1);

    store = applyDailyClose(store, bullishClose(4 * DAY, { dailyDirection: "bearish", dailyAgreement: "contradicts" }));
    expect(store.active).toBeNull();

    const retirement = store.events.find((e) => e.kind === "retired")!;
    expect(retirement.reason).toContain("confirmed structural reversal");
  });

  it("names the real evidence rather than a score delta", () => {
    let store = activateLong();
    store = applyDailyClose(store, bullishClose(3 * DAY, { biasScore: 38, biasVerdict: "bearish" }));
    const retirement = store.events.find((e) => e.kind === "retired")!;
    expect(retirement.reason).toContain("crossed decisively to bearish");
    expect(retirement.reason).not.toMatch(/score changed/i);
  });

  it("does not flip straight into the opposite thesis — the reverse must earn its own closes", () => {
    let store = activateLong();
    const bearish = (t: number): DailyCloseEvidence => ({
      t,
      closePrice: 100,
      biasScore: 38,
      biasVerdict: "bearish",
      dailyAgreement: "confirms",
      dailyDirection: "bearish",
      fourHourAgreement: "confirms",
      planInputs: {
        verdict: "bearish",
        confidence: 70,
        agreement: 70,
        price: 100,
        atrPct: 3,
        supportResistance: SHORT_ZONES,
        historicalWinRatePct: 55,
        historicalWinRateN: 40,
      },
      reasons: ["Supply is overwhelming demand"],
    });

    store = applyDailyClose(store, bearish(3 * DAY));
    // Retired the long AND started counting the short in the same close,
    // but did not activate one.
    expect(store.active).toBeNull();
    expect(store.pending).toEqual({ direction: "short", closes: 1, firstSeenAt: 3 * DAY });

    store = applyDailyClose(store, bearish(4 * DAY));
    expect(store.active!.direction).toBe("short");
    expect(store.active!.version).toBe(2);
  });
});

describe("§32.8-9 — price-driven lifecycle", () => {
  it("8. a stop breach invalidates immediately, mid-day, without waiting for a close", () => {
    const store = activateLong();
    // An intrabar wick through the stop counts, matching execution.ts's
    // pessimistic resolution — the close back at 93 does not save it.
    const after = applyTick(store, { t: 2 * DAY + 3600_000, price: 93, low: 91 }, CONTINUOUS_SESSION);

    expect(after.active!.status).toBe("invalidated");
    const event = after.events.at(-1)!;
    expect(event.kind).toBe("invalidated");
    expect(event.materiality).toBe("critical");
  });

  it("8. an invalidated thesis latches — later ticks cannot revive it", () => {
    let store = applyTick(activateLong(), { t: 2 * DAY + 1, price: 91 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("invalidated");
    store = applyTick(store, { t: 2 * DAY + 2, price: 105 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("invalidated");
  });

  it("9. reaching the first target completes the plan", () => {
    const store = applyTick(activateLong(), { t: 3 * DAY, price: 109, high: 110.5 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("completed");
  });

  it("9. a completed thesis is cleared at the next daily close so a new plan can form", () => {
    let store = applyTick(activateLong(), { t: 3 * DAY, price: 111, high: 111 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("completed");

    store = applyDailyClose(store, bullishClose(4 * DAY));
    // Cleared, and the fresh assessment starts a new candidate rather than
    // silently continuing the finished one.
    expect(store.active).toBeNull();
    expect(store.pending?.closes).toBe(1);
  });

  it("reads ENTRY AVAILABLE inside the zone and MISSED once price runs away", () => {
    const store = activateLong();
    expect(applyTick(store, { t: 3 * DAY, price: 94 }, CONTINUOUS_SESSION).active!.status).toBe("entry-available");

    // activationPrice 100 + missedDistance (1 ATR = 3) => beyond 103 is a chase.
    expect(applyTick(store, { t: 3 * DAY, price: 102 }, CONTINUOUS_SESSION).active!.status).toBe("active");
    expect(applyTick(store, { t: 3 * DAY, price: 104 }, CONTINUOUS_SESSION).active!.status).toBe("missed");
  });

  it("retires a plan that stayed missed, so a fresh one can be priced", () => {
    let store = activateLong();
    for (let i = 0; i < DEFAULT_SWING_CONFIG.maxMissedCloses; i++) {
      store = applyTick(store, { t: (3 + i) * DAY - 1, price: 104 }, CONTINUOUS_SESSION);
      expect(store.active!.status).toBe("missed");
      store = applyDailyClose(store, bullishClose((3 + i) * DAY));
    }

    // The old plan is gone and the still-valid thesis has begun re-earning
    // its closes, rather than staying welded to an entry nobody could take.
    expect(store.active).toBeNull();
    expect(store.pending?.direction).toBe("long");
    expect(store.events.find((e) => e.kind === "retired")!.reason).toContain("re-priced rather than chased");
  });

  it("a missed setup becomes actionable again if price returns to the zone", () => {
    let store = applyTick(activateLong(), { t: 3 * DAY, price: 104 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("missed");
    store = applyTick(store, { t: 3 * DAY + 1, price: 94 }, CONTINUOUS_SESSION);
    expect(store.active!.status).toBe("entry-available");
  });
});

describe("§32.10 — data outage produces no false signal", () => {
  it("leaves an active thesis untouched and does not consume the close", () => {
    const store = activateLong();
    const after = applyDailyClose(store, bullishClose(3 * DAY, { biasScore: null, dailyDirection: null }));

    expect(after.active).toEqual(store.active);
    // The close was NOT recorded, so it is retried once data returns rather
    // than being silently skipped.
    expect(after.lastCloseAt).toBe(store.lastCloseAt);
  });

  it("never activates a thesis from missing data", () => {
    let store = emptySwingStore();
    for (let i = 1; i <= 5; i++) {
      store = applyDailyClose(store, bullishClose(i * DAY, { biasScore: null, dailyDirection: null }));
    }
    expect(store.active).toBeNull();
    expect(store.pending).toBeNull();
  });

  it("cannot build a plan without ATR, so no thesis activates", () => {
    let store = emptySwingStore();
    for (let i = 1; i <= 4; i++) {
      const ev = bullishClose(i * DAY);
      store = applyDailyClose(store, { ...ev, planInputs: { ...ev.planInputs!, atrPct: null } });
    }
    expect(store.active).toBeNull();
  });
});

describe("§32.11-12 — replay safety and multi-day persistence", () => {
  it("11. is idempotent per close, so a replayed or raced close cannot double-advance state", () => {
    const store = activateLong();
    const replayed = applyDailyClose(store, bullishClose(2 * DAY));
    expect(replayed).toEqual(store);

    // An out-of-order (older) close is ignored too.
    expect(applyDailyClose(store, bullishClose(DAY))).toEqual(store);
  });

  it("11. ticking at any frequency converges on the same state as ticking once", () => {
    // This is what makes a stateful engine backtestable: the live path ticks
    // thousands of times a day, the replay ticks hourly, and both must land
    // in the same place.
    const base = activateLong();
    const once = applyTick(base, { t: 3 * DAY, price: 101 }, CONTINUOUS_SESSION);

    let many = base;
    for (let i = 0; i < 200; i++) many = applyTick(many, { t: 3 * DAY, price: 101 }, CONTINUOUS_SESSION);

    expect(many.active).toEqual(once.active);
  });

  it("12. an active thesis survives two weeks of ordinary daily closes unchanged", () => {
    let store = activateLong();
    const activatedPlan = store.active!.plan;

    for (let day = 3; day <= 16; day++) {
      // Ordinary drift: score wanders across the OLD 44/56 boundaries and
      // price wanders within the plan, exactly the conditions that used to
      // produce ENTER LONG -> WAIT -> ENTER LONG.
      const score = [58, 61, 56, 59, 63, 57, 60][day % 7];
      store = applyDailyClose(store, bullishClose(day * DAY, { biasScore: score }));
      store = applyTick(store, { t: day * DAY + 3600_000, price: 99 + (day % 3) }, CONTINUOUS_SESSION);
    }

    const state = store.active!;
    expect(state.version).toBe(1);
    expect(state.direction).toBe("long");
    expect(state.health).toBe("confirmed");
    expect(state.plan).toEqual(activatedPlan);
    // Exactly one thesis event in fourteen days: the activation itself.
    expect(store.events.filter((e) => e.kind !== "reconfirmed")).toHaveLength(1);
  });
});

describe("entry zone derivation", () => {
  it("uses the protective zone when it is a realistic pullback away", () => {
    const result = buildEntryZone("long", 100, 3, zone("support", 95, 96), DEFAULT_SWING_CONFIG);
    expect(result).toMatchObject({ entryLow: 95, entryHigh: 96 });
    expect(result.entryBasis).toContain("Pullback into the 1D support zone");
  });

  it("falls back to an explicit at-market band when the zone is out of reach", () => {
    // 1.5 ATR = 4.5, so a zone 20 points away is not a swing entry anyone
    // would wait for. Saying so beats pretending the level is actionable.
    const result = buildEntryZone("long", 100, 3, zone("support", 79, 80), DEFAULT_SWING_CONFIG);
    expect(result.entryLow).toBeCloseTo(99.25, 5);
    expect(result.entryHigh).toBeCloseTo(100.75, 5);
    expect(result.entryBasis).toContain("At market");
  });

  it("ignores a zone on the wrong side of price", () => {
    const result = buildEntryZone("long", 100, 3, zone("support", 101, 102), DEFAULT_SWING_CONFIG);
    expect(result.entryBasis).toContain("At market");
  });

  it("mirrors correctly for shorts", () => {
    const result = buildEntryZone("short", 100, 3, zone("resistance", 104, 105), DEFAULT_SWING_CONFIG);
    expect(result).toMatchObject({ entryLow: 104, entryHigh: 105 });
  });
});

/**
 * GAP AWARENESS. `statusForPrice` used to hand-roll its intrabar test and
 * carried a documented exception saying to route it through `levelReached`
 * before the swing layer served a session market. These pin what that
 * routing actually changed — and, just as importantly, what it did not.
 *
 * The activated long plan: entry 92-96, stop 91.25, target 110, anchor 100.
 */
describe("gap-aware lifecycle", () => {
  const bothLevelsTouched = { t: 3 * DAY, price: 95, high: 112, low: 91 };

  it("crypto is unchanged: a bar touching both levels resolves to the stop", () => {
    // The pessimistic intrabar convention, identical to the pre-fix code and
    // to resolveTrade. A continuous market has no open to gap from.
    const after = applyTick(activateLong(), { ...bothLevelsTouched, open: 100 }, CONTINUOUS_SESSION);
    expect(after.active!.status).toBe("invalidated");
  });

  it("a session market that REOPENS above the target completes, and does not report a stop", () => {
    /*
     * THE BUG THIS FIXES. The market gapped to 112 — already past the 110
     * target — before a single trade printed, then sold off to 91. The
     * intrabar test sees `low <= 91.25` and calls the thesis invalidated,
     * when the target had been exceeded at the open. Not a rounding error;
     * the wrong outcome.
     */
    const after = applyTick(activateLong(), { ...bothLevelsTouched, open: 112 }, US_EQUITY_SESSION);
    expect(after.active!.status).toBe("completed");
    expect(after.events.at(-1)!.kind).toBe("completed");
  });

  it("a session market that REOPENS below the stop invalidates, as it always did", () => {
    // Same bar shape, gapped the other way. The label was already right here;
    // this pins that the fix did not invert it while making the other case work.
    const after = applyTick(
      activateLong(),
      { t: 3 * DAY, price: 111, open: 90, high: 112, low: 89 },
      US_EQUITY_SESSION
    );
    expect(after.active!.status).toBe("invalidated");
  });

  it("a session market that does NOT gap uses the same pessimistic rule as crypto", () => {
    // Opening between the levels means the bar traded through them in some
    // order nobody can recover, so the adverse one wins — on both sessions.
    const opened = { ...bothLevelsTouched, open: 100 };
    expect(applyTick(activateLong(), opened, US_EQUITY_SESSION).active!.status).toBe("invalidated");
    expect(applyTick(activateLong(), opened, CONTINUOUS_SESSION).active!.status).toBe("invalidated");
  });

  it("no open means no gap is INFERRED, even on a session market", () => {
    /*
     * A live poll is a spot quote, not a closed bar. Treating the quote as an
     * open would manufacture a gap out of ordinary intrabar movement, so an
     * open-less tick is evaluated under continuous rules whatever the
     * instrument — the conservative direction, and the honest one.
     */
    const noOpen = bothLevelsTouched;
    expect(applyTick(activateLong(), noOpen, US_EQUITY_SESSION).active!.status).toBe("invalidated");
    expect(applyTick(activateLong(), noOpen, CONTINUOUS_SESSION).active!.status).toBe("invalidated");
  });

  it("is still a pure function of price: session choice alone moves nothing on an ordinary bar", () => {
    const ordinary = { t: 3 * DAY, price: 94, open: 95, high: 96, low: 93 };
    expect(applyTick(activateLong(), ordinary, US_EQUITY_SESSION).active!.status).toBe("entry-available");
    expect(applyTick(activateLong(), ordinary, CONTINUOUS_SESSION).active!.status).toBe("entry-available");
  });
});
