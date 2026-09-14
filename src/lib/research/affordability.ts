/**
 * WHICH NAMES CAN THIS ACCOUNT TRADE AT ALL.
 *
 * ── The finding this exists to answer ─────────────────────────────────
 *
 * The reach screen ranked MU first on excursion asymmetry: ratio 3.66,
 * up-reach 72.4%, median +26.0% against -7.1%, independent_n 13. A good
 * ranking. MU trades near $190 and its October calls run well over $1,500 a
 * contract. The account holds $195.51.
 *
 * The best-ranked candidate was untradeable, and nothing in the stack knew
 * it. That is not a missing budget filter — a filter answers a question about
 * one screen run. It is a missing UNIVERSE. `barsPanel.json` holds 124 names
 * weighted toward large caps: $190 semis, $700 index ETFs. The names an
 * account of this size can express a view on are the ones where a 0.30-0.50
 * delta contract costs under roughly $100. Nobody had ever enumerated that
 * set, and it is the only universe that matters here.
 *
 * ── Why it is stored nightly rather than computed per request ─────────
 *
 * Affordability moves with price, and the whole point of the set is that
 * membership CHANGES: a name at $22 becomes reachable when it falls to $14,
 * and unreachable when it runs. A per-request filter answers "can I trade
 * this today" and forgets. A stored series answers "when did this become
 * reachable", which is the question a growing account actually has.
 *
 * It also makes the growth path measurable rather than rhetorical. The
 * artifact carries a CURVE — how many names clear each budget level — so
 * "what does another thousand dollars buy" has a number instead of a feeling.
 *
 * ── The delta band, and why cheapest-overall is the wrong answer ──────
 *
 * The cheapest contract on any chain is a far out-of-the-money lottery
 * ticket, and it is cheap precisely because it will expire worthless. Asking
 * "what is the cheapest contract" would rank every name by how far its
 * junk strikes are from spot, which is not a measure of anything.
 *
 * So the search is inside a DELTA BAND. 0.30-0.50 is the range where a bought
 * option is a directional position rather than a coin flip: enough delta that
 * the underlying moving pays, not so much that the premium is mostly
 * intrinsic and the equity would do the same job cheaper. The band is a
 * declared parameter, not a hidden default, and the artifact records which
 * band produced it so a later change is visible rather than silent.
 *
 * ── Gates are part of the definition, not a post-filter ───────────────
 *
 * A contract with no open interest and a 60%-wide market has a price but is
 * not tradeable, and including it would report a universe wider than the one
 * that exists. OI and spread gates are applied INSIDE the search, so the
 * cheapest qualifying contract is the cheapest one that could actually be
 * bought and later sold.
 */

import { REACH_HORIZON_SESSIONS } from "./forwardReach";
import { tradingSessionsBetween } from "./marketCalendar";

/** Delta band a bought contract must sit in to count as expressing a view. */
export const DELTA_BAND: readonly [number, number] = [0.3, 0.5];

/** Widest market tolerated, as a percent of mid. Matches the contract screen. */
export const MAX_SPREAD_PCT_OF_MID = 25;

/** Open interest floor. Getting in is not the problem; getting out is. */
export const MIN_OPEN_INTEREST = 10;

/**
 * Budget rungs the coverage curve is reported at, in dollars.
 *
 * Chosen to span the account's actual path rather than to look tidy: it holds
 * ~$195 today, and the rungs bracket that closely enough to show the next
 * name becoming reachable, then widen once the answer stops changing quickly.
 */
export const BUDGET_RUNGS = [100, 200, 300, 500, 750, 1000, 2000, 5000] as const;

/** How many expiries the sweep prices per name. */
export const EXPIRIES_EXAMINED = 2;

/**
 * The two nearest expiries THE SCREEN COULD ACTUALLY USE.
 *
 * The ask was "the nearest 2 expiries", and taken literally that produces a
 * universe the ranking cannot consume. The screen refuses any contract with
 * fewer than `REACH_HORIZON_SESSIONS` sessions left, because a ten-session
 * probability does not describe a five-session contract. A front-week expiry
 * would therefore be priced here, counted as making a name affordable, and
 * then rejected downstream — leaving the ranking's top row unbuyable again,
 * which is the exact failure this artifact exists to end.
 *
 * So the filter is applied at selection: affordable means affordable in a
 * contract the screen can rank. `expiriesExamined` is stored beside the
 * result so a reader can see the sweep was two and not, say, one because a
 * name only lists weeklies.
 */
export function selectAffordabilityExpiries(
  expirations: readonly string[],
  now: number,
  count = EXPIRIES_EXAMINED
): string[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return expirations
    .filter((d) => tradingSessionsBetween(today, d) >= REACH_HORIZON_SESSIONS)
    .sort()
    .slice(0, count);
}

