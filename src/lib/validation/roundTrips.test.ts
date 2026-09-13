import { describe, expect, it } from "vitest";
import artifactJson from "../../data/liveLedger.json";
import {
  JOIN_CONTRACT,
  RawRoundTrip,
  buildLiveLedger,
  scanFillTimes,
  unavailableLedger,
} from "./roundTrips";

function trip(over: Partial<RawRoundTrip> = {}): RawRoundTrip {
  return {
    schema: "roundtrip/1.1",
    id: "TEST:2026-08-19T14:00:00Z",
    symbol: "TEST",
    instrument: "equity",
    qty: 1,
    multiplier: 1,
    entry: { price: 10, price_source: "derived_from_realized_gain", ts: null, ts_source: "unavailable" },
    exit: { price: 11, ts: "2026-08-19T14:00:00Z", venue: null, order_id: null },
    realized_usd: 1,
    hold_sessions: null,
    rules_at_entry: null,
    levels_armed_at_entry: null,
    side: "long",
    ...over,
  };
}

/** Stamps spread evenly across one RTH session, in the offset given. */
function rthStamps(count: number, offsetHours: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const localMin = 10 * 60 + Math.floor((i / count) * 300); // 10:00–15:00 local
    const utcMin = (((localMin - offsetHours * 60) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(utcMin / 60)).padStart(2, "0");
    const mm = String(utcMin % 60).padStart(2, "0");
    out.push(`2026-08-19T${hh}:${mm}:00Z`);
  }
  return out;
}

describe("scanFillTimes", () => {
  it("recovers the offset a genuine fill series was recorded in", () => {
    const scan = scanFillTimes(rthStamps(40, -4));
    expect(scan.bestOffsetHours).toBe(-4);
    expect(scan.bestRthFraction).toBe(1);
    expect(scan.credible).toBe(true);
  });

  it("recovers a different offset just as well, so the answer is not hard-coded to ET", () => {
    const scan = scanFillTimes(rthStamps(40, +9));
    expect(scan.bestOffsetHours).toBe(9);
    expect(scan.credible).toBe(true);
  });

  it("refuses stamps scattered around the clock, and lands near the chance rate", () => {
    const spread: string[] = [];
    for (let h = 0; h < 24; h++) spread.push(`2026-08-19T${String(h).padStart(2, "0")}:15:00Z`);
    const scan = scanFillTimes(spread);
    expect(scan.credible).toBe(false);
    // 6.5 of every 24 hours is RTH, but stamps land on :15, so the sweep hits
    // 10:15 through 15:15 and misses 09:15 and 16:15 — six, not seven.
    expect(scan.bestRthFraction).toBeCloseTo(6 / 24, 5);
    expect(scan.bestRthFraction).toBeLessThan(scan.threshold);
  });

  it("reports zero rather than dividing by nothing on an empty series", () => {
    const scan = scanFillTimes([]);
    expect(scan.n).toBe(0);
    expect(scan.bestRthFraction).toBe(0);
    expect(scan.credible).toBe(false);
  });
});

