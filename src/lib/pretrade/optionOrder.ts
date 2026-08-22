import { OptionLegEcho } from "@/lib/portfolio/buildPortfolio";
import { definedRiskBudget } from "@/lib/research/exitDesign";
import {
  HeldPosition,
  LivePrice,
  MAX_BETA_EXPOSURE,
  DEPLOYMENT_CAP,
  PretradeCheck,
  PretradeVerdict,
  reduceChecks,
  sharedFreshnessCheck,
} from "./check";

/**
 * THE DEFINED-RISK ORDER AUDIT — the pre-trade check for the account as it
 * actually is.
 *
 * Ground truth that forced this module: every one of the 24 names the
 * account trades refuses a stop (`no_width_survives` at every tested
 * horizon); the account cannot short; buying power is ~$137; and the only
 * structure that has ever fit is a long option, whose maximum loss is the
 * premium and cannot be gapped through. The site could state the loss
 * budget and model a HELD leg — but nothing audited the option ORDER about
 * to be placed, which is the moment the equity auditor exists for.
 *
 * ── Long single-leg only, and why ─────────────────────────────────────
 *
 * A bought call or put is defined-risk BY CONSTRUCTION: the debit is the
 * whole downside. A sold option is not — a short call's loss is unbounded
 * and a short put's is strike-sized — and this cash account cannot margin
 * either. An order this module cannot honestly call defined-risk is
 * refused by the route, never audited as if it were.
 *
 * ── What is measured vs what is the caller's claim ────────────────────
 *
 * The breakeven reach probability is MEASURED (this name's own bars, at
 * the tenor-matched horizon). The delta is the CALLER's claim — the site
 * has no options chain — and every figure derived from it says so. Theta
 * is deliberately absent: with no chain there is nothing to measure, and
 * a modelled decay figure would be a number wearing a measurement's
 * clothes. The tenor itself is in every horizon figure instead.
 *
 * PURE, like the equity engine: the route resolves prices, bars and reach
 * cells; this file judges and writes sentences.
 */

export interface OptionOrder {
  leg: OptionLegEcho;
  /** PER-CONTRACT premium (0.86, not 86) — the /api/portfolio convention. */
  premium: number;
  /** Positive. Long-only is enforced by the route before this engine runs. */
  contracts: number;
}

/** The measured probability that the underlying touches a level within the tenor. */
export interface BreakevenReach {
  /** Percent of historical windows that touched, 0-100. */
  reachPct: number;
  n: number;
  independentN: number;
  horizonSessions: number;
}

export interface OptionOrderInputs {
  symbol: string;
  order: OptionOrder;
  accountValue: number;
  buyingPowerUsd: number | null;
  /** The caller's risk policy, same trio /api/exit/design uses. Null = undeclared. */
  budget: { hardFloorUsd: number; concurrentPositions: number } | null;
  /**
   * The caller's own floor for breakeven reach, 0-100. The site measures
   * the probability; only the caller knows the payoff they expect beyond
   * breakeven, so only they can say what probability is too low — same
   * contract as edge_bp on the cost check. Null = the measurement is
   * reported and the check returns unknown rather than inventing a floor.
   */
  minBreakevenReachPct: number | null;
  /** Underlying spot the route resolved: live_price if supplied, else the stored close. */
  spot: { value: number; source: string } | null;
  /** Breakeven distance and its measured reach, computed by the route from `spot`. */
  breakeven: { movePct: number; reach: BreakevenReach | null } | null;
  /** Beta of the underlying, measured by the route. Null when unfittable. */
  beta: number | null;
  /** The held book, reduced exactly as the equity audit reduces it. */
  existingPositions: readonly HeldPosition[];
  earnings: { date: string | null; status: "confirmed" | "none" | "lookup_failed" };
  /** Trading sessions until expiry, approximated by the route and echoed. */
  sessionsToExpiry: number;
  livePrice: LivePrice | null;
  priceAgeSessions: number;
  nowMs: number;
}

const usd = (v: number) => `$${v.toFixed(2)}`;
const pct1 = (v: number) => `${v.toFixed(1)}%`;

