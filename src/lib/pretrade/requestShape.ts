import { parseOptionLeg } from "@/lib/portfolio/buildPortfolio";

/**
 * THE REQUEST SHAPE, DECLARED ONCE — what /api/pretrade/check takes, what
 * each field unlocks, and every defect in a body named in one pass.
 *
 * Measured cost of not having this: a caller discovering the endpoint cold
 * took FOUR round trips to a first successful audit — symbol, then
 * account_value, then the equity-or-option requirement, then the
 * per-contract premium. Every error named its own fix, which is why the
 * sequence terminated at all, but each 400 revealed exactly one field. At
 * market open that cadence is the difference between a check that gets run
 * and a check that gets skipped, and an audit that is skipped protects
 * nobody.
 *
 * Two consumers, one truth:
 *
 *  - `collectShapeDefects` names EVERY defect in a body at once, so the
 *    worst cold start is one 400 listing the requirements and one listing
 *    the option leg's internals — not one per field.
 *  - `REQUEST_SHAPE` is returned by GET on the same path, so the shape can
 *    be read before the first POST is ever sent. It also names what each
 *    OPTIONAL field unlocks, because the second measured failure was a
 *    caller receiving `unknown` on two checks purely for not knowing the
 *    budget fields existed.
 */

/**
 * What GET /api/pretrade/check returns. Field-for-field, this documents the
 * same validation `collectShapeDefects` enforces — they live in one file so
 * the document and the enforcement cannot drift apart silently.
 */
export const REQUEST_SHAPE = {
  endpoint: "POST /api/pretrade/check",
  purpose:
    "Every reason not to place this trade, at once, from committed artifacts. " +
    "Verdict is block / incomplete / pass; incomplete is NOT a pass.",
  required: {
    symbol: "Ticker, e.g. \"CLSK\".",
    account_value: "Total account value in USD. Every cap is judged against it.",
    one_of: {
      equity: {
        shares: "Position size about to be placed.",
        entry: "Intended entry price.",
        stop: "Intended stop price. The width is measured against this name's own bars.",
      },
      option: {
        option_order: {
          right: "\"call\" or \"put\". Long single-leg only — a sold option is refused, not audited.",
          strike: "Strike price.",
          expiry: "YYYY-MM-DD.",
          delta: "The leg's delta, as posted by your chain. A call's lies in (0,1], a put's in [-1,0).",
          premium: "PER-CONTRACT premium: 0.86, not 86. Multiplied by 100 internally.",
          contracts: "Positive integer. Defaults to 1.",
          multiplier: "Optional, defaults to 100.",
        },
      },
    },
  },
  optional: {
    hold_sessions: "Equity path. Sessions the stop must survive. Defaults to 20.",
    edge_bp:
      "Equity path. Your claimed edge in basis points. UNLOCKS the cost check — " +
      "without it, cost reports unknown because the site will not invent your edge.",
    hard_floor_usd:
      "Option path, with concurrent_positions. Your risk policy floor. UNLOCKS the " +
      "max_loss_vs_budget verdict — without it the loss is stated but not judged.",
    concurrent_positions: "Option path, with hard_floor_usd. Positions the budget is split across.",
    min_breakeven_reach_pct:
      "Option path. Your floor for the measured probability of reaching breakeven, 0-100. " +
      "UNLOCKS the breakeven_reach verdict — the site measures the probability, only you " +
      "know the payoff you expect beyond it.",
    buying_power: "UNLOCKS the reachability check: can this order actually be placed.",
    live_price: {
      _:
        "All three fields or none. UNLOCKS freshness judged on the market instead of the " +
        "stored close, and is the only price source for a symbol outside the bars panel.",
      value: "The price.",
      as_of: "ISO timestamp it was quoted at.",
      source: "Where it came from, e.g. \"broker_bid\".",
    },
    existing_positions:
      "The held book, one row per position ({symbol, shares, price} or {symbol, contracts, " +
      "premium, option:{...}}). UNLOCKS book-aware beta_exposure and deployment_cap — " +
      "without it both are judged against an empty book, which understates them.",
  },
  examples: {
    equity: {
      symbol: "CLSK",
      account_value: 4200,
      shares: 40,
      entry: 12.4,
      stop: 11.15,
      hold_sessions: 20,
      edge_bp: 120,
      buying_power: 900,
    },
    option: {
      symbol: "CLSK",
      account_value: 4200,
      hard_floor_usd: 3800,
      concurrent_positions: 4,
      min_breakeven_reach_pct: 25,
      buying_power: 900,
      option_order: {
        right: "call",
        strike: 14,
        expiry: "2026-10-16",
        delta: 0.38,
        premium: 0.86,
        contracts: 1,
      },
    },
  },
  coverage:
    "A symbol outside the committed bars panel (declared in " +
    "src/lib/markets/scannerUniverse.ts) gets a PARTIAL audit, not a refusal: checks " +
    "needing only the order and account run in full; checks needing history report " +
    "unknown and the response's `coverage` block names each one. Supply live_price to " +
    "recover the spot-dependent checks.",
} as const;