describe("buildLiveLedger", () => {
  it("counts a strategy id as the join key, and nothing else as one", () => {
    const withKey = buildLiveLedger([trip({ strategy_id: "overnight-miners-close-to-open" })]);
    expect(withKey.joinable).toBe(1);
    expect(withKey.blockers.find((b) => b.id === "no-strategy-id")).toBeUndefined();
    expect(withKey.statement).toContain("can be differenced against its paper price");
  });

  it("does not treat a basket ticker as a join", () => {
    const led = buildLiveLedger([trip({ symbol: "RIOT" }), trip({ symbol: "APLD" })]);
    expect(led.inDeclaredNames).toBe(2);
    expect(led.joinable).toBe(0);
    expect(led.statement).toContain("coincidence of ticker rather than a join");
  });

  it("excludes the scanned basket from the overlap, since it holds everything", () => {
    // A name in `scanned` but in no industry basket must not count as declared.
    const led = buildLiveLedger([trip({ symbol: "RIOT" })]);
    expect(led.declaredNameBreakdown.map((b) => b.basket)).not.toContain("scanned");
    expect(led.declaredNameBreakdown).toContainEqual({ basket: "miners", trips: 1 });
  });

  it("clears the derived-price blocker only when the price was observed", () => {
    const observed = buildLiveLedger([
      trip({ entry: { price: 10, price_source: "observed", ts: "2026-08-19T14:00:00Z", ts_source: "measured" } }),
    ]);
    expect(observed.blockers.find((b) => b.id === "entry-price-derived")).toBeUndefined();
    expect(observed.blockers.find((b) => b.id === "no-entry-timestamp")).toBeUndefined();
  });

  it("keeps closed-only standing even on an otherwise perfect row", () => {
    const led = buildLiveLedger([
      trip({
        strategy_id: "x",
        hold_sessions: 1,
        entry: { price: 10, price_source: "observed", ts: "2026-08-19T14:00:00Z", ts_source: "measured" },
      }),
    ]);
    // Everything else can be fixed by recording more; this one is about what
    // the log structurally omits, so it must not fall out with the others.
    expect(led.blockers.map((b) => b.id)).toContain("closed-only");
  });

  it("distinguishes an empty log from an unreadable one", () => {
    expect(buildLiveLedger([]).source).toBe("read");
    expect(unavailableLedger().source).toBe("unavailable");
    expect(unavailableLedger().statement).toContain("none were seen");
  });

  it("names the question each blocker closes, not just that it blocks", () => {
    const led = buildLiveLedger([trip()]);
    for (const b of led.blockers) {
      expect(["register-join", "execution-quality", "any-aggregate"]).toContain(b.blocks);
      expect(b.detail.length).toBeGreaterThan(40);
      expect(b.count).toBeGreaterThan(0);
      expect(b.of).toBeGreaterThanOrEqual(b.count);
    }
  });

  it("keeps realised dollars out of the statement", () => {
    const led = buildLiveLedger([trip({ realized_usd: 5000 })]);
    expect(led.realized?.usd).toBe(5000);
    expect(led.statement).not.toContain("5000");
    expect(led.statement).not.toContain("$");
  });
});

describe("JOIN_CONTRACT", () => {
  it("ties every requested field to the question it unlocks", () => {
    expect(JOIN_CONTRACT.length).toBeGreaterThan(0);
    for (const c of JOIN_CONTRACT) {
      expect(["register-join", "execution-quality", "any-aggregate"]).toContain(c.unlocks);
      expect(c.why.length).toBeGreaterThan(60);
    }
  });

  it("asks for a strategy id, which is the one field that unblocks the join", () => {
    expect(JOIN_CONTRACT.some((c) => c.field === "strategy_id" && c.unlocks === "register-join")).toBe(true);
  });
});

/*
 * Against the committed artefact, not a fixture. A fixture proves the
 * arithmetic; these prove the arithmetic ran on the real log and that the
 * page's central claim is still true of it.
 */
describe("the committed ledger", () => {
  const { ledger } = artifactJson as unknown as { ledger: ReturnType<typeof buildLiveLedger> };

  it("has read the log", () => {
    expect(ledger.source).toBe("read");
    expect(ledger.trips).toBeGreaterThan(0);
  });

  it("has no joinable trip, which is why rung 3 is empty", () => {
    expect(ledger.joinable).toBe(0);
    expect(ledger.blockers.find((b) => b.id === "no-strategy-id")?.count).toBe(ledger.trips);
  });

  it("still finds the overlap that must not be mistaken for a join", () => {
    expect(ledger.inDeclaredNames).toBeGreaterThan(0);
    expect(ledger.inDeclaredNames).toBeLessThan(ledger.trips);
  });

  it("rejects the exit stamps as fill times by a wide margin, not a narrow one", () => {
    expect(ledger.fillTimes.credible).toBe(false);
    // Near chance is the claim. A near-threshold reading would mean the
    // convention is merely undocumented rather than the stamps being non-fills.
    expect(ledger.fillTimes.bestRthFraction).toBeLessThan(0.5);
    expect(ledger.fillTimes.bestRthFraction).toBeGreaterThan(ledger.fillTimes.chanceFraction - 0.05);
  });

  it("carries no per-trade detail into the repository", () => {
    const text = JSON.stringify(artifactJson);
    expect(text).not.toContain("roundtrip/1.1\",\"id\"");
    expect(text).not.toMatch(/"order_id"/);
    expect(text).not.toMatch(/"realized_usd"/);
    expect(artifactJson).not.toHaveProperty("ledger.rows");
  });

  it("records where it was read from without naming the operator's account", () => {
    const hint = (artifactJson as { sourceHint: string }).sourceHint;
    expect(hint.startsWith("~") || !hint.includes("/")).toBe(true);
    expect(hint).not.toContain("/Users/");
  });
});
