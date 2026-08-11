/**
 * Turns the swing state machine's state into the handful of strings the
 * decision surface renders.
 *
 * Pure and separate from the components on purpose: the rules about what a
 * trader is told — "act now" vs "don't chase" vs "the thesis is intact but
 * weakening" — are product logic, and product logic inside JSX is product
 * logic nobody can test. Nothing here computes an opinion; every value is
 * read off the state `swingThesis.ts` already produced.
 */

import { SwingThesisState, PlanStatus, SwingThesisStore, ThesisEvent } from "./swingThesis";
import { SwingThesisSnapshot } from "@/types/market";

export type SwingTone = "long" | "short" | "neutral" | "warn" | "danger";

export interface SwingView {
  /** The single loudest thing on the page. */
  label: string;
  tone: SwingTone;
  /** One sentence. Never a paragraph. */
  detail: string;
  /**
   * Compact provenance, e.g. "PLAN ACTIVE · v2 · 3d". Null when no thesis
   * stands, because a chip claiming a plan exists when none does is worse
   * than no chip.
   */
  chip: string | null;
  /**
   * The separate TACTICAL line. Short-term conditions live here and ONLY
   * here, so that "momentum is fading" can never be mistaken for "the trade
   * is off" — the distinction the whole refactor exists to draw.
   */
  tactical: string | null;
  /** Null when no thesis stands; the caller renders structure instead of a plan. */
  state: SwingThesisState | null;
}

const DAY_MS = 86_400_000;

