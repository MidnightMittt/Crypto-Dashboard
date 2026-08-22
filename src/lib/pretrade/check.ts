/**
 * THE PRE-TRADE AUDITOR — every reason a sized trade should not be placed.
 *
 * Placing two orders on 2026-08-20 took roughly twenty minutes of
 * hand-written Python: stop survival across seven widths and three horizons,
 * hit rates at nine target levels, beta-adjusted book exposure, and a
 * deployment cap that had to be RESCALED first because it was derived on a
 * $211.67 account while the account stood at $338. That analysis is what
 * stands between a sized trade and a guess, and it lived nowhere.
 *
 * This is assembly, not new mathematics. Stop survival, beta, the earnings
 * veto, measured spreads and price staleness are all built and tested
 * elsewhere; the value here is running them together, every time, in an order
 * nobody has to remember.
 *
 * ── Two rules that decide whether it is usable ────────────────────────
 *
 * 1. EVERY CHECK CARRIES ITS REASON AND ITS SAMPLE SIZE. Never a bare
 *    boolean. A blocked trade has to be arguable — a trader who cannot
 *    interrogate a refusal will eventually override it on instinct, and then
 *    the auditor is worse than nothing because it taught them to ignore it.
 *
 * 2. A CHECK THAT CANNOT BE EVALUATED IS NOT A PASS. Missing data returns
 *    `unknown`, which is a distinct third state and never silently green.
 *    "The stop grid has no history for this name" and "the stop survives
 *    comfortably" are opposite facts and must not render identically.
 *
 * PURE. No fetching, no clock of its own. Everything it needs arrives as
 * inputs, so every branch is testable and the route is the only thing that
 * has to know where numbers come from.
 */

export type CheckStatus = "pass" | "fail" | "unknown";

export interface PretradeCheck {
  name: string;
  status: CheckStatus;
  /** One sentence naming the number and the threshold it was judged against. */
  detail: string;
  /** The figures behind the sentence, so a caller can re-derive the judgement. */
  data?: Record<string, number | string | null>;
}

export type Verdict = "pass" | "block" | "incomplete";

export interface PretradeVerdict {
  verdict: Verdict;
  /** Why the verdict is what it is, in the trader's own terms. */
  summary: string;
  checks: PretradeCheck[];
}

/**
 * A position already held, for book-level exposure — reduced by the ROUTE to
 * the two numbers every instrument shares, so the engine has one exposure
 * semantics and never needs to know how an option is priced.
 *
 *   capitalUsd            what the position ties up: shares x price for
 *                         equity, contracts x premium x multiplier for an
 *                         option. Signed.
 *   marketEquivalentUsd   what it moves like: value x beta for equity,
 *                         delta-equivalent x beta for an option. Null when
 *                         unmeasurable — never assumed, because a 1-lot call
 *                         at $125 of premium was measured moving like ~$800
 *                         of stock, and a book that counts it as $125 (or
 *                         zero) understates exactly when it matters.
 */
export interface HeldPosition {
  symbol: string;
  instrument: "equity" | "option";
  capitalUsd: number;
  marketEquivalentUsd: number | null;
}

/**
 * A live price the CALLER vouches for, with the provenance that makes it
 * arguable. The site cannot verify the value — it can only date it and name
 * where the caller says it came from, and both travel with the verdict.
 */
export interface LivePrice {
  value: number;
  /** Epoch ms of the caller's `as_of`, parsed by the route so this stays pure. */
  asOfMs: number;
  /** Named by the caller, e.g. "broker_bid". Echoed, never interpreted. */
  source: string;
}

export interface PretradeInputs {
  symbol: string;
  shares: number;
  entry: number;
  stop: number;
  holdSessions: number;
  accountValue: number;
  existingPositions: readonly HeldPosition[];

