import { MarketExposure } from "./buildPretrade";

/**
 * THE SHARED BETA LOOKUP.
 *
 * `/api/pretrade` and `/api/portfolio` both need the overnight study's
 * beta/alpha rows, and two endpoints reporting different betas for the same
 * symbol would be worse than either reporting none. One reader, one declared
 * pairing, both routes.
 */

/**
 * SPY at 250 sessions is the declared headline pairing — one proxy and one
 * horizon fixed in advance, so nothing served is the flattering pick of the
 * four proxy-window combinations the study computes.
 */
export const HEADLINE_PROXY = "SPY";
export const HEADLINE_WINDOW = 250;

export interface OvernightArtifact {
  generatedAt: number;
  rows: { symbol: string; window: number; lastClose: number | null; asOf: string | null; overnightNetBp: number }[];
  alphaRows?: {
    subject: string;
    kind: string;
    proxy: string;
    window: number;
    alphaBp: number;
    alphaT: number;
    beta: number;
    rSquared: number;
    n: number;
    detectableAlphaAtT3Bp: number;
    significantAfterFdr: boolean;
  }[];
}

/**
 * Beta/alpha per symbol at the headline pairing.
 *
 * ── The proxy's own beta is DECLARED, not estimated ───────────────────
 *
 * The study skips regressing SPY on SPY, correctly: it is a tautology and
 * would report beta 1 with zero residual and an infinite t. But an agent
 * hedging with SPY then gets "not_in_overnight_study" for the hedge, the
 * hedge drops out of the coverage denominator, and the portfolio's beta reads
 * as though only the long leg existed — understating the leverage, which is
 * the dangerous direction.
 *
 * So the identity is stated rather than fitted: the beta of the proxy against
 * itself is exactly 1, its R-squared exactly 1, and its alpha exactly 0. That
 * is arithmetic, not a measurement, and `method` says so.
 */
export function marketExposureFromArtifact(artifact: OvernightArtifact): Map<string, MarketExposure> {
  const out = new Map<string, MarketExposure>();
  const proxyNetBp =
    artifact.rows.find((r) => r.symbol === HEADLINE_PROXY && r.window === HEADLINE_WINDOW)
      ?.overnightNetBp ?? null;
  if (proxyNetBp === null) return out;

  for (const a of artifact.alphaRows ?? []) {
    if (a.kind !== "symbol" || a.proxy !== HEADLINE_PROXY || a.window !== HEADLINE_WINDOW) continue;
    out.set(a.subject, {
      proxy: a.proxy,
      window_sessions: a.window,
      observations: a.n,
      beta: a.beta,
      alpha_bp: a.alphaBp,
      alpha_t: a.alphaT,
      alpha_significant_after_fdr: a.significantAfterFdr,
      detectable_alpha_at_t3_bp: a.detectableAlphaAtT3Bp,
      r_squared: a.rSquared,
      proxy_net_bp: proxyNetBp,
      derivation: "regressed_ols",
    });
  }

  // The identity. Only added if the study did not already cover it somehow.
  if (!out.has(HEADLINE_PROXY)) {
    out.set(HEADLINE_PROXY, {
      proxy: HEADLINE_PROXY,
      window_sessions: HEADLINE_WINDOW,
      observations: 0,
      beta: 1,
      alpha_bp: 0,
      alpha_t: 0,
      alpha_significant_after_fdr: false,
      detectable_alpha_at_t3_bp: 0,
      r_squared: 1,
      proxy_net_bp: proxyNetBp,
      derivation: "identity_by_definition",
    });
  }
  return out;
}

/** Last close per symbol, for valuing a position the caller did not mark. */
export function lastCloseFromArtifact(
  artifact: OvernightArtifact
): Map<string, { price: number; asOf: string }> {
  const out = new Map<string, { price: number; asOf: string }>();
  for (const r of artifact.rows) {
    if (r.lastClose === null || r.asOf === null) continue;
    // Rows repeat per window; the close is the same, so first wins.
    if (!out.has(r.symbol)) out.set(r.symbol, { price: r.lastClose, asOf: r.asOf });
  }
  return out;
}
