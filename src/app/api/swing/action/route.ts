import { NextResponse } from "next/server";
import { AssetSymbol } from "@/types/market";
import { fetchOkxDailyCandles, fetchOkx4hCandles } from "@/lib/providers/okxCandles";
import { fetchDeepDailyCandles } from "@/lib/providers/okxDeepHistory";
import { scanAsset } from "@/lib/swing/scanner";
import { openPaperPosition } from "@/lib/swing/paper";
import { loadState, saveState, addPosition, toggleWatch } from "@/lib/swing/store";
import { DEFAULT_RISK_CONFIG, RiskConfig } from "@/lib/swing/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/swing/action — the only mutating surface a user can trigger.
 *
 *   { action: "approve", opportunityId, asset }   open a PAPER position
 *   { action: "watch",   opportunityId }          toggle the watchlist
 *   { action: "config",  config }                 update risk settings
 *
 * ── MANUAL APPROVAL IS THE DEFAULT, AND THE ONLY MODE HERE ──────────────
 *
 * "approve" requires an explicit user action carrying a specific opportunity
 * id. There is no automated-entry path in this route. An optional automatic
 * paper mode was asked for and is NOT implemented in this phase — stated in
 * the report rather than half-built, because a half-built auto-trader is the
 * kind of thing that runs when you did not mean it to.
 *
 * ── THE OPPORTUNITY IS RE-DERIVED, NOT TRUSTED ──────────────────────────
 *
 * The client sends an ID, never a plan. The server re-scans and re-checks
 * risk before opening anything. A posted plan could carry any stop, any size
 * and any entry — including ones the risk rules would have refused.
 *
 * NO BROKERAGE CALL EXISTS IN THIS FILE. Paper only.
 */
export async function POST(request: Request) {
  let body: { action?: string; opportunityId?: string; asset?: string; config?: Partial<RiskConfig> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  let state = await loadState();

  if (body.action === "watch") {
    if (!body.opportunityId) return NextResponse.json({ error: "opportunityId required." }, { status: 400 });
    state = toggleWatch(state, body.opportunityId);
    await saveState(state);
    return NextResponse.json({ ok: true, watchlist: state.watchlist });
  }

  if (body.action === "config") {
    // Merge over defaults so a partial update cannot leave a field undefined
    // and silently disable a risk rule.
    const next: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...state.config, ...(body.config ?? {}) };
    state = { ...state, config: next };
    await saveState(state);
    return NextResponse.json({ ok: true, config: next });
  }

  if (body.action === "approve") {
    const { opportunityId, asset } = body;
    if (!opportunityId || !asset) {
      return NextResponse.json({ error: "opportunityId and asset required." }, { status: 400 });
    }

    const [daily, fourH, deep] = await Promise.all([
      fetchOkxDailyCandles(asset as AssetSymbol),
      fetchOkx4hCandles(asset as AssetSymbol).catch(() => []),
      fetchDeepDailyCandles(asset as AssetSymbol).catch(() => []),
    ]);
    if (!daily.length) return NextResponse.json({ error: `No candles for ${asset}.` }, { status: 502 });

    const found = scanAsset({
      asset, daily, fourH, deepDaily: deep, config: state.config,
      riskState: { openPositions: state.positions, realisedToday: 0, realisedThisWeek: 0 },
    });
    const o = found.find((x) => x.id === opportunityId);
    if (!o) {
      return NextResponse.json(
        { error: "That opportunity no longer exists. It was re-scanned and is gone — the level or the setup has changed." },
        { status: 409 }
      );
    }
    // Re-checked server-side. The client cannot talk past a risk rule.
    if (o.riskRefusal) return NextResponse.json({ error: o.riskRefusal }, { status: 409 });
    if (!o.sizing) return NextResponse.json({ error: "No valid position size for this plan." }, { status: 409 });

    const bar = daily[daily.length - 1];
    const position = openPaperPosition({ opportunity: o, bar, config: state.config });
    if (!position) return NextResponse.json({ error: "Could not build a position from this plan." }, { status: 409 });

    const res = addPosition(state, position);
    if (!res.added) {
      return NextResponse.json({ error: "A position for this opportunity is already open." }, { status: 409 });
    }
    state = res.state;
    state = {
      ...state,
      notifications: [
        { t: Date.now(), message: `${asset}: ${o.direction} PAPER position opened at ${position.entryPrice.toFixed(2)}.`, opportunityId },
        ...state.notifications,
      ].slice(0, 200),
    };
    await saveState(state);
    return NextResponse.json({ ok: true, position });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
