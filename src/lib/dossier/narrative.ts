import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { TradePlan } from "@/lib/signals/tradePlan";
import { formatPrice } from "@/lib/utils/format";
import {
  EvidenceBullet,
  InvalidationTrigger,
  MacroContext,
  PlannedEntryRead,
  Read,
  TldrSection,
} from "./types";

/**
 * THE NARRATIVE COMPOSER — prose assembled from evidence, never written.
 *
 * The product goal is a page that reads like an analyst wrote it. The obvious
 * implementation is to hand the numbers to a language model and print what
 * comes back. This module exists because that is the wrong answer for this
 * product, and the reason is worth stating precisely.
 *
 * A generated summary is a SECOND OPINION. It can emphasise a module the
 * engine down-weighted, soften a refusal the engine issued, or produce a
 * confident sentence about a reading that scored 20% confidence — and it does
 * so invisibly, in fluent English, which is exactly what makes it dangerous.
 * The platform's whole claim is that every conclusion decomposes into the
 * evidence behind it. A model writing the summary breaks that claim at the
 * most-read point on the page.
 *
 * So every sentence here is COMPOSED: selected from the engine's own fields
 * and joined by templates. The vocabulary is fixed, the clause order is
 * fixed, and each clause is emitted only when the evidence for it exists.
 * That is a real constraint — the prose is less varied than a model's — and
 * it buys the one property that matters: it cannot say something the engine
 * did not measure.
 *
 * ── The rule for every function below ─────────────────────────────────
 *
 * NOTHING IS ASSERTED FROM ABSENCE. A missing module produces a missing
 * clause, never a reassuring one. "No bearish evidence" is only ever printed
 * when modules ran and none was bearish — never when nothing ran.
 */

/** Modules whose plain reading carries the "what is happening" claim best. */
const STATE_PRIORITY = ["marketStructure", "technicals", "equityTrendQuality", "equityRelativeStrength"];

/**
 * Clause 1 — WHAT IS HAPPENING. Prefers the structural read, because "price
 * is making higher highs" is a fact a reader can check on a chart, whereas a
 * composite score is a claim they have to trust.
 *
 * Returns whether that leading read CONTRADICTS the overall verdict, because
 * the answer changes how the next clause has to be written (see below).
 */
function stateClause(bias: MarketBias, symbol: string): { text: string; conflicts: boolean } {
  for (const id of STATE_PRIORITY) {
    const m = bias.metrics.find((x) => x.id === id && x.verdict !== "neutral");
    if (m) return { text: m.explanation, conflicts: m.verdict !== bias.verdict };
  }
  // Nothing directional to lead with: say what the composite is, plainly.
  const direction = bias.verdict === "bullish" ? "leaning higher" : bias.verdict === "bearish" ? "leaning lower" : "going sideways";
  return { text: `${symbol} is ${direction} on the evidence available.`, conflicts: false };
}

/**
 * Clause 2 — WHAT SUPPORTS IT. Null when nothing does.
 *
 * ── The contradiction case, which is the important one ────────────────
 *
 * The leading structural read is the asset's OWN chart; the verdict is the
 * whole composite. They can disagree — a stock making lower highs inside a
 * broadening, well-bid market is a real and common situation. When they do,
 * simply printing both facts in sequence produces a page that appears to
 * contradict itself in its own summary ("an intact downtrend… market breadth
 * backs it up"), which destroys trust faster than being wrong would.
 *
 * So the disagreement is NAMED rather than smoothed. It is also genuinely the
 * most decision-relevant sentence available: it tells the reader the bullish
 * case rests on the backdrop and not on the chart in front of them, which is
 * precisely what they need to size the position correctly.
 */
function supportClause(bias: MarketBias, stateConflicts: boolean): string | null {
  const side = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  if (side.length === 0) {
    return stateConflicts
      ? `The overall read still leans ${bias.verdict}, though nothing else is currently backing that up.`
      : null;
  }

  const named = side.slice(0, 2).map((m) => m.label.toLowerCase());
  const joined = named.length === 2 ? `${named[0]} and ${named[1]}` : named[0];

  if (stateConflicts) {
    // The supports named here are what HOLD THE VERDICT UP; the chart is the
    // thing pointing the other way. Getting that round the wrong way reads as
    // nonsense to anyone actually checking, which is the reader who matters.
    return `The ${bias.verdict} read comes from the backdrop rather than from the chart itself — ${joined} are what hold it up.`;
  }
  return bias.verdict === "bearish"
    ? `${cap(joined)} are pushing the same way.`
    : `${cap(joined)} back it up.`;
}

