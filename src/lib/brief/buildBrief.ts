import { LedgerDiff } from "@/lib/markets/historyLedger";

/**
 * THE BRIEF — Roadmap Phase 2, item 3. The front door.
 *
 * What a returning trader needs before anything else: what regime are we in,
 * what changed overnight, what could blow up today, and is there anything
 * worth doing. In that order, and nothing else.
 *
 * ── The rule that makes this hard, and worth building ─────────────────
 *
 * ACTIONABLE ITEMS ARE EDGE-QUALIFIED ONLY. Not "the highest-scoring
 * tickers", not "the most interesting charts" — only things backed by a
 * signal that cleared the Wilson gate and survived FDR correction. On this
 * platform that is a very short list, and on most days it will be empty.
 *
 * "Nothing qualifies today" is therefore the NORMAL output and is written as
 * a conclusion rather than an apology. A brief that always finds three ideas
 * is not a brief, it is a content schedule — and the pressure to fill it is
 * exactly how a research tool becomes a tip sheet.
 *
 * ── One item is one DECISION, not one ticker ──────────────────────────
 *
 * The momentum record belongs to holding the whole decile. Listing its eight
 * names as eight items would imply eight independent claims and invite a
 * reader to take one, which is not the thing that was measured. So the
 * basket is a single item carrying its names, and the cap of three counts
 * decisions.
 */

export interface BriefItem {
  /** The decision, in one line. */
  headline: string;
  /** What it rests on, in the engine's voice. */
  detail: string;
  /** Every name the decision covers. */
  symbols: string[];
  /** The measured record that entitles this to be here at all. */
  record: string;
  /** Where a reader goes to check it. */
  href: string;
}

export interface RiskEvent {
  symbol: string;
  date: string;
  /** Calendar days out. Negative is impossible here — past events are dropped. */
  daysAway: number;
}

export interface Brief {
  /** The regime, in a sentence. Null when the snapshot has no regime read. */
  stateLine: string | null;
  /** Overnight transitions, or null when there is no previous session. */
  diff: LedgerDiff | null;
  ledgerEntries: number;
  riskEvents: RiskEvent[];
  items: BriefItem[];
  /** Present exactly when `items` is empty. Never a shrug. */
  noItemsReason: string | null;
}

export interface BriefInputs {
  regime: { regime: string; headline: string } | null;
  diff: LedgerDiff | null;
  ledgerEntries: number;
  /** Today's cross-section, for the momentum basket. */
  crossSection: {
    asOf: number;
    breadthPct: number | null;
    decileSize: number;
    members: Array<{ symbol: string; mom: number }>;
  } | null;
  /** The gated long-only record, read from signalValidation.json. */
  momentumRecord: {
    winRate: number;
    lowerBound: number | null;
    n: number;
    meanSpread: number;
    holdSessions: number;
    earnsEdge: boolean;
  } | null;
  /** Upcoming reports for names the brief might mention. */
  earnings: Array<{ symbol: string; date: string }>;
  now: number;
}

/** Beyond this the panel's breakpoints no longer describe today's market. */
const MAX_CROSS_SECTION_AGE_MS = 10 * 86_400_000;
/** The planner's own veto window, reused so the brief and the plans agree. */
const RISK_EVENT_HORIZON_DAYS = 5;
/** The roadmap's cap. Counts DECISIONS, not tickers. */
const MAX_ITEMS = 3;

export function buildBrief(inputs: BriefInputs): Brief {
  const { regime, diff, ledgerEntries, earnings, now } = inputs;

  const items: BriefItem[] = [];
  let noItemsReason: string | null = null;

  const momentum = momentumItem(inputs);
  if (momentum.item) items.push(momentum.item);
  else noItemsReason = momentum.reason;

  return {
    stateLine: regime?.headline ?? null,
    diff,
    ledgerEntries,
    riskEvents: upcomingEvents(earnings, now),
    items: items.slice(0, MAX_ITEMS),
    noItemsReason: items.length === 0 ? noItemsReason : null,
  };
}

/**
 * The momentum basket, or the reason there isn't one.
 *
 * Every refusal below is a real condition with a stated cause, because the
 * whole value of "nothing qualifies today" is that it distinguishes between
 * *the market is not offering this setup* and *we cannot currently tell*.
 * Collapsing those into one empty state would make the brief's silence
 * meaningless.
 */
