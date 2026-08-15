import { MarketBias, MetricVerdict } from "@/lib/signals/types";
import { TradePlan, TradePlanRefusal, TRADE_PLAN_REFUSAL_SHORT } from "@/lib/signals/tradePlan";
import { EarningsVetoResult, EARNINGS_VETO_SESSIONS } from "@/lib/markets/earningsVeto";
import { agreementLevel, evidenceLevel } from "@/lib/signals/plainLanguage";

/**
 * THE SETUP CHECKLIST — is this a good trade, scannable in three seconds.
 *
 * Deliberately a different question from the bull and bear cases directly
 * above it. Those ask WHICH WAY the evidence points; this asks whether the
 * setup is worth taking at all, which turns on things that are not evidence
 * in the directional sense: whether a plan survived the expectancy gate,
 * whether earnings sit inside the hold, whether the options market contests
 * the read, whether the readings agree with each other. A checklist that
 * merely re-listed the bullish metrics would be the bull case with ticks.
 *
 * ── It computes nothing ───────────────────────────────────────────────
 *
 * Every row is a SELECTION and a LABEL over a value the engine already
 * measured. There is no scoring here, no weighting, and deliberately no
 * composite: a "setup quality" number computed in this file would be a
 * second opinion sitting beside `bias.score` with no record of its own,
 * which is the exact defect removed when the dual composite score was
 * consolidated. The headline is `plan.stars` — already backtested, already
 * carrying its own written rationale.
 *
 * When the gate refuses a plan there is no setup to rate, and the honest
 * headline is "no setup" rather than a low number. A one-star rating claims
 * a bad trade exists; the gate's whole point is that it does not.
 */

export type CheckState = "pass" | "caution" | "fail";

export interface ChecklistRow {
  state: CheckState;
  /** What is being checked, in the reader's words. */
  label: string;
  /** The measurement behind it. Never a restatement of the label. */
  detail: string;
}

export interface Checklist {
  /**
   * The plan's own backtested rating, 1-5, or null when the gate refused —
   * in which case there is no setup to rate.
   */
  stars: number | null;
  /** The engine's own sentence for that rating. */
  starRationale: string | null;
  rows: ChecklistRow[];
  passed: number;
  total: number;
  /** One line a reader can stop at. */
  summary: string;
}

export interface ChecklistInputs {
  bias: MarketBias;
  plan: TradePlan | null;
  refusal: TradePlanRefusal | null;
  earnings: EarningsVetoResult | null;
  /**
   * The symbol's next earnings date, and the three cases have to stay
   * distinguishable because they mean opposite things to a reader:
   *
   *   string    — a date came back. The window claim is verifiable.
   *   null      — we looked and got nothing. NOT the same as "clear".
   *   undefined — the asset has no earnings at all (crypto). Row omitted.
   *
   * `earnings` above only says whether a veto FIRED, so on its own it
   * cannot separate "confirmed clear" from "never found out".
   */
  nextEarningsDate: string | null | undefined;
  /**
   * Whether the options market's positioning agrees with the engine's read.
   * Null when there is no chain, or when positioning is not leaning either
   * way — both of which mean "no opinion", not "agrees".
   */
  optionsAgrees: boolean | null;
}

/**
 * How many readings get their own row.
 *
 * The full list belongs in the evidence section; a checklist people scan has
 * to stay scannable, and past five or six rows a reader stops reading rather
 * than starts.
 */
const MAX_METRIC_ROWS = 5;

const agreesWith = (m: MetricVerdict, verdict: string): CheckState =>
  m.verdict === "neutral" ? "caution" : m.verdict === verdict ? "pass" : "fail";

/**
 * Which readings earn a row, and in what order.
 *
 * `topBullish` and `topBearish` are each already ranked by weight ×
 * confidence, so the strongest-supported readings lead within a side. But
 * taking the top five from the AGREEING side alone would fill every row with
 * ticks and hide the single reading that argues against the trade — which is
 * the row a checklist exists to surface. So the two sides are interleaved:
 * whatever the cap, the opposing case is represented.
 *
 * Neutral readings fill any remaining slots as cautions. A reading that made
 * no directional claim is not evidence against the trade, but it is not
 * support either, and a setup resting on modules that are mostly abstaining
 * is a different proposition from one they back.
 */
function rowsWorthShowing(bias: MarketBias): MetricVerdict[] {
  if (bias.verdict === "neutral") return bias.metrics.slice(0, MAX_METRIC_ROWS);

  const agreeing = bias.verdict === "bearish" ? bias.topBearish : bias.topBullish;
  const opposing = bias.verdict === "bearish" ? bias.topBullish : bias.topBearish;

  const interleaved: MetricVerdict[] = [];
  for (let i = 0; i < Math.max(agreeing.length, opposing.length); i++) {
    if (agreeing[i]) interleaved.push(agreeing[i]);
    if (opposing[i]) interleaved.push(opposing[i]);
  }

  const shown = new Set(interleaved.map((m) => m.id));
  const neutrals = bias.metrics.filter((m) => m.verdict === "neutral" && !shown.has(m.id));
  return [...interleaved, ...neutrals].slice(0, MAX_METRIC_ROWS);
}

