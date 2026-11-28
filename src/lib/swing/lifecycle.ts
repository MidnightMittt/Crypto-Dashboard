import { Candle, atr } from "../technicals/indicators";
import { SupportResistanceZone } from "../technicals/marketStructure";
import { TradeDirection } from "../signals/tradePlan";
import { SetupState, EntryTrigger, PaperPosition } from "./types";

/**
 * SETUP LIFECYCLE — identity, triggers, and state.
 *
 * ── IDENTITY IS THE POINT ───────────────────────────────────────────────
 *
 * A setup must be the SAME setup across scans. Without that, every poll
 * mints a fresh "opportunity", the alert stream repeats forever, and a paper
 * engine happily opens the same trade five times. The id is derived from
 * asset + direction + the zone's price band, ROUNDED — because zone edges
 * drift by small amounts as bars arrive, and an unrounded key would mint a
 * new identity on noise. That exact bug cost this project a false 65.7%
 * result when a backtest keyed a cooldown on unrounded zone boundaries and
 * counted one reclaim seven times.
 *
 * ── CONFLUENCE CANNOT SATISFY A TRIGGER ─────────────────────────────────
 *
 * `detectTrigger` reads ONLY price action: where the bar's high, low and
 * close sit relative to the zone. It takes no confluence, no trend score, no
 * star rating. That separation is deliberate and is the mechanism behind the
 * rule that an excellent level is a WATCH, not a long.
 */

/** Rounding applied to zone edges when minting an id. 3 significant-ish digits. */
function idBand(price: number): string {
  if (!(price > 0)) return "0";
  const mag = Math.pow(10, Math.floor(Math.log10(price)) - 2);
  return String(Math.round(price / mag) * mag);
}

export function opportunityId(asset: string, direction: TradeDirection, zone: SupportResistanceZone | null): string {
  const band = zone ? `${idBand(zone.priceLow)}-${idBand(zone.priceHigh)}` : "nozone";
  return `${asset}:${direction}:${band}`;
}

/**
 * What price must do, and whether it has.
 *
 * Only the LAST CLOSED bar can satisfy a trigger. A forming bar can un-form,
 * and a trigger that fires on an intrabar touch is a trigger that fires on
 * noise and then un-fires.
 */
export function detectTrigger(input: {
  direction: TradeDirection;
  zone: SupportResistanceZone | null;
  candles: Candle[];
}): EntryTrigger {
  const { direction, zone, candles } = input;
  if (!zone || candles.length < 3) {
    return { kind: "none", description: "No structural zone to trigger against.", price: null, satisfied: false };
  }
  const bar = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const inZone = (p: number) => p >= zone.priceLow && p <= zone.priceHigh;

  if (direction === "long") {
    // RECLAIM — the level was lost and has been taken back. The engine's own
    // zone classifier owns that determination; here it is only read.
    if (zone.status === "reclaiming") {
      return {
        kind: "reclaim",
        description: "Level was lost and has been reclaimed — hold above the zone high confirms",
        price: zone.priceHigh,
        satisfied: bar.close > zone.priceHigh,
      };
    }
    // REJECTION — traded INTO support and closed back above it. The wick is
    // the evidence: buyers were present low enough to matter.
    const wicked = bar.low <= zone.priceHigh && bar.close > zone.priceHigh;
    return {
      kind: "rejection",
      description: "Price must trade into the zone and close back above its high",
      price: zone.priceHigh,
      satisfied: wicked,
    };
  }

  // SHORT
  if (zone.status === "breaking") {
    return {
      kind: "retest-hold",
      description: "Support has broken — a failed retest from below confirms",
      price: zone.priceLow,
      satisfied: bar.close < zone.priceLow && prev.high >= zone.priceLow,
    };
  }
  const wicked = bar.high >= zone.priceLow && bar.close < zone.priceLow;
  return {
    kind: "rejection",
    description: "Price must trade into the zone and close back below its low",
    price: zone.priceLow,
    satisfied: wicked,
  };
}

/**
 * Pre-entry state from geometry and the trigger.
 *
 * Returns only LEVEL states. Position states (ACTIVE and beyond) are owned by
 * the paper engine, because they are facts about a position rather than
 * inferences about price — and inferring "ACTIVE" from a chart is exactly how
 * a tracker and a broker drift apart.
 */