export interface AffordabilityContract {
  expiry: string;
  kind: "call" | "put";
  strike: number;
  delta: number;
  bid: number;
  ask: number;
  mid: number;
  /** Cash outlay for one contract, in dollars. */
  costUsd: number;
  spreadPctOfMid: number;
  openInterest: number;
}

export type AffordabilityMiss =
  | "no_chain"
  | "no_contract_in_delta_band"
  | "band_contracts_all_gated";

export interface AffordabilityEntry {
  symbol: string;
  spot: number | null;
  /** Cheapest qualifying contract per expiry examined, nearest first. */
  cheapestByExpiry: AffordabilityContract[];
  /** The cheapest across every expiry examined. Null when none qualified. */
  cheapest: AffordabilityContract | null;
  /** Why there is no cheapest. Null when there is one. */
  missReason: AffordabilityMiss | null;
  /**
   * How the band contracts fared against each gate, kept as data and not only
   * as prose so a consumer can distinguish an illiquid name from a bad feed
   * without parsing `detail`.
   */
  gates: BandGateCounts;
  /** The sentence a reader needs. Names the number, per the /api/distance rule. */
  detail: string;
}

export interface AffordabilityView {
  generatedAt: number;
  /**
   * The most recent completed session at the moment the chains were read —
   * what the quotes actually describe.
   */
  session: string;
  /**
   * The last session in the bars panel the roster came from.
   *
   * Kept separate from `session` because the panel is known to run a session
   * behind on some runs, and collapsing the two would let a reader attribute
   * Friday's option prices to Thursday's closes. When these differ the
   * artifact is still correct; it is the join that needs care.
   */
  panelSession: string;
  deltaBand: readonly [number, number];
  maxSpreadPctOfMid: number;
  minOpenInterest: number;
  expiriesExamined: number;
  entries: AffordabilityEntry[];
  /** Names clearing each budget rung — the growth path, with numbers. */
  coverage: { budgetUsd: number; tradeable: number; of: number; symbols: string[] }[];
}

export interface CandidateContract {
  expiry: string;
  kind: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  openInterest: number;
}

/**
 * Why the band contracts did or did not survive, counted separately.
 *
 * A single `gated` total was not enough, and the reason is a finding rather
 * than a nicety. The first full sweep excluded 25 names as "quotable, not
 * tradeable" — among them GILD, ISRG, REGN, LMT, UNP and CSX, six of the most
 * liquid option markets in the United States. Read as a market fact that is
 * absurd. Read as a venue fact it is obvious: the 2026-09-25 GILD 140 put came
 * back bid 0.36 against ask 3.45, a 162% spread. Real GILD trades pennies wide.
 *
 * An `or` in the miss reason hid that. "Failed the spread or open-interest
 * gate" is compatible both with a thin market nobody wants and with a quote
 * feed that is not returning real bids, and those call for opposite responses
 * — the first is the universe working, the second is the universe being wrong.
 * Splitting the counts and carrying the median spread makes the difference
 * legible without anyone having to re-run the sweep by hand.
 */
export interface BandGateCounts {
  /** Contracts inside the delta band, before any gate. */
  inBand: number;
  /** No usable two-sided market, so no mid exists to test. */
  unpriceable: number;
  /** Failed the spread gate alone. */
  spread: number;
  /** Failed the open-interest gate alone. */
  openInterest: number;
  /** Failed both. */
  both: number;
  /** Cleared every gate. */
  passed: number;
  /**
   * Median spread across band contracts that had a mid, as a percent of it.
   * Null when none were priceable. This is the number that distinguishes a
   * genuinely illiquid name from an unreliable feed.
   */
  medianSpreadPctOfMid: number | null;
}

const emptyGates = (): BandGateCounts => ({
  inBand: 0,
  unpriceable: 0,
  spread: 0,
  openInterest: 0,
  both: 0,
  passed: 0,
  medianSpreadPctOfMid: null,
});

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The cheapest gate-clearing contract inside the delta band, per expiry.
 *
 * Puts are included and their delta compared by MAGNITUDE: a -0.42 delta put
 * expresses a downward view with the same conviction a +0.42 call expresses
 * upward, and comparing the signed value would silently make the band
 * call-only. The account is long-biased today, but a screen that structurally
 * cannot see a put is a screen that will be wrong in a drawdown.
 */