export function buildChecklist(inputs: ChecklistInputs): Checklist {
  const { bias, plan, refusal, earnings, nextEarningsDate, optionsAgrees } = inputs;
  const rows: ChecklistRow[] = [];

  // ── 1. Does the evidence line up? (see rowsWorthShowing) ──
  for (const m of rowsWorthShowing(bias)) {
    rows.push({
      /*
       * With no directional call there is nothing for a reading to agree
       * WITH, so every row is a caution rather than a tick — a page that
       * ticked readings against a verdict it never made would be inventing
       * agreement.
       */
      state: bias.verdict === "neutral" ? "caution" : agreesWith(m, bias.verdict),
      label: m.label,
      detail: m.explanation,
    });
  }

  // ── 2. Do the readings agree with EACH OTHER? ──
  const agree = agreementLevel(bias.agreement);
  rows.push({
    state: agree === "unanimous" || agree === "mostly-agree" ? "pass" : agree === "split" ? "caution" : "fail",
    label: "Readings agree with each other",
    detail:
      agree === "conflicting"
        ? `Only ${bias.agreement}% agreement — the modules are pulling against each other, which is the case where a confident-looking score is least trustworthy.`
        : `${bias.agreement}% of the weighted evidence points the same way.`,
  });

  // ── 3. Is the evidence any good? ──
  const ev = evidenceLevel(bias.confidence);
  rows.push({
    state: ev === "strong" ? "pass" : ev === "moderate" ? "caution" : "fail",
    label: "Evidence is strong enough to act on",
    detail: `Aggregate data quality across contributing readings is ${bias.confidence}% (${ev}). This measures how good the inputs are, separately from whether they agree.`,
  });

  /*
   * ── 4. Did a plan survive the expectancy gate? ─────────────────────
   *
   * The single most decision-relevant row on the page, because it is the
   * one that can say no on its own.
   */
  if (plan) {
    rows.push({
      state: plan.riskRewardRatio >= 2 ? "pass" : "caution",
      label: "Risk and reward are worth it",
      detail: `${plan.riskRewardRatio.toFixed(1)}× to the first target, measured from the real entry rather than from today's price.`,
    });
  } else {
    rows.push({
      state: "fail",
      label: "A plan survives the expectancy gate",
      detail: refusal
        ? TRADE_PLAN_REFUSAL_SHORT[refusal]
        : "No plan was produced, and no reason was recorded — treat that as a defect rather than as a verdict.",
    });
  }

  /*
   * ── 5. Is there an event inside the hold? ──
   *
   * A GREEN TICK HERE USED TO MEAN "we did not find a date", and a missing
   * date looks exactly like a clear calendar. The prose said so honestly,
   * but prose is not what a reader scans under time pressure — the tick is,
   * and the tick fed the "N of 9 checks pass" headline, so an unanswered
   * question was counted as a satisfied safeguard. On HUT, CIFR and WULF
   * that is the live case: no date is retrieved, and the row read PASS.
   *
   * The engine is right to keep building plans when the calendar is silent
   * (see earningsVeto.ts — a free keyless endpoint that fails from CI must
   * not block every equity plan). Nothing about the veto changes here. What
   * changes is that the checklist stops claiming a check it never made.
   *
   * Omitted entirely where earnings are not a concept, following the
   * options row above: a question that does not apply is not a pass.
   */
  if (nextEarningsDate !== undefined) {
    rows.push(
      earnings
        ? {
            state: "fail",
            label: "No earnings inside the holding period",
            detail: `Earnings on ${earnings.date}, ${earnings.sessions} ${earnings.sessions === 1 ? "session" : "sessions"} away. A gap jumps stops rather than trading through them, so the plan's printed risk is not the risk actually available across that date.`,
          }
        : nextEarningsDate !== null
          ? {
              state: "pass",
              label: "No earnings inside the holding period",
              detail: `Next report is ${nextEarningsDate}, outside the ${EARNINGS_VETO_SESSIONS}-session window. A date was retrieved, so this is a confirmed clear rather than an absence of information.`,
            }
          : {
              state: "caution",
              label: "Earnings date could not be confirmed",
              detail: `No earnings date came back for this symbol, so the holding period cannot be checked against one. This is an unanswered question, not a clear calendar — the plan still builds, because a calendar outage must not veto every equity, but do not read it as "no report scheduled".`,
            }
    );
  }

  // ── 6. Does an independent market agree? ──
  if (optionsAgrees !== null) {
    rows.push({
      state: optionsAgrees ? "pass" : "fail",
      label: "Options positioning agrees",
      detail: optionsAgrees
        ? "The options market is leaning the same way as the chart — a second, independently sourced read agreeing with the first."
        : "The options market is leaning the OPPOSITE way to the chart. One of the two is wrong; that is a reason to size smaller rather than to dismiss either.",
    });
  }

  const passed = rows.filter((r) => r.state === "pass").length;
  return {
    stars: plan?.stars ?? null,
    starRationale: plan?.starRationale ?? null,
    rows,
    passed,
    total: rows.length,
    summary: composeSummary(plan, rows, passed),
  };
}

/**
 * The summary never repeats the headline. When the gate refused, the card
 * already shows "no setup to rate" in the largest type on it, so saying it
 * again here wastes the one line a reader is most likely to read — that line
 * should name the blockers instead.
 */
function composeSummary(plan: TradePlan | null, rows: ChecklistRow[], passed: number): string {
  const failed = rows.filter((r) => r.state === "fail");
  const names = failed.map((f) => f.label.toLowerCase()).join(", ");

  if (failed.length === 0) {
    return plan
      ? `${passed} of ${rows.length} checks pass, none fail.`
      : `Nothing fails outright, but no plan cleared the gate — see below.`;
  }
  return `${failed.length === 1 ? "The one check that fails is" : `${failed.length} checks fail:`} ${names}.`;
}
