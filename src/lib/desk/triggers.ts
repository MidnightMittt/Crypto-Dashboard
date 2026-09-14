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
 * That refusal discipline is not hypothetical for this book. The live
 * triggers are on an on-chain token whose public dashboards have been
 * caught wrong twice by the trading session (a wrong-pool fallback served
 * four different queries the same data; a 24h volume figure off by ~20x
 * against Swap events). Until a pool address and an approved source
 * exist, a PONS "price" here would be a guess about WHICH POOL as much as
 * a number — so the field stays null and the reason says exactly what
 * would fill it.
 */

export type TriggerKind = "price_floor" | "price_review" | "rate_falsifier";

export interface DeclaredTrigger {
  id: string;
  /** What the level is about — a ticker, a position, a series. */
  subject: string;
  kind: TriggerKind;
  level: number;
  unit: string;
  /** Who declared it and when — a trigger without provenance is a vibe. */
  declared_by: string;
  declared_on: string;
  /** What breaching means, in the declarer's own terms. */
  on_breach: string;
  /** What a reading needs before this trigger can carry a distance. */
  source_required: string;
  /** For rate falsifiers: consecutive readings required to fire. */
  consecutive_readings?: number;
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
   * Signed distance from reading to level, in percent of the level.
   * Negative means the trigger side has been crossed. Null without a reading.
   */
  distance_pct: number | null;
  breached: boolean | null;
  /** Present exactly when reading is null. Names what is missing, not just that it is. */
  refusal: string | null;
}

/**
 * Distance with the sign oriented so NEGATIVE always means "crossed".
 *
 * A floor is breached from above (price below level); a review level is an
 * alert armed from below (price above level). A rate falsifier fires when
 * the rate falls UNDER the level, like a floor. Orienting the sign per
 * kind means a reader scans one column for danger instead of remembering
 * which direction each trigger cares about.
 */
export function evaluateTrigger(
  t: DeclaredTrigger,
  reading: TriggerReading | null,
  nowMs: number
): EvaluatedTrigger {
  if (reading === null) {
    return {
      ...t,
      reading: null,
      distance_pct: null,
      breached: null,
      refusal:
        `No reading: ${t.source_required} ` +
        "Distance and breach are null rather than computed from a guessed source.",
    };
  }
  const raw = ((reading.value - t.level) / t.level) * 100;
  const oriented = t.kind === "price_review" ? -raw : raw;
  const ageSeconds = Math.max(0, Math.round((nowMs - Date.parse(reading.observed_at)) / 1000));
  return {
    ...t,
    reading: { ...reading, age_seconds: ageSeconds },
    distance_pct: Math.round(oriented * 100) / 100,
    breached: oriented < 0,
    refusal: null,
  };
}
