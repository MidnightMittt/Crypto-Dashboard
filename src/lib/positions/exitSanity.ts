/**
 * EXIT SANITY — the $72 feature.
 *
 * The loss it exists to prevent, verbatim from the book: a resting option
 * sell was raised from 0.92 to 1.22 on a contract whose LIFETIME HIGH was
 * 0.95. The order could never fill. That one edit cost $72 — the position
 * decayed to worthless behind a target no print had ever touched.
 *
 * The check: a resting exit target is compared against the contract's OWN
 * traded high over its whole available history. A target above every price
 * ever printed is flagged UNREACHABLE — not as advice, as arithmetic.
 *
 * ── The rule that makes edits safe ────────────────────────────────────
 *
 * RAISING A WORKING EXIT IS A NEW TRADE and must clear the same bar as an
 * entry. An edit that moves a target further from the market is evaluated
 * exactly as if the order were being placed fresh — plus it is NAMED as a
 * raise, because the 0.92→1.22 edit looked like housekeeping and was in fact
 * the decision that lost the money.
 *
 * ── Inputs are POSTED ─────────────────────────────────────────────────
 *
 * The contract's history comes from the holder's broker (get_option_historicals
 * on their side); this site cannot read Robinhood and does not pretend to.
 * The evaluator takes the lifetime high as a posted input with its stamp, and
 * the verdict carries both. Pure function — no clock, no network.
 */

export interface ExitSanityInput {
  /** Human label for the contract, e.g. "SMR 2026-11-21 25C". */
  contract: string;
  /** The resting (or proposed) exit target, per contract. */
  targetPrice: number;
  /** The contract's lifetime traded high, POSTED from broker historicals. */
  lifetimeHigh: number;
  /** When the historicals were read, ISO — stamps travel with verdicts. */
  highAsOf: string;
  /** Present when this is an EDIT of a working order: the current target. */
  priorTarget?: number | null;
  /** Optional: last traded price, for distance context only. */
  lastPrice?: number | null;
}

export interface ExitSanityVerdict {
  contract: string;
  verdict: "REACHABLE" | "UNREACHABLE" | "RAISE_UNREACHABLE";
  /** target / lifetimeHigh — above 1.0 means no print has ever touched it. */
  targetVsHigh: number;
  isRaise: boolean;
  summary: string;
  stamps: { lifetime_high: { value: number; as_of: string; source: "posted (broker historicals)" } };
}

export function evaluateExitSanity(i: ExitSanityInput): ExitSanityVerdict {
  const ratio = i.lifetimeHigh > 0 ? i.targetPrice / i.lifetimeHigh : Infinity;
  const unreachable = i.targetPrice > i.lifetimeHigh;
  const isRaise = i.priorTarget !== undefined && i.priorTarget !== null && i.targetPrice > i.priorTarget;

  const verdict: ExitSanityVerdict["verdict"] = unreachable
    ? isRaise
      ? "RAISE_UNREACHABLE"
      : "UNREACHABLE"
    : "REACHABLE";

  const raiseClause = isRaise
    ? `This is a RAISE (${i.priorTarget} → ${i.targetPrice}) — raising a working exit is a new trade and must clear the same bar as an entry. `
    : "";

  const summary = unreachable
    ? `${i.contract}: target ${i.targetPrice} exceeds the contract's lifetime high of ${i.lifetimeHigh} ` +
      `(${((ratio - 1) * 100).toFixed(0)}% above every price it has ever printed). ${raiseClause}` +
      `An order above all history is not an exit, it is a hope with a ticket number.`
    : `${i.contract}: target ${i.targetPrice} sits inside traded history (lifetime high ${i.lifetimeHigh}, ` +
      `target at ${(ratio * 100).toFixed(0)}% of it). ${raiseClause}` +
      `Reachability says nothing about likelihood — only that at least one print has been there.`;

  return {
    contract: i.contract,
    verdict,
    targetVsHigh: ratio,
    isRaise,
    summary,
    stamps: { lifetime_high: { value: i.lifetimeHigh, as_of: i.highAsOf, source: "posted (broker historicals)" } },
  };
}