/**
 * Clause 3 — WHAT FIGHTS IT, and what to do about it.
 *
 * This is the clause that turns a description into a decision: the counter-
 * evidence is what justifies waiting for a level rather than buying now, so
 * the two are stated together rather than in separate sections.
 */
function tensionClause(bias: MarketBias, plan: TradePlan | null): string | null {
  const against = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;
  const counter = against[0] ?? null;

  if (!counter && !plan) return null;

  if (counter && plan) {
    const zone = `${formatPrice(plan.entryLow)}–${formatPrice(plan.entryHigh)}`;
    const verb = bias.verdict === "bearish" ? "selling rallies into" : "buying pullbacks into";
    return `${counter.label} argues the other way, so ${verb} ${zone} offers better odds than chasing the current price.`;
  }
  if (counter) return `${counter.label} argues the other way, which is the main reason not to size this aggressively.`;

  const zone = `${formatPrice(plan!.entryLow)}–${formatPrice(plan!.entryHigh)}`;
  return `Nothing material argues the other way; the plan waits for ${zone} rather than chasing.`;
}

/** Clause 4 — WHAT ENDS IT. Only when a real level exists. */
function invalidationClause(plan: TradePlan | null, verdict: string): string | null {
  if (!plan) return null;
  const side = verdict === "bearish" ? "below" : "above";
  return `The setup stays valid ${side} ${formatPrice(plan.stopPrice)}.`;
}

/**
 * THE TEN-SECOND READ. Four clauses, each conditional on its own evidence.
 *
 * Deliberately capped at four: the moment this becomes a paragraph it stops
 * being a summary and becomes something the reader skims, which defeats the
 * point of having one.
 */
export function composeTldr(inputs: {
  bias: MarketBias;
  plan: TradePlan | null;
  symbol: string;
  name: string;
  /**
   * Which way the options market is positioned, when it is leaning at all.
   * Null covers both "no chain" and "no lean" — neither of which is an
   * opinion, and neither may be printed as one.
   */
  optionsLean?: "bullish" | "bearish" | null;
}): TldrSection {
  const { bias, plan, symbol, name, optionsLean = null } = inputs;
  const display = name && name !== symbol ? name : symbol;

  const { text: state, conflicts } = stateClause(bias, display);
  const support = supportClause(bias, conflicts);
  /*
   * When the chart already contradicts the verdict, the tension clause would
   * repeat the same opposition a second time in three sentences. The support
   * clause has already carried it, so this one is dropped.
   */
  const tension = conflicts ? null : tensionClause(bias, plan);
  const options = optionsClause(bias, optionsLean);
  const invalidation = invalidationClause(plan, bias.verdict);

  const full = [state, support, tension, options, invalidation].filter(Boolean).join(" ");
  return { state, support, tension, options, invalidation, full };
}

/**
 * Clause 4 — WHAT AN INDEPENDENT MARKET THINKS.
 *
 * Earns a sentence in the ten-second read only because it is sourced
 * elsewhere: every other clause above is derived from the price history this
 * engine already scored, while this one comes from what other people are
 * paying for optionality. A second source agreeing is worth a line; a second
 * source DISAGREEING is worth more than that, and is the case this clause
 * mostly exists for.
 *
 * Null when there is no chain, when positioning is not leaning either way,
 * or when the engine itself has no direction to compare against — in each
 * case there is no comparison to report, and manufacturing one would be the
 * kind of reassuring filler the composer exists to prevent.
 */
function optionsClause(bias: MarketBias, lean: "bullish" | "bearish" | null): string | null {
  if (lean === null || bias.verdict === "neutral") return null;
  return lean === bias.verdict
    ? "The options market is positioned the same way, which is a second and independently sourced read agreeing with this one."
    : `The options market is positioned the OTHER way — ${lean} against this ${bias.verdict} read. Independent sources disagreeing is a reason to size smaller, not a reason to pick the one you prefer.`;
}

/**
 * THE BULL CASE — everything arguing price rises, strongest first.
 *
 * Ordered by the engine's own ranking (weight × confidence), so the list is
 * not "everything bullish" but "what actually moved the score". A module that
 * contributed nothing does not get to appear as a reason.
 *
 * ── Absolute, not relative to the verdict ─────────────────────────────
 *
 * These used to be "supports it" and "fights it", swapped by side so that
 * the supporting column always matched the call. That made the same reading
 * appear under opposite headings on two different tickers — rising volume
 * "supports" a bullish name and "fights" a bearish one — so the labels
 * carried no fixed meaning and could not be compared across the site.
 *
 * Bull and bear are properties of the evidence, not of the current call. The
 * verdict is stated loudly enough three sections above; the reader can see
 * which column it agrees with.
 */
export function composeBullCase(bias: MarketBias): EvidenceBullet[] {
  return bias.topBullish.map(toBullet);
}