export function cheapestInBand(
  contracts: readonly CandidateContract[],
  band: readonly [number, number] = DELTA_BAND
): { best: AffordabilityContract | null; inBand: number; gated: number; gates: BandGateCounts } {
  let best: AffordabilityContract | null = null;
  const gates = emptyGates();
  const spreads: number[] = [];

  for (const c of contracts) {
    if (c.delta === null || !Number.isFinite(c.delta)) continue;
    const mag = Math.abs(c.delta);
    if (mag < band[0] || mag > band[1]) continue;
    gates.inBand++;

    const { bid, ask } = c;
    if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) {
      gates.unpriceable++;
      continue;
    }
    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;
    spreads.push(spreadPct);
    const tooWide = spreadPct > MAX_SPREAD_PCT_OF_MID;
    const tooThin = c.openInterest < MIN_OPEN_INTEREST;
    if (tooWide || tooThin) {
      if (tooWide && tooThin) gates.both++;
      else if (tooWide) gates.spread++;
      else gates.openInterest++;
      continue;
    }
    gates.passed++;

    const costUsd = mid * 100;
    if (best === null || costUsd < best.costUsd) {
      best = {
        expiry: c.expiry,
        kind: c.kind,
        strike: c.strike,
        delta: Math.round(c.delta * 1000) / 1000,
        bid,
        ask,
        mid: Math.round(mid * 100) / 100,
        costUsd: Math.round(costUsd * 100) / 100,
        spreadPctOfMid: Math.round(spreadPct * 10) / 10,
        openInterest: c.openInterest,
      };
    }
  }

  const m = median(spreads);
  gates.medianSpreadPctOfMid = m === null ? null : Math.round(m * 10) / 10;
  const gated = gates.unpriceable + gates.spread + gates.openInterest + gates.both;
  return { best, inBand: gates.inBand, gated, gates };
}

/**
 * Above this multiple of the spread limit, a market is not merely wide.
 *
 * A genuinely illiquid contract sits somewhat over the limit — 30%, 40% of
 * mid. A median at more than twice the limit across a whole name means the
 * bid and the ask are not describing the same moment, which is a property of
 * the feed rather than of the market.
 */
const FEED_SUSPICION_MULTIPLE = 2;

const FEED_CAVEAT =
  "A median market this far past the limit is more consistent with a stale or " +
  "one-sided quote feed than with the underlying's liquidity, so treat this " +
  "exclusion as unconfirmed until the chain is read from a live venue.";

function looksLikeFeed(g: BandGateCounts): boolean {
  const spreadDriven = g.spread + g.both > g.openInterest;
  return (
    spreadDriven &&
    g.medianSpreadPctOfMid !== null &&
    g.medianSpreadPctOfMid > MAX_SPREAD_PCT_OF_MID * FEED_SUSPICION_MULTIPLE
  );
}

/**
 * The counts, as the sentence a reader needs. Never an `or`.
 *
 * The overlap is stated as an overlap rather than added into both totals. A
 * name with 18 band contracts, 13 failing spread alone and 5 failing both,
 * reads correctly as "18 on the spread gate, 5 of those also under the
 * open-interest floor" and incorrectly as "18 on the spread gate, 5 on open
 * interest" — the second invites the reader to sum 23 rejections out of 18
 * contracts and conclude the counts are broken.
 */
