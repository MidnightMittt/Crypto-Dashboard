import { NextResponse } from "next/server";
import { buildBookCards } from "@/lib/positions/cards";
import { loadReads, readsById } from "@/lib/positions/readsStore";

/**
 * GET /api/positions — the book, live.
 *
 * One request = live chain ticks (both chains), GeckoTerminal windows, and
 * the thesis verdicts evaluated against the committed read history. Dynamic
 * because the whole point is "is each thing I own still doing what I bought
 * it for" as of NOW, not as of the last deploy.
 *
 * Every number carries its source: chain | api | posted. The venues the site
 * cannot read (Robinhood, Xverse, Coinbase) appear as posted holdings with
 * their stamps — never as pretend-live figures.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const reads = readsById(loadReads());
  const cards = await buildBookCards(reads);
  const broken = cards.filter((c) => c.theses.some((t) => t.state === "broken"));
  return NextResponse.json({
    observedAt: new Date().toISOString(),
    headline: broken.length
      ? `${broken.length} position(s) with a BROKEN thesis: ${broken.map((b) => b.label).join("; ")}`
      : "no broken theses on the last two reads",
    cards,
    notes: [
      "Theses break only on two consecutive reads — one read is BREAKING, not broken.",
      "Out-of-range LP yield is 0 regardless of pool volume; coverage reflects the position, not the pool.",
      "chain = read from the contract this request; api = GeckoTerminal; posted = holder-supplied with a date.",
    ],
  });
}