function maxLossCheck(i: OptionOrderInputs): PretradeCheck {
  const maxLoss = i.order.premium * i.order.leg.multiplier * i.order.contracts;
  if (!i.budget) {
    return {
      name: "max_loss_vs_budget",
      status: "unknown",
      detail:
        `Maximum loss is ${usd(maxLoss)} — the premium, by construction; it cannot be gapped ` +
        `through. No risk budget declared to judge it against: supply hard_floor_usd and ` +
        `concurrent_positions (the same policy /api/exit/design takes) to make this a gate.`,
      data: { max_loss_usd: Number(maxLoss.toFixed(2)), budget_usd: null },
    };
  }
  const b = definedRiskBudget(i.accountValue, i.budget.hardFloorUsd, i.budget.concurrentPositions);
  if (!b) {
    return {
      name: "max_loss_vs_budget",
      status: "fail",
      detail:
        `The declared policy cannot produce a budget: ${usd(i.accountValue)} against a ` +
        `${usd(i.budget.hardFloorUsd)} floor across ${i.budget.concurrentPositions} positions. ` +
        `An account at or under its own floor has no risk capacity to spend.`,
      data: { max_loss_usd: Number(maxLoss.toFixed(2)), budget_usd: null },
    };
  }
  const ok = maxLoss <= b.perPositionUsd;
  return {
    name: "max_loss_vs_budget",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `Maximum loss ${usd(maxLoss)} fits the ${usd(b.perPositionUsd)} per-position budget ` +
        `(${usd(b.riskCapacityUsd)} capacity across ${i.budget.concurrentPositions} positions). ` +
        `The premium is the whole downside; it cannot be gapped through.`
      : `Maximum loss ${usd(maxLoss)} exceeds the ${usd(b.perPositionUsd)} per-position budget by ` +
        `${usd(maxLoss - b.perPositionUsd)} (${usd(b.riskCapacityUsd)} capacity across ` +
        `${i.budget.concurrentPositions} positions). The overage is small only until the other ` +
        `positions want their share.`,
    data: {
      max_loss_usd: Number(maxLoss.toFixed(2)),
      budget_usd: b.perPositionUsd,
      risk_capacity_usd: b.riskCapacityUsd,
      concurrent_positions: i.budget.concurrentPositions,
    },
  };
}

function optionReachabilityCheck(i: OptionOrderInputs, buyingPower: number): PretradeCheck {
  const debit = i.order.premium * i.order.leg.multiplier * i.order.contracts;
  const exerciseCapital = i.order.leg.strike * i.order.leg.multiplier * i.order.contracts;
  const ok = debit <= buyingPower;
  return {
    name: "reachability",
    status: ok ? "pass" : "fail",
    detail: ok
      ? `The ${usd(debit)} debit fits inside ${usd(buyingPower)} of buying power, leaving ` +
        `${usd(buyingPower - debit)}. Note: EXERCISING would need ${usd(exerciseCapital)} — ` +
        `selling to close does not, but an ITM expiry forces that choice on a deadline.`
      : `The ${usd(debit)} debit exceeds ${usd(buyingPower)} of buying power — this order cannot ` +
        `be placed. A correct read on an unaffordable contract is advice for a different account.`,
    data: {
      debit_usd: Number(debit.toFixed(2)),
      buying_power: Number(buyingPower.toFixed(2)),
      exercise_capital_usd: Number(exerciseCapital.toFixed(2)),
    },
  };
}

