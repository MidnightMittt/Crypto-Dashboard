import { describe, expect, it } from "vitest";
import {
  MAX_WATCHLIST,
  add,
  contains,
  isFull,
  normalise,
  normaliseSymbol,
  remove,
  toggle,
} from "./watchlist";

describe("normaliseSymbol", () => {
  it("upper-cases and trims", () => {
    expect(normaliseSymbol("  aapl ")).toBe("AAPL");
  });

  /*
   * People paste from other terminals. $AAPL is a StockTwits/X convention and
   * AAPL.US is this repo's own ingest suffix — a user typing either means the
   * same instrument, and admitting three spellings of one ticker would let
   * the same name occupy three watchlist slots.
   */
  it("strips the decorations tickers arrive wearing", () => {
    expect(normaliseSymbol("$NVDA")).toBe("NVDA");
    expect(normaliseSymbol("AAPL.US")).toBe("AAPL");
    expect(normaliseSymbol("BTC-USD.SPOT")).toBe("BTC-USD");
  });

  it("keeps the separators real tickers use", () => {
    expect(normaliseSymbol("BRK.B")).toBe("BRK.B");
    expect(normaliseSymbol("BTC-USD")).toBe("BTC-USD");
  });

  it("returns null rather than a guess for things that are not tickers", () => {
    for (const bad of ["", "   ", "!!", "a b", "TOOLONGSYMBOLHERE", "<script>"]) {
      expect(normaliseSymbol(bad), bad).toBeNull();
    }
  });
});

describe("normalise", () => {
  it("de-duplicates across spellings of the same ticker", () => {
    expect(normalise(["aapl", "$AAPL", "AAPL.US"])).toEqual(["AAPL"]);
  });

  it("drops unusable entries instead of failing the whole list", () => {
    expect(normalise(["NVDA", "", "!!", "MU"])).toEqual(["NVDA", "MU"]);
  });

  /*
   * Insertion order is information: the list is a queue of attention, and
   * what was added last is what is being thought about. Sorting would throw
   * that away for free.
   */
  it("preserves insertion order rather than sorting", () => {
    expect(normalise(["MU", "AAPL", "NVDA"])).toEqual(["MU", "AAPL", "NVDA"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_WATCHLIST + 10 }, (_, i) => `SYM${i}`);
    expect(normalise(many)).toHaveLength(MAX_WATCHLIST);
  });
});

describe("add", () => {
  /*
   * Front-insertion is the load-bearing choice. Appending would make the cap
   * evict nothing and refuse everything new once full — the freshest interest
   * losing to one added months ago.
   */
  it("adds to the front", () => {
    expect(add(["AAPL", "MU"], "NVDA")).toEqual(["NVDA", "AAPL", "MU"]);
  });

  it("moves an existing symbol to the front rather than duplicating it", () => {
    expect(add(["AAPL", "MU", "NVDA"], "NVDA")).toEqual(["NVDA", "AAPL", "MU"]);
  });

  it("evicts the stalest entry when full", () => {
    const full = Array.from({ length: MAX_WATCHLIST }, (_, i) => `SYM${i}`);
    const next = add(full, "NVDA");
    expect(next).toHaveLength(MAX_WATCHLIST);
    expect(next[0]).toBe("NVDA");
    expect(next).not.toContain(`SYM${MAX_WATCHLIST - 1}`);
  });

  it("leaves the list untouched for an unusable symbol", () => {
    expect(add(["AAPL"], "!!")).toEqual(["AAPL"]);
  });
});

describe("remove and toggle", () => {
  it("removes by any spelling", () => {
    expect(remove(["AAPL", "MU"], "$aapl")).toEqual(["MU"]);
  });

  it("removing something absent is a no-op, not an error", () => {
    expect(remove(["AAPL"], "NVDA")).toEqual(["AAPL"]);
  });

  it("toggle adds then removes, returning to the start", () => {
    const once = toggle(["AAPL"], "NVDA");
    expect(once).toEqual(["NVDA", "AAPL"]);
    expect(toggle(once, "NVDA")).toEqual(["AAPL"]);
  });
});

describe("contains and isFull", () => {
  it("matches regardless of how the symbol is written", () => {
    expect(contains(["AAPL"], "aapl.us")).toBe(true);
    expect(contains(["AAPL"], "NVDA")).toBe(false);
  });

  it("reports fullness so a UI can explain a refusal instead of doing nothing", () => {
    expect(isFull([])).toBe(false);
    expect(isFull(Array.from({ length: MAX_WATCHLIST }, (_, i) => `SYM${i}`))).toBe(true);
  });
});