function momentumItem(inputs: BriefInputs): { item: BriefItem | null; reason: string } {
  const { crossSection: cs, momentumRecord: rec, now } = inputs;

  if (!cs || !rec) {
    return {
      item: null,
      reason:
        "The cross-sectional ranking behind the one validated equity signal was not available for this build, " +
        "so no Edge-qualified item can be offered. This is a gap in our pipeline, not a statement about the market.",
    };
  }

  if (!rec.earnsEdge) {
    return {
      item: null,
      reason:
        "No signal on this platform currently clears its own gate. Items appear here only when something has beaten " +
        "its baseline out of sample and survived correction for multiple testing — and today nothing does.",
    };
  }

  const ageDays = Math.floor((now - cs.asOf) / 86_400_000);
  if (now - cs.asOf > MAX_CROSS_SECTION_AGE_MS) {
    return {
      item: null,
      reason:
        `The reference panel was last measured ${ageDays} days ago. Its ranking and its breadth reading are both ` +
        "too old to act on, so the item is withheld rather than offered on stale evidence.",
    };
  }

  if (cs.breadthPct === null) {
    return {
      item: null,
      reason:
        "Market breadth could not be measured, and this signal's record only holds when more than half the panel " +
        "trades above its own 200-session average. Without that reading the regime is unknown and the claim does not apply.",
    };
  }

  if (cs.breadthPct <= 0.5) {
    return {
      item: null,
      reason:
        `Only ${(cs.breadthPct * 100).toFixed(0)}% of the panel trades above its own 200-session average. The one ` +
        "validated equity signal INVERTS in broad weakness — its declared complement measured below its own base rate — " +
        "so today it says stand aside. That is the signal working, not the signal missing.",
    };
  }

  const decile = cs.members.slice(0, Math.max(1, cs.decileSize));
  if (decile.length === 0) {
    return { item: null, reason: "The ranked panel came back empty, so no decile could be formed." };
  }

  /*
   * TWO STATE READS THAT CAN LEGITIMATELY DISAGREE.
   *
   * The risk regime is a CROSS-ASSET appetite read (credit versus duration,
   * consumer versus staples). This signal's gate is EQUITY PARTICIPATION —
   * the share of the panel above its own 200-session average. They measure
   * different things and can point opposite ways, which is exactly what is
   * happening when a defensive tape still has most stocks trending.
   *
   * Left unsaid, a reader sees "Risk-OFF" at the top of the page and a
   * qualifying long basket at the bottom and concludes the engine
   * contradicts itself. Naming the divergence costs one sentence and is the
   * difference between a disagreement and a defect.
   */
  const divergence =
    inputs.regime && inputs.regime.regime === "risk-off"
      ? " Note the split with the state line above: risk appetite is defensive on the cross-asset pairs while " +
        "equity participation is broad. Those are different measurements, not a contradiction — this signal was " +
        "validated against participation, and it is participation that is healthy."
      : "";

  const lb = rec.lowerBound === null ? null : (rec.lowerBound * 100).toFixed(1);
  return {
    item: {
      headline: `Momentum basket — the top ${decile.length} of the ranking, held as one position`,
      detail:
        `Breadth is ${(cs.breadthPct * 100).toFixed(0)}%, which is the regime this signal was validated in. The record ` +
        `belongs to holding the WHOLE decile, equally weighted: it is not a claim about any single name here, and ` +
        `taking one of them is not the thing that was measured.` + divergence,
      symbols: decile.map((m) => m.symbol),
      record:
        `Beat the equal-weighted panel in ${(rec.winRate * 100).toFixed(1)}% of ${rec.n} non-overlapping ` +
        `${rec.holdSessions}-session periods${lb ? `, 95% lower bound ${lb}%` : ""}, averaging ` +
        `${rec.meanSpread >= 0 ? "+" : ""}${(rec.meanSpread * 100).toFixed(2)}% excess per period after 2pp of costs.`,
      href: `/asset/${encodeURIComponent(decile[0].symbol)}`,
    },
    reason: "",
  };
}

/**
 * Reports due inside the veto window, soonest first.
 *
 * Past dates are dropped rather than shown as negative: a report that already
 * happened is not a risk to plan around, and rendering "-3 days" invites the
 * reader to work out what that means.
 */
function upcomingEvents(
  earnings: ReadonlyArray<{ symbol: string; date: string }>,
  now: number
): RiskEvent[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return earnings
    .map((e) => ({
      symbol: e.symbol,
      date: e.date,
      daysAway: Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
    }))
    .filter((e) => Number.isFinite(e.daysAway) && e.daysAway >= 0 && e.daysAway <= RISK_EVENT_HORIZON_DAYS)
    .sort((a, b) => a.daysAway - b.daysAway || a.symbol.localeCompare(b.symbol));
}
