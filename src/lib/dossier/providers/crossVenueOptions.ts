import { CrossVenueRead, ParsedContract, summariseParsed } from "./cboeOptions";

/**
 * CROSS-VENUE OPTIONS CONFIRMATION.
 *
 * Two independent option chains, compared on the expiration BOTH list, using
 * the SAME summariser both venues already run. The comparison is restricted
 * to one shared expiry precisely so it is honest: front-month against
 * full-chain would compare two different things and call it agreement.
 *
 * Three checks, each of which can independently be evaluated or skipped when
 * a venue lacks the input:
 *   - ATM implied vol, to within a tolerance (levels, from two solvers)
 *   - put/call open-interest ratio, same side of parity (positioning)
 *   - net gamma-exposure SIGN (dealer-hedging direction)
 *
 * Agreement raises confidence in the single-venue read; disagreement is
 * surfaced as a reason to trust it less, never silently averaged away.
 */

/** IV levels agree within the larger of 5 points absolute or 20% relative. */
const IV_ABS_TOL = 5;
const IV_REL_TOL = 0.2;

function ivAgrees(a: number, b: number): boolean {
  return Math.abs(a - b) <= IV_ABS_TOL || Math.abs(a - b) / Math.max(a, b) <= IV_REL_TOL;
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

export interface VenueChain {
  spot: number;
  contracts: ParsedContract[];
}

/**
 * Compare the two chains on `sharedExpiry`. Returns null when the venues do
 * not overlap on that expiration — no common ground, no comparison, rather
 * than a manufactured one.
 */
export function crossConfirm(
  primary: VenueChain,
  secondary: VenueChain,
  sharedExpiry: string
): CrossVenueRead | null {
  const p = primary.contracts.filter((c) => c.expiry === sharedExpiry);
  const s = secondary.contracts.filter((c) => c.expiry === sharedExpiry);
  if (p.length === 0 || s.length === 0) return null;

  const ps = summariseParsed(p, primary.spot);
  const ss = summariseParsed(s, secondary.spot);
  if (!ps || !ss) return null;

  // ── IV agreement ──
  const atmIvPctPrimary = ps.atmIvPct;
  const atmIvPctSecondary = ss.atmIvPct;
  const ivAgree =
    atmIvPctPrimary !== null && atmIvPctSecondary !== null
      ? ivAgrees(atmIvPctPrimary, atmIvPctSecondary)
      : null;

  // ── Put/call OI ratio, same side of parity ──
  const putCallOiPrimary = ps.callOi > 0 ? ps.putOi / ps.callOi : null;
  const putCallOiSecondary = ss.callOi > 0 ? ss.putOi / ss.callOi : null;
  const putCallAgree =
    putCallOiPrimary !== null && putCallOiSecondary !== null
      ? putCallOiPrimary > 1 === putCallOiSecondary > 1
      : null;

  // ── Net GEX sign ──
  const gexSignPrimary = ps.netGexUsdPer1Pct !== null ? sign(ps.netGexUsdPer1Pct) : null;
  const gexSignSecondary = ss.netGexUsdPer1Pct !== null ? sign(ss.netGexUsdPer1Pct) : null;
  const gexAgree =
    gexSignPrimary !== null && gexSignSecondary !== null ? gexSignPrimary === gexSignSecondary : null;

  const checks = [ivAgree, putCallAgree, gexAgree];
  const comparisons = checks.filter((c) => c !== null).length;
  const agreements = checks.filter((c) => c === true).length;

  return {
    expiry: sharedExpiry,
    atmIvPctPrimary,
    atmIvPctSecondary,
    ivAgree,
    putCallOiPrimary,
    putCallOiSecondary,
    putCallAgree,
    gexSignPrimary,
    gexSignSecondary,
    gexAgree,
    agreements,
    comparisons,
    line: composeLine({ agreements, comparisons, ivAgree, atmIvPctPrimary, atmIvPctSecondary, putCallAgree, gexAgree }),
  };
}

function composeLine(x: {
  agreements: number;
  comparisons: number;
  ivAgree: boolean | null;
  atmIvPctPrimary: number | null;
  atmIvPctSecondary: number | null;
  putCallAgree: boolean | null;
  gexAgree: boolean | null;
}): string {
  if (x.comparisons === 0) {
    return "A second options venue (Tradier) returned a chain, but the two had no overlapping check to compare — the read still rests on the primary venue alone.";
  }

  const disagreements: string[] = [];
  if (x.ivAgree === false && x.atmIvPctPrimary !== null && x.atmIvPctSecondary !== null) {
    disagreements.push(
      `implied vol (${x.atmIvPctPrimary.toFixed(0)}% vs ${x.atmIvPctSecondary.toFixed(0)}%)`
    );
  }
  if (x.putCallAgree === false) disagreements.push("which side of put/call parity positioning sits on");
  if (x.gexAgree === false) disagreements.push("the sign of dealer gamma");

  if (x.agreements === x.comparisons) {
    return `A second, independent options venue (Tradier, greeks from ORATS) agrees on all ${x.comparisons} check${x.comparisons === 1 ? "" : "s"} that could be compared on the shared expiry — the chain read is corroborated across venues, not a single vendor's snapshot.`;
  }

  if (x.agreements === 0) {
    return `A second options venue (Tradier) disagrees on ${describeList(disagreements)} — treat the single-venue chain read with more caution until the venues reconcile.`;
  }

  return `A second options venue (Tradier) agrees on ${x.agreements} of ${x.comparisons} checks but differs on ${describeList(disagreements)} — partial corroboration, with the disagreement worth noting.`;
}

function describeList(items: string[]): string {
  if (items.length === 0) return "at least one check";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
