import { NextRequest, NextResponse } from "next/server";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel, SymbolPanel } from "@/lib/research/barsPanel";
import { Bar } from "@/lib/research/types";
import { DistanceItem, distanceRow, sortByDistance } from "@/lib/research/distanceTable";

/**
 * POST /api/distance — price-to-level distances, sorted, with how often one
 * session travels that far.
 *
 *   { "items": [ { "symbol": "BTDR", "price": 11.315, "level": 10.20,
 *                  "label": "time-stop threshold" } ] }
 *
 * Stateless: the broker is the source of truth for the book and a copy here
 * would drift, so prices and levels arrive in the request and nothing is
 * stored. The site's contribution is the frequency column — from committed
 * daily bars, lows for a level below price, highs for one above, horizon
 * one session so the windows do not overlap.
 *
 * Rows that cannot be computed are rejected BY NAME beside the table rather
 * than failing the whole request — this is a watcher, not a gate, and the
 * caller polling with fifteen levels should not lose fourteen answers to
 * one typo. (The pre-trade auditor takes the opposite stance on its book,
 * deliberately: a mis-parsed held position changes a verdict; a mis-parsed
 * distance row only loses itself.)
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;

/** A watch list, not a universe scan. */
const MAX_ITEMS = 100;

/** Panel rows to Bars, interpolated fills excluded — the rule everywhere else uses. */
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const raw = body.items;
  if (!Array.isArray(raw)) {
    return NextResponse.json(
      { error: "Body must carry an `items` array of {symbol, price, level, label?}." },
      { status: 400 }
    );
  }
  if (raw.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `At most ${MAX_ITEMS} items; got ${raw.length}.` },
      { status: 400 }
    );
  }

  const rows = [];
  const rejected: { index: number; symbol: string; reason: string }[] = [];
  const barsCache = new Map<string, Bar[] | null>();

  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    const symbol = String(o.symbol ?? "").trim().toUpperCase();
    const price = Number(o.price);
    const level = Number(o.level);

    if (!symbol) {
      rejected.push({ index: i, symbol: String(o.symbol ?? ""), reason: "symbol is required" });
      continue;
    }
    if (!(Number.isFinite(price) && price > 0)) {
      rejected.push({ index: i, symbol, reason: `price must be a positive number, got ${String(o.price)}` });
      continue;
    }
    if (!(Number.isFinite(level) && level > 0)) {
      rejected.push({ index: i, symbol, reason: `level must be a positive number, got ${String(o.level)}` });
      continue;
    }

    if (!barsCache.has(symbol)) {
      const sp = panel.symbols[symbol];
      barsCache.set(symbol, sp ? realBars(panel.sessions, sp) : null);
    }

    const item: DistanceItem = {
      symbol,
      price,
      level,
      label: typeof o.label === "string" ? o.label : undefined,
    };
    rows.push(distanceRow(item, barsCache.get(symbol) ?? null));
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    price_source: "client_supplied — the site holds no book and no live feed; distances are as fresh as the prices posted",
    bars_session: panel.sessions[panel.sessions.length - 1] ?? null,
    rows: sortByDistance(rows),
    rejected,
  });
}

/** A GET is an agent that has not read the contract; answer with the contract. */
export function GET() {
  return NextResponse.json(
    {
      error: "post_required",
      detail: "POST the levels you are watching with the prices you hold; sorted distances come back.",
      example: {
        items: [
          { symbol: "BTDR", price: 11.315, level: 10.2, label: "time-stop threshold" },
          { symbol: "RIOT", price: 19.7, level: 16.04, label: "disaster stop" },
          { symbol: "CIFR", price: 15.76, level: 18.32, label: "ladder rung" },
        ],
      },
      notes: [
        "Stateless. Prices are the caller's; the site stores nothing and holds no book.",
        "single_session_touch says how often ONE session travels that far on this name's own daily bars — lows for a level below price, highs for one above. Non-overlapping windows, so n is the honest count.",
        "Rows that cannot be computed are rejected by name beside the table; the rest still answer.",
      ],
    },
    { status: 405 }
  );
}
