import Link from "next/link";
import type { Metadata } from "next";
import { TradeDesk } from "@/components/trade/TradeDesk";

/**
 * THE DESK — "I am thinking about this trade. Talk me out of it."
 *
 * ── Why this page exists and why it is not fifteen cards ──────────────
 *
 * Fifteen API routes had no UI. The obvious build is a Research page with a
 * card per endpoint, and it is the wrong build twice over. The charter's
 * first rule is that nothing appears because it exists, and a grid of
 * endpoint explorers is that rule's textbook violation. Worse, four of those
 * routes answer ONE question between them, IN SEQUENCE — a card each would
 * make the trader retype the symbol four times and chain the answers in
 * their head.
 *
 * So the page is the chain, not the endpoints:
 *
 *   1. /api/exit/design    where can a stop even go, before you pick one
 *   2. /api/pretrade/check every reason not to place the order you typed
 *   3. /api/cost/express   the move needed before the trade beats nothing
 *   4. /api/distance       how often price actually touches those levels
 *
 * Stage 1's reach curve is stage 4's input. That dependency is the argument.
 *
 * The other eleven routes are differently-homed, not homeless: /api/record
 * and /api/rules/ledger answer "did we work" and belong on /validation;
 * /api/screen/reach answers "what should I look at" and precedes this page,
 * with the scanner; /api/health is operations; /api/asset and
 * /api/positioning are already the JSON behind rendered pages;
 * /api/watch mutations need auth that does not exist yet.
 *
 * ── The framing is adversarial on purpose ─────────────────────────────
 *
 * A trader arrives here having already decided. Every other surface on the
 * site helps find a trade; this one is the only place whose job is to argue
 * against one, and a page that returns "looks good" is worth nothing to
 * somebody who already thought that. The button says "talk me out of it"
 * because that is the service being rendered.
 */

export const metadata: Metadata = {
  title: "Trade desk · Leverage Terminal",
  description: "Four measurements against one order, in the order they answer it.",
};

export default function TradePage() {
  return (
    <div className="min-h-screen">
      <main className="mx-auto flex max-w-[1000px] flex-col gap-5 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink">Trade desk</h1>
            <p className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-ink-faint">
              Talk me out of it
            </p>
          </div>
          <nav className="flex gap-4 text-[11px] uppercase tracking-[0.16em] text-ink-muted">
            <Link href="/scanner" className="hover:text-ink">
              ← Scanner
            </Link>
            <Link href="/validation" className="hover:text-ink">
              Validation
            </Link>
          </nav>
        </div>

        <p className="max-w-3xl text-[13px] leading-relaxed text-ink-muted">
          Every other surface here helps you find a trade. This one argues against the one you have
          already found. Type the order you are considering and four independent measurements run
          against it — where a stop can survive, what would block the order, what the round trip
          costs before you are even, and how often price has actually reached the levels you chose.
          Each is measured from committed history, and each refuses rather than guesses when the
          history is too thin to answer.
        </p>

        <TradeDesk />

        <p className="max-w-3xl text-[11px] leading-relaxed text-ink-faint">
          Nothing on this page is a recommendation, and a clean sweep is not one either — four
          measurements failing to object is the absence of an objection, not the presence of an
          edge. The signals with a measured out-of-sample record are on{" "}
          <Link href="/validation" className="text-ink-muted underline-offset-2 hover:underline">
            validation
          </Link>
          , failures included.
        </p>
      </main>
    </div>
  );
}
