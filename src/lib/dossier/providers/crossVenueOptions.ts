import { CrossVenueRead, ParsedContract, summariseParsed } from "./cboeOptions";

/**
 * CROSS-VENUE OPTIONS CONFIRMATION.
 *
 * Two independent option chains, compared on the expiration BOTH list, using
 * the SAME summariser both venues already run. The comparison is restricted
 * to one shared expiry precisely so it is honest: front-month against
 * full-chain would compare two different things and call it agreement.
 *
 * The independence audit lives on `CrossVenueRead` in cboeOptions.ts and is
 * the reason this module counts only two checks rather than three: open
 * interest is OCC data both venues redistribute, so a put/call "agreement"
 * is a number agreeing with itself. It is reported as integrity, not
 * corroboration.
 *
 * ── Thresholds, and why magnitude is reported anyway ──────────────────
 *
 * Any IV tolerance is a judgement call, so the GAP IN POINTS is always
 * carried and always shown; the boolean only decides how loudly to present
 * it. The bar below — 2 points absolute, or 5% relative for high-vol names
 * where 2 points is noise — was set against measured gaps (NVDA 1.3, AAPL
 * 6.1, IREN 0.5) on the principle that several vol points on a near-dated
 * ATM option is a materially different price, not a rounding difference. The
 * earlier 5-point/20% bar waved AAPL's 6.1-point gap through as "agreement",
 * which is exactly the overstatement this page must not make.
 */

const IV_ABS_TOL = 2;
const IV_REL_TOL = 0.05;

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

  // ── Independent check 1: implied vol, with the gap kept ──
  const atmIvPctPrimary = ps.atmIvPct;
  const atmIvPctSecondary = ss.atmIvPct;
  const bothIv = atmIvPctPrimary !== null && atmIvPctSecondary !== null;
  const ivGapPoints = bothIv ? Math.abs(atmIvPctPrimary - atmIvPctSecondary) : null;
  const ivAgree = bothIv ? ivAgrees(atmIvPctPrimary, atmIvPctSecondary) : null;

  // ── Independent check 2 (coarse): net dealer-gamma sign ──
  const gexSignPrimary = ps.netGexUsdPer1Pct !== null ? sign(ps.netGexUsdPer1Pct) : null;
  const gexSignSecondary = ss.netGexUsdPer1Pct !== null ? sign(ss.netGexUsdPer1Pct) : null;
  const gexAgree =
    gexSignPrimary !== null && gexSignSecondary !== null ? gexSignPrimary === gexSignSecondary : null;

  /*
   * Shared-source integrity, NOT a third vote: both venues redistribute OCC
   * open interest, so these ratios should be identical. A mismatch means one
   * venue's ingest is stale or partial — worth knowing, but its agreement
   * proves nothing about the chain read.
   */
  const putCallOiPrimary = ps.callOi > 0 ? ps.putOi / ps.callOi : null;
  const putCallOiSecondary = ss.callOi > 0 ? ss.putOi / ss.callOi : null;
  const openInterestIdentical =
    putCallOiPrimary !== null && putCallOiSecondary !== null
      ? Math.abs(putCallOiPrimary - putCallOiSecondary) < 0.001
      : null;

  const independent = [ivAgree, gexAgree];
  const comparisons = independent.filter((c) => c !== null).length;
  const agreements = independent.filter((c) => c === true).length;

  return {
    expiry: sharedExpiry,
    atmIvPctPrimary,
    atmIvPctSecondary,
    ivGapPoints,
    ivAgree,
    putCallOiPrimary,
    putCallOiSecondary,
    openInterestIdentical,
    gexSignPrimary,
    gexSignSecondary,
    gexAgree,
    agreements,
    comparisons,
    line: composeLine({
      comparisons,
      ivAgree,
      ivGapPoints,
      atmIvPctPrimary,
      atmIvPctSecondary,
      gexAgree,
      openInterestIdentical,
    }),
  };
}

function composeLine(x: {
  comparisons: number;
  ivAgree: boolean | null;
  ivGapPoints: number | null;
  atmIvPctPrimary: number | null;
  atmIvPctSecondary: number | null;
  gexAgree: boolean | null;
  openInterestIdentical: boolean | null;
}): string {
  if (x.comparisons === 0) {
    return "A second options venue (Tradier) returned a chain, but neither implied vol nor dealer gamma could be compared on the shared expiry — the read still rests on the primary venue alone.";
  }

  const parts: string[] = [];

  // The independent evidence, magnitude first.
  if (x.ivGapPoints !== null && x.atmIvPctPrimary !== null && x.atmIvPctSecondary !== null) {
    parts.push(
      x.ivAgree
        ? `A second, independent options venue (Tradier, greeks from ORATS) prices this expiry within ${x.ivGapPoints.toFixed(1)} implied-vol point${x.ivGapPoints < 1.05 && x.ivGapPoints >= 0.95 ? "" : "s"} of the primary read (${x.atmIvPctPrimary.toFixed(0)}% vs ${x.atmIvPctSecondary.toFixed(0)}%) — two different solvers landing in the same place.`
        : `A second options venue (Tradier, greeks from ORATS) prices this expiry ${x.ivGapPoints.toFixed(1)} implied-vol points away from the primary read (${x.atmIvPctPrimary.toFixed(0)}% vs ${x.atmIvPctSecondary.toFixed(0)}%) — the two vendors' models disagree materially about what this chain implies, so treat the volatility figure, and anything derived from it, as uncertain.`
    );
  }

  if (x.gexAgree !== null) {
    parts.push(
      x.gexAgree
        ? "Both venues put dealer gamma on the same side, so the hedging-direction read is not one vendor's artefact."
        : "The venues put dealer gamma on OPPOSITE sides — the hedging-direction read is not safe to lean on."
    );
  }

  // The shared-source note, so agreement here is never mistaken for a second opinion.
  if (x.openInterestIdentical === true) {
    parts.push(
      "Open interest matches exactly, as it must — both venues redistribute the OCC's figures, so that is a data-integrity check rather than a second opinion."
    );
  } else if (x.openInterestIdentical === false) {
    parts.push(
      "Open interest does NOT match between the venues even though both redistribute the same OCC figures — one feed is stale or partial, which is a reason to distrust the position counts above."
    );
  }

  return parts.join(" ");
}
