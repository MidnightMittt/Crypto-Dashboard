import { describe, expect, it } from "vitest";
import {
  DeskForm,
  EMPTY_FORM,
  capitalUsd,
  checkBody,
  checkGate,
  costBody,
  distanceBody,
  distanceGate,
  exitBody,
  exitGate,
  riskAtStop,
  stopWidthPct,
} from "./desk";

const form = (over: Partial<DeskForm> = {}): DeskForm => ({
  ...EMPTY_FORM,
  symbol: "apld",
  accountValue: 25_000,
  shares: 400,
  entry: 12.5,
  stop: 11.25,
  ...over,
});

describe("stage gates", () => {
  /*
   * The ordering claim, asserted rather than described: stage 1 must answer
   * with nothing but a symbol, because its output is where the trader GETS a
   * stop. If it demanded one, the page would be a circle.
   */
  it("lets the exit design answer before a stop exists", () => {
    expect(exitGate(form({ stop: null, entry: null, shares: null, accountValue: null }))).toEqual({
      ready: true,
    });
  });

  it("names every missing field rather than reporting a bare not-ready", () => {
    const g = checkGate({ ...EMPTY_FORM, symbol: "APLD" });
    expect(g.ready).toBe(false);
    if (g.ready) throw new Error("unreachable");
    expect(g.missing).toEqual(["account value", "share count", "an entry price", "a stop price"]);
  });

  it("treats zero and negative as absent, not as values", () => {
    expect(checkGate(form({ shares: 0 })).ready).toBe(false);
    expect(checkGate(form({ entry: -1 })).ready).toBe(false);
    expect(distanceGate(form({ stop: 0 })).ready).toBe(false);
  });

  it("is ready when the form is complete", () => {
    expect(checkGate(form())).toEqual({ ready: true });
    expect(distanceGate(form())).toEqual({ ready: true });
  });
});

describe("request bodies", () => {
  /*
   * THE SEAM THIS FILE EXISTS FOR. /api/pretrade/check reads `shares`;
   * /api/portfolio spells the same concept `quantity`. Sending the wrong one
   * does not error — it produced a silently empty held book once already, an
   * answer that looks exactly like a correct answer to an empty book. So the
   * key is asserted by name, not by shape.
   */
  it("sends shares, not quantity, to the pre-trade auditor", () => {
    const b = checkBody(form());
    expect(b).toHaveProperty("shares", 400);
    expect(b).not.toHaveProperty("quantity");
    expect(b).toEqual({
      symbol: "APLD",
      shares: 400,
      entry: 12.5,
      stop: 11.25,
      hold_sessions: 20,
      account_value: 25_000,
    });
  });

  it("uppercases the symbol for every endpoint", () => {
    expect(checkBody(form()).symbol).toBe("APLD");
    expect(exitBody(form()).symbol).toBe("APLD");
    expect((costBody(form()).candidates as { symbol: string }[])[0].symbol).toBe("APLD");
    expect((distanceBody(form()).items as { symbol: string }[])[0].symbol).toBe("APLD");
  });

  it("passes the chosen stop to the exit designer as a percent of entry", () => {
    expect(exitBody(form()).stop_pct).toBe(10);
  });

  it("omits stop_pct entirely when the trader has not chosen one", () => {
    const b = exitBody(form({ stop: null }));
    expect(b).not.toHaveProperty("stop_pct");
    expect(b).toEqual({ symbol: "APLD", hold_sessions: 20, account_value: 25_000 });
  });

  /*
   * A fabricated spread renders identically to a measured one. The route
   * measures the round trip from committed history when no quote is sent, so
   * sending an invented bid/ask around the entry price would replace a
   * measurement with a guess and nothing downstream could tell.
   */
  it("sends no bid or ask it does not have", () => {
    const c = (costBody(form()).candidates as Record<string, unknown>[])[0];
    expect(c).not.toHaveProperty("bid");
    expect(c).not.toHaveProperty("ask");
    expect(c.kind).toBe("equity");
  });

  it("builds distance rows for the stop and each target rung", () => {
    const items = distanceBody(form(), [5, 10]).items as {
      level: number;
      label: string;
      price: number;
    }[];
    expect(items.map((i) => i.label)).toEqual(["stop", "+5% target", "+10% target"]);
    expect(items[0].level).toBe(11.25);
    expect(items[1].level).toBe(13.125);
    expect(items.every((i) => i.price === 12.5)).toBe(true);
  });

  it("drops a rung that would price at or below zero instead of letting the route reject it", () => {
    const items = distanceBody(form({ stop: null }), [-100, -150, 10]).items as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(["+10% target"]);
  });
});

describe("the sizing line", () => {
  it("reports capital, stop width and risk from the same three numbers", () => {
    expect(capitalUsd(form())).toBe(5000);
    expect(stopWidthPct(form())).toBe(10);
    expect(riskAtStop(form())).toEqual({ usd: 500, pctOfAccount: 2 });
  });

  /*
   * A stop above a long entry is not a small risk or a negative risk — it is
   * a malformed order. Returning a negative dollar figure would render as a
   * guaranteed profit, so the width keeps its sign (it is a short's geometry
   * and the trader should see that) while the risk refuses.
   */
  it("keeps the sign on an inverted stop but refuses to call it risk", () => {
    const inverted = form({ stop: 13.75 });
    expect(stopWidthPct(inverted)).toBe(-10);
    expect(riskAtStop(inverted)).toBeNull();
  });

  it("gives a dollar risk without an account value, and no percentage", () => {
    expect(riskAtStop(form({ accountValue: null }))).toEqual({ usd: 500, pctOfAccount: null });
  });

  it("returns null rather than zero when the numbers are absent", () => {
    expect(capitalUsd(EMPTY_FORM)).toBeNull();
    expect(stopWidthPct(EMPTY_FORM)).toBeNull();
    expect(riskAtStop(EMPTY_FORM)).toBeNull();
  });
});