function breakevenReachCheck(i: OptionOrderInputs): PretradeCheck {
  if (!i.spot || !i.breakeven) {
    return {
      name: "breakeven_reach",
      status: "unknown",
      detail:
        `No underlying price could be resolved, so the breakeven distance cannot be measured. ` +
        `Supply live_price, or wait for the daily close to cover ${i.symbol}.`,
      data: { breakeven_move_pct: null, reach_pct: null },
    };
  }
  const dir = i.order.leg.right === "call" ? "rise" : "fall";
  const be = i.breakeven;
  if (be.movePct <= 0) {
    /*
     * Spot already sits beyond breakeven at the resolved price. The reach
     * question is answered by construction; what remains is retention,
     * which a touch-probability cannot model and this audit does not claim
     * to.
     */
    return {
      name: "breakeven_reach",
      status: "pass",
      detail:
        `At the resolved spot (${usd(i.spot.value)}, ${i.spot.source}) the underlying already ` +
        `sits beyond this contract's breakeven — the reach question is answered by construction. ` +
        `The live question is retention through expiry, which a touch probability cannot model ` +
        `and this audit does not pretend to.`,
      data: { breakeven_move_pct: Number(be.movePct.toFixed(2)), reach_pct: 100, spot: i.spot.value },
    };
  }
  if (!be.reach) {
    return {
      name: "breakeven_reach",
      status: "unknown",
      detail:
        `Breakeven needs a ${pct1(be.movePct)} ${dir} within ~${i.sessionsToExpiry} sessions, but ` +
        `${i.symbol} has too little history to measure how often it moves that far in that time. ` +
        `Unmeasured is not the same as unlikely — or likely.`,
      data: { breakeven_move_pct: Number(be.movePct.toFixed(2)), reach_pct: null },
    };
  }
  const r = be.reach;
  const measured =
    `Breakeven needs a ${pct1(be.movePct)} ${dir} within ~${r.horizonSessions} sessions; ` +
    `${i.symbol}'s own history ${dir === "rise" ? "reached" : "fell"} that far in ` +
    `${pct1(r.reachPct)} of comparable windows (n=${r.n.toLocaleString()}, ` +
    `independent_n=${r.independentN}). Everything short of breakeven at expiry is a total loss ` +
    `of premium; everything beyond it is not measured here.`;
  const data = {
    breakeven_move_pct: Number(be.movePct.toFixed(2)),
    reach_pct: Number(r.reachPct.toFixed(1)),
    n: r.n,
    independent_n: r.independentN,
    horizon_sessions: r.horizonSessions,
    spot: i.spot.value,
    spot_source: i.spot.source,
    floor_pct: i.minBreakevenReachPct,
  };
  if (i.minBreakevenReachPct === null) {
    /*
     * Measured but not judged: the site knows the probability of reaching
     * breakeven, and only the caller knows the payoff they expect beyond
     * it — a 20% reach can be a fine trade at 6x and a terrible one at
     * 1.5x. Same contract as the cost check's edge_bp: no declared floor,
     * no invented verdict.
     */
    return {
      name: "breakeven_reach",
      status: "unknown",
      detail:
        `${measured} No min_breakeven_reach_pct declared, so no verdict — the acceptable ` +
        `probability depends on the payoff you expect beyond breakeven, which only you know.`,
      data,
    };
  }
  const ok = r.reachPct >= i.minBreakevenReachPct;
  return {
    name: "breakeven_reach",
    status: ok ? "pass" : "fail",
    detail: `${measured} ${ok ? "Clears" : "Misses"} your declared ${pct1(i.minBreakevenReachPct)} floor.`,
    data,
  };
}

function optionBetaExposureCheck(i: OptionOrderInputs): PretradeCheck {
  if (i.beta === null || !i.spot) {
    return {
      name: "beta_exposure",
      status: "unknown",
      detail:
        i.beta === null
          ? `${i.symbol}'s beta is unmeasured, so the order's market-equivalent size cannot be added to the book.`
          : `No underlying price could be resolved, so the delta-equivalent cannot be priced.`,
      data: { beta: i.beta },
    };
  }
  const deltaEquivalent =
    i.order.contracts * i.order.leg.delta * i.order.leg.multiplier * i.spot.value;
  const added = deltaEquivalent * i.beta;
  const existing = i.existingPositions.reduce((s, p) => s + (p.marketEquivalentUsd ?? 0), 0);
  const unmeasured = i.existingPositions.filter((p) => p.marketEquivalentUsd === null).length;
  const total = existing + added;
  const ratio = i.accountValue > 0 ? total / i.accountValue : Infinity;
  const ok = ratio <= MAX_BETA_EXPOSURE;
  return {
    name: "beta_exposure",
    status: ok ? "pass" : "fail",
    detail:
      `Adds ${usd(added)} market-equivalent (${usd(deltaEquivalent)} delta-equivalent x beta ` +
      `${i.beta.toFixed(2)}, delta ${i.order.leg.delta} as posted by the caller); the book would ` +
      `reach ${(ratio * 100).toFixed(0)}% of the account against a ${MAX_BETA_EXPOSURE * 100}% ceiling.` +
      (unmeasured > 0
        ? ` ${unmeasured} held position${unmeasured === 1 ? "" : "s"} contribute${unmeasured === 1 ? "s" : ""} nothing here, so the true figure is HIGHER.`
        : ""),
    data: {
      beta: i.beta,
      delta: i.order.leg.delta,
      added_market_equivalent: Number(added.toFixed(2)),
      book_market_equivalent: Number(total.toFixed(2)),
      ratio_of_account: Number(ratio.toFixed(3)),
      ceiling: MAX_BETA_EXPOSURE,
      positions_without_beta: unmeasured,
    },
  };
}

