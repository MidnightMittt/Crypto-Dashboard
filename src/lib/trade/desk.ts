/**
 * THE TRADE DESK — one form, four endpoints, one decision.
 *
 * ── Why this is one page and not fifteen ──────────────────────────────
 *
 * Fifteen API routes had no UI. The obvious build is a "Research" page with
 * fifteen cards on it, and it is the wrong build: the charter's first rule is
 * that nothing appears because it exists, and a grid of endpoint explorers is
 * the definition of appearing because it exists. Worse, four of those routes
 * answer ONE question between them and answer it in sequence — a card each
 * would make the trader type the same symbol four times and then do the
 * chaining in their head.
 *
 * The question is "I am thinking about this trade — talk me out of it", and
 * the four routes are its four stages:
 *
 *   1. exit/design    where can the stop even GO, before you pick one
 *   2. pretrade/check every reason not to place the order you then typed
 *   3. cost/express   which instrument needs the smallest move to break even
 *   4. distance       how often price actually touches the levels you chose
 *
 * Stage 1's answer is stage 2's input. That dependency is the whole argument:
 * these are not four tools, they are four questions in an order, and the
 * order is the product.
 *
 * The other eleven routes are not homeless, they are differently-homed —
 * /api/record and /api/rules/ledger answer "did we work", which is
 * /validation; /api/screen/reach answers "what should I look at", which
 * precedes this page and belongs with the scanner; /api/health is operations;
 * /api/asset and /api/positioning are the JSON behind pages that already
 * render. Wiring them HERE would have produced a dashboard, which is the one
 * thing the charter says this product must not feel like.
 *
 * ── Why the request shaping lives here and not in the component ───────
 *
 * Four endpoints, four different body conventions, built from one form. That
 * is four chances to send `quantity` where the route reads `shares` — the
 * exact defect that once let /api/pretrade/check silently zero an entire
 * held book because /api/portfolio spells the same concept differently. Pure
 * functions with tests are the only way that mismatch fails loudly instead of
 * looking like an empty answer.
 */

export interface DeskForm {
  symbol: string;
  accountValue: number | null;
  shares: number | null;
  entry: number | null;
  stop: number | null;
  holdSessions: number;
}

export const DEFAULT_HOLD_SESSIONS = 20;

export const EMPTY_FORM: DeskForm = {
  symbol: "",
  accountValue: null,
  shares: null,
  entry: null,
  stop: null,
  holdSessions: DEFAULT_HOLD_SESSIONS,
};

/**
 * A stage either has what it needs or names what it is missing.
 *
 * Deliberately NOT a boolean. "Not ready" and "not ready because you have not
 * entered a stop" are different messages, and a disabled panel with no reason
 * is indistinguishable from a broken one — which is how a working endpoint
 * reads as an outage.
 */
export type StageGate = { ready: true } | { ready: false; missing: string[] };

const positive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

function gate(pairs: [string, boolean][]): StageGate {
  const missing = pairs.filter(([, ok]) => !ok).map(([label]) => label);
  return missing.length === 0 ? { ready: true } : { ready: false, missing };
}

/**
 * Stage 1 asks only for a symbol, and that is the point: it answers BEFORE
 * the trader has chosen a stop, so its answer is what they choose from.
 */
export function exitGate(f: DeskForm): StageGate {
  return gate([
    ["a symbol", f.symbol.trim().length > 0],
    ["a hold length", positive(f.holdSessions)],
  ]);
}

export function checkGate(f: DeskForm): StageGate {
  return gate([
    ["a symbol", f.symbol.trim().length > 0],
    ["account value", positive(f.accountValue)],
    ["share count", positive(f.shares)],
    ["an entry price", positive(f.entry)],
    ["a stop price", positive(f.stop)],
  ]);
}

export function costGate(f: DeskForm): StageGate {
  return gate([
    ["a symbol", f.symbol.trim().length > 0],
    ["an entry price", positive(f.entry)],
  ]);
}

export function distanceGate(f: DeskForm): StageGate {
  return gate([
    ["a symbol", f.symbol.trim().length > 0],
    ["an entry price", positive(f.entry)],
    ["a stop price", positive(f.stop)],
  ]);
}