/** "3d" / "18h" / "just now" — compact enough for a chip. */
export function ageLabel(from: number, now: number): string {
  const ms = Math.max(0, now - from);
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours}h` : "just now";
}

function directionLabel(state: SwingThesisState): string {
  return state.direction === "long" ? "LONG" : "SHORT";
}

function toneOf(state: SwingThesisState): SwingTone {
  if (state.status === "invalidated") return "danger";
  if (state.status === "missed") return "warn";
  if (state.status === "completed") return "neutral";
  return state.direction === "long" ? "long" : "short";
}

const STATUS_DETAIL: Record<PlanStatus, (s: SwingThesisState) => string> = {
  "entry-available": (s) =>
    `Price is inside the planned entry zone — this is the level the plan was built to enter at, with the stop at ${s.plan.stopPrice.toFixed(2)}.`,
  active: (s) =>
    `The plan is live and waiting for price to reach the entry zone at ${s.plan.entryLow.toFixed(2)}–${s.plan.entryHigh.toFixed(2)}.`,
  missed: () => "Price left the entry zone without filling. The thesis still stands, but this entry has passed — do not chase it.",
  invalidated: (s) => `Price reached ${s.plan.stopPrice.toFixed(2)}, the level this thesis was defined as wrong beyond.`,
  completed: (s) => `Price reached the first target at ${s.plan.target1Price.toFixed(2)}.`,
};

const STATUS_LABEL: Record<PlanStatus, (s: SwingThesisState) => string> = {
  "entry-available": (s) => `ENTER ${directionLabel(s)}`,
  active: (s) => `${directionLabel(s)} PLAN ACTIVE`,
  missed: () => "MISSED — DO NOT CHASE",
  invalidated: () => "THESIS INVALIDATED",
  completed: () => "TARGET REACHED",
};

const STATUS_CHIP: Record<PlanStatus, string> = {
  "entry-available": "ENTRY AVAILABLE",
  active: "PLAN ACTIVE",
  missed: "MISSED",
  invalidated: "INVALIDATED",
  completed: "COMPLETED",
};

/**
 * The tactical line (§19 of the brief).
 *
 * Deliberately narrow: it reports deterioration in the swing evidence, and
 * says in the same breath that the thesis is unchanged. The stateless
 * short-term read is NOT piped in here — it moves several times a day, and
 * echoing it beside a multi-day plan is exactly the noise this refactor
 * removes.
 */
function tacticalLine(state: SwingThesisState): string | null {
  if (state.health !== "weakening") return null;
  return `Supporting evidence has weakened for ${state.weakeningCloses} daily close${state.weakeningCloses === 1 ? "" : "s"} — the swing thesis still stands, but with less backing than when it was established.`;
}

/**
 * Restates the fast-moving stateless read as a CONDITION rather than an
 * action.
 *
 * Rendering its raw label would put a second imperative ("ENTER SHORT") on
 * the same surface as the standing thesis, inviting a trader to act on the
 * very signal that changed ~7 times a day. The information is worth keeping;
 * the call to action is not. One idea, one location.
 */
export function shortTermCondition(action: string): string {
  switch (action) {
    case "enter-long":
      return "short-term conditions favour the long side";
    case "enter-short":
      return "short-term conditions favour the short side";
    case "wait-long-confirmation":
      return "short-term bias is bullish but unconfirmed by price action";
    case "wait-short-confirmation":
      return "short-term bias is bearish but unconfirmed by price action";
    default:
      return "no short-term directional edge";
  }
}

/** The most recent event, which is what "why did this change" means in practice. */
export function latestEvent(store: SwingThesisStore): ThesisEvent | null {
  return store.events.length > 0 ? store.events[store.events.length - 1] : null;
}

/**
 * Builds the view.
 *
 * `snapshot === null` and `snapshot.available === false` are different
 * states and produce different copy: the first means the engine has nothing
 * to assess, the second means we could not find out. Neither is allowed to
 * render as a confident "no setup".
 */
export function buildSwingView(snapshot: SwingThesisSnapshot | null, now: number): SwingView {
  if (!snapshot) {
    return {
      label: "NO SWING SETUP",
      tone: "neutral",
      detail: "There isn't enough data to assess a swing thesis for this asset right now.",
      chip: null,
      tactical: null,
      state: null,
    };
  }

  if (!snapshot.available) {
    return {
      label: "PLAN STATE UNAVAILABLE",
      tone: "neutral",
      detail:
        "The stored swing thesis could not be read, so this is not a statement that no trade exists — it's a statement that we couldn't check.",
      chip: null,
      tactical: null,
      state: null,
    };
  }

  const state = snapshot.store.active;

  if (!state) {
    /*
     * COLD START is its own answer. A store that has never folded in a
     * daily close hasn't rejected anything — it hasn't looked yet. Saying
     * "no thesis qualifies" here would be a confident claim built on zero
     * observations, which is exactly the kind of thing this engine is not
     * allowed to do. There is no backfill: reconstructing past closes would
     * need past bias scores nobody recorded, and inventing them would break
     * point-in-time integrity for the sake of a faster first render.
     */
    if (snapshot.store.lastCloseAt === 0) {
      return {
        label: "ESTABLISHING SWING THESIS",
        tone: "neutral",
        detail:
          "The swing engine hasn't observed a daily close yet for this asset. It needs consecutive confirming closes before it will call a multi-day trade — this is a cold start, not a verdict.",
        chip: null,
        tactical: null,
        state: null,
      };
    }

    const pending = snapshot.store.pending;
    const retired = latestEvent(snapshot.store);
    const detail = pending
      ? `A ${pending.direction} setup is forming: ${pending.closes} qualifying daily close${pending.closes === 1 ? "" : "s"} so far. A swing thesis needs consecutive confirmation before it activates.`
      : retired && retired.kind === "retired"
        ? retired.reason
        : "No swing thesis currently qualifies. Conditions haven't lined up across the composite bias, daily structure and 4H for long enough to justify a multi-day trade.";

    return { label: "NO SWING SETUP", tone: "neutral", detail, chip: null, tactical: null, state: null };
  }

  return {
    label: STATUS_LABEL[state.status](state),
    tone: toneOf(state),
    detail: STATUS_DETAIL[state.status](state),
    chip: `${STATUS_CHIP[state.status]} · v${state.version} · ${ageLabel(state.activatedAt, now)}`,
    tactical: tacticalLine(state),
    state,
  };
}