function optionDeploymentCheck(i: OptionOrderInputs): PretradeCheck {
  const debit = i.order.premium * i.order.leg.multiplier * i.order.contracts;
  const deployed = i.existingPositions.reduce((s, p) => s + p.capitalUsd, 0) + debit;
  const ratio = i.accountValue > 0 ? deployed / i.accountValue : Infinity;
  const ok = ratio <= DEPLOYMENT_CAP;
  return {
    name: "deployment_cap",
    status: ok ? "pass" : "fail",
    detail:
      `${usd(deployed)} deployed of ${usd(i.accountValue)} — ${(ratio * 100).toFixed(0)}% against a ` +
      `${DEPLOYMENT_CAP * 100}% cap. The option counts at its premium: that is the capital committed, ` +
      `while its EXPOSURE is judged by beta_exposure above.`,
    data: {
      deployed: Number(deployed.toFixed(2)),
      account_value: i.accountValue,
      ratio: Number(ratio.toFixed(3)),
      cap: DEPLOYMENT_CAP,
    },
  };
}

function tenorEarningsCheck(i: OptionOrderInputs): PretradeCheck {
  if (i.earnings.status === "lookup_failed") {
    return {
      name: "earnings_window",
      status: "unknown",
      detail:
        `Could not establish whether ${i.symbol} reports inside the tenor. A failed lookup clears nothing.`,
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
  const inside = i.earnings.date <= i.order.leg.expiry;
  /*
   * PASS either way, and deliberately so: this is where the option audit
   * and the equity audit legitimately disagree. The equity veto exists
   * because a gap jumps a stop — the printed risk was never available
   * across the event. A long option's risk IS available across the event:
   * the premium is the floor and no gap can go through it. What remains is
   * context, not a veto — the market prices known events into premium, so
   * the caller is likely paying for that report whether they want it or
   * not, and the post-event IV reset is a real cost this site cannot
   * measure without a chain. Named, not judged.
   */
  return {
    name: "earnings_window",
    status: "pass",
    detail: inside
      ? `${i.symbol} reports ${i.earnings.date}, INSIDE this contract's tenor (expiry ` +
        `${i.order.leg.expiry}). Not a veto — the premium is the whole downside and a gap cannot ` +
        `go through it — but the event is likely priced into what you are paying, and implied ` +
        `volatility typically resets after the report. This audit has no options chain, so that ` +
        `cost is named rather than measured.`
      : `${i.symbol} reports ${i.earnings.date}, after this contract's ${i.order.leg.expiry} expiry.`,
    data: {
      earnings_date: i.earnings.date,
      expiry: i.order.leg.expiry,
      inside_tenor: inside ? 1 : 0,
    },
  };
}

/** The audit. Same three-word verdict contract as the equity path. */
export function runOptionOrderChecks(i: OptionOrderInputs): PretradeVerdict {
  const checks: PretradeCheck[] = [
    sharedFreshnessCheck(i.livePrice, i.nowMs, i.priceAgeSessions, null),
    maxLossCheck(i),
    breakevenReachCheck(i),
    optionBetaExposureCheck(i),
    optionDeploymentCheck(i),
    tenorEarningsCheck(i),
  ];
  if (i.buyingPowerUsd !== null) checks.push(optionReachabilityCheck(i, i.buyingPowerUsd));
  return reduceChecks(checks);
}
