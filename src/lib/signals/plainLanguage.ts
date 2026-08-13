/**
 * NUMBERS INTO WORDS — the shared vocabulary layer.
 *
 * The engine thinks in percentages because percentages are what it can
 * compute honestly. A reader does not think in percentages: "Data Quality
 * 28%" and "Agreement 100%" sitting side by side is two decimals of
 * precision wrapped around zero comprehension, and a user who has to decode
 * a label is a user the interface failed.
 *
 * So every surface converts through THIS module rather than printing raw
 * figures, for the same reason every surface scores through one engine: two
 * places translating independently would eventually disagree about what
 * "thin" means, and the disagreement would be invisible.
 *
 * ── What this is NOT allowed to do ────────────────────────────────────
 *
 * It never softens a finding. Plain language means shorter words, not
 * gentler claims — "the evidence is thin" is exactly as discouraging as
 * "confidence 28%", and deliberately so. The precise number stays available
 * beside the word everywhere it matters, because a professional reader must
 * still be able to audit the reading rather than trust an adjective.
 */

/** How good the evidence behind a reading is. */
export type EvidenceLevel = "thin" | "moderate" | "strong";

/**
 * Boundaries chosen to match the thresholds the rest of the engine already
 * treats as meaningful (the markets page has long described >= 65 as
 * "solid, agreeing" and >= 40 as "partial"), so the word and the existing
 * prose can never contradict each other.
 */
export function evidenceLevel(confidencePct: number): EvidenceLevel {
  if (confidencePct >= 65) return "strong";
  if (confidencePct >= 40) return "moderate";
  return "thin";
}

/** One line a reader can act on, without needing the percentage. */
export function describeEvidence(confidencePct: number): string {
  switch (evidenceLevel(confidencePct)) {
    case "strong":
      return "Plenty of solid evidence behind this read.";
    case "moderate":
      return "A partial picture — enough to lean on, not enough to lean hard.";
    default:
      return "Thin evidence. Treat this as a hint, not a signal.";
  }
}

/** How much the separate signals concur WITH EACH OTHER. */
export type AgreementLevel = "conflicting" | "split" | "mostly-agree" | "unanimous";

export function agreementLevel(agreementPct: number): AgreementLevel {
  if (agreementPct >= 100) return "unanimous";
  if (agreementPct >= 67) return "mostly-agree";
  if (agreementPct >= 34) return "split";
  return "conflicting";
}

export function describeAgreement(agreementPct: number): string {
  switch (agreementLevel(agreementPct)) {
    case "unanimous":
      return "Every signal points the same way.";
    case "mostly-agree":
      return "Most signals point the same way.";
    case "split":
      return "The signals are split.";
    default:
      return "The signals contradict each other.";
  }
}

/**
 * THE DISTINCTION THAT MATTERS MOST, in one sentence.
 *
 * Evidence quality and agreement are different questions and the case worth
 * seeing is where they come apart: a unanimous read built on almost no data
 * looks like certainty and is not. Rather than print two percentages and
 * hope the reader does the reasoning, name the situation.
 */
export function describeConviction(confidencePct: number, agreementPct: number): string {
  const evidence = evidenceLevel(confidencePct);
  const agree = agreementLevel(agreementPct);

  if (evidence === "thin" && (agree === "unanimous" || agree === "mostly-agree")) {
    return "Everything agrees — but on thin evidence, which looks like certainty and is not. Unanimous readings from few sources flip easily.";
  }
  if (evidence === "strong" && (agree === "conflicting" || agree === "split")) {
    return "Good evidence, but it disagrees with itself. The score is a compromise between real opposing signals, not a consensus.";
  }
  if (evidence === "strong" && agree === "unanimous") {
    return "Strong evidence and every signal agrees — the most reliable combination this engine produces.";
  }
  return `${describeEvidence(confidencePct)} ${describeAgreement(agreementPct)}`;
}

/**
 * PLAIN DEFINITIONS for terms with no shorter honest synonym.
 *
 * Some vocabulary cannot be removed without losing the meaning — a stop IS
 * a stop. The rule applied here: never make a reader look a term up
 * elsewhere. Anything in this table is explained on the spot, in one
 * sentence, with no second piece of jargon inside the explanation.
 */
export const GLOSSARY: Record<string, string> = {
  ATR: "Average True Range — the amount this asset typically moves in a day. Used to judge whether a stop is realistic or is sitting inside normal daily noise.",
  breadth:
    "How many things are participating, rather than how far the index moved. A rise carried by two names is weaker than the same rise carried by twenty.",
  stop: "The price at which the reason for the trade is gone, so the position is closed. Not a prediction — a statement about which level, if lost, breaks the setup.",
  target: "A price where the move is expected to run out of room, usually the next structural level above or below.",
  "risk/reward":
    "How much you stand to make against how much you stand to lose. 2.0 means the target is twice as far away as the stop.",
  invalidation:
    "The specific thing that would prove this read wrong. Stated in advance so the exit is a decision made calmly rather than in the moment.",
  "relative strength":
    "Whether this is outperforming the wider market, not whether it went up. Something can rise and still be lagging.",
  volatility: "How violently the price swings. High volatility widens the stop needed and shrinks the position that fits behind it.",
  "money flow": "Where capital is actually moving — into or out of the asset — as opposed to what the price chart says.",
  liquidity: "How much can be bought or sold without moving the price. Thin liquidity turns an ordinary exit into a costly one.",
  drawdown: "How far a position went against you before it worked — the pain you had to sit through, not the final result.",
};

/**
 * Case-insensitive lookup, so a caller can pass the term exactly as it is
 * displayed ("ATR", "Stop", "risk/reward") without knowing how it was keyed.
 * Indexed once rather than probing case variants, which silently missed
 * every capitalised key.
 */
const GLOSSARY_INDEX = new Map(Object.entries(GLOSSARY).map(([k, v]) => [k.toLowerCase(), v]));

export function define(term: string): string | null {
  return GLOSSARY_INDEX.get(term.toLowerCase()) ?? null;
}

/**
 * A 0-100 composite as a star count, for readers who want magnitude before
 * they want a number. Deliberately coarse: five buckets is the most
 * precision a directional score of this kind can honestly carry.
 */
export function strengthStars(score: number): number {
  const distance = Math.abs(score - 50);
  if (distance >= 30) return 5;
  if (distance >= 20) return 4;
  if (distance >= 12) return 3;
  if (distance >= 6) return 2;
  return 1;
}
