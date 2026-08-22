import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import spreadHistoryJson from "@/data/spreadHistory.json";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { BENCHMARK_SYMBOL } from "@/lib/research/benchmark";
import { DatedReturn, regressOnMarket } from "@/lib/research/alphaBeta";
import { Bar } from "@/lib/research/types";
import { survivalAt } from "@/lib/research/stopViability";
import { latestCompletedSession, sessionsBetween } from "@/lib/asset/priceStaleness";
import { HeldPosition, LivePrice, PretradeInputs, runPretradeChecks } from "@/lib/pretrade/check";
import { parseHeldPositions } from "@/lib/pretrade/parseHeldPositions";
import { BreakevenReach, runOptionOrderChecks } from "@/lib/pretrade/optionOrder";
import { parseOptionLeg } from "@/lib/portfolio/buildPortfolio";
import { reachAt } from "@/lib/research/exitDesign";

/**
 * POST /api/pretrade/check — every reason not to place this trade, at once.
 *
 * Sizing two orders by hand took roughly twenty minutes of Python. The
 * arithmetic was never the hard part; remembering all seven questions under
 * time pressure was. This runs them together, from committed artifacts only,
 * so it answers in milliseconds and cannot be slower than the decision.
 *
 * The engine is pure and lives in src/lib/pretrade/check.ts. This file does
 * one job: turn a symbol into the measurements that engine needs, and say
 * plainly when a measurement does not exist. Every "unknown" below is a real
 * absence rather than a failure to look.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const calendar = earningsJson as EarningsCalendar;
const spreads = (spreadHistoryJson as { observations: SpreadObservation[] }).observations;

interface SpreadObservation {
  session: string;
  symbol: string;
  window: string;
  spreadBp: number;
}

/** Panel rows to Bars, fills excluded — the same rule the asset facts use. */
function realBars(sessions: readonly string[], sp: SymbolPanel): Bar[] {
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({ t: Date.parse(sessions[i]), open: row[0], high: row[1], low: row[2], close: row[3], volume: row[4] });
  }
  return out;
}

/** Daily returns keyed by session, in BASIS POINTS — the unit DatedReturn declares. */
function returns(sessions: readonly string[], sp: SymbolPanel): DatedReturn[] {
  const out: DatedReturn[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const a = sp.bars[i - 1];
    const b = sp.bars[i];
    if (!a || !b || a[3] <= 0) continue;
    out.push({ date: sessions[i], netBp: (b[3] / a[3] - 1) * 10_000 });
  }
  return out;
}

/**
 * Beta against the declared benchmark.
 *
 * Null rather than 1.0 when it cannot be fitted. The engine treats a null
 * beta as UNKNOWN and says so, because assuming 1.0 for a name that actually
 * runs 4.57 understates its market-equivalent size by more than four times —
 * which is the specific error that put a book at 204% of the account while
 * notional read 45%.
 */
function betaOf(symbol: string): number | null {
  const sp = panel.symbols[symbol];
  const bench = panel.symbols[BENCHMARK_SYMBOL];
  if (!sp || !bench) return null;
  const r = regressOnMarket(returns(panel.sessions, sp), returns(panel.sessions, bench));
  return r && Number.isFinite(r.beta) ? Number(r.beta.toFixed(3)) : null;
}

/**
 * Measured round-trip cost: the entry window's spread plus the exit window's.
 *
 * Both legs, because cost lives at the EXIT as much as the entry and a
 * one-sided figure understates it by roughly half. Null unless BOTH windows
 * have observations for this symbol — a round trip priced from one leg is a
 * modelled number wearing a measured one's clothes.
 */