  /** Beta of the candidate. Null when unmeasured. */
  beta: number | null;
  /** Survival of THIS stop width at THIS horizon, 0-1, from the stop grid. */
  stopSurvival: { survival: number; independentN: number } | null;
  /** Next earnings date, ISO, and whether the lookup is trustworthy. */
  earnings: { date: string | null; status: "confirmed" | "none" | "lookup_failed" };
  /** Measured round-trip cost in basis points, and the edge it is charged against. */
  cost: { roundTripBp: number; edgeBp: number } | null;
  /** Price staleness, from the same module /api/asset uses. */
  priceAgeSessions: number;
  /** Today, ISO date, for the earnings window. */
  today: string;
  /**
   * Optional caller-supplied live price. When present, data_freshness judges
   * ITS age rather than the stored close's — which otherwise fails during
   * every live session by construction, because the close it measures does
   * not exist until tonight. Null means: behave exactly as before.
   */
  livePrice: LivePrice | null;
  /**
   * Optional buying power. When present, a `reachability` check asks the
   * question no other check does: can THIS account place THIS order at all.
   * A perfect call on a $186 stock against $137 of buying power is not a
   * trade — it is advice for a different account, and the auditor saying
   * PASS over it would be the least useful green light it can produce.
   * Absent: the check does not appear, so existing callers are unchanged.
   */
  buyingPowerUsd: number | null;
  /** The route's clock, epoch ms. Here so the engine keeps no clock of its own. */
  nowMs: number;
}

/** Survival floor a stop must clear. Matches SURVIVAL_FLOOR_PCT in stopViability. */
export const SURVIVAL_FLOOR = 0.7;

/**
 * Share of the account that may be deployed.
 *
 * Expressed as a FRACTION, never a dollar figure. A cap written in dollars
 * silently tightens as the account grows and silently loosens as it shrinks —
 * exactly what happened when a cap derived at $211.67 was still in use at
 * $338 and nobody had rescaled it.
 */
export const DEPLOYMENT_CAP = 0.7;

/**
 * Beta-adjusted book exposure ceiling, as a multiple of account value.
 *
 * The book reached 204% market-equivalent on one $95.58 position at beta
 * 4.57. Notional is the wrong axis for these names, and 1.5x is the point
 * past which a normal day in the driver moves the account more than a
 * position-sizing rule intends.
 */
export const MAX_BETA_EXPOSURE = 1.5;

/** Sessions before earnings within which a plan is refused. */
export const EARNINGS_BUFFER_SESSIONS = 3;

/**
 * Oldest a caller-supplied live price may be and still count as fresh.
 *
 * Fifteen minutes, matching the watchdog sweep's staleness guard, and for
 * the same reason: a price older than that may not reflect the market, and
 * judging a trade against it is the stale-close problem with extra steps.
 * The check fails rather than warns past the limit — the caller holds the
 * broker connection and can always re-quote.
 */
export const LIVE_PRICE_MAX_AGE_SECONDS = 15 * 60;

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const usd = (v: number) => `$${v.toFixed(2)}`;

function stopSurvivalCheck(i: PretradeInputs): PretradeCheck {
  const widthPct = i.entry > 0 ? ((i.entry - i.stop) / i.entry) * 100 : 0;
  if (!i.stopSurvival) {
    return {
      name: "stop_survival",
      status: "unknown",
      detail:
        `No stop grid for ${i.symbol} — too little history to measure how often a ` +
        `${widthPct.toFixed(1)}% stop survives a ${i.holdSessions}-session hold. ` +
        `Unmeasured is not the same as safe.`,
      data: { width_pct: Number(widthPct.toFixed(2)), survival: null, independent_n: null },
    };
  }
  const { survival, independentN } = i.stopSurvival;
  const ok = survival >= SURVIVAL_FLOOR;
  return {
    name: "stop_survival",
    status: ok ? "pass" : "fail",
    detail:
      `A ${widthPct.toFixed(1)}% stop survives ${pct(survival)} of ${i.holdSessions}-session ` +
      `holds; the floor is ${pct(SURVIVAL_FLOOR)}. ` +
      (ok
        ? "Wide enough that ordinary movement should not take it out."
        : "This stop is inside the name's normal range and will most likely be hit by noise."),
    data: {
      width_pct: Number(widthPct.toFixed(2)),
      survival: Number(survival.toFixed(3)),
      floor: SURVIVAL_FLOOR,
      independent_n: independentN,
    },
  };
}

