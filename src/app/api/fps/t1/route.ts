import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel } from "@/lib/research/barsPanel";
import { postGapRv } from "@/lib/research/postGapRv";
import { evaluateFpsT1 } from "@/lib/research/fpsTrigger";
import { THRESHOLDS } from "@/lib/chain/config";

/**
 * POST /api/fps/t1 — the FPS option trigger, evaluated on POSTED inputs.
 *
 * The IV is posted, never fetched, by explicit design agreed with the trading
 * session: they hold live chain access on the broker side, a keyless vendor
 * would be a THIRD opinion on the number that arms a trade, and the register's
 * rule is that a screen IV is not a traded IV — the evaluator must measure the
 * contract we would actually transact in. So the caller posts
 * {contract, iv_pct, asof} plus the earnings dates, and this route computes
 * post-gap RV21 from committed FPS bars and returns the dated reading.
 *
 * STALE is said out loud: a post older than ~1 session
 * (THRESHOLDS.t1PostMaxAgeHours) returns state STALE with the age — it does
 * NOT fall back to another source silently, because there is no other source
 * that measures the thing we transact in.
 *
 * Stateless: the reading is returned, not persisted — Vercel's filesystem is
 * read-only at request time, so a server-side T1 history would need its own
 * ledger + cron. The caller keeps the record for now, and every response
 * carries the stamps needed to make that record honest.
 *
 * MEASURE AND ARM ONLY. No orders, no sizing, no "should". T2 is deliberately
 * unplumbed: it wants $30.50-31.50 against a $39.50 close — 22% away — and
 * effort spent on a trigger that cannot fire is effort taken from ones that
 * can.
 */

export const dynamic = "force-dynamic";

const SYMBOL = "FPS";
const panel = barsPanelJson as unknown as BarsPanel;

const EXAMPLE = {
  contract: { expiry: "2026-10-16", strike: 40, right: "call" },
  iv_pct: 62.5,
  asof: "2026-09-20T14:00:00Z",
  earnings_dates: ["2026-11-05"],
};

/** GET — the post shape, before the first POST is sent. Same habit as /api/pretrade/check. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    endpoint: "POST /api/fps/t1",
    required: {
      contract: "{ expiry: YYYY-MM-DD, strike: number, right: 'call'|'put' } — names the contract the IV was read from.",
      iv_pct: "The contract's implied vol, annualised percent, read off the broker chain you would trade on.",
      asof: `ISO timestamp the IV was read. Posts older than ${THRESHOLDS.t1PostMaxAgeHours}h return STALE.`,
      earnings_dates: "Array of YYYY-MM-DD earnings dates (may be empty). Posted, same trust model as the IV.",
    },
    example: EXAMPLE,
    rule: `T1 arms when iv_pct <= ${THRESHOLDS.armIvToRvRatio} x post-gap RV21. The raw ratio and both windows are returned even when not armed.`,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON", see: "GET /api/fps/t1 for the shape" }, { status: 400 });
  }

  // All defects in one pass — the pretrade lesson applied from day one.
  const defects: string[] = [];
  const c = (body.contract ?? {}) as Record<string, unknown>;
  const expiry = typeof c.expiry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.expiry) ? c.expiry : null;
  if (!expiry) defects.push("contract.expiry is required as YYYY-MM-DD");
  const strike = Number(c.strike);
  if (!(Number.isFinite(strike) && strike > 0)) defects.push("contract.strike is required and positive");
  const right = typeof c.right === "string" ? c.right.toLowerCase() : "";
  if (right !== "call" && right !== "put") defects.push('contract.right must be "call" or "put"');
  const ivPct = Number(body.iv_pct);
  if (!(Number.isFinite(ivPct) && ivPct > 0 && ivPct < 500)) {
    defects.push("iv_pct is required: the contract's annualised IV in percent (62.5, not 0.625)");
  }
  const asofMs = typeof body.asof === "string" ? Date.parse(body.asof) : NaN;
  if (!Number.isFinite(asofMs)) defects.push("asof is required: ISO timestamp the IV was read");
  const earningsDates = Array.isArray(body.earnings_dates)
    ? (body.earnings_dates as unknown[]).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : null;
  if (earningsDates === null) defects.push("earnings_dates is required (an array of YYYY-MM-DD; may be empty)");
  if (defects.length > 0) {
    return NextResponse.json(
      { error: `${defects.length} defect(s), all named at once.`, defects, see: "GET /api/fps/t1" },
      { status: 400 }
    );
  }

  const nowMs = Date.now();
  const ageHours = (nowMs - asofMs) / 3_600_000;

  // STALE is a stated condition, never a silent fallback.
  if (ageHours > THRESHOLDS.t1PostMaxAgeHours) {
    return NextResponse.json({
      state: "STALE",
      reason:
        `The posted IV is ${ageHours.toFixed(1)}h old against a ${THRESHOLDS.t1PostMaxAgeHours}h limit. ` +
        `Re-read the contract and re-post; there is no other source that measures the contract we would trade.`,
      posted_asof: new Date(asofMs).toISOString(),
      evaluated_at: new Date(nowMs).toISOString(),
    });
  }
  if (ageHours < -0.1) {
    return NextResponse.json(
      { error: `asof is ${(-ageHours).toFixed(1)}h in the future — clock skew or a mangled timestamp; unverifiable is not fresh.` },
      { status: 400 }
    );
  }

  /*
   * Post-gap RV21 from committed FPS bars. Absent bars (the window between
   * FPS entering the universe and the next nightly ingest) → rv null →
   * INCOMPLETE, stated as pending rather than broken.
   */
  const sp = panel.symbols[SYMBOL];
  let rv = null;
  let barsNote: string | null = null;
  if (!sp) {
    barsNote =
      `${SYMBOL} is declared in the universe but its daily bars are not committed yet — ` +
      `the nightly ingest populates them, so RV21 arrives with the next data refresh.`;
  } else {
    const opens = sp.bars.map((b) => (b && b[0] > 0 ? b[0] : 0));
    const closes = sp.bars.map((b) => (b && b[3] > 0 ? b[3] : 0));
    rv = postGapRv(opens, closes, panel.sessions as string[]);
    if (!rv) barsNote = `${SYMBOL} bars are present but too few clean sessions for RV21 — refused rather than thinned.`;
  }

  const today = new Date(nowMs).toISOString().slice(0, 10);
  const dates = earningsDates as string[];
  const earningsInContractLife = dates.some((d) => d >= today && d <= (expiry as string));
  const earningsInRvWindow = rv ? dates.some((d) => d >= rv!.window.from && d <= rv!.window.to) : false;

  const reading = evaluateFpsT1({
    symbol: SYMBOL,
    contractIvPct: ivPct,
    contractLabel: `${SYMBOL} ${expiry} ${strike} ${right.toUpperCase()}`,
    rv,
    earningsInContractLife,
    earningsInRvWindow,
    observedAt: new Date(nowMs).toISOString(),
  });

  return NextResponse.json({
    ...reading,
    stamps: {
      iv: { asof: new Date(asofMs).toISOString(), age_hours: Number(ageHours.toFixed(2)), source: "posted (broker chain, caller-read)" },
      rv: rv ? { window: rv.window, source: "committed FPS daily bars, post-gap rule 4σ/MAD" } : null,
      earnings_dates: { values: dates, source: "posted" },
    },
    ...(barsNote ? { note: barsNote } : {}),
  });
}
