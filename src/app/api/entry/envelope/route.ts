import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import barsPanelJson from "@/data/barsPanel.json";
import equityExecutionJson from "@/data/equityExecutionStats.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { EquityExecutionSnapshot } from "@/lib/dossier/equityExpectations";
import { designOptionExit } from "@/lib/research/optionExitDesign";
import { trailingSigmaAnnualized } from "@/lib/research/gbmTouch";
import { Bar } from "@/lib/research/types";

/**
 * GET /api/entry/envelope — what the tools claim, captured AT entry.
 *
 * The chain's predictions are worthless as evidence unless they are
 * recorded before the outcome: a Thursday trade whose rung probabilities
 * are reconstructed on Friday is a postdiction wearing a timestamp. This
 * endpoint assembles the site's claims about ONE contract into a single
 * stamped document — exit rungs with corrected touch probabilities and
 * their calibration cells, the conversion verdict at the contract's own
 * tenor and sigma band, provenance for every input — plus a sha256 of the
 * claims block, so the copy the trading session stores in
 * roundtrips.jsonl (method_id exit-design-option-rungs) is verifiably the
 * one the site produced.
 *
 * The SITE does not store the envelope, deliberately: the book lives at
 * the broker and in the trading session's log, and a copy here would be a
 * staleness surface without a capability. The site knows its own claims;
 * the trade's owner stores them with the trade.
 *
 *   GET /api/entry/envelope?symbol=CLSK&right=call&strike=14
 *       &expiry=2026-10-02&premium=1.35
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const snapshot = equityExecutionJson as unknown as EquityExecutionSnapshot;

function realBars(sessions: readonly string[], sp: SymbolPanel): Bar[] {
  const filled = new Set(sp.interpolated);
  const out: Bar[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const row = sp.bars[i];
    if (!row || filled.has(i)) continue;
    out.push({ t: Date.parse(sessions[i]), open: row[0], high: row[1], low: row[2], close: row[3], volume: row[4] ?? 0 });
  }
  return out;
}

export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = String(q.get("symbol") ?? "").trim().toUpperCase();
  const right = String(q.get("right") ?? "").toLowerCase();
  const strike = Number(q.get("strike"));
  const expiry = String(q.get("expiry") ?? "");
  const premium = Number(q.get("premium"));

  if (!symbol || (right !== "call" && right !== "put") || !Number.isFinite(strike) || !Number.isFinite(premium) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return NextResponse.json(
      { error: "need symbol, right=call|put, numeric strike, expiry=YYYY-MM-DD, per-share premium." },
      { status: 400 }
    );
  }
  const sp = panel.symbols[symbol];
  if (!sp) {
    return NextResponse.json({ error: `${symbol} is not in the committed panel.` }, { status: 404 });
  }

  const bars = realBars(panel.sessions, sp);
  const spot = bars.length > 0 ? bars[bars.length - 1].close : NaN;
  const today = new Date().toISOString().slice(0, 10);

  const exit = designOptionExit({
    right, strike, expiry, premium, today, spot, bars, snapshot,
  });
  const sigma = trailingSigmaAnnualized(bars);

  const claims = {
    contract: { symbol, right, strike, expiry, premium_per_share: premium },
    as_of: {
      captured_at: new Date().toISOString(),
      bars_session: panel.sessions[panel.sessions.length - 1] ?? null,
      spot_is: "last committed panel close, NOT a live quote — audit the live price via /api/pretrade/check before ordering",
      spot,
      trailing_sigma: sigma,
    },
    option_exit: exit,
    method: {
      method_id: "exit-design-option-rungs",
      record_fields:
        "store this whole document in roundtrips.jsonl at entry; measured_at and exact_match " +
        "live on each rung's touch block. The envelope is evidence only if stored BEFORE the outcome.",
    },
  };

  const hash = createHash("sha256").update(JSON.stringify(claims)).digest("hex");
  return NextResponse.json({ ...claims, claims_sha256: hash });
}