function betaExposureCheck(i: PretradeInputs): PretradeCheck {
  if (i.beta === null) {
    return {
      name: "beta_exposure",
      status: "unknown",
      detail:
        `${i.symbol}'s beta is unmeasured, so its market-equivalent size cannot be added to the ` +
        `book. Treating it as 1.0 would understate a high-beta name by several times.`,
      data: { beta: null },
    };
  }

  const addedNotional = i.shares * i.entry;
  const added = addedNotional * i.beta;
  const existing = i.existingPositions.reduce(
    (sum, p) => sum + (p.marketEquivalentUsd ?? 0),
    0
  );
  const unmeasured = i.existingPositions.filter((p) => p.marketEquivalentUsd === null).length;
  const total = existing + added;
  const ratio = i.accountValue > 0 ? total / i.accountValue : Infinity;
  const ok = ratio <= MAX_BETA_EXPOSURE;

  return {
    name: "beta_exposure",
    status: ok ? "pass" : "fail",
    detail:
      `Adds ${usd(added)} market-equivalent (${usd(addedNotional)} notional x beta ${i.beta.toFixed(2)}); ` +
      `the book would reach ${pct(ratio)} of the account against a ${pct(MAX_BETA_EXPOSURE)} ceiling.` +
      (unmeasured > 0
        ? ` ${unmeasured} held position${unmeasured === 1 ? "" : "s"} ha${unmeasured === 1 ? "s" : "ve"} no measurable market-equivalent and contribute${unmeasured === 1 ? "s" : ""} nothing here, so the true figure is HIGHER.`
        : ""),
    data: {
      beta: i.beta,
      added_market_equivalent: Number(added.toFixed(2)),
      book_market_equivalent: Number(total.toFixed(2)),
      ratio_of_account: Number(ratio.toFixed(3)),
      ceiling: MAX_BETA_EXPOSURE,
      positions_without_beta: unmeasured,
    },
  };
}

function deploymentCapCheck(i: PretradeInputs): PretradeCheck {
  const deployed =
    i.existingPositions.reduce((s, p) => s + p.capitalUsd, 0) + i.shares * i.entry;
  const ratio = i.accountValue > 0 ? deployed / i.accountValue : Infinity;
  const ok = ratio <= DEPLOYMENT_CAP;
  return {
    name: "deployment_cap",
    status: ok ? "pass" : "fail",
    detail:
      `${usd(deployed)} deployed of ${usd(i.accountValue)} — ${pct(ratio)} against a ` +
      `${pct(DEPLOYMENT_CAP)} cap. The cap is a FRACTION, so it rescales with the account ` +
      `rather than going stale the way a dollar figure does.`,
    data: {
      deployed: Number(deployed.toFixed(2)),
      account_value: i.accountValue,
      ratio: Number(ratio.toFixed(3)),
      cap: DEPLOYMENT_CAP,
    },
  };
}

