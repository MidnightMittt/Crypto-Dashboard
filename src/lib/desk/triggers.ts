/**
 * DESK TRIGGERS — declared levels, evaluated against named readings.
 *
 * The desk answers "what is about to require a decision". Its unit is a
 * TRIGGER: a level someone declared in advance, a current reading with a
 * source and an age, and the distance between them. The declaration lives
 * in a committed store; the evaluation lives here; and where no reading
 * source is wired the trigger is served with an explicit refusal naming
 * the missing dependency — a hub that quietly invents a price to have
 * something to show is worse than one that says it cannot see.
 *
 * ── Orientation is DECLARED, never inferred ───────────────────────────
 *
 * The first version derived breach direction from the trigger's kind, and
 * guessed one wrong: it read "review level" as an alert from below, when
 * the declared review at $0.455 sat between spot and the floor — a
 * FALLING-price alert. The direction a level cares about is part of the
 * declaration, so it is now a required field (`breach_when`), and the
 * evaluator contains no direction opinions of its own. The sign
 * convention survives: distance is oriented so NEGATIVE always means
 * crossed, whichever side the trigger watches.
 *
 * ── Ticks, not dollars, for the LP range ──────────────────────────────
 *
 * The LP range bounds are ticks, which are fixed; a USD version of them
 * has two moving parts (PONS/WETH and ETH/USD) and was quoted around a
 * stale ETH for a week — "floor $0.408" was only true at ETH $2,480.
 * Tick-native triggers are single-sourced from slot0(); any USD rendering
 * is a convenience the ROUTE attaches, stamped with the ETH assumption
 * that produced it.
 */

export type TriggerKind =
  | "price_floor"
  | "price_review"
  | "rate_falsifier"
  | "pool_tick";

export interface DeclaredTrigger {
  id: string;
  /** What the level is about — a ticker, a position, a series. */
  subject: string;
  kind: TriggerKind;
  level: number;
  unit: string;
  /** The side that constitutes crossing. Declared, because inferring it is how it gets guessed wrong. */
  breach_when: "at_or_above" | "at_or_below";
  /** Who declared it and when — a trigger without provenance is a vibe. */
  declared_by: string;
  declared_on: string;
  /** What breaching means, in the declarer's own terms. */
  on_breach: string;
  /** What a reading needs before this trigger can carry a distance. */
  source_required: string;
  /** For rate falsifiers: consecutive readings required to fire. */
  consecutive_readings?: number;
  /** How the level was derived, when it was converted from another unit. */
  derivation?: string;
}

export interface TriggerReading {
  value: number;
  source: string;
  /** ISO timestamp of the observation the value describes. */
  observed_at: string;
}

export interface EvaluatedTrigger extends DeclaredTrigger {
  reading: (TriggerReading & { age_seconds: number }) | null;
  /**
   * Oriented distance from reading to level: NEGATIVE means crossed.
   * Ticks for pool_tick triggers, percent of the level otherwise.
   * Null without a reading.
   */
  distance: number | null;
  distance_unit: "pct_of_level" | "ticks";
  breached: boolean | null;
  /** Present exactly when reading is null. Names what is missing, not just that it is. */
  refusal: string | null;
}

export function evaluateTrigger(
  t: DeclaredTrigger,
  reading: TriggerReading | null,
  nowMs: number
): EvaluatedTrigger {
  const unit: EvaluatedTrigger["distance_unit"] = t.kind === "pool_tick" ? "ticks" : "pct_of_level";
  if (reading === null) {
    return {
      ...t,
      reading: null,
      distance: null,
      distance_unit: unit,
      breached: null,
      refusal:
        `No reading: ${t.source_required} ` +
        "Distance and breach are null rather than computed from a guessed source.",
    };
  }
  /*
   * Positive = margin remaining, negative = crossed, whichever side the
   * declaration watches. at_or_above breaches upward, so margin is
   * level - value; at_or_below breaches downward, so margin is value - level.
   */
  const margin =
    t.breach_when === "at_or_above" ? t.level - reading.value : reading.value - t.level;
  const distance =
    unit === "ticks" ? Math.round(margin) : Math.round((margin / t.level) * 10000) / 100;
  const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(reading.observed_at)) / 1000));
  return {
    ...t,
    reading: { ...reading, age_seconds: ageSeconds },
    distance,
    distance_unit: unit,
    breached: margin <= 0,
    refusal: null,
  };
}