/** THE BEAR CASE — everything arguing price falls, same treatment. */
export function composeBearCase(bias: MarketBias): EvidenceBullet[] {
  return bias.topBearish.map(toBullet);
}

function toBullet(m: MetricVerdict): EvidenceBullet {
  return {
    claim: m.label,
    metricId: m.id,
    label: m.label,
    detail: m.explanation,
    confidence: m.confidence,
  };
}

/**
 * WHAT CHANGES MY OPINION — the exits, in advance.
 *
 * Three kinds, and keeping them distinct matters: a price level is checkable
 * on a chart, an evidence flip needs the next daily rebuild, and an event has
 * a date. Collapsing them into one list would leave a reader unsure what they
 * are supposed to watch.
 */
/**
 * Beyond this the list stops being read. Concrete triggers claim the slots
 * first; module flips fill whatever is left.
 */
const MAX_TRIGGERS = 5;

/** Module flips are useful but never lead — cap them even when slots are free. */
const MAX_EVIDENCE_TRIGGERS = 3;

/**
 * WHAT WOULD CHANGE THE ANSWER — always as a price, on every ticker.
 *
 * This section used to collapse on exactly the days it mattered most. With a
 * plan it named a level: "a daily close beyond $294.14". Without one it fell
 * back to engine internals — "Price Action Strength 15/100 — below 20 this
 * reports neutral regardless of direction" — which is not something anybody
 * can act on, or even watch for.
 *
 * Measured across five tickers on 2026-08-16: a price appeared on the two
 * that carried plans and on none of the three reading WAIT. Since the EV gate
 * landed, WAIT is the majority state, so the question this section answers
 * was unusable on most tickers on most days.
 *
 * The fix is not new data. `nextEntry` already computes both the level that
 * would MAKE this a trade and the nearest structure either side — and its own
 * doc says the watch levels exist so "a reader is never left without a price
 * to watch". They simply were not reaching this section.
 *
 * ── What "invalidation" means when there is no position ───────────────
 *
 * With a plan, the answer is the stop: the level past which the reason for
 * the trade is gone. Without one, the opinion being invalidated is *standing
 * aside*, so the trigger is the level at which standing aside stops being
 * right — plus the structure whose loss would change the read itself. Both
 * are prices a reader can set an alert on.
 */
export function composeInvalidation(inputs: {
  bias: MarketBias;
  plan: TradePlan | null;
  earningsDate: string | null;
  /**
   * Where the next decision happens. Supplies the price on days with no plan;
   * absent, the function degrades to exactly its previous behaviour.
   */
  nextEntry?: Read<PlannedEntryRead> | null;
}): InvalidationTrigger[] {
  const { bias, plan, earningsDate, nextEntry } = inputs;
  const price: InvalidationTrigger[] = [];
  const event: InvalidationTrigger[] = [];
  const evidence: InvalidationTrigger[] = [];

  if (plan) {
    price.push({
      kind: "price",
      condition: `A daily close beyond ${formatPrice(plan.stopPrice)}`,
      consequence:
        "That level sits past the structure the whole idea rests on, so losing it means the reason for the trade is gone — not merely that price moved.",
    });
  } else {
    const entry = nextEntry?.status === "available" ? nextEntry.data : null;
    /*
     * Deduplicated on the FORMATTED price, because a conditional entry's
     * trigger is frequently the same structure edge a watch level names, and
     * printing one level twice reads as two independent conditions.
     */
    const seen = new Set<string>();

    const candidate =
      entry?.entries.find((e) => e.primary && e.triggerPrice !== null) ??
      entry?.entries.find((e) => e.triggerPrice !== null);
    if (candidate?.triggerPrice != null) {
      seen.add(formatPrice(candidate.triggerPrice));
      price.push({
        kind: "price",
        condition: `Price reaching ${formatPrice(candidate.triggerPrice)}`,
        consequence:
          "That is where standing aside stops being the answer — close enough to structure to price a stop against, which is what turns this read into a trade with measured risk.",
      });
    }

    for (const w of entry?.watchLevels ?? []) {
      const at = formatPrice(w.price);
      if (seen.has(at)) continue;
      seen.add(at);
      price.push({
        kind: "price",
        condition: w.direction === "long" ? `A daily close below ${at}` : `A daily close above ${at}`,
        consequence:
          w.direction === "long"
            ? "That removes the nearest support this read leans on, and the next decision moves down to whatever structure sits beneath it."
            : "That clears the nearest resistance capping this read, which changes what the upside above here is worth.",
      });
    }
  }

  /*
   * Ahead of module flips, not behind them. A report can gap price straight
   * through a stop, which makes it the one condition that can invalidate a
   * trade before any reading has time to change.
   */
  if (earningsDate) {
    event.push({
      kind: "event",
      condition: `Earnings on ${earningsDate}`,
      consequence:
        "A report can gap price straight past a stop, so the risk printed on any plan is not actually available across that date.",
    });
  }

  /*
   * Evidence triggers come from `watchNext`, which the engine already
   * populates with the modules closest to flipping AND able to name the level
   * that would do it. A module with no stated threshold is excluded upstream
   * rather than given a vague sentence here.
   */
  const slots = Math.min(
    MAX_EVIDENCE_TRIGGERS,
    Math.max(0, MAX_TRIGGERS - price.length - event.length)
  );
  for (const m of bias.watchNext) {
    if (evidence.length >= slots) break;
    if (!m.nextTrigger) continue;
    evidence.push({
      kind: "evidence",
      condition: `${m.label} ${m.nextTrigger}`,
      consequence: "That would remove one of the readings currently holding this view up.",
    });
  }

  return [...price, ...event, ...evidence];
}