export function derivePreEntryState(input: {
  price: number;
  entryLow: number;
  entryHigh: number;
  stopPrice: number;
  direction: TradeDirection;
  trigger: EntryTrigger;
  candles: Candle[];
  approachAtr?: number;
}): SetupState {
  const { price, entryLow, entryHigh, stopPrice, direction, trigger, candles } = input;
  const approachAtr = input.approachAtr ?? 0.75;

  // INVALIDATED first — a dead thesis outranks every other read.
  if (direction === "long" && price < stopPrice) return "INVALIDATED";
  if (direction === "short" && price > stopPrice) return "INVALIDATED";

  const a = atr(candles);
  const atEntry = price >= entryLow && price <= entryHigh;
  const edge = price < entryLow ? entryLow : entryHigh;
  const edgeAtr = a && a > 0 ? Math.abs(price - edge) / a : Number.POSITIVE_INFINITY;

  /*
   * THE TRIGGER DECIDES CONFIRMATION, NOT CONTAINMENT.
   *
   * The first version required price to be INSIDE the entry zone before it
   * would call ENTRY_CONFIRMED. That is self-contradictory: a `rejection`
   * trigger is defined as a bar that wicks into the zone and CLOSES BACK
   * ABOVE it, which by construction leaves the close outside the entry band.
   * The two conditions could almost never both hold.
   *
   * Measured over 2,157 walk-forward scans on BTC: price sat inside the entry
   * zone 1,206 times, a trigger fired 609 times, and they coincided just 10.
   * The bot would effectively never have traded — found only by running the
   * spine end-to-end, not by any unit test of either piece alone.
   *
   * So confirmation is: THE TRIGGER FIRED, and price has not yet run away.
   * The proximity bound is what stops this becoming a chase — a rejection
   * confirmed three ATRs ago is history, not an entry.
   */
  const CONFIRM_MAX_ATR = 1.5;
  if (trigger.satisfied && (atEntry || edgeAtr <= CONFIRM_MAX_ATR)) return "ENTRY_CONFIRMED";

  if (atEntry) return "WAITING_CONFIRMATION";
  if (edgeAtr <= approachAtr) return "APPROACHING";
  return "WATCHING";
}

/** Distance from price to the near edge of the entry zone, in ATRs. */
export function distanceInAtr(price: number, entryLow: number, entryHigh: number, candles: Candle[]): number {
  const a = atr(candles);
  if (!a || a <= 0) return Number.POSITIVE_INFINITY;
  if (price >= entryLow && price <= entryHigh) return 0;
  const edge = price < entryLow ? entryLow : entryHigh;
  return Math.abs(price - edge) / a;
}

/**
 * One sentence describing a state change, for the alert stream.
 *
 * Returns null when nothing changed — which is how repeat notifications are
 * suppressed. Alerts are tied to TRANSITIONS, never to ticks: a setup sitting
 * in WATCHING for a week should produce one alert, not a thousand.
 */
export function describeTransition(prev: SetupState | null, next: SetupState, asset: string, direction: TradeDirection): string | null {
  if (prev === next) return null;
  const side = direction === "long" ? "long" : "short";
  switch (next) {
    case "WATCHING":            return `${asset}: a ${side} level is now worth watching.`;
    case "APPROACHING":         return `${asset}: price is approaching the ${side} entry zone.`;
    case "WAITING_CONFIRMATION":return `${asset}: price is AT the ${side} entry zone — waiting for the trigger.`;
    case "ENTRY_CONFIRMED":     return `${asset}: ${side} entry trigger CONFIRMED.`;
    case "ACTIVE":              return `${asset}: ${side} position opened.`;
    case "PARTIALLY_EXITED":    return `${asset}: a take-profit target filled on the ${side}.`;
    case "COMPLETED":           return `${asset}: ${side} position closed.`;
    case "INVALIDATED":         return `${asset}: the ${side} thesis is invalidated — price closed through the stop level.`;
    default:                    return null;
  }
}

/** Is this opportunity already represented by an open paper position? */
export function hasOpenPosition(opportunityId: string, positions: PaperPosition[]): boolean {
  return positions.some(
    (p) => p.opportunityId === opportunityId && (p.state === "ACTIVE" || p.state === "PARTIALLY_EXITED")
  );
}
