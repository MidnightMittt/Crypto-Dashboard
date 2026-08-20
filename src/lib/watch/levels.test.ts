import { describe, expect, it } from "vitest";
import {
  Breach,
  MAX_QUOTE_AGE_SECONDS,
  WatchLevel,
  WatchQuote,
  evaluateAll,
  evaluateLevel,
  isArmed,
  markFired,
  rejectionReason,
} from "./levels";

const NOW = new Date("2026-08-20T18:00:00Z");

const level = (over: Partial<WatchLevel> = {}): WatchLevel => ({
  id: "w1",
  symbol: "CIFR",
  level: 16,
  direction: "below",
  note: "Disaster stop — thesis is dead below this.",
  armedAt: "2026-08-20T14:00:00Z",
  firedAt: null,
  firedPrice: null,
  delivered: false,
  ...over,
});

const quote = (over: Partial<WatchQuote> = {}): WatchQuote => ({
  symbol: "CIFR",
  price: 17.21,
  asOf: "2026-08-20T17:59:00Z",
  ageSeconds: 60,
  ...over,
});

const firedOf = (b: Breach) => (b.kind === "fired" ? b : null);
const skipOf = (b: Breach) => (b.kind === "skipped" ? b : null);

describe("evaluateLevel", () => {
  it("does not fire while price is above a stop", () => {
    const b = evaluateLevel(level(), quote({ price: 17.21 }), NOW);
    expect(b.kind).toBe("skipped");
    expect(skipOf(b)!.reason).toContain("not reached");
    // The distance is stated, so a quiet sweep is legible rather than blank.
    expect(skipOf(b)!.reason).toContain("$1.21");
  });

  it("fires when a stop is touched exactly", () => {
    const b = evaluateLevel(level({ level: 16 }), quote({ price: 16 }), NOW);
    expect(b.kind).toBe("fired");
    expect(firedOf(b)!.message).toContain("fell to $16.00");
    expect(firedOf(b)!.message).toContain("below your $16.00 level");
  });

  it("fires an above-level on a breakout and words it correctly", () => {
    const b = evaluateLevel(level({ direction: "above", level: 18, note: "" }), quote({ price: 18.4 }), NOW);
    expect(b.kind).toBe("fired");
    expect(firedOf(b)!.message).toContain("rose to $18.40");
  });

  it("carries the note into the message, because the note is the why", () => {
    const b = evaluateLevel(level(), quote({ price: 15.5 }), NOW);
    expect(firedOf(b)!.message).toContain("thesis is dead below this");
  });

  /* Every alert must say it is only an alert. This site never places orders. */
  it("states that no order was placed", () => {
    const b = evaluateLevel(level(), quote({ price: 15.5 }), NOW);
    expect(firedOf(b)!.message).toContain("no order has been placed");
  });

  /*
   * THE STALENESS REFUSAL, which is why the price-staleness work had to land
   * first. A stale print that has drifted through a stop instructs you to act
   * on something that may never have happened.
   */
  it("refuses to fire on a quote older than one sweep interval", () => {
    // One second past the limit is already a refusal — the boundary is strict.
    const edge = evaluateLevel(level(), quote({ price: 15.5, ageSeconds: MAX_QUOTE_AGE_SECONDS + 1 }), NOW);
    expect(edge.kind).toBe("skipped");
    expect(skipOf(edge)!.reason).toContain("refusing to fire");

    const stuck = evaluateLevel(level(), quote({ price: 15.5, ageSeconds: 40 * 60 }), NOW);
    expect(skipOf(stuck)!.reason).toContain("40 minutes old");
  });

  it("still fires at exactly the age limit", () => {
    const b = evaluateLevel(level(), quote({ price: 15.5, ageSeconds: MAX_QUOTE_AGE_SECONDS }), NOW);
    expect(b.kind).toBe("fired");
  });

  it("distinguishes a missing quote from a quiet market", () => {
    const b = evaluateLevel(level(), null, NOW);
    expect(b.kind).toBe("skipped");
    expect(skipOf(b)!.reason).toContain("no quote available");
  });

  /*
   * ONE-SHOT. A stop that re-alerts on every sweep while price sits below it
   * trains you to mute the channel, and a muted channel you believe in is
   * worse than no channel.
   */
  it("does not re-fire a level that has already fired", () => {
    const spent = level({ firedAt: "2026-08-20T17:00:00Z", firedPrice: 15.9 });
    expect(isArmed(spent)).toBe(false);
    const b = evaluateLevel(spent, quote({ price: 15.5 }), NOW);
    expect(b.kind).toBe("skipped");
    expect(skipOf(b)!.reason).toContain("already fired");
  });
});

describe("evaluateAll", () => {
  it("evaluates each level against its own symbol's quote", () => {
    const levels = [
      level({ id: "a", symbol: "CIFR", level: 16 }),
      level({ id: "b", symbol: "BTDR", level: 9, direction: "below" }),
      level({ id: "c", symbol: "NOQUOTE", level: 5 }),
    ];
    const quotes = new Map([
      ["CIFR", quote({ symbol: "CIFR", price: 17.21 })],
      ["BTDR", quote({ symbol: "BTDR", price: 8.5 })],
    ]);
    const out = evaluateAll(levels, quotes, NOW);
    expect(out[0].kind).toBe("skipped"); // above its stop
    expect(out[1].kind).toBe("fired"); // through its stop
    expect(out[2].kind).toBe("skipped"); // no quote
    expect(skipOf(out[2])!.reason).toContain("no quote");
  });
});

describe("markFired", () => {
  it("records the tripping price and does not mutate the original", () => {
    const armed = level();
    const spent = markFired(armed, quote({ price: 15.5 }), NOW, true);
    expect(spent.firedAt).toBe(NOW.toISOString());
    expect(spent.firedPrice).toBe(15.5);
    expect(spent.delivered).toBe(true);
    expect(armed.firedAt).toBeNull();
  });

  /*
   * A fired level whose alert failed to send is the state that matters most:
   * the trigger is preserved and visible even though nobody was told.
   */
  it("preserves a fire whose delivery failed", () => {
    const spent = markFired(level(), quote({ price: 15.5 }), NOW, false);
    expect(spent.firedAt).not.toBeNull();
    expect(spent.delivered).toBe(false);
  });
});

describe("rejectionReason", () => {
  it("accepts a well-formed level", () => {
    expect(rejectionReason({ symbol: "CIFR", level: 16, direction: "below" })).toBeNull();
  });

  /* An agent that believes it armed a stop, and did not, is worse off than one that knows it is unprotected. */
  it("rejects the malformed cases by name", () => {
    expect(rejectionReason({ level: 16, direction: "below" })).toContain("symbol is required");
    expect(rejectionReason({ symbol: "CIFR", level: 0, direction: "below" })).toContain("positive number");
    expect(rejectionReason({ symbol: "CIFR", level: NaN, direction: "below" })).toContain("positive number");
    expect(rejectionReason({ symbol: "CIFR", level: 16, direction: "sideways" })).toContain('"below"');
  });
});