/**
 * THE TRUST LINE — the epistemics, compressed to something that fits.
 *
 * The verdict card carried two full bordered paragraphs plus a footnote:
 * roughly six hundred characters of "no module contributing to this has a
 * validated forward record", "250 calls are registered and waiting", and
 * "this platform does not generate summaries with a language model". Every
 * word of that is true and worth saying, and all of it was standing between
 * the reader and the trade on the most valuable screen in the product.
 *
 * So the prose folds and this line stays. The constraint that matters: the
 * summary must carry the CONCLUSION, not merely announce that a caveat
 * exists. A reader who never opens the fold has still been told the read has
 * no track record — otherwise folding would be hiding, which is the one
 * thing the layering rule forbids.
 */
export function composeTrustLine(input: {
  gradeLabel: string;
  validatedWeightPct: number;
  forward: { scored: number | null; open: number; edgeVsBaselinePct: number | null } | null;
}): string {
  const { gradeLabel, validatedWeightPct, forward } = input;

  const basis =
    gradeLabel === "descriptive"
      ? "Describes conditions, forecasts nothing"
      : `${Math.round(validatedWeightPct)}% of the weight behind this has a forward record`;

  if (!forward) return `${basis}. No track record is kept for this verdict yet.`;

  if (forward.scored === null || forward.scored === 0) {
    return (
      `${basis}. No scored track record yet — ` +
      `${forward.open.toLocaleString()} calls are still inside their window.`
    );
  }

  const edge =
    forward.edgeVsBaselinePct === null
      ? "against no measured baseline"
      : `${forward.edgeVsBaselinePct >= 0 ? "beating" : "trailing"} the baseline by ` +
        `${Math.abs(forward.edgeVsBaselinePct).toFixed(2)}%`;
  return `${basis}. ${forward.scored.toLocaleString()} past calls scored, ${edge}.`;
}

/**
 * THE MACRO SENTENCE — what this ticker inherited from the tape.
 *
 * Composed rather than listed because the interesting case is DISAGREEMENT: a
 * leading industry inside a risk-off tape is a specific situation, and it is
 * invisible if the three facts are printed as three separate badges.
 */
export function composeMacroSummary(o: {
  regime: string;
  sectorName: string | null;
  sectorState: string | null;
  industryName: string | null;
  industryState: string | null;
}): string {
  const parts: string[] = [];
  const tape =
    o.regime === "risk-on"
      ? "The wider tape is risk-on"
      : o.regime === "risk-off"
        ? "The wider tape is risk-off"
        : "The wider tape is mixed";
  parts.push(tape);

  if (o.industryName && o.industryState) {
    parts.push(`${o.industryName} is ${o.industryState}`);
  } else if (o.sectorName && o.sectorState) {
    parts.push(`${o.sectorName} is ${o.sectorState}`);
  }

  /*
   * The divergence call-out. Only fires when the two genuinely disagree,
   * because "everything agrees" is the common case and saying so every time
   * trains the reader to skip the line.
   */
  const riskOff = o.regime === "risk-off";
  const strong = o.industryState === "leading" || o.industryState === "improving";
  const weak = o.industryState === "lagging" || o.industryState === "weakening";

  let tail = ".";
  if (riskOff && strong) {
    tail = " — money is still favouring this corner while leaving the market generally, which is where relative strength is worth the most.";
  } else if (!riskOff && weak && o.regime === "risk-on") {
    tail = " — this corner is being left behind by a market that is otherwise advancing, which is a harder tape to own.";
  }

  return parts.join(", ") + tail;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Re-exported for the dossier builder, which assembles the MacroContext around it. */
export type { MacroContext };