function measuredRoundTripBp(symbol: string): number | null {
  const forWindow = (w: string) => {
    const xs = spreads.filter((o) => o.symbol === symbol && o.window === w).map((o) => o.spreadBp);
    return xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null;
  };
  const entry = forWindow("entry");
  const exit = forWindow("exit");
  if (entry === null || exit === null) return null;
  return Number((entry + exit).toFixed(2));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const shares = Number(body.shares);
  const entry = Number(body.entry);
  const stop = Number(body.stop);
  const holdSessions = Number(body.hold_sessions ?? 20);
  const accountValue = Number(body.account_value);
  const isOptionOrder = body.option_order !== undefined && body.option_order !== null;

  if (!symbol || !Number.isFinite(accountValue)) {
    return NextResponse.json(
      { error: "symbol and account_value are required and must be numeric" },
      { status: 400 }
    );
  }
  if (!isOptionOrder && (!Number.isFinite(shares) || !Number.isFinite(entry) || !Number.isFinite(stop))) {
    return NextResponse.json(
      { error: "shares, entry and stop are required for an equity audit (or send option_order for a defined-risk option audit)" },
      { status: 400 }
    );
  }

  /*
   * live_price is all-or-nothing. A supplied price without an as_of cannot
   * be dated; without a source it cannot be argued with. Accepting a partial
   * one and quietly falling back would be the exact failure this endpoint
   * already had once: a field accepted and silently unused. So a malformed
   * live_price is a 400 naming the defect, never a shrug.
   */
  let livePrice: LivePrice | null = null;
  if (body.live_price !== undefined && body.live_price !== null) {
    const lp = body.live_price as Record<string, unknown>;
    const value = Number(lp.value);
    const asOfMs = typeof lp.as_of === "string" ? Date.parse(lp.as_of) : NaN;
    const source = typeof lp.source === "string" ? lp.source.trim() : "";
    const defects: string[] = [];
    if (!(Number.isFinite(value) && value > 0)) defects.push("value must be a positive number");
    if (!Number.isFinite(asOfMs)) defects.push("as_of must be an ISO timestamp");
    if (!source) defects.push("source must name where the price came from (e.g. broker_bid)");
    if (defects.length > 0) {
      return NextResponse.json(
        {
          error: `live_price is incomplete: ${defects.join("; ")}.`,
          hint: 'Send all three or none: {"live_price":{"value":15.75,"as_of":"2026-08-21T19:59:59Z","source":"broker_bid"}}',
        },
        { status: 400 }
      );
    }
    livePrice = { value, asOfMs, source };
  }

  const sp = panel.symbols[symbol];
  if (!sp) {
    return NextResponse.json(
      {
        error: `${symbol} is not in the positioning universe this endpoint covers.`,
        hint: "Declared in src/lib/markets/scannerUniverse.ts (positioningUniverse).",
      },
      { status: 404 }
    );
  }

  /*
   * Parsed all-or-nothing. This used to read `Number(p.shares) || 0`, and
   * /api/portfolio's convention for the same concept is `quantity` — so a
   * caller reusing that key had every held position silently zeroed, and
   * the concurrent-exposure check compared the trade against an empty book
   * while appearing to have been given one. Two independent audit reports
   * called the check "missing" before the coercion was found. A book this
   * route cannot fully parse is now a 400 naming the row, never a shrink.
   *
   * Option legs are validated by the same function /api/portfolio uses and
   * reduced to the two numbers the engine reads: capital (premium x
   * multiplier — what deployment_cap counts) and market-equivalent
   * (delta-equivalent x the underlying's measured beta — what
   * beta_exposure counts). Beta is MEASURED here rather than trusted from
   * the caller, so the book's exposure is computed the same way for every
   * position; the underlying price is the caller's snapshot when supplied,
   * else our last close.
   */
  const parsedHeld = parseHeldPositions(body.existing_positions, Date.now());
  if (!parsedHeld.ok) {
    return NextResponse.json({ error: parsedHeld.error }, { status: 400 });
  }
  const lastCloseOf = (sym: string): number | null => {
    const held = panel.symbols[sym];
    if (!held) return null;
    const bars = realBars(panel.sessions, held);
    const close = bars[bars.length - 1]?.close;
    return Number.isFinite(close) && close > 0 ? close : null;
  };
  const existingPositions: HeldPosition[] = parsedHeld.positions.map((p) => {
    const beta = betaOf(p.symbol);
    if (p.kind === "equity") {
      const capital = p.shares * p.price;
      return {
        symbol: p.symbol,
        instrument: "equity",
        capitalUsd: capital,
        marketEquivalentUsd: beta === null ? null : capital * beta,
      };
    }
    const underlying = p.underlyingPrice ?? lastCloseOf(p.symbol);
    return {
      symbol: p.symbol,
      instrument: "option",
      capitalUsd: p.contracts * p.premium * p.leg.multiplier,
      marketEquivalentUsd:
        beta === null || underlying === null
          ? null
          : p.contracts * p.leg.delta * p.leg.multiplier * underlying * beta,
    };
  });

  const bars = realBars(panel.sessions, sp);
  const today = latestCompletedSession(new Date());
  const lastSession = panel.sessions[panel.sessions.length - 1] ?? today;
  const priceAgeSessions = sessionsBetween(lastSession, today);
  const buyingPowerUsd = Number.isFinite(Number(body.buying_power)) ? Number(body.buying_power) : null;

  /*
   * ── THE DEFINED-RISK OPTION ORDER AUDIT ─────────────────────────────
   *
   * The account this endpoint serves cannot short, holds ~$137 of buying
   * power, and every name it trades refuses a stop — so the structure it
   * actually places is a bought option, and the order about to be placed
   * deserves the same named-check treatment the equity path has. Long
   * single-leg only: a sold option's downside is not defined-risk and this
   * account cannot margin one, so a sell is refused with the reason rather
   * than audited as if the premium were the whole story.
   */
  if (isOptionOrder) {
    const oo = body.option_order as Record<string, unknown>;
    const orderSide = oo.side === undefined || oo.side === null ? "buy" : String(oo.side).toLowerCase();
    if (orderSide !== "buy") {
      return NextResponse.json(
        {
          error:
            "Only BOUGHT single-leg options are audited: a sold call's downside is unbounded and a " +
            "sold put's is strike-sized — neither is defined-risk, and a cash account cannot margin " +
            "them. This refusal is the audit.",
        },
        { status: 400 }
      );
    }
    const contracts = Number(oo.contracts ?? 1);
    if (!Number.isInteger(contracts) || contracts < 1) {
      return NextResponse.json(
        { error: `option_order.contracts must be a positive integer, got ${String(oo.contracts)}.` },
        { status: 400 }
      );
    }
    const premium = Number(oo.premium);
    if (!(Number.isFinite(premium) && premium > 0)) {
      return NextResponse.json(
        { error: "option_order.premium is required: the PER-CONTRACT premium (0.86, not 86)." },
        { status: 400 }
      );
    }
    // Same validator the portfolio and the held book use — one contract
    // cannot be a valid leg to one path and an invalid one to another.
    const parsedLeg = parseOptionLeg(
      symbol,
      {
        strike: oo.strike === undefined || oo.strike === null ? undefined : Number(oo.strike),
        expiry: typeof oo.expiry === "string" ? oo.expiry : undefined,
        right: typeof oo.right === "string" ? oo.right : undefined,
        delta: oo.delta === undefined || oo.delta === null ? undefined : Number(oo.delta),
        multiplier: oo.multiplier === undefined || oo.multiplier === null ? undefined : Number(oo.multiplier),
      },
      Date.now()
    );
    if (!parsedLeg.ok) {
      return NextResponse.json({ error: parsedLeg.reason }, { status: 400 });
    }
    const leg = parsedLeg.leg;

    const spotValue = livePrice?.value ?? lastCloseOf(symbol);
    const spot =
      spotValue === null
        ? null
        : { value: spotValue, source: livePrice ? `live_price (${livePrice.source})` : "stored_close" };

    /*
     * Tenor in SESSIONS, approximated as calendar days x 5/7 and echoed in
     * inputs_used — the reach machinery counts trading bars, an expiry is a
     * calendar date, and the conversion is stated rather than hidden.
     */
    const calendarDays = Math.max(
      0,
      Math.round((Date.parse(`${leg.expiry}T23:59:59Z`) - Date.now()) / 86_400_000)
    );
    const sessionsToExpiry = Math.max(1, Math.round((calendarDays * 5) / 7));

    /*
     * Breakeven, measured against this name's own bars at the tenor-matched
     * horizon: a call needs the HIGH to reach strike+premium (reachAt), a
     * put needs the LOW to fall to strike-premium (1 - survivalAt). Same
     * machinery, same overlap-honest independent_n, as everything else.
     */
    let breakeven: { movePct: number; reach: BreakevenReach | null } | null = null;
    if (spot) {
      const bePrice = leg.right === "call" ? leg.strike + premium : leg.strike - premium;
      const movePct =
        leg.right === "call"
          ? ((bePrice - spot.value) / spot.value) * 100
          : ((spot.value - bePrice) / spot.value) * 100;
      let reach: BreakevenReach | null = null;
      if (movePct > 0) {
        if (leg.right === "call") {
          const rc = reachAt(bars, movePct, sessionsToExpiry);
          if (rc) reach = { reachPct: rc.reachPct, n: rc.n, independentN: rc.independentN, horizonSessions: sessionsToExpiry };
        } else {
          const sc = survivalAt(bars, movePct, sessionsToExpiry);
          if (sc)
            reach = {
              reachPct: Number((100 - sc.survivalPct).toFixed(1)),
              n: sc.n,
              independentN: sc.independentN,
              horizonSessions: sessionsToExpiry,
            };
        }
      }
      breakeven = { movePct, reach };
    }

    // The caller's risk policy, same top-level names /api/exit/design takes.
    const hardFloor = Number(body.hard_floor_usd);
    const concurrent = Number(body.concurrent_positions);
    const budget =
      Number.isFinite(hardFloor) && Number.isFinite(concurrent)
        ? { hardFloorUsd: hardFloor, concurrentPositions: concurrent }
        : null;
    const minReach = Number(body.min_breakeven_reach_pct);

    const verdict = runOptionOrderChecks({
      symbol,
      order: { leg, premium, contracts },
      accountValue,
      buyingPowerUsd,
      budget,
      minBreakevenReachPct: Number.isFinite(minReach) ? minReach : null,
      spot,
      breakeven,
      beta: betaOf(symbol),
      existingPositions,
      earnings: earningsFor(symbol, today),
      sessionsToExpiry,
      livePrice,
      priceAgeSessions,
      nowMs: Date.now(),
    });

    return NextResponse.json({
      ...verdict,
      inputs_used: {
        instrument: "option",
        order: { ...leg, premium, contracts, side: "buy" },
        spot: spot ? { value: spot.value, source: spot.source } : null,
        sessions_to_expiry: sessionsToExpiry,
        sessions_to_expiry_method: "calendar_days_x_5_over_7_rounded",
        beta_benchmark: BENCHMARK_SYMBOL,
        price_session: lastSession,
        budget,
        min_breakeven_reach_pct: Number.isFinite(minReach) ? minReach : null,
        live_price: livePrice
          ? { value: livePrice.value, as_of: new Date(livePrice.asOfMs).toISOString(), source: livePrice.source }
          : null,
        existing_positions_used: parsedHeld.positions.map((src, idx) => {
          const p = existingPositions[idx];
          return {
            symbol: p.symbol,
            instrument: p.instrument,
            capital_usd: Number(p.capitalUsd.toFixed(2)),
            market_equivalent_usd:
              p.marketEquivalentUsd === null ? null : Number(p.marketEquivalentUsd.toFixed(2)),
            beta: betaOf(p.symbol),
            ...(src.kind === "option" ? { option: src.leg } : {}),
          };
        }),
      },
    });
  }

  // Stop survival at exactly this width and horizon, not a nearby grid cell.
  const widthPct = entry > 0 ? ((entry - stop) / entry) * 100 : 0;
  const cell = widthPct > 0 ? survivalAt(bars, widthPct, holdSessions) : null;

  /*
   * The EDGE is the caller's claim, never the site's invention. A cost check
   * needs something to charge cost against, and only the trader knows what
   * edge they believe they are taking. Absent it, the check reports unknown
   * rather than inventing a number that would make the verdict look measured.
   */
  const edgeBp = Number(body.edge_bp);
  const roundTripBp = measuredRoundTripBp(symbol);
  const cost =
    Number.isFinite(edgeBp) && roundTripBp !== null ? { roundTripBp, edgeBp } : null;

  const inputs: PretradeInputs = {
    symbol,
    shares,
    entry,
    stop,
    holdSessions,
    accountValue,
    existingPositions,
    beta: betaOf(symbol),
    /*
     * independentN, not n. The windows overlap, so the raw count would
     * overstate the evidence behind a survival figure by roughly the horizon.
     */
    stopSurvival: cell ? { survival: cell.survivalPct / 100, independentN: cell.independentN } : null,
    earnings: earningsFor(symbol, today),
    cost,
    priceAgeSessions,
    today,
    livePrice,
    buyingPowerUsd,
    nowMs: Date.now(),
  };

  return NextResponse.json({
    ...runPretradeChecks(inputs),
    inputs_used: {
      beta_benchmark: BENCHMARK_SYMBOL,
      stop_width_pct: Number(widthPct.toFixed(2)),
      price_session: lastSession,
      edge_bp: Number.isFinite(edgeBp) ? edgeBp : null,
      live_price: livePrice
        ? { value: livePrice.value, as_of: new Date(livePrice.asOfMs).toISOString(), source: livePrice.source }
        : null,
      /*
       * The book AS PARSED and AS REDUCED, one row per held position. The
       * caller can diff this against what it sent; a position it holds
       * that does not appear here — or an option leg whose
       * market_equivalent_usd reads null — is a bug report, not a shrug.
       */
      existing_positions_used: parsedHeld.positions.map((src, idx) => {
        const p = existingPositions[idx];
        return {
          symbol: p.symbol,
          instrument: p.instrument,
          capital_usd: Number(p.capitalUsd.toFixed(2)),
          market_equivalent_usd:
            p.marketEquivalentUsd === null ? null : Number(p.marketEquivalentUsd.toFixed(2)),
          beta: betaOf(p.symbol),
          ...(src.kind === "option" ? { option: src.leg } : {}),
        };
      }),
    },
  });
}

function earningsFor(symbol: string, today: string): PretradeInputs["earnings"] {
  const entry = calendar.entries.find((e) => e.symbol === symbol && e.date >= today);
  if (entry) return { date: entry.date, status: "confirmed" };
  const sweep = calendar.sweep;
  const swept = sweep !== undefined && sweep.throughDate >= today && sweep.universe.includes(symbol);
  return swept ? { date: null, status: "none" } : { date: null, status: "lookup_failed" };
}
