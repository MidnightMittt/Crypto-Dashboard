import { NextRequest, NextResponse } from "next/server";
import { CandidateInput, compareCostToExpress } from "@/lib/execution/costToExpress";
import { measuredRoundTripBp } from "@/lib/execution/measuredSpread";

/**
 * POST /api/cost/express — the same view, priced in every instrument that
 * could carry it.
 *
 * The platform could say WHAT to trade and not what to trade it WITH.
 * Equity, option and spot were each priced on their own scale and never
 * against each other, which left Rule 63 — an edge smaller than the spread
 * is not an edge — enforceable only within one asset class at a time.
 *
 * The engine is pure and lives in lib/execution/costToExpress.ts. This file
 * resolves the three cost sources and nothing else:
 *
 *   equity   the MEASURED spread history, both legs, when the symbol has
 *            one; a caller quote only as a stated fallback
 *   option   the caller's chain quote, converted through delta
 *   spot     a live order book from a public venue endpoint
 *
 * ── No API key, deliberately ─────────────────────────────────────────
 *
 * Kraken's book, ticker and OHLC are unauthenticated. The key its owner
 * holds unlocks balances, orders and trade history — none of which this
 * site wants: /api/portfolio takes POSTED positions precisely so there are
 * no credentials, no scraped session and nothing stored. A trading-capable
 * key in a deployed web app would buy zero capability here.
 */

export const dynamic = "force-dynamic";

const MAX_CANDIDATES = 8;
const KRAKEN_BOOK = (pair: string) =>
  `https://api.kraken.com/0/public/Depth?pair=${encodeURIComponent(pair)}&count=1`;

/** Top of book from a public venue. Null on any failure — never a guessed spread. */
async function krakenTopOfBook(pair: string): Promise<{ bid: number; ask: number } | null> {
  try {
    const res = await fetch(KRAKEN_BOOK(pair), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      error?: string[];
      result?: Record<string, { bids?: [string, string, number][]; asks?: [string, string, number][] }>;
    };
    if (json.error?.length) return null;
    const book = Object.values(json.result ?? {})[0];
    const bid = Number(book?.bids?.[0]?.[0]);
    const ask = Number(book?.asks?.[0]?.[0]);
    if (!(Number.isFinite(bid) && Number.isFinite(ask) && ask > bid && bid > 0)) return null;
    return { bid, ask };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function quoteFrom(o: Record<string, unknown>): { bid: number; ask: number } | null {
  const bid = num(o.bid);
  const ask = num(o.ask);
  return bid !== null && ask !== null && ask > bid && bid > 0 ? { bid, ask } : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const raw = body.candidates;
  if (!Array.isArray(raw) || raw.length === 0) {
    return NextResponse.json(
      {
        error: "Body must carry a non-empty `candidates` array.",
        hint: 'Each is {kind:"equity"|"option"|"spot", ...}. See GET for the contract.',
      },
      { status: 400 }
    );
  }
  if (raw.length > MAX_CANDIDATES) {
    return NextResponse.json(
      { error: `At most ${MAX_CANDIDATES} candidates; got ${raw.length}.` },
      { status: 400 }
    );
  }

  const candidates: CandidateInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? "").toLowerCase();
    const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : `candidate[${i}]`;

    if (kind === "equity") {
      const symbol = String(o.symbol ?? "").trim().toUpperCase();
      candidates.push({
        kind: "equity",
        label: symbol ? `${symbol} equity` : label,
        measuredRoundTripBp: symbol ? measuredRoundTripBp(symbol) : null,
        quote: quoteFrom(o),
      });
      continue;
    }

    if (kind === "spot") {
      const pair = String(o.pair ?? "").trim();
      const venue = String(o.venue ?? "kraken").trim().toLowerCase();
      /*
       * Only a public venue is consulted, and only for a book. An unknown
       * venue is refused by name rather than silently falling back to a
       * caller quote, which would let an unverified spread wear a measured
       * one's provenance.
       */
      const quote =
        venue === "kraken" && pair ? await krakenTopOfBook(pair) : quoteFrom(o);
      candidates.push({
        kind: "spot",
        label: pair ? `${pair} spot` : label,
        venue: venue === "kraken" && pair ? "kraken (public book)" : venue,
        quote,
      });
      continue;
    }

    if (kind === "option") {
      candidates.push({
        kind: "option",
        label,
        quote: quoteFrom(o),
        delta: num(o.delta) ?? 0,
        multiplier: num(o.multiplier) ?? 100,
        underlyingPrice: num(o.underlying_price) ?? 0,
      });
      continue;
    }

    return NextResponse.json(
      { error: `candidates[${i}].kind must be "equity", "option" or "spot"; got ${JSON.stringify(o.kind)}.` },
      { status: 400 }
    );
  }

  const comparison = compareCostToExpress(candidates);

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    axis: "breakeven_underlying_move_pct — the move the UNDERLYING must make to cover a round trip",
    ...comparison,
    notes: [
      "Comparing raw spreads overstates the gap: an option's spread is charged on the premium, which controls several times its own value in delta-equivalent exposure. On the real book that is the difference between 354x and 54x, and only the latter is denominated in the same unit as an edge.",
      "Cheapest is not best. This ranks COST alone; leverage per dollar and whether the downside is capped are reported beside it and are not scored.",
      "No reach, hit-rate or expectancy figure appears here for crypto. Those are drift-contaminated on a sample that fell 84.5% over its history — down-touch would read as a property of the asset when it is a property of the period — and the symmetric/antisymmetric decomposition that made the equity version honest has not been run on crypto.",
      "Spot books are live and one-shot; equity costs prefer the measured spread history because a single snapshot is one draw from a distribution, and modelled costs have run 1.9-12.8x wrong against observed ones here.",
    ],
  });
}

/** A GET is an agent that has not read the contract; answer with the contract. */
export function GET() {
  return NextResponse.json(
    {
      error: "post_required",
      detail:
        "POST the instruments that could carry the same view; each comes back priced on one axis — the underlying move needed to cover a round trip.",
      example: {
        candidates: [
          { kind: "spot", venue: "kraken", pair: "STX/USD", label: "Stacks spot" },
          { kind: "equity", symbol: "BTDR" },
          {
            kind: "option",
            label: "BTDR 2026-08-28 10.50C",
            bid: 1.05,
            ask: 1.45,
            delta: 0.724,
            multiplier: 100,
            underlying_price: 11.37,
          },
        ],
      },
      notes: [
        "equity uses the measured spread history when the symbol has one; supply bid/ask only as a fallback and the response will say it was used.",
        "option requires bid, ask, delta, multiplier and underlying_price — without them a premium spread cannot be converted into an underlying move.",
        "spot fetches a live public order book. No API key is involved, and none should be given to this site.",
      ],
    },
    { status: 405 }
  );
}
