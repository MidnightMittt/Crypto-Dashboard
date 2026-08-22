/**
 * TICKERS THAT MEAN TWO THINGS — declared, because guessing is the worst
 * outcome this platform can produce.
 *
 * `resolveTicker`'s own header says it: *"Guessing produces a confident page
 * about the wrong asset, which is the single worst outcome this platform can
 * produce — worse than no answer."* It then had no concept of a symbol that
 * legitimately means two assets, so it picked one silently. Typing STX served
 * a confident Seagate page to someone who meant the Stacks blockchain, and
 * nothing on it said the other reading existed.
 *
 * ── Why the fix is disambiguation and not re-routing ──────────────────
 *
 * Flipping STX to crypto would break Seagate, a real $850 listing with
 * options, and merely invert who gets the wrong page. Both readings are
 * correct; only the silence is wrong. So the resolver keeps a default — the
 * exchange-listed meaning of a bare symbol — and ALWAYS states the other
 * reading with a route to it.
 *
 * ── Every field below was verified against the provider, not remembered ──
 *
 * Checked 2026-08-22. The check mattered: three tickers in the crypto
 * routing list turned out to shadow real US equities, and two candidates
 * that "obviously" collided (UNI, ALGO) returned no real equity and were
 * dropped rather than declared. A collision table written from memory would
 * have been a second guess wearing a first one's authority.
 */

export interface CollisionMeaning {
  kind: "equity" | "crypto";
  /** What the asset actually is, as the provider names it. */
  label: string;
  /** The symbol that FETCHES this meaning. Not always the typed one. */
  providerSymbol: string;
  /** Where this reading lives on the site. */
  href: string;
  /** Price seen at verification, so a future reader can tell if this rotted. */
  verifiedPrice: number;
}

export interface TickerCollision {
  symbol: string;
  meanings: CollisionMeaning[];
  /** Index into `meanings` that a BARE symbol resolves to, and why. */
  servedIndex: number;
  servedBecause: string;
  /**
   * The way this collision costs money, when it has one. Named because a
   * mistaken identity is cheap until something tradeable shares the name.
   */
  hazard?: string;
}

/**
 * FRIENDLY NAMES for assets whose provider symbol nobody would guess.
 *
 * Yahoo already disambiguated Stacks by appending a number — it serves
 * Stacks as `STX4847-USD`, while plain `STX-USD` is STOX, a different and
 * effectively dead token at $0.0028. So "route STX to crypto" would have
 * produced a WORSE error than Seagate: same asset class, wrong coin, and no
 * signal to the reader that anything was off. Typing the name works instead.
 */
export const CRYPTO_ALIASES: Record<string, { providerSymbol: string; label: string }> = {
  STACKS: { providerSymbol: "STX4847-USD", label: "Stacks" },
  STX4847: { providerSymbol: "STX4847-USD", label: "Stacks" },
};

/** Verified 2026-08-22 against the daily-bar provider. */
export const TICKER_COLLISIONS: readonly TickerCollision[] = [
  {
    symbol: "STX",
    meanings: [
      {
        kind: "equity",
        label: "Seagate Technology Holdings plc",
        providerSymbol: "STX",
        href: "/asset/STX",
        verifiedPrice: 850.0,
      },
      {
        kind: "crypto",
        label: "Stacks (the Bitcoin L2)",
        providerSymbol: "STX4847-USD",
        href: "/asset/STACKS",
        verifiedPrice: 0.2216,
      },
    ],
    servedIndex: 0,
    servedBecause:
      "STX is Seagate's listed ticker, so a bare STX is served as the equity. Stacks is one click away and is NOT reachable as plain STX-USD — that symbol is Stox, a different token at $0.0028.",
    hazard:
      "STXL, STXX and STXU are 2x-long ETFs on SEAGATE — enterprise storage, not Stacks — and all three carry \"STX\" in their names. Buying one expecting leveraged Bitcoin-L2 exposure gets a doubled bet on hard drives, and a datacenter rally would make the chart look right the whole time you held the wrong asset.",
  },
  {
    symbol: "LINK",
    meanings: [
      {
        kind: "crypto",
        label: "Chainlink",
        providerSymbol: "LINK-USD",
        href: "/asset/LINK",
        verifiedPrice: 0,
      },
      {
        kind: "equity",
        label: "Interlink Electronics, Inc.",
        providerSymbol: "LINK",
        href: "/asset/LINK",
        verifiedPrice: 5.08,
      },
    ],
    servedIndex: 0,
    servedBecause:
      "LINK is routed to Chainlink because that is overwhelmingly the intended asset, but Interlink Electronics trades on the same ticker at $5.08.",
  },
  {
    symbol: "ATOM",
    meanings: [
      {
        kind: "crypto",
        label: "Cosmos",
        providerSymbol: "ATOM-USD",
        href: "/asset/ATOM",
        verifiedPrice: 0,
      },
      {
        kind: "equity",
        label: "Atomera Incorporated",
        providerSymbol: "ATOM",
        href: "/asset/ATOM",
        verifiedPrice: 4.78,
      },
    ],
    servedIndex: 0,
    servedBecause:
      "ATOM is routed to Cosmos, but Atomera Incorporated trades on the same ticker at $4.78.",
  },
  {
    symbol: "APT",
    meanings: [
      {
        kind: "crypto",
        label: "Aptos",
        providerSymbol: "APT-USD",
        href: "/asset/APT",
        verifiedPrice: 0,
      },
      {
        kind: "equity",
        label: "Alpha Pro Tech, Ltd.",
        providerSymbol: "APT",
        href: "/asset/APT",
        verifiedPrice: 5.21,
      },
    ],
    servedIndex: 0,
    servedBecause:
      "APT is routed to Aptos, but Alpha Pro Tech trades on the same ticker at $5.21.",
  },
];

const BY_SYMBOL = new Map(TICKER_COLLISIONS.map((c) => [c.symbol, c]));

export function collisionFor(symbol: string): TickerCollision | null {
  return BY_SYMBOL.get(symbol.toUpperCase()) ?? null;
}

/** The reading NOT being served — what the banner offers as the alternative. */
export function otherMeanings(c: TickerCollision): CollisionMeaning[] {
  return c.meanings.filter((_, i) => i !== c.servedIndex);
}
