import { describe, expect, it } from "vitest";
import { normaliseInput, resolveTicker } from "./resolveTicker";

describe("normaliseInput", () => {
  it("handles what people actually type", () => {
    expect(normaliseInput("  aapl ").symbol).toBe("AAPL");
    expect(normaliseInput("$NVDA").symbol).toBe("NVDA");
    expect(normaliseInput("brk.b").symbol).toBe("BRK.B");
  });

  it("recognises every common crypto pair spelling", () => {
    for (const form of ["BTC-USD", "btc/usd", "BTC-USDT", "sol-usdc"]) {
      const r = normaliseInput(form);
      expect(r.explicitCrypto, form).toBe(true);
    }
    expect(normaliseInput("BTC-USD").symbol).toBe("BTC");
    expect(normaliseInput("sol/usd").symbol).toBe("SOL");
  });

  it("does not mistake a hyphenated equity ticker for a crypto pair", () => {
    // Class shares and some foreign listings carry hyphens.
    const r = normaliseInput("RDS-A");
    expect(r.explicitCrypto).toBe(false);
    expect(r.symbol).toBe("RDS-A");
  });
});

describe("resolveTicker", () => {
  it("sends index ETFs to their existing validated page rather than re-deriving them live", () => {
    const r = resolveTicker("spy");
    expect(r.kind).toBe("precomputed-equity");
    if (r.kind === "precomputed-equity") expect(r.href).toBe("/markets/spy");
  });

  it("resolves an ordinary US listing to a live equity fetch", () => {
    const r = resolveTicker("AAPL");
    expect(r.kind).toBe("equity");
    if (r.kind === "equity") {
      expect(r.providerSymbol).toBe("AAPL");
      expect(r.inTrackedIndustry).toBe(false);
    }
  });

  it("flags a name that belongs to a tracked industry, so sector context can be shown", () => {
    const r = resolveTicker("NVDA");
    expect(r.kind).toBe("equity");
    if (r.kind === "equity") expect(r.inTrackedIndustry).toBe(true);
  });

  it("recognises the datacenter/mining names added to the taxonomy", () => {
    for (const sym of ["IREN", "CIFR", "WULF", "HUT", "BTDR", "MARA"]) {
      const r = resolveTicker(sym);
      expect(r.kind, sym).toBe("equity");
      if (r.kind === "equity") expect(r.inTrackedIndustry, sym).toBe(true);
    }
  });

  it("routes crypto to the crypto path and marks where derivatives actually exist", () => {
    const btc = resolveTicker("BTC");
    expect(btc.kind).toBe("crypto");
    if (btc.kind === "crypto") {
      expect(btc.providerSymbol).toBe("BTC-USD");
      expect(btc.hasDerivatives).toBe(true);
    }

    const sol = resolveTicker("SOL");
    expect(sol.kind).toBe("crypto");
    // SOL has price data but no funding/OI picture on this platform — the
    // page must not imply a derivatives read it cannot produce.
    if (sol.kind === "crypto") expect(sol.hasDerivatives).toBe(false);
  });

  it("honours explicit pair notation even for a coin not on the known list", () => {
    const r = resolveTicker("PEPE-USD");
    expect(r.kind).toBe("crypto");
    if (r.kind === "crypto") expect(r.providerSymbol).toBe("PEPE-USD");
  });

  it("refuses empty and company-name input with an instruction, not an error code", () => {
    const empty = resolveTicker("   ");
    expect(empty.kind).toBe("invalid");
    if (empty.kind === "invalid") expect(empty.reason).toContain("Type a ticker");

    const name = resolveTicker("Apple Incorporated");
    expect(name.kind).toBe("invalid");
    if (name.kind === "invalid") expect(name.reason).toContain("not the company name");
  });

  it("never silently guesses — every input lands in exactly one kind", () => {
    /*
     * The failure this module exists to prevent is a confident page about
     * the WRONG asset. Every branch must be reachable and disjoint.
     */
    const kinds = ["AAPL", "SPY", "BTC", "ETH-USD", "", "a-very-long-symbol-here"].map(
      (s) => resolveTicker(s).kind
    );
    expect(kinds).toEqual([
      "equity",
      "precomputed-equity",
      "crypto",
      "crypto",
      "invalid",
      "invalid",
    ]);
  });
});
