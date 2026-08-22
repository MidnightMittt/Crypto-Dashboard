import { INDUSTRIES } from "@/lib/markets/industries";
import { CRYPTO_ALIASES, TickerCollision, collisionFor } from "./tickerCollisions";

/**
 * WHAT DID THE USER JUST TYPE?
 *
 * The search box accepts anything. Before a single byte is fetched, this
 * decides what the string IS — a US listing, a crypto asset, or something
 * this platform cannot answer for — and where its data would come from.
 *
 * ── Why a resolver rather than "just try Yahoo" ───────────────────────
 *
 * Because the failure modes differ and the user needs to know which one hit
 * them. "BTC" typed into an equity endpoint returns a real, wrong series
 * (there was a shell company on that ticker). A typo returns an empty
 * result that looks identical to a delisted name. Guessing produces a
 * confident page about the wrong asset, which is the single worst outcome
 * this platform can produce — worse than no answer.
 *
 * ── The precomputed shortcut ──────────────────────────────────────────
 *
 * A handful of symbols already have a full daily-refreshed page built from
 * validated bars (the index ETFs). Those resolve to `precomputed` so search
 * sends the user to the better page rather than re-deriving a thinner
 * version of it live.
 */

/** Symbols with a committed, validated, daily-refreshed snapshot page. */
const PRECOMPUTED_EQUITIES = new Set(["SPY", "QQQ", "DIA", "IWM"]);

/**
 * Crypto assets this platform has a real derivatives picture for. Typing one
 * of these gets funding, open interest, basis and CVD on top of the price
 * layer; anything else crypto gets the price layer alone and says so.
 */
const DEEP_CRYPTO = new Set(["BTC", "ETH"]);

/**
 * Common crypto tickers, used ONLY to route a bare symbol that would
 * otherwise be ambiguous. Deliberately short: this is a disambiguation aid,
 * not a supported-asset list — an unlisted coin still resolves as crypto if
 * the user types the `-USD` form, and the fetch is what finally decides
 * whether data exists.
 */
const KNOWN_CRYPTO = new Set([
  "BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "DOT",
  "MATIC", "LTC", "TRX", "SHIB", "UNI", "ATOM", "XLM", "NEAR", "APT", "ARB",
  "OP", "SUI", "SEI", "TIA", "INJ", "FIL", "ICP", "HBAR", "VET", "ALGO",
]);

export type ResolvedTicker =
  | {
      kind: "precomputed-equity";
      symbol: string;
      /** Route to the existing, validated snapshot page. */
      href: string;
    }
  | {
      kind: "equity";
      symbol: string;
      /** Yahoo's symbol for the fetch — identical for plain US listings. */
      providerSymbol: string;
      /** True when this name is a constituent of a tracked industry, which adds sector context. */
      inTrackedIndustry: boolean;
      /** Present when this ticker legitimately names another asset too. */
      collision?: TickerCollision;
    }
  | {
      kind: "crypto";
      symbol: string;
      /** Yahoo quotes crypto as `<SYM>-USD`, except where it has disambiguated a collision itself. */
      providerSymbol: string;
      /** True when the derivatives layer (funding, OI, basis) is genuinely available. */
      hasDerivatives: boolean;
      /** Present when this ticker legitimately names another asset too. */
      collision?: TickerCollision;
    }
  | { kind: "invalid"; input: string; reason: string };

/** Every ticker that appears anywhere in the industry taxonomy, for the context flag. */
const INDUSTRY_MEMBERS = new Set<string>(
  INDUSTRIES.flatMap((i) => [i.etf, ...i.constituents])
);

/**
 * Normalises what people actually type: lower case, "$AAPL", stray spaces,
 * and the "BTC-USD" / "BTC/USD" / "BTCUSD" family.
 */
export function normaliseInput(raw: string): { symbol: string; explicitCrypto: boolean } {
  const trimmed = raw.trim().toUpperCase().replace(/^\$/, "");

  // Explicit crypto pair notation, in any of the three common spellings.
  const pair = trimmed.match(/^([A-Z0-9]{2,10})[-/](USD|USDT|USDC)$/);
  if (pair) return { symbol: pair[1], explicitCrypto: true };

  return { symbol: trimmed.replace(/[^A-Z0-9.\-]/g, ""), explicitCrypto: false };
}

export function resolveTicker(raw: string): ResolvedTicker {
  const { symbol, explicitCrypto } = normaliseInput(raw);

  if (symbol.length === 0) {
    return { kind: "invalid", input: raw, reason: "Type a ticker symbol to analyse — for example AAPL, NVDA, or BTC." };
  }
  if (symbol.length > 10) {
    return {
      kind: "invalid",
      input: raw,
      reason: `“${raw.trim()}” is too long to be a ticker. Search takes the symbol itself, not the company name.`,
    };
  }

  /*
   * A NAMED ASSET WHOSE PROVIDER SYMBOL NOBODY WOULD GUESS.
   *
   * Checked before every other branch because the provider has already
   * disambiguated some collisions itself: Stacks is served as
   * `STX4847-USD`, while plain `STX-USD` is Stox, a different token at
   * $0.0028. Routing a bare STX to "crypto" would therefore have produced
   * a worse error than serving Seagate — right asset class, wrong coin,
   * and nothing on the page to say so.
   */
  const alias = CRYPTO_ALIASES[symbol];
  if (alias) {
    return {
      kind: "crypto",
      symbol,
      providerSymbol: alias.providerSymbol,
      hasDerivatives: DEEP_CRYPTO.has(symbol),
      collision: collisionFor(symbol) ?? undefined,
    };
  }

  if (explicitCrypto || (KNOWN_CRYPTO.has(symbol) && !PRECOMPUTED_EQUITIES.has(symbol))) {
    return {
      kind: "crypto",
      symbol,
      providerSymbol: `${symbol}-USD`,
      hasDerivatives: DEEP_CRYPTO.has(symbol),
      collision: collisionFor(symbol) ?? undefined,
    };
  }

  if (PRECOMPUTED_EQUITIES.has(symbol)) {
    return { kind: "precomputed-equity", symbol, href: `/markets/${symbol.toLowerCase()}` };
  }

  return {
    kind: "equity",
    symbol,
    providerSymbol: symbol,
    inTrackedIndustry: INDUSTRY_MEMBERS.has(symbol),
    collision: collisionFor(symbol) ?? undefined,
  };
}
