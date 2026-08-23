/**
 * CAN THIS ACCOUNT ACTUALLY PLACE THIS TRADE?
 *
 * The scanner led with IWM at $299.96 against $137.14 of buying power —
 * zero shares affordable, ranked first, with a full plan beneath it. A
 * recommendation that cannot be taken is indistinguishable from no
 * recommendation, and it was occupying the top slot.
 *
 * Buying power arrives as a QUERY PARAM rather than a stored setting,
 * because the site holds no account by design — the broker is the source of
 * truth and /api/portfolio takes posted positions precisely so nothing is
 * stored here. The reader supplies it at read time, nothing persists, and a
 * page loaded without it behaves exactly as before.
 *
 * Ranking is untouched. This annotates; it does not re-rank, filter or hide.
 * Knowing the best setup on the board is out of reach is itself information,
 * and suppressing it would replace one silent failure with another.
 */
export function Reachability({
  price,
  buyingPower,
  compact = false,
}: {
  price: number | null | undefined;
  buyingPower: number | null;
  compact?: boolean;
}) {
  if (buyingPower === null || !price || !(price > 0)) return null;

  const shares = Math.floor(buyingPower / price);
  const reachable = shares >= 1;
  const text = reachable
    ? `${shares} share${shares === 1 ? "" : "s"} affordable`
    : `0 shares — needs $${price.toFixed(2)}, you have $${buyingPower.toFixed(2)}`;

  if (compact) {
    return (
      <span
        className={`ml-1.5 whitespace-nowrap text-[9px] uppercase tracking-[0.1em] ${
          reachable ? "text-ink-faint" : "text-danger"
        }`}
        title={reachable ? text : `Out of reach: ${text}`}
      >
        {reachable ? `${shares}×` : "unreachable"}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] ${
        reachable ? "border-hairline text-ink-muted" : "border-danger/40 bg-danger/[0.06] text-danger"
      }`}
    >
      {reachable ? text : `Out of reach — ${text}`}
    </span>
  );
}

/** `?bp=137.14`. Null when absent or unusable, which restores the old behaviour exactly. */
export function parseBuyingPower(raw: string | string[] | undefined): number | null {
  const v = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}