/** Calendar days as a proxy for sessions — deliberately conservative, see below. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function earningsCheck(i: PretradeInputs): PretradeCheck {
  if (i.earnings.status === "lookup_failed") {
    return {
      name: "earnings_window",
      status: "unknown",
      detail:
        `Could not establish whether ${i.symbol} reports during the hold. That is not the same ` +
        `as "no earnings" — a failed lookup clears nothing.`,
      data: { earnings_date: null, status: "lookup_failed" },
    };
  }
  if (i.earnings.status === "none" || i.earnings.date === null) {
    return {
      name: "earnings_window",
      status: "pass",
      detail: `No earnings for ${i.symbol} in the swept window.`,
      data: { earnings_date: null, status: "none" },
    };
  }

  const daysAway = daysBetween(i.today, i.earnings.date);
  // Calendar days over-count sessions, so a report is flagged EARLIER than a
  // session count would flag it. Erring toward refusing a trade near an event
  // is the correct direction for the error.
  const insideHold = daysAway >= 0 && daysAway <= i.holdSessions + EARNINGS_BUFFER_SESSIONS;
  return {
    name: "earnings_window",
    status: insideHold ? "fail" : "pass",
    detail: insideHold
      ? `${i.symbol} reports ${i.earnings.date}, ${daysAway} days out and inside a ` +
        `${i.holdSessions}-session hold plus a ${EARNINGS_BUFFER_SESSIONS}-session buffer. ` +
        `The gap is not tradeable through a stop.`
      : `${i.symbol} reports ${i.earnings.date}, ${daysAway} days out — beyond the hold.`,
    data: { earnings_date: i.earnings.date, days_away: daysAway, hold_sessions: i.holdSessions },
  };
}

function costCheck(i: PretradeInputs): PretradeCheck {
  if (!i.cost) {
    return {
      name: "round_trip_cost",
      status: "unknown",
      detail:
        `No measured spread history for ${i.symbol}. A modelled cost is not a substitute — ` +
        `Corwin-Schultz has returned 114-177bp on these names where the observed book was one tick.`,
      data: { round_trip_bp: null, edge_bp: null },
    };
  }
  const { roundTripBp, edgeBp } = i.cost;
  const ok = roundTripBp < edgeBp;
  return {
    name: "round_trip_cost",
    status: ok ? "pass" : "fail",
    detail:
      `${roundTripBp.toFixed(1)}bp measured round trip against a ${edgeBp.toFixed(1)}bp edge` +
      (ok
        ? `, leaving ${(edgeBp - roundTripBp).toFixed(1)}bp.`
        : ` — the cost exceeds the edge and this is a losing trade before it starts.`),
    data: {
      round_trip_bp: Number(roundTripBp.toFixed(2)),
      edge_bp: Number(edgeBp.toFixed(2)),
      net_bp: Number((edgeBp - roundTripBp).toFixed(2)),
    },
  };
}

function priceBandCheck(i: PretradeInputs): PretradeCheck {
  const ok = i.stop < i.entry && i.stop > 0 && i.entry > 0 && i.shares > 0;
  return {
    name: "price_band",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `Entry ${usd(i.entry)}, stop ${usd(i.stop)}, ${i.shares} shares — internally consistent.`
      : `Entry ${usd(i.entry)} and stop ${usd(i.stop)} with ${i.shares} shares do not describe a ` +
        `long trade. A stop at or above entry is not a stop.`,
    data: { entry: i.entry, stop: i.stop, shares: i.shares },
  };
}

function freshnessCheck(i: PretradeInputs): PretradeCheck {
  /*
   * With a caller-supplied live price, freshness judges WHAT WAS SUPPLIED —
   * its age in seconds, its source by name — never the stored close. Without
   * one, the old behaviour survives untouched: the close is the only price
   * there is, and during a live session it is ≥1 session behind by
   * construction, which is a true fact the caller can only cure by supplying
   * a live price with provenance.
   */
  if (i.livePrice) {
    const { value, asOfMs, source } = i.livePrice;
    const ageSeconds = Math.round((i.nowMs - asOfMs) / 1000);
    /*
     * Reported, not judged: how far the caller's intended entry sits from
     * the price they say is live. The auditor has no basis to fail a limit
     * order placed away from the market, but the gap belongs beside the
     * verdict so a fat-fingered entry is visible in the same payload.
     */
    const entryVsLivePct = value > 0 ? Number((((i.entry - value) / value) * 100).toFixed(2)) : null;
    const data = {
      live_price: value,
      source,
      price_age_seconds: ageSeconds,
      limit_seconds: LIVE_PRICE_MAX_AGE_SECONDS,
      entry_vs_live_pct: entryVsLivePct,
    };

    if (ageSeconds < 0) {
      return {
        name: "data_freshness",
        status: "fail",
        detail:
          `The supplied live price is dated ${-ageSeconds}s in the FUTURE. Clock skew or a ` +
          `mangled timestamp — either way its age cannot be established, and unverifiable ` +
          `is not the same as fresh.`,
        data,
      };
    }
    const ok = ageSeconds <= LIVE_PRICE_MAX_AGE_SECONDS;
    return {
      name: "data_freshness",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `Live price ${usd(value)} from "${source}", ${ageSeconds}s old — within the ` +
          `${LIVE_PRICE_MAX_AGE_SECONDS / 60}-minute limit. The value is the caller's claim; ` +
          `the site dates it and names its source, it cannot verify it.`
        : `The supplied "${source}" price is ${ageSeconds}s old against a ` +
          `${LIVE_PRICE_MAX_AGE_SECONDS}s limit — a live price this stale is a stored ` +
          `close with extra steps. Re-quote and resubmit.`,
      data,
    };
  }

  const ok = i.priceAgeSessions === 0;
  return {
    name: "data_freshness",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `Price is the latest completed session's close.`
      : `Price is ${i.priceAgeSessions} session${i.priceAgeSessions === 1 ? "" : "s"} behind. ` +
        `Every figure above is derived from it, so the whole check is as stale as the price. ` +
        `During a live session this is true by construction — supply live_price with ` +
        `provenance to be judged on the market instead of the close.`,
    data: { price_age_sessions: i.priceAgeSessions },
  };
}

