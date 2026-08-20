/**
 * THE PROTECTIONS THAT MUST OUTLIVE THE SESSION THAT SET THEM.
 *
 * Exits that live at the broker are safe by construction: the broker keeps
 * running. Time-stops and disaster-stops cannot go there — they are
 * conditional on things a broker order cannot express — so today they live
 * inside a trading agent's process and evaporate when it dies. On 2026-08-20
 * that process was down for six hours with open positions and no watcher.
 *
 * This site is the only component that runs independently of that loop, which
 * makes it the correct home for those protections. Everything in this module
 * exists to make one guarantee true: a level, once armed, is still armed after
 * the thing that armed it has gone away — and after this service itself has
 * restarted.
 *
 * ── What this is NOT ──────────────────────────────────────────────────
 *
 * It does not place orders and never will. It watches and it tells you. The
 * distinction matters because a watcher that is wrong costs you a message,
 * while an actor that is wrong costs you a position.
 *
 * ── One-shot, deliberately ────────────────────────────────────────────
 *
 * A level fires ONCE. A stop that re-alerts every sweep while price sits
 * below it produces a stream a human learns to ignore, and an alert channel
 * you have muted is worse than none because you believe you are covered.
 * Re-arming is an explicit act.
 */

export type WatchDirection = "below" | "above";

export interface WatchLevel {
  id: string;
  symbol: string;
  /** The price that matters. Absolute, in dollars — never a percentage. */
  level: number;
  /** `below` for stops and disaster-stops; `above` for targets and breakouts. */
  direction: WatchDirection;
  /** Free text carried into the alert. This is where "why" lives. */
  note: string;
  armedAt: string;
  /** Set once, when it fires. Non-null means spent, not deleted. */
  firedAt: string | null;
  /** The price that tripped it, kept so the alert can be audited later. */
  firedPrice: number | null;
  /**
   * Whether the notification was actually delivered. A fired level with
   * `delivered: false` is the important state: the trigger is recorded and
   * survives, but nobody was told, and GET /api/watch must show it.
   */
  delivered: boolean;
}

/** A price to evaluate against, with the provenance to decide whether to trust it. */
export interface WatchQuote {
  symbol: string;
  price: number;
  /** When the price was true, from the provider. */
  asOf: string;
  /** Age in seconds at evaluation time. */
  ageSeconds: number;
}

/**
 * How old a quote may be and still trip a level.
 *
 * A disaster-stop fired from a stale print is a false alarm at best and, if
 * the stale value drifted back through the level while the real price never
 * did, an instruction to act on something that did not happen. Fifteen
 * minutes matches the alerting cadence this is designed around: any quote
 * older than one sweep interval means the feed, not the market, moved.
 */
export const MAX_QUOTE_AGE_SECONDS = 15 * 60;

export type Breach =
  | { kind: "fired"; level: WatchLevel; quote: WatchQuote; message: string }
  | { kind: "skipped"; level: WatchLevel; reason: string };

/** Armed = not yet fired. The only levels a sweep needs to consider. */
export function isArmed(l: WatchLevel): boolean {
  return l.firedAt === null;
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/**
 * One armed level against one quote.
 *
 * Returns `skipped` with a reason rather than silently doing nothing, so a
 * sweep can report why a level did not fire — "the quote was 40 minutes old"
 * and "price is nowhere near it" are different facts and a stuck feed must
 * not read as a quiet market.
 */
export function evaluateLevel(level: WatchLevel, quote: WatchQuote | null, now: Date): Breach {
  if (!isArmed(level)) {
    return { kind: "skipped", level, reason: `already fired at ${level.firedAt}` };
  }
  if (quote === null) {
    return { kind: "skipped", level, reason: "no quote available for this symbol on this sweep" };
  }
  if (quote.ageSeconds > MAX_QUOTE_AGE_SECONDS) {
    return {
      kind: "skipped",
      level,
      reason:
        `quote is ${Math.round(quote.ageSeconds / 60)} minutes old (limit ` +
        `${MAX_QUOTE_AGE_SECONDS / 60}) — refusing to fire on a price that may not reflect the market`,
    };
  }

  const hit = level.direction === "below" ? quote.price <= level.level : quote.price >= level.level;
  if (!hit) {
    const away = Math.abs(quote.price - level.level);
    return {
      kind: "skipped",
      level,
      reason: `not reached: ${money(quote.price)} is ${money(away)} from ${money(level.level)}`,
    };
  }

  const word = level.direction === "below" ? "fell to" : "rose to";
  return {
    kind: "fired",
    level,
    quote,
    message:
      `${level.symbol} ${word} ${money(quote.price)}, ${level.direction} your ${money(level.level)} level. ` +
      (level.note ? `${level.note} ` : "") +
      `Quote as of ${quote.asOf} (${Math.round(quote.ageSeconds)}s old). ` +
      `This is a watch alert — no order has been placed.`,
  };
}

/** Every armed level against the quotes a sweep gathered. */
export function evaluateAll(
  levels: readonly WatchLevel[],
  quotes: ReadonlyMap<string, WatchQuote>,
  now: Date
): Breach[] {
  return levels.map((l) => evaluateLevel(l, quotes.get(l.symbol) ?? null, now));
}

/** The stored form of a level that has just fired. Never mutates the input. */
export function markFired(level: WatchLevel, quote: WatchQuote, now: Date, delivered: boolean): WatchLevel {
  return { ...level, firedAt: now.toISOString(), firedPrice: quote.price, delivered };
}

/**
 * Validates a registration request. Returns the reason it is unusable, or
 * null when it is fine.
 *
 * Rejecting a malformed level loudly matters more here than in most places:
 * an agent that believes it armed a disaster-stop, and did not, is worse off
 * than one that knows it has no protection.
 */
export function rejectionReason(input: {
  symbol?: unknown;
  level?: unknown;
  direction?: unknown;
}): string | null {
  if (typeof input.symbol !== "string" || input.symbol.trim() === "") {
    return "symbol is required";
  }
  if (typeof input.level !== "number" || !Number.isFinite(input.level) || input.level <= 0) {
    return "level must be a positive number, in dollars";
  }
  if (input.direction !== "below" && input.direction !== "above") {
    return 'direction must be "below" (stop) or "above" (target)';
  }
  return null;
}
