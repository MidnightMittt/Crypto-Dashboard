import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getPositionCard } from "@/lib/chain/lpPosition";
import { parseSeries } from "@/lib/chain/feeSeries";
import { CHAIN, POOL, POSITION, THRESHOLDS } from "@/lib/chain/config";

/**
 * GET /api/lp — the LP position card (live from chain) plus the persisted
 * fee-rate series (from the committed JSONL).
 *
 * Dynamic by necessity: the card is a live read of pool state at the current
 * block, so this route cannot be static. Because it is already dynamic, the
 * series JSONL is read with fs at request time rather than imported — which
 * side-steps the force-static import blocker that append-only stores otherwise
 * hit.
 *
 * READ-ONLY end to end. Every number carries a stamp: the card its block and
 * observedAt, each series row its ts, the ETH price its venue label. A figure
 * without provenance is a bug by this endpoint's own rule.
 *
 * A chain read that fails (RPC down, historical-state error) returns 503 with
 * the reason rather than a card of zeros — an unreachable chain is a stated
 * absence, never a silent zero.
 */

export const dynamic = "force-dynamic";

const SERIES = path.join(process.cwd(), "src", "data", "lpFeeSeries.jsonl");

export async function GET(): Promise<NextResponse> {
  const series = fs.existsSync(SERIES) ? parseSeries(fs.readFileSync(SERIES, "utf8")) : [];

  let card;
  try {
    card = await getPositionCard();
  } catch (err) {
    return NextResponse.json(
      {
        error: "LP position could not be read from chain.",
        detail: err instanceof Error ? err.message : String(err),
        series, // the persisted history is still served — it is what we have
      },
      { status: 503 }
    );
  }

  return NextResponse.json({
    card,
    series,
    definition: {
      chain: { chainId: CHAIN.chainId, rpc: CHAIN.rpcUrl },
      pool: POOL.address,
      fee_pips: POOL.feePips,
      token0: POOL.token0,
      token1: POOL.token1,
      npm: POSITION.npm,
      token_id: POSITION.tokenId.toString(),
      range: { tickLower: POSITION.tickLower, tickUpper: POSITION.tickUpper },
      thresholds: {
        review_tick: THRESHOLDS.reviewTick,
        cadence_hours: THRESHOLDS.cadenceHours,
        series_gap_alert_hours: THRESHOLDS.seriesGapAlertHours,
      },
    },
    /*
     * vol_2h is null on every row until the log-sweep phase: it needs the Swap
     * event topic computed from the canonical signature and checked against a
     * real log on this chain, and a guessed topic would silently match nothing.
     * Stated here so an empty column reads as deferred, not broken.
     */
    notes: [
      "vol_2h is deferred to the log-sweep phase (needs the verified Swap topic).",
      "The series is forward-only: this RPC keeps no historical state, so it cannot be backfilled.",
    ],
  });
}
