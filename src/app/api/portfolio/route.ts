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
  const positions: PositionInput[] = raw.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      symbol: typeof o.symbol === "string" ? o.symbol : String(o.symbol ?? ""),
      quantity: Number(o.quantity),
      price: o.price === undefined || o.price === null ? undefined : Number(o.price),
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
      example: { positions: [{ symbol: "APLD", quantity: 100, price: 31.2 }] },
      notes: [
        "price is optional and falls back to our last close, with provenance saying which.",
        "quantity is signed: a negative quantity is a short and offsets market beta.",
        "weighted_beta_of_covered is refused below 60% beta coverage rather than understated.",
        "No P&L, no score, no recommendation.",
      ],
    },
    { status: 405 }
  );
}
