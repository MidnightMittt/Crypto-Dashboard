import paperJson from "../../data/paperLines.json";
import { IVRV_SCREEN_DECLARATION } from "../research/ivRvScreen";
import type { DeclaredMethod } from "./roundTrips";

/**
 * EVERY METHOD THIS SITE HAS DECLARED, IN ONE LIST.
 *
 * The round-trip reader needs to answer two questions about a `method_id` on a
 * fill — do we know this method, and did we declare it before the trade — and
 * neither can be answered from the log alone. This is the other half.
 *
 * ── Why it is assembled rather than written down ──────────────────────
 *
 * A hand-maintained list of declared ids would be a second place for the
 * register to live, and the moment a paper line is added without touching it
 * the site starts reporting a real strategy as `method-not-declared`. So it is
 * derived from the declarations themselves: the paper lines carry their own
 * `declaredOn`, and the IV/RV screen carries its own.
 *
 * ── The two kinds of declaration, kept distinct ───────────────────────
 *
 * A paper line is declared AND priced nightly, so a fill under it can be
 * differenced against the price the strategy assumed. The IV/RV screen is
 * declared and has no paper price — it is a claim about a ranking, not a
 * simulated book. `hasPaperPrice` carries that difference through to the
 * ledger, where it becomes its own blocker rather than being quietly folded
 * into "joinable". Attribution without a reference price answers who executed
 * a trade, not how well it was executed.
 */

interface PaperLinesShape {
  lines: { id: string; line: { full: { declaration: { declaredOn: string } } } }[];
}

export const DECLARED_METHODS: readonly DeclaredMethod[] = [
  ...(paperJson as unknown as PaperLinesShape).lines.map((l) => ({
    id: l.id,
    declaredOn: l.line.full.declaration.declaredOn,
    hasPaperPrice: true,
  })),
  {
    id: IVRV_SCREEN_DECLARATION.id,
    declaredOn: IVRV_SCREEN_DECLARATION.declaredOn,
    hasPaperPrice: false,
  },
];
