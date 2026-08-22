import { OptionLegEcho, parseOptionLeg } from "@/lib/portfolio/buildPortfolio";

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
 *   - Any option field (strike/expiry/right/delta/multiplier/
 *     underlying_price) declares the row an option leg, validated by the
 *     SAME function /api/portfolio uses — one contract cannot be a valid
 *     leg to one endpoint and an invalid one to the other. For an option,
 *     `price` is the PER-CONTRACT premium (1.25, not 125).
 */

export type ParsedHeldPosition =
  | {
      kind: "equity";
      symbol: string;
      /** Signed. Negative is short and offsets book exposure. */
      shares: number;
      price: number;
    }
  | {
      kind: "option";
      symbol: string;
      /** Signed contract count. */
      contracts: number;
      /** PER-CONTRACT premium (1.25, not 125), same convention as /api/portfolio. */
      premium: number;
      leg: OptionLegEcho;
      /** Caller's mark for the underlying, so delta and spot share a snapshot. */
      underlyingPrice: number | null;
    };

export type HeldPositionsParse =
  | { ok: true; positions: ParsedHeldPosition[] }
  | { ok: false; error: string };

export function parseHeldPositions(raw: unknown, nowMs: number): HeldPositionsParse {
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

    const declaresOption =
      o.strike !== undefined ||
      o.expiry !== undefined ||
      o.right !== undefined ||
      o.delta !== undefined ||
      o.multiplier !== undefined ||
      o.underlying_price !== undefined;

    if (declaresOption) {
      const parsed = parseOptionLeg(
        symbol,
        {
          strike: o.strike === undefined || o.strike === null ? undefined : Number(o.strike),
          expiry: typeof o.expiry === "string" ? o.expiry : undefined,
          right: typeof o.right === "string" ? o.right : undefined,
          delta: o.delta === undefined || o.delta === null ? undefined : Number(o.delta),
          multiplier: o.multiplier === undefined || o.multiplier === null ? undefined : Number(o.multiplier),
        },
        nowMs
      );
      if (!parsed.ok) {
        return { ok: false, error: `${at}: ${parsed.reason}` };
      }
      const underlying = Number(o.underlying_price);
      positions.push({
        kind: "option",
        symbol,
        contracts: shares,
        premium: price,
        leg: parsed.leg,
        underlyingPrice: Number.isFinite(underlying) && underlying > 0 ? underlying : null,
      });
      continue;
    }

    positions.push({ kind: "equity", symbol, shares, price });
  }
  return { ok: true, positions };
}
