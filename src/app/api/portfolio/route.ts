import { NextResponse } from "next/server";
import overnightJson from "@/data/overnightPremium.json";
import { PositionInput, buildPortfolio } from "@/lib/portfolio/buildPortfolio";
import {
  OvernightArtifact,
  lastCloseFromArtifact,
  marketExposureFromArtifact,
} from "@/lib/pretrade/marketExposure";

/**
 * POST /api/portfolio
 *
 *   { "positions": [ { "symbol": "APLD", "quantity": 100, "price": 31.20 } ] }
 *
 * The agent holds the positions; this analyses them. `price` is optional and
 * falls back to our last close, with the provenance saying which was used.
 *
 * ── Why the agent posts rather than this site pulling ─────────────────
 *
 * Robinhood publishes no official API, so an integration could only be an
 * unofficial client — ruled out by ROADMAP.md's standing prohibitions — and it
 * would mean automating credentials. The agent already knows its own holdings,
 * so inverting the direction costs nothing and removes the entire problem: no
 * brokerage client, no credentials, no scraped session, nothing stored.
 *
 * ── What this answers, and what it refuses to ────────────────────────
 *
 * It answers what the book is ACTUALLY long. Measured against overnight SPY
 * the scanned cohort runs beta 2.87 to 4.81, so a handful of these names is
 * not a diversified basket — it is roughly a 4x levered index overnight trade
 * with several names' worth of single-name risk on top.
 * `market_equivalent_usd` is that sentence as a number.
 *
 * It computes no P&L. At $100 a night the strategy's expected gain is $0.374
 * against $2.828 of noise, and a prominent P&L invites abandoning a working
 * strategy after an unlucky fortnight or scaling a broken one after a lucky
 * one. It also emits no verdict, score or recommendation, for the same reason
 * /api/pretrade does not.
 */

export const dynamic = "force-dynamic";

/** A book, not a universe scan. Generous enough for any real portfolio. */
const MAX_POSITIONS = 200;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: 'Send {"positions":[{"symbol":"APLD","quantity":100}]}' },
      { status: 400 }
    );
  }

  const raw = (body as { positions?: unknown })?.positions;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "positions_required", detail: "Body must carry a `positions` array." },
      { status: 400 }
    );
  }
  if (raw.length > MAX_POSITIONS) {
    return NextResponse.json(
      { error: "too_many_positions", detail: `At most ${MAX_POSITIONS}; got ${raw.length}.` },
      { status: 400 }
    );
  }

  /*
   * Coerced defensively rather than trusted: a quantity arriving as a string
   * would otherwise multiply into a concatenation, and a symbol arriving as a
   * number would silently miss every lookup. Anything unusable is REJECTED
   * with a reason by the builder rather than dropped here, so the caller can
   * see which of its holdings did not make it in.
   */
  const num = (v: unknown): number | undefined =>
    v === undefined || v === null ? undefined : Number(v);
  const str = (v: unknown): string | undefined =>
    v === undefined || v === null ? undefined : String(v);

  const positions: PositionInput[] = raw.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      symbol: typeof o.symbol === "string" ? o.symbol : String(o.symbol ?? ""),
      quantity: Number(o.quantity),
      price: num(o.price),
      /*
       * Option fields pass through untouched; the builder validates the leg
       * as a whole and rejects it by name if it cannot be modelled. These
       * used to be dropped here, which valued a 1-lot call as 1.25 shares
       * of stock — a ~140x silent understatement of real exposure.
       */
      strike: num(o.strike),
      expiry: str(o.expiry),
      right: str(o.right),
      delta: num(o.delta),
      multiplier: num(o.multiplier),
      underlying_price: num(o.underlying_price),
    };
  });

  const artifact = overnightJson as unknown as OvernightArtifact;

  return NextResponse.json(
    buildPortfolio({
      positions,
      now: Date.now(),
      lastClose: lastCloseFromArtifact(artifact),
      marketExposure: marketExposureFromArtifact(artifact),
    })
  );
}

/**
 * A GET here is almost always an agent that has not read the contract, so it
 * answers with the contract rather than a bare 405.
 */
export function GET() {
  return NextResponse.json(
    {
      error: "post_required",
      detail: "POST a book of positions; this endpoint reads nothing from any broker.",
      example: {
        positions: [
          { symbol: "APLD", quantity: 100, price: 31.2 },
          {
            symbol: "BTDR",
            quantity: 1,
            price: 1.25,
            strike: 10.5,
            expiry: "2026-08-28",
            right: "call",
            delta: 0.724,
          },
        ],
      },
      notes: [
        "price is optional for equity and falls back to our last close, with provenance saying which.",
        "quantity is signed: a negative quantity is a short and offsets market beta.",
        "Supplying any of strike/expiry/right/delta/multiplier declares an option leg.",
        "An option leg needs strike, expiry, right and delta; an unmodellable leg is rejected by name, never valued as equity.",
        "For an option, price is the PER-CONTRACT premium (1.25, not 125); multiplier defaults to 100.",
        "Option legs return delta_equivalent_usd (real exposure) and capped_downside_usd (max loss) separately.",
        "underlying_price is optional on an option leg so delta and spot can share one broker snapshot; falls back to our close.",
        "weighted_beta_of_covered is refused below 60% coverage rather than understated.",
        "No P&L, no score, no recommendation.",
      ],
    },
    { status: 405 }
  );
}
