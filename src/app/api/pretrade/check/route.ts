import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import earningsJson from "@/data/earningsCalendar.json";
import { EarningsCalendar } from "@/lib/markets/earningsVeto";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { BENCHMARK_SYMBOL } from "@/lib/research/benchmark";
import { DatedReturn, regressOnMarket } from "@/lib/research/alphaBeta";
import { Bar } from "@/lib/research/types";
import { survivalAt } from "@/lib/research/stopViability";
import { latestCompletedSession, sessionsBetween } from "@/lib/asset/priceStaleness";
import { HeldPosition, LivePrice, PretradeInputs, runPretradeChecks } from "@/lib/pretrade/check";
import { parseHeldPositions } from "@/lib/pretrade/parseHeldPositions";
// One implementation of "what does this cost to trade" — see measuredSpread.ts.
import { measuredRoundTripBp } from "@/lib/execution/measuredSpread";
import { BreakevenReach, runOptionOrderChecks } from "@/lib/pretrade/optionOrder";
import { REQUEST_SHAPE, collectShapeDefects } from "@/lib/pretrade/requestShape";
import { positioningUniverse } from "@/lib/markets/scannerUniverse";
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
 *
 * Two contracts added after the endpoint was tested cold by its own caller:
 *
 *  - ALL SHAPE DEFECTS IN ONE 400. Discovering the request shape used to
 *    take four round trips, one field per error. Shape validation now lives
 *    in requestShape.ts and names everything wrong at once, and GET on this
 *    path returns the full shape with worked examples before a POST is ever
 *    sent.
 *
 *  - A SYMBOL OUTSIDE THE BARS PANEL GETS A PARTIAL AUDIT, NOT A REFUSAL.
 *    Most checks need only the order and the account; refusing all of them
 *    because history is missing declined to audit the exact names most
 *    likely to be traded on a thesis rather than a signal. The engines
 *    already report unknown per missing measurement — the flat 404 here was
 *    the only thing in the stack that refused. The response's `coverage`
 *    block says plainly what is missing and what it costs, and the verdict
 *    arithmetic is unchanged: unknowns make an audit INCOMPLETE, never a
 *    pass.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const calendar = earningsJson as EarningsCalendar;

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


