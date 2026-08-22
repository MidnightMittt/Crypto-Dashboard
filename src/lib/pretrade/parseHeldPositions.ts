/**
 * PARSING THE HELD BOOK — loudly, because the silent version cost a week.
 *
 * The concurrent-exposure check was reported as "missing" twice. It was
 * never missing: it worked whenever a held position arrived under the key
 * this route expected (`shares`). But its sibling endpoint /api/portfolio
 * takes `quantity`, the caller naturally reused that convention, and
 * `Number(undefined) || 0` coerced every held position to zero shares —
 * so the book silently shrank to nothing, and a check that should have
 * read 62x the account read 0.6x, byte-identical to sending no book at
 * all. A field accepted and silently zeroed is worse than one rejected:
 * it produced two independent wrong audit reports before anyone found it.
 *
 * Rules, mirroring live_price's all-or-nothing treatment:
 *   - `shares` and `quantity` are both accepted; if both appear they must
 *     agree, because two disagreeing sizes for one position is a defect in
 *     the caller's book, not a choice for this route to make.
 *   - A position that cannot be fully parsed (symbol, a finite non-zero
 *     share count, a positive price) is an ERROR naming the row — never a
 *     zero-contribution pass-through.
 */

export interface ParsedHeldPosition {
  symbol: string;
  /** Signed. Negative is short and offsets book exposure. */
  shares: number;
  price: number;
}

export type HeldPositionsParse =
  | { ok: true; positions: ParsedHeldPosition[] }
  | { ok: false; error: string };

export function parseHeldPositions(raw: unknown): HeldPositionsParse {
  if (raw === undefined || raw === null) return { ok: true, positions: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "existing_positions must be an array of {symbol, shares, price}." };
  }

  const positions: ParsedHeldPosition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    const symbol = String(o.symbol ?? "").trim().toUpperCase();
    const at = `existing_positions[${i}]${symbol ? ` (${symbol})` : ""}`;

    if (!symbol) return { ok: false, error: `${at}: symbol is required.` };

    const hasShares = o.shares !== undefined && o.shares !== null;
    const hasQuantity = o.quantity !== undefined && o.quantity !== null;
    if (!hasShares && !hasQuantity) {
      return { ok: false, error: `${at}: supply shares (or quantity — both keys are accepted).` };
    }
    const shares = Number(hasShares ? o.shares : o.quantity);
    if (hasShares && hasQuantity && Number(o.shares) !== Number(o.quantity)) {
      return {
        ok: false,
        error: `${at}: shares (${String(o.shares)}) and quantity (${String(o.quantity)}) disagree — send one, or the same value.`,
      };
    }
    if (!Number.isFinite(shares) || shares === 0) {
      return { ok: false, error: `${at}: shares must be a finite non-zero number, got ${String(hasShares ? o.shares : o.quantity)}.` };
    }

    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) {
      return {
        ok: false,
        error: `${at}: price must be a positive number, got ${String(o.price)}. A held position priced at zero would contribute nothing to book exposure, silently.`,
      };
    }

    positions.push({ symbol, shares, price });
  }
  return { ok: true, positions };
}