function gateBreakdown(g: BandGateCounts): string {
  const parts: string[] = [];
  const spreadTotal = g.spread + g.both;
  if (spreadTotal > 0) {
    parts.push(
      `${spreadTotal} on the spread gate` +
        (g.medianSpreadPctOfMid === null
          ? ""
          : ` (median market ${g.medianSpreadPctOfMid}% of mid against a ${MAX_SPREAD_PCT_OF_MID}% limit)`) +
        (g.both > 0 ? `, ${g.both} of those also under the open-interest floor` : "")
    );
  }
  if (g.openInterest > 0) {
    parts.push(
      `${g.openInterest} on open interest under ${MIN_OPEN_INTEREST}` +
        (spreadTotal > 0 ? " alone" : "")
    );
  }
  if (g.unpriceable > 0) parts.push(`${g.unpriceable} with no two-sided market`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "no gate recorded.";
}

export function buildEntry(
  symbol: string,
  spot: number | null,
  /** Contracts grouped by expiry, nearest expiry first. */
  byExpiry: readonly (readonly CandidateContract[])[],
  /**
   * The venue's own words when it refused. Carried through verbatim because
   * "not configured", "rate limited" and "this name lists no options" are
   * three different facts that all arrive as an empty chain, and only the
   * last one is about the symbol.
   */
  chainRefusal: string | null = null
): AffordabilityEntry {
  if (byExpiry.length === 0) {
    return {
      symbol,
      spot,
      cheapestByExpiry: [],
      cheapest: null,
      missReason: "no_chain",
      gates: emptyGates(),
      detail:
        `${symbol} excluded: no option chain was returned, so affordability is unknown rather than false.` +
        (chainRefusal ? ` Venue said: ${chainRefusal}` : ""),
    };
  }

  const cheapestByExpiry: AffordabilityContract[] = [];
  const gates = emptyGates();
  const medians: number[] = [];
  for (const contracts of byExpiry) {
    const { best, gates: g } = cheapestInBand(contracts);
    gates.inBand += g.inBand;
    gates.unpriceable += g.unpriceable;
    gates.spread += g.spread;
    gates.openInterest += g.openInterest;
    gates.both += g.both;
    gates.passed += g.passed;
    if (g.medianSpreadPctOfMid !== null) medians.push(g.medianSpreadPctOfMid);
    if (best) cheapestByExpiry.push(best);
  }
  /*
   * A median of per-expiry medians rather than of the pooled spreads. It is
   * the weaker statistic, but it costs one number per expiry instead of
   * retaining every band contract on the panel, and the question it answers —
   * "is this market pennies wide or dollars wide" — does not turn on the
   * difference.
   */
  const medianSpread = median(medians);
  gates.medianSpreadPctOfMid = medianSpread === null ? null : Math.round(medianSpread * 10) / 10;
  const inBandTotal = gates.inBand;
  const gatedTotal = gates.unpriceable + gates.spread + gates.openInterest + gates.both;

  const cheapest = cheapestByExpiry.reduce<AffordabilityContract | null>(
    (a, b) => (a === null || b.costUsd < a.costUsd ? b : a),
    null
  );

  if (cheapest === null) {
    /*
     * The two misses are kept apart because they mean opposite things to a
     * reader watching for a name to become reachable. "No contract in the
     * band" is a chain that does not offer the structure at all and will not
     * change with price. "All gated" is a chain that offers it in a market
     * too wide or too thin to use, which can improve tomorrow.
     */
    const reason: AffordabilityMiss =
      inBandTotal === 0 ? "no_contract_in_delta_band" : "band_contracts_all_gated";
    return {
      symbol,
      spot,
      cheapestByExpiry: [],
      cheapest: null,
      missReason: reason,
      gates,
      detail:
        reason === "no_contract_in_delta_band"
          ? `${symbol} excluded: no contract in the ${DELTA_BAND[0]}-${DELTA_BAND[1]} delta band across ${byExpiry.length} expiries.`
          : `${symbol} excluded: ${inBandTotal} contracts sat in the delta band and all ${gatedTotal} failed a gate — ` +
            gateBreakdown(gates) +
            ` Quotable, not tradeable.` +
            (looksLikeFeed(gates) ? ` ${FEED_CAVEAT}` : ""),
    };
  }

  return {
    symbol,
    spot,
    cheapestByExpiry,
    cheapest,
    missReason: null,
    gates,
    detail:
      `${symbol}: cheapest qualifying contract $${cheapest.costUsd.toFixed(0)} ` +
      `(${cheapest.expiry} ${cheapest.strike} ${cheapest.kind}, delta ${cheapest.delta}).`,
  };
}

/**
 * How many names clear each budget rung.
 *
 * The point of the curve is the SHAPE. A reader asking what another thousand
 * dollars buys should be able to read it off directly rather than infer it
 * from a single count at today's balance.
 */
export function coverageCurve(
  entries: readonly AffordabilityEntry[],
  rungs: readonly number[] = BUDGET_RUNGS
): AffordabilityView["coverage"] {
  return rungs.map((budgetUsd) => {
    const symbols = entries
      .filter((e) => e.cheapest !== null && e.cheapest.costUsd <= budgetUsd)
      .map((e) => e.symbol)
      .sort();
    return { budgetUsd, tradeable: symbols.length, of: entries.length, symbols };
  });
}

/** Names this budget can trade, cheapest first. */
export function tradeableAt(
  view: AffordabilityView,
  budgetUsd: number
): { symbol: string; costUsd: number }[] {
  return view.entries
    .filter((e) => e.cheapest !== null && e.cheapest.costUsd <= budgetUsd)
    .map((e) => ({ symbol: e.symbol, costUsd: e.cheapest!.costUsd }))
    .sort((a, b) => a.costUsd - b.costUsd);
}

/**
 * Names this budget excludes, with the number that excludes them.
 *
 * "MU excluded: cheapest qualifying contract $1,520 against budget $195" is
 * information — it says when MU becomes reachable and therefore what growing
 * the account buys. MU silently absent is not information, and a screen whose
 * short list has no explanation reads as coverage.
 *
 * Sorted by cost ascending, so the front of the list is the next name that
 * comes within reach.
 */
export function excludedAt(
  view: AffordabilityView,
  budgetUsd: number
): { symbol: string; costUsd: number | null; detail: string }[] {
  return view.entries
    .filter((e) => e.cheapest === null || e.cheapest.costUsd > budgetUsd)
    .map((e) => ({
      symbol: e.symbol,
      costUsd: e.cheapest?.costUsd ?? null,
      detail:
        e.cheapest === null
          ? e.detail
          : `${e.symbol} excluded: cheapest qualifying contract $${e.cheapest.costUsd.toFixed(0)} against budget $${budgetUsd.toFixed(0)}.`,
    }))
    .sort((a, b) => (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity));
}