/**
 * Every shape defect in the body, named in one pass.
 *
 * Deliberately does NOT stop at the first problem: the cost of this endpoint
 * is round trips, not CPU. Semantic refusals — a sold option, an unknown
 * symbol — are not shape defects and stay in the route: they are judgements
 * about a well-formed request, and their wording is part of the audit.
 */
export function collectShapeDefects(body: Record<string, unknown>, nowMs: number): string[] {
  const defects: string[] = [];

  const symbol = String(body.symbol ?? "").trim();
  if (!symbol) defects.push('symbol is required, e.g. "CLSK"');
  if (!Number.isFinite(Number(body.account_value))) {
    defects.push("account_value is required and must be numeric — every cap is judged against it");
  }

  const isOptionOrder = body.option_order !== undefined && body.option_order !== null;

  if (!isOptionOrder) {
    const equityMissing = (["shares", "entry", "stop"] as const).filter(
      (k) => !Number.isFinite(Number(body[k]))
    );
    if (equityMissing.length > 0) {
      defects.push(
        `${equityMissing.join(", ")} ${equityMissing.length === 1 ? "is" : "are"} required ` +
          `for an equity audit — or send option_order for a defined-risk option audit`
      );
    }
  } else {
    const oo = body.option_order as Record<string, unknown>;
    const contracts = oo.contracts === undefined || oo.contracts === null ? 1 : Number(oo.contracts);
    if (!Number.isInteger(contracts) || contracts < 1) {
      defects.push(`option_order.contracts must be a positive integer, got ${String(oo.contracts)}`);
    }
    const premium = Number(oo.premium);
    if (!(Number.isFinite(premium) && premium > 0)) {
      defects.push("option_order.premium is required: the PER-CONTRACT premium (0.86, not 86)");
    }
    /*
     * The same validator the portfolio and the held book use, so a leg
     * cannot be valid to one path and invalid to another. It aggregates its
     * own missing fields into one reason, which is folded in here rather
     * than surfaced on a later round trip.
     */
    const leg = parseOptionLeg(
      symbol || "?",
      {
        strike: oo.strike === undefined || oo.strike === null ? undefined : Number(oo.strike),
        expiry: typeof oo.expiry === "string" ? oo.expiry : undefined,
        right: typeof oo.right === "string" ? oo.right : undefined,
        delta: oo.delta === undefined || oo.delta === null ? undefined : Number(oo.delta),
        multiplier:
          oo.multiplier === undefined || oo.multiplier === null ? undefined : Number(oo.multiplier),
      },
      nowMs
    );
    if (!leg.ok) defects.push(leg.reason);
  }

  if (body.hold_sessions !== undefined && body.hold_sessions !== null) {
    const hs = Number(body.hold_sessions);
    if (!(Number.isFinite(hs) && hs >= 1)) {
      defects.push(`hold_sessions must be a positive number of sessions, got ${String(body.hold_sessions)}`);
    }
  }

  /*
   * live_price is all-or-nothing. A supplied price without an as_of cannot
   * be dated; without a source it cannot be argued with. Accepting a partial
   * one and quietly falling back would be the exact failure this endpoint
   * already had once: a field accepted and silently unused.
   */
  if (body.live_price !== undefined && body.live_price !== null) {
    const lp = body.live_price as Record<string, unknown>;
    const lpDefects: string[] = [];
    if (!(Number.isFinite(Number(lp.value)) && Number(lp.value) > 0)) {
      lpDefects.push("value must be a positive number");
    }
    if (typeof lp.as_of !== "string" || !Number.isFinite(Date.parse(lp.as_of))) {
      lpDefects.push("as_of must be an ISO timestamp");
    }
    if (typeof lp.source !== "string" || !lp.source.trim()) {
      lpDefects.push("source must name where the price came from (e.g. broker_bid)");
    }
    if (lpDefects.length > 0) {
      defects.push(
        `live_price is incomplete: ${lpDefects.join("; ")}. Send all three or none: ` +
          `{"live_price":{"value":15.75,"as_of":"2026-08-21T19:59:59Z","source":"broker_bid"}}`
      );
    }
  }

  return defects;
}
