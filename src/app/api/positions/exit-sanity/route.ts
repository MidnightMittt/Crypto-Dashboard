import { NextRequest, NextResponse } from "next/server";
import { evaluateExitSanity } from "@/lib/positions/exitSanity";

/**
 * POST /api/positions/exit-sanity — the $72 check.
 *
 * Compare a resting (or proposed) option exit against the contract's own
 * lifetime traded high. The high is POSTED from broker historicals — this
 * site cannot read Robinhood and does not pretend to. All defects in one
 * 400; GET returns the shape.
 *
 * The rule the endpoint encodes: raising a working exit is a new trade.
 */

export const dynamic = "force-dynamic";

const EXAMPLE = {
  contract: "SMR 2026-11-21 25C",
  target_price: 1.22,
  lifetime_high: 0.95,
  high_as_of: "2026-10-02T14:00:00Z",
  prior_target: 0.92,
};

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    endpoint: "POST /api/positions/exit-sanity",
    required: {
      contract: "Label, e.g. \"SMR 2026-11-21 25C\".",
      target_price: "The resting or proposed exit, per contract.",
      lifetime_high: "The contract's lifetime traded high, from broker historicals (full window).",
      high_as_of: "ISO timestamp the historicals were read.",
    },
    optional: {
      prior_target: "Present when EDITING a working order — a raise is named and judged as a new trade.",
      last_price: "Context only.",
    },
    example: EXAMPLE,
    rule: "A target above every price the contract has ever printed is UNREACHABLE — arithmetic, not advice.",
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON", see: "GET /api/positions/exit-sanity" }, { status: 400 });
  }

  const defects: string[] = [];
  const contract = typeof body.contract === "string" && body.contract.trim() ? body.contract.trim() : null;
  if (!contract) defects.push("contract is required (a label for the option)");
  const target = Number(body.target_price);
  if (!(Number.isFinite(target) && target > 0)) defects.push("target_price is required and positive (per contract: 1.22, not 122)");
  const high = Number(body.lifetime_high);
  if (!(Number.isFinite(high) && high > 0)) defects.push("lifetime_high is required and positive — the contract's own traded high, full window");
  const asOf = typeof body.high_as_of === "string" && Number.isFinite(Date.parse(body.high_as_of)) ? body.high_as_of : null;
  if (!asOf) defects.push("high_as_of is required: ISO timestamp the historicals were read");
  const priorRaw = body.prior_target;
  const prior = priorRaw === undefined || priorRaw === null ? null : Number(priorRaw);
  if (prior !== null && !(Number.isFinite(prior) && prior > 0)) defects.push("prior_target, when present, must be positive");

  if (defects.length) {
    return NextResponse.json(
      { error: `${defects.length} defect(s), all named at once.`, defects, see: "GET /api/positions/exit-sanity" },
      { status: 400 }
    );
  }

  const verdict = evaluateExitSanity({
    contract: contract!,
    targetPrice: target,
    lifetimeHigh: high,
    highAsOf: asOf!,
    priorTarget: prior,
    lastPrice: Number.isFinite(Number(body.last_price)) ? Number(body.last_price) : null,
  });
  return NextResponse.json(verdict);
}