function reachabilityCheck(i: PretradeInputs, buyingPower: number): PretradeCheck {
  const cost = i.shares * i.entry;
  const ok = cost <= buyingPower;
  const sharePrice = i.entry;
  const maxShares = sharePrice > 0 ? Math.floor(buyingPower / sharePrice) : 0;
  return {
    name: "reachability",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `${usd(cost)} for ${i.shares} shares fits inside ${usd(buyingPower)} of buying power, ` +
        `leaving ${usd(buyingPower - cost)}.`
      : `${i.shares} shares at ${usd(sharePrice)} costs ${usd(cost)} against ${usd(buyingPower)} of ` +
        `buying power — this order cannot be placed at this size. ` +
        (maxShares > 0
          ? `At most ${maxShares} share${maxShares === 1 ? "" : "s"} is reachable; re-run the check at that size, because every figure above scales with it.`
          : `Not even one share is reachable at this price. A correct call here is advice for a different account.`),
    data: {
      order_cost: Number(cost.toFixed(2)),
      buying_power: Number(buyingPower.toFixed(2)),
      max_affordable_shares: maxShares,
    },
  };
}

/**
 * Run every check and reduce to one verdict.
 *
 * `block` on any failure. `incomplete` when nothing failed but something
 * could not be evaluated — deliberately NOT a pass, because the most
 * dangerous output here is a green light produced by absent data.
 */
export function runPretradeChecks(i: PretradeInputs): PretradeVerdict {
  const checks: PretradeCheck[] = [
    priceBandCheck(i),
    freshnessCheck(i),
    stopSurvivalCheck(i),
    betaExposureCheck(i),
    deploymentCapCheck(i),
    earningsCheck(i),
    costCheck(i),
  ];
  // Present exactly when the caller declared buying power — see the input's doc.
  if (i.buyingPowerUsd !== null) checks.push(reachabilityCheck(i, i.buyingPowerUsd));

  const failed = checks.filter((c) => c.status === "fail");
  const unknown = checks.filter((c) => c.status === "unknown");

  if (failed.length > 0) {
    return {
      verdict: "block",
      summary:
        `BLOCK — ${failed.length} check${failed.length === 1 ? "" : "s"} failed: ` +
        `${failed.map((c) => c.name).join(", ")}. Each carries its number and threshold below; ` +
        `override only against the specific figure, never against the verdict.`,
      checks,
    };
  }
  if (unknown.length > 0) {
    return {
      verdict: "incomplete",
      summary:
        `INCOMPLETE — nothing failed, but ${unknown.length} check${unknown.length === 1 ? "" : "s"} ` +
        `could not be evaluated: ${unknown.map((c) => c.name).join(", ")}. This is not a pass. ` +
        `The most expensive green light is one produced by missing data.`,
      checks,
    };
  }
  return {
    verdict: "pass",
    summary: `PASS — all ${checks.length} checks cleared on measured values.`,
    checks,
  };
}
