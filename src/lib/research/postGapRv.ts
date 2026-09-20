/**
 * POST-GAP REALIZED VOLATILITY — RV with earnings-gap jumps removed.
 *
 * The FPS option trigger (T1) compares a contract's implied vol against the
 * realized vol the underlying WOULD show if its earnings gaps were not in the
 * sample. A single gap up or down on a report dominates a 21-session RV and
 * makes an option look "fairly priced" against a number that is really one
 * jump — which produced two wrong "fair" readings before the rule was fixed.
 *
 * ── The rule, exactly as specified, and the variant it REPLACED ───────
 *
 * Drop a session ONLY when its GAP component (overnight, close→open) is a
 * >4-sigma outlier, where sigma = 1.4826 × MAD of the gap components. This is
 * NOT the retired "3× median move on the whole bar" rule, which stripped
 * ordinary volatility from high-vol names by judging the full daily move
 * rather than the gap alone. The distinction matters: a name that simply
 * trends hard intraday keeps all its sessions here; only an overnight jump
 * that stands out from the name's OWN gap distribution is removed.
 *
 * ── Why the gap, not the whole return ─────────────────────────────────
 *
 * An earnings move arrives as an overnight gap: the print lands after close,
 * the reaction is in the next open. Intraday range is ordinary volatility a
 * vol seller is paid to carry. Isolating the gap component targets the event
 * without punishing a volatile-but-continuous tape.
 */

/** Annualisation convention shared with ivRv.ts — zero-mean, 252 sessions. */
const ANNUALISATION_SESSIONS = 252;
/** Sessions in the RV21 window. */
export const RV_WINDOW_SESSIONS = 21;
/** MAD → sigma scaling for a normal distribution. */
export const MAD_TO_SIGMA = 1.4826;
/** A gap this many sigma from the median gap is an outlier and its session is dropped. */
export const GAP_SIGMA_CUT = 4;
/** Below this many retained returns, RV is refused rather than estimated thin. */
export const MIN_RETAINED = 8;

export interface PostGapRvResult {
  /** Annualised post-gap realized vol, percent. */
  rvPct: number;
  /** Sessions actually used, after dropping gap outliers. */
  retained: number;
  /** Sessions dropped as gap outliers, with the dates and gap sizes. */
  dropped: { date: string; gapPct: number }[];
  /** The window the RV was measured over, stated so the number is arguable. */
  window: { from: string; to: string; sessions: number };
}

/** median of a numeric slice (sorted copy). */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Post-gap RV over the last `window` sessions of an OHLC series.
 *
 * `opens`, `closes`, `dates` are aligned arrays, oldest first. Returns null
 * rather than a partial number when the window has fewer than MIN_RETAINED
 * usable returns after dropping outliers — the MIN_ENTRIES culture: an RV
 * computed on a handful of sessions is noise wearing a decimal point.
 */
export function postGapRv(
  opens: readonly number[],
  closes: readonly number[],
  dates: readonly string[],
  window = RV_WINDOW_SESSIONS
): PostGapRvResult | null {
  const n = closes.length;
  if (n < 2 || opens.length !== n || dates.length !== n) return null;

  // Build aligned per-session components over the trailing window. A session's
  // daily return needs the prior close, so the window starts one bar in.
  const start = Math.max(1, n - window);
  const sessions: { date: string; ret: number; gap: number }[] = [];
  for (let i = start; i < n; i++) {
    const prevClose = closes[i - 1];
    const open = opens[i];
    const close = closes[i];
    if (!(prevClose > 0 && open > 0 && close > 0)) continue; // gap over a hole understates — skip
    sessions.push({
      date: dates[i],
      ret: Math.log(close / prevClose),
      gap: Math.log(open / prevClose), // overnight component
    });
  }
  if (sessions.length < MIN_RETAINED) return null;

  // Outlier test on the GAP components: |gap - median(gap)| > 4 * sigma.
  const gaps = sessions.map((s) => s.gap);
  const medGap = median(gaps);
  const absDev = gaps.map((g) => Math.abs(g - medGap));
  const mad = median(absDev);

  /*
   * MAD DEGENERACY, and the standard fix for it.
   *
   * When more than half the gaps are (near-)identical, MAD collapses to ~0 —
   * and in floating point it lands on noise like 2e-16, not exactly zero. A
   * 4-sigma test against ~0 then flags ordinary 0.1% gaps as earnings jumps
   * and strips half the sample, which is precisely the over-dropping this rule
   * was meant to avoid. The Iglewicz–Hoaglin remedy: when MAD is negligible,
   * fall back to 1.253 × mean-absolute-deviation as the scale. That keeps a
   * lone genuine gap detectable (a huge outlier still dominates the MeanAD)
   * while a tight, near-degenerate distribution stops manufacturing outliers.
   * If BOTH are ~0 the gaps are truly identical — no dispersion, nothing to
   * flag — and sigma stays 0.
   */
  const MAD_FLOOR = 1e-9; // 1e-7% in log-return space — far below any real gap dispersion
  let sigma: number;
  if (mad > MAD_FLOOR) {
    sigma = MAD_TO_SIGMA * mad;
  } else {
    const meanAbsDev = absDev.reduce((a, d) => a + d, 0) / absDev.length;
    sigma = 1.253 * meanAbsDev;
  }

  const kept: { date: string; ret: number }[] = [];
  const dropped: { date: string; gapPct: number }[] = [];
  for (const s of sessions) {
    // sigma === 0 (all gaps identical) means no gap has any dispersion to
    // exceed — nothing is an outlier, keep everything.
    const isOutlier = sigma > 0 && Math.abs(s.gap - medGap) > GAP_SIGMA_CUT * sigma;
    if (isOutlier) dropped.push({ date: s.date, gapPct: s.gap * 100 });
    else kept.push({ date: s.date, ret: s.ret });
  }
  if (kept.length < MIN_RETAINED) return null;

  // Zero-mean annualised stdev, matching ivRv's convention so the ratio is a
  // comparison and not a units mismatch.
  const sumSq = kept.reduce((a, k) => a + k.ret * k.ret, 0);
  const rvPct = Math.sqrt(sumSq / kept.length) * Math.sqrt(ANNUALISATION_SESSIONS) * 100;

  return {
    rvPct,
    retained: kept.length,
    dropped,
    window: { from: sessions[0].date, to: sessions[sessions.length - 1].date, sessions: sessions.length },
  };
}