export const normalizeSymbol = (s: string): string => s.trim().toUpperCase();

/** POST /api/exit/design */
export function exitBody(f: DeskForm): Record<string, unknown> {
  return {
    symbol: normalizeSymbol(f.symbol),
    hold_sessions: f.holdSessions,
    ...(positive(f.accountValue) ? { account_value: f.accountValue } : {}),
    ...(positive(f.entry) && positive(f.stop)
      ? { stop_pct: Number((((f.entry - f.stop) / f.entry) * 100).toFixed(4)) }
      : {}),
  };
}

/**
 * POST /api/pretrade/check.
 *
 * `shares`, not `quantity`. The two routes spell the same concept
 * differently and this is the seam where that costs something.
 */
export function checkBody(f: DeskForm): Record<string, unknown> {
  return {
    symbol: normalizeSymbol(f.symbol),
    shares: f.shares,
    entry: f.entry,
    stop: f.stop,
    hold_sessions: f.holdSessions,
    account_value: f.accountValue,
  };
}

/**
 * POST /api/cost/express, equity leg only.
 *
 * No bid/ask is sent because the desk has none to send. The route measures
 * the round trip from committed spread history when the quote is absent,
 * which is a measurement; inventing a spread around the entry price would be
 * a fabrication that renders identically.
 */
export function costBody(f: DeskForm): Record<string, unknown> {
  return {
    candidates: [
      {
        kind: "equity",
        symbol: normalizeSymbol(f.symbol),
        label: `${normalizeSymbol(f.symbol)} shares`,
      },
    ],
  };
}

/**
 * POST /api/distance — the levels the trader actually typed, plus the rungs
 * stage 1 proposed. Levels at or below zero are dropped here rather than
 * sent: the route would reject them row by row, and a rejection the desk
 * could have predicted is noise, not information.
 */
export function distanceBody(f: DeskForm, targetPcts: readonly number[] = []): Record<string, unknown> {
  const symbol = normalizeSymbol(f.symbol);
  const entry = f.entry as number;
  const items: { symbol: string; price: number; level: number; label: string }[] = [];

  if (positive(f.stop)) items.push({ symbol, price: entry, level: f.stop, label: "stop" });
  for (const pct of targetPcts) {
    const level = Number((entry * (1 + pct / 100)).toFixed(4));
    if (level > 0) items.push({ symbol, price: entry, level, label: `+${pct}% target` });
  }
  return { items };
}

/**
 * The stop width the trader has chosen, as a percent of entry. Negative when
 * the stop sits ABOVE entry — which is a short's geometry, and the desk
 * shows the sign rather than taking an absolute value, because a long with
 * an inverted stop and a short are the same two numbers and opposite trades.
 */
export function stopWidthPct(f: DeskForm): number | null {
  if (!positive(f.entry) || !positive(f.stop)) return null;
  return Number((((f.entry - f.stop) / f.entry) * 100).toFixed(2));
}

/** Capital the order ties up, for the sizing line beside the form. */
export function capitalUsd(f: DeskForm): number | null {
  if (!positive(f.entry) || !positive(f.shares)) return null;
  return Number((f.entry * f.shares).toFixed(2));
}

/**
 * Loss at the stop, in dollars and as a share of the account.
 *
 * Null when the stop is inverted rather than a negative "risk": a number
 * that goes negative here reads as a guaranteed profit, and the honest
 * answer to "how much do I lose at a stop above my long entry" is that the
 * question is malformed.
 */
export function riskAtStop(f: DeskForm): { usd: number; pctOfAccount: number | null } | null {
  const width = stopWidthPct(f);
  if (width === null || width <= 0 || !positive(f.shares) || !positive(f.entry)) return null;
  const usd = Number(((f.entry - (f.stop as number)) * f.shares).toFixed(2));
  return {
    usd,
    pctOfAccount: positive(f.accountValue) ? Number(((usd / f.accountValue) * 100).toFixed(2)) : null,
  };
}
