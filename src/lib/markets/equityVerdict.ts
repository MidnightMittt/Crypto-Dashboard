import { MarketBias } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal, TRADE_PLAN_REFUSAL_SHORT } from "@/lib/signals/tradePlan";
import { describeEvidence, evidenceLevel } from "@/lib/signals/plainLanguage";
import { DIRECTIONAL_THRESHOLD } from "@/lib/signals/scoring";

/**
 * THE ANSWER, IN ONE GLANCE — bullish, bearish, or neither, plus one plain
 * sentence saying what to do about it.
 *
 * The page this feeds used to open with "BULLISH CONDITIONS 70 / 100 · Data
 * Quality 28% · Agreement 100%" and put the trade plan below five cards of
 * commentary about the reading. That is exactly backwards: the reader came
 * to find out whether to buy, and had to decode three competing numbers and
 * scroll past the engine's self-assessment to find out there was no trade.
 *
 * ── The rule that makes this trustworthy ──────────────────────────────
 *
 * THE WORD MUST SURVIVE EVERY GATE. It is derived from the plan outcome,
 * not from the score. A bullish read whose plan was refused is NOT "BULLISH,
 * buy" — it is WAIT, with the refusal stated. This mirrors the crypto
 * VerdictStrip contract, where the headline word is the gated
 * recommendation rather than the raw bias, so the two asset classes can
 * never mean different things by the same green circle.
 *
 * Simplifying the language must never simplify the claim. Every branch
 * below says something at least as cautious as the machinery behind it.
 */

export type VerdictAction = "buy" | "sell" | "wait" | "stand-aside";

export interface AssetVerdict {
  /** 🟢 🔴 🟡 ⚪ — readable before a single word is. */
  emoji: string;
  /** One or two words, upper case, the whole answer. */
  word: string;
  /** Tailwind text colour token. */
  tone: string;
  /** One plain sentence: what this is and what to do about it. */
  sentence: string;
  action: VerdictAction;
}

/**
 * Why the score alone is never the headline: a directional read with no
 * executable plan is a WAIT, and saying "bullish" over it would invite
 * exactly the trade the engine just declined to offer.
 */
export function equityVerdict(inputs: {
  bias: MarketBias;
  plan: TradePlan | null;
  refusal: TradePlanRefusal | null;
  /** The refusal's own numbers, when the gate carried them. Preferred over the static text. */
  refusalDetail?: string | null;
  /** Nearest report date inside the veto window, for a concrete "wait until" line. */
  earningsDate?: string | null;
}): AssetVerdict {
  const { bias, plan, refusal, refusalDetail = null, earningsDate = null } = inputs;
  const bullish = bias.verdict === "bullish";
  const bearish = bias.verdict === "bearish";

  // ── No direction at all ────────────────────────────────────────────
  if (!bullish && !bearish) {
    const distance = Math.abs(bias.score - 50);
    /*
     * The symbol's own nearest driver, so 21 balanced pages do not read as
     * one sentence with a different digit. watchNext is real, per-symbol
     * data — the metric closest to a threshold and the level that moves it
     * — and a NO EDGE without it tells the reader to stand aside without
     * saying what they are standing aside FOR.
     */
    const watch = bias.watchNext[0] ?? null;
    return {
      emoji: "⚪",
      word: "NO EDGE",
      tone: "text-ink-muted",
      action: "stand-aside",
      sentence:
        `The evidence is balanced — ${distance.toFixed(0)} point${distance === 1 ? "" : "s"} from neutral, ` +
        `inside the band where this engine will not call a direction. There is nothing to trade here yet, ` +
        `which is a finding rather than a failure.` +
        (watch ? ` Closest to moving it: ${watch.label} — ${watch.nextTrigger}` : ""),
    };
  }

  const side = bullish ? "up" : "down";

  // ── Direction, but the plan was refused ────────────────────────────
  if (refusal) {
    /*
     * The measured sentence beats the static one whenever the gate carried
     * its own numbers: "trades like this have lost money" is unfalsifiable
     * as written, and a verdict the reader cannot disagree with is one they
     * stop reading. The detail names the statistic, the bound, the horizon
     * and the sample, so the disagreement has something to grip.
     */
    const why = refusalDetail ?? TRADE_PLAN_REFUSAL_SHORT[refusal];
    const until =
      refusal === "earnings-imminent" && earningsDate
        ? ` Reconsider after ${earningsDate}.`
        : "";
    return {
      emoji: "🟡",
      word: "WAIT",
      tone: "text-amber",
      action: "wait",
      sentence: `The read leans ${side}, but there is no trade worth taking right now. ${why}${until}`,
    };
  }

  // ── Direction with a real plan ─────────────────────────────────────
  if (plan) {
    const evidence = evidenceLevel(bias.confidence);
    const caution =
      evidence === "thin"
        ? " The evidence behind it is thin, so size it small."
        : evidence === "moderate"
          ? " The evidence is partial, so this is a lean rather than a conviction trade."
          : "";
    return {
      emoji: bullish ? "🟢" : "🔴",
      word: bullish ? "BULLISH" : "BEARISH",
      tone: bullish ? "text-success" : "text-danger",
      action: bullish ? "buy" : "sell",
      sentence:
        `The evidence points ${side}, and there is a plan below with a defined entry, ` +
        `stop and target.${caution}`,
    };
  }

  /*
   * Directional, no plan and NO NAMED REFUSAL. Reached only when a caller
   * supplies neither — treated as "no plan offered" rather than assumed
   * tradeable, because inventing confidence from missing information is the
   * one failure this engine must never have.
   */
  return {
    emoji: "🟡",
    word: "WAIT",
    tone: "text-amber",
    action: "wait",
    sentence: `The read leans ${side}, but no plan was produced for it, so there is nothing to act on.`,
  };
}

/** The plain-English summary of how much to trust the read, for the line under the verdict. */
export function describeReadQuality(bias: MarketBias): string {
  return describeEvidence(bias.confidence);
}

/** Score distance needed before the engine will name a side — for explaining a NO EDGE call. */
export const NEUTRAL_BAND = DIRECTIONAL_THRESHOLD;