/** GET — the request shape, before the first POST is ever sent. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(REQUEST_SHAPE);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "body must be JSON", see: "GET /api/pretrade/check for the request shape" },
      { status: 400 }
    );
  }

  const nowMs = Date.now();

  /*
   * EVERY shape defect at once — one 400 for the whole body, never a chain
   * of them. The held book is parsed here too, so a malformed position row
   * surfaces in the same response as a missing premium instead of on the
   * round trip after it.
   */
  const defects = collectShapeDefects(body, nowMs);
  const parsedHeld = parseHeldPositions(body.existing_positions, nowMs);
  if (!parsedHeld.ok) defects.push(parsedHeld.error);
  const heldRows = parsedHeld.ok ? parsedHeld.positions : [];
  if (defects.length > 0) {
    return NextResponse.json(
      {
        error: `${defects.length} defect${defects.length === 1 ? "" : "s"} in the request — all named below, none discovered on a later round trip.`,
        defects,
        see: "GET /api/pretrade/check for the full shape, what each optional field unlocks, and worked examples for both paths.",
      },
      { status: 400 }
    );
  }

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  const shares = Number(body.shares);
  const entry = Number(body.entry);
  const stop = Number(body.stop);
  const holdSessions = Number(body.hold_sessions ?? 20);
  const accountValue = Number(body.account_value);
  const isOptionOrder = body.option_order !== undefined && body.option_order !== null;

  // Complete by construction — collectShapeDefects already rejected a partial one.
  let livePrice: LivePrice | null = null;
  if (body.live_price !== undefined && body.live_price !== null) {
    const lp = body.live_price as Record<string, unknown>;
    livePrice = {
      value: Number(lp.value),
      asOfMs: Date.parse(String(lp.as_of)),
      source: String(lp.source).trim(),
    };
  }

  /*
   * ── COVERAGE, NOT PERMISSION ─────────────────────────────────────────
   *
   * A symbol outside the bars panel used to be a flat 404 — which meant the
   * auditor declined the exact trade most in need of auditing: a name
   * traded on a thesis this week rather than a signal in the universe. The
   * engines already degrade honestly per missing measurement, so the route
   * now resolves what it can and states what it cannot:
   *
   *   runs in full: max_loss, deployment_cap, reachability, earnings_window
   *   needs bars:   beta_exposure, stop_survival / breakeven reach
   *                 probability, cost
   *   needs a price: breakeven distance — recoverable via live_price
   *
   * The block below is LOUD in the response because the other reading of an
   * uncovered symbol is a typo, and a mostly-unknown audit must not be
   * mistaken for a measured one. The verdict already cannot be: unknowns
   * reduce to INCOMPLETE, never to pass.
   */
  const sp = panel.symbols[symbol];
  const covered = sp !== undefined;
  /*
   * Two different absences, named apart. A DECLARED name with no bars yet is
   * in the window between joining the universe and the next nightly ingest —
   * coverage is coming and nobody needs to act. An UNDECLARED name is either
   * a typo or a name someone should ask to have added. Collapsing them would
   * tell the caller to request an addition that is already done.
   */
  const declared = positioningUniverse().includes(symbol);
  const partialNote =
    `This audit is PARTIAL: checks needing only the order and account ran in full; ` +
    `checks needing this name's history ` +
    `(beta_exposure, ${isOptionOrder ? "breakeven reach probability" : "stop_survival, cost"}) ` +
    `report unknown rather than a number. Supply live_price to recover the ` +
    `price-dependent checks.`;
  const coverage = covered
    ? { bars: true as const }
    : {
        bars: false as const,
        note: declared
          ? `${symbol} is declared in the universe but its daily bars have not been committed ` +
            `yet — the nightly ingest populates them, so full coverage arrives with the next ` +
            `data refresh. ${partialNote}`
          : `${symbol} has no committed daily bars — it is outside the ingest universe declared ` +
            `in src/lib/markets/scannerUniverse.ts. ${partialNote} If you expected coverage, ` +
            `check the spelling; if the name is newly traded, ask for it to be added to the ` +
            `universe.`,
      };

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
   * else our last close. Parsed above with the shape pass — a malformed row
   * lands in the same 400 as every other defect.
   */
  const lastCloseOf = (sym: string): number | null => {
    const held = panel.symbols[sym];
    if (!held) return null;
    const bars = realBars(panel.sessions, held);
    const close = bars[bars.length - 1]?.close;
    return Number.isFinite(close) && close > 0 ? close : null;
  };
  const existingPositions: HeldPosition[] = heldRows.map((p) => {
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

  const bars = sp ? realBars(panel.sessions, sp) : [];
  const today = latestCompletedSession(new Date());
  const lastSession = panel.sessions[panel.sessions.length - 1] ?? today;
  /*
   * Null, not the panel's global age, for an uncovered symbol: the panel's
   * newest session dates OTHER names' closes, and this one has no close to
   * date. The freshness check states that instead of counting sessions.
   */
  const priceAgeSessions = covered ? sessionsBetween(lastSession, today) : null;
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
    /*
     * Contracts, premium and the leg were all validated by the shape pass —
     * every defect already surfaced in the single 400 above. Re-derived here
     * because the shape pass validates and this path consumes; the ok-check
     * is type narrowing, not a reachable branch.
     */
    const contracts = Number(oo.contracts ?? 1);
    const premium = Number(oo.premium);
    const parsedLeg = parseOptionLeg(
      symbol,
      {
        strike: oo.strike === undefined || oo.strike === null ? undefined : Number(oo.strike),
        expiry: typeof oo.expiry === "string" ? oo.expiry : undefined,
        right: typeof oo.right === "string" ? oo.right : undefined,
        delta: oo.delta === undefined || oo.delta === null ? undefined : Number(oo.delta),
        multiplier: oo.multiplier === undefined || oo.multiplier === null ? undefined : Number(oo.multiplier),
      },
      nowMs
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
      Math.round((Date.parse(`${leg.expiry}T23:59:59Z`) - nowMs) / 86_400_000)
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
    // Passed through field-by-field rather than collapsed to one nullable
    // object, so the check can name the field that is actually absent —
    // see the note on OptionOrderInputs.riskPolicy.
    const hardFloor = Number(body.hard_floor_usd);
    const concurrent = Number(body.concurrent_positions);
    const riskPolicy = {
      hardFloorUsd: Number.isFinite(hardFloor) ? hardFloor : null,
      concurrentPositions: Number.isFinite(concurrent) ? concurrent : null,
    };
    const minReach = Number(body.min_breakeven_reach_pct);

    const verdict = runOptionOrderChecks({
      symbol,
      order: { leg, premium, contracts },
      accountValue,
      buyingPowerUsd,
      riskPolicy,
      minBreakevenReachPct: Number.isFinite(minReach) ? minReach : null,
      spot,
      breakeven,
      beta: betaOf(symbol),
      existingPositions,
      earnings: earningsFor(symbol, today),
      sessionsToExpiry,
      livePrice,
      priceAgeSessions,
      nowMs,
    });

    return NextResponse.json({
      ...verdict,
      coverage,
      inputs_used: {
        instrument: "option",
        order: { ...leg, premium, contracts, side: "buy" },
        spot: spot ? { value: spot.value, source: spot.source } : null,
        sessions_to_expiry: sessionsToExpiry,
        sessions_to_expiry_method: "calendar_days_x_5_over_7_rounded",
        beta_benchmark: BENCHMARK_SYMBOL,
        price_session: covered ? lastSession : null,
        // Echoed as received, so a caller can see at a glance which half of
        // the policy the route actually got.
        budget: {
          hard_floor_usd: riskPolicy.hardFloorUsd,
          concurrent_positions: riskPolicy.concurrentPositions,
        },
        min_breakeven_reach_pct: Number.isFinite(minReach) ? minReach : null,
        live_price: livePrice
          ? { value: livePrice.value, as_of: new Date(livePrice.asOfMs).toISOString(), source: livePrice.source }
          : null,
        existing_positions_used: heldRows.map((src, idx) => {
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
    nowMs,
  };

  return NextResponse.json({
    ...runPretradeChecks(inputs),
    coverage,
    inputs_used: {
      beta_benchmark: BENCHMARK_SYMBOL,
      stop_width_pct: Number(widthPct.toFixed(2)),
      price_session: covered ? lastSession : null,
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
      existing_positions_used: heldRows.map((src, idx) => {
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
