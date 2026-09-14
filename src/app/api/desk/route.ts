import { NextResponse } from "next/server";
import deskTriggersJson from "@/data/deskTriggers.json";
import earningsJson from "@/data/earningsCalendar.json";
import ivRvJson from "@/data/ivRvHistory.json";
import asymmetryJson from "@/data/asymmetryForward.json";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel } from "@/lib/research/barsPanel";
import { DeclaredTrigger, evaluateTrigger } from "@/lib/desk/triggers";
import { evaluateIvRvScreen } from "@/lib/research/ivRvScreen";
import { evaluateAsymmetryScreen } from "@/lib/research/asymmetryScreen";
import type { IvRvPoint } from "@/lib/research/ivRv";

/**
 * GET /api/desk — what is about to require a decision.
 *
 * The toolchain's other endpoints answer "what to buy" (the screen),
 * "should this order exist" (the auditor) and "where to sell" (exit
 * design). This one answers the operational question between them: which
 * declared level is close, which falsifier is counting, which date does
 * something change on. READ-AND-RECORD ONLY — the desk holds no keys,
 * places nothing, and every number names its source and its age.
 *
 * The refusal posture is the feature. The live triggers are on an
 * on-chain token the site currently has NO wired source for, and the
 * public dashboards for that pool have been caught wrong twice (a
 * wrong-pool fallback, and a 24h volume ~20x off the chain's own Swap
 * events). So those triggers ship with distance null and a refusal that
 * names exactly what would fill it — a pool address plus an RPC url or
 * an approved by-address source — rather than a number from a source
 * nobody vouched for. A hub that invents a price to look complete is the
 * dashboard failure this book already paid for once.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const triggers = (deskTriggersJson as { triggers: DeclaredTrigger[] }).triggers;
const earnings = earningsJson as unknown as {
  generatedAt: number | string;
  entries: { symbol: string; date: string }[];
  sweep?: { throughDate?: string; universe?: string[] };
};
const ivRv = ivRvJson as unknown as {
  generatedAt: number;
  points: IvRvPoint[];
  observationSessions: { date: string; sessionIndex: number }[];
};
const asymmetry = asymmetryJson as unknown as {
  generatedAt: number;
  observations: Parameters<typeof evaluateAsymmetryScreen>[0]["observations"];
};

export function GET() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const ageSeconds = (t: number | string) =>
    Math.max(0, Math.round((now - (typeof t === "string" ? Date.parse(t) : t)) / 1000));

  /*
   * §1 TRIGGERS. Declared levels from the committed store, each evaluated
   * against whatever reading source is wired for it. Today that is none —
   * the readings map is empty until the PONS pool address and an approved
   * source exist — so every trigger carries its refusal. The evaluation
   * machinery is live and tested; it is the readings that are blocked,
   * and the blocker is named per trigger rather than summarised away.
   */
  const readings = new Map<string, never>();
  const evaluated = triggers.map((t) => evaluateTrigger(t, readings.get(t.id) ?? null, now));

  /*
   * §2 LP ORACLE. The declaration is held; the count is honest: zero
   * readings recorded, so the three-consecutive falsifier has nothing to
   * count and says so. Position facts are carried verbatim from the
   * trading session's declaration so a future oracle scores against the
   * stored baseline rather than a remembered one.
   */
  const falsifier = triggers.find((t) => t.id === "lp-fee-yield-falsifier") ?? null;
  const lpOracle = {
    position: {
      id: "#1109566",
      pool: "PONS/WETH 0.3%",
      ticks: [77640, 87000],
      baseline: "0.0429 WETH + 190.2 PONS at PONS $0.630",
      minted: "2026-09-09T22:40:00-04:00",
      source: "trading session declaration, 2026-09-10 OUTBOX entry, restated by Mitchell 2026-09-14",
    },
    falsifier: falsifier
      ? {
          rule: falsifier.on_breach,
          level: falsifier.level,
          unit: falsifier.unit,
          consecutive_readings_required: falsifier.consecutive_readings ?? null,
          readings_recorded: 0,
          consecutive_under: 0,
          status:
            "declared, not counting: no fee-yield readings exist on this side. " +
            falsifier.source_required,
        }
      : null,
    what_a_real_oracle_needs:
      "slot0 tick + active liquidity + Swap-event volume read from the pool contract by " +
      "address. Fee yield must be per unit of ACTIVE liquidity — the TVL-based figure is " +
      "the one that misled the book for three days and it is refused here by construction.",
  };

  /*
   * §3 CALENDAR. Only dates that exist in committed artifacts, each with
   * its source and age. No macro calendar is invented: FOMC and the like
   * are not in any store this site maintains, and a hand-typed date would
   * be exactly the unsourced number this endpoint exists to refuse.
   */
  const upcomingEarnings = earnings.entries
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const ivRvSessionIndex = new Map(ivRv.observationSessions.map((o) => [o.date, o.sessionIndex]));
  const ivRvStanding = evaluateIvRvScreen(ivRv.points, (d) => ivRvSessionIndex.get(d));
  const asymmetryStanding = evaluateAsymmetryScreen(asymmetry);

  const calendar = {
    earnings: {
      upcoming: upcomingEarnings,
      known_through: earnings.sweep?.throughDate ?? null,
      universe_size: earnings.sweep?.universe?.length ?? null,
      source: "Nasdaq public calendar, nightly sweep, degrade-don't-fail",
      age_seconds: ageSeconds(earnings.generatedAt),
      note:
        "Past known_through the catalyst columns on the contracts screen go null, not false — " +
        "an absence is only a fact inside the swept window.",
    },
    gates: [
      {
        id: "ivrv-option-screen",
        question: "Was the CLSK trade a screened method or one lucky read?",
        earliest_evaluable: ivRvStanding.earliestEvaluableDate,
        gates: ivRvStanding.gates.map((g) => ({ id: g.id, have: g.have, need: g.need, met: g.met })),
        verdict: ivRvStanding.verdict,
        source: "ivRvHistory.json standing, computed at request time from the committed artifact",
        age_seconds: ageSeconds(ivRv.generatedAt),
      },
      {
        id: "asymmetry-excursion-screen",
        question: "Does the screen's asymmetry column predict forward excursion balance?",
        earliest_evaluable_in_sessions: asymmetryStanding.earliestEvaluableInSessions,
        gates: asymmetryStanding.gates.map((g) => ({ id: g.id, have: g.have, need: g.need, met: g.met })),
        verdict: asymmetryStanding.verdict,
        reading: asymmetryStanding.reading,
        source: "asymmetryForward.json standing, computed at request time from the committed artifact",
        age_seconds: ageSeconds(asymmetry.generatedAt),
      },
    ],
    panel: {
      last_session: panel.sessions[panel.sessions.length - 1] ?? null,
      age_seconds: ageSeconds(panel.generatedAt),
      note: "Every bars-derived number upstream keys off this session; if it lags, they lag with it.",
    },
  };

  return NextResponse.json({
    generated_at: new Date(now).toISOString(),
    posture:
      "Read-and-record only. Nothing here executes, and no number appears without its source " +
      "and age. A null distance with a named blocker outranks a number from an unvouched source.",
    triggers: evaluated,
    lp_oracle: lpOracle,
    calendar,
    blocked_on: [
      "PONS/WETH pool contract address — from the trading session, into the shared channel.",
      "Either DESK_RPC_URL (an RPC endpoint for the chain the pool lives on) or Mitchell's " +
        "approval of a specific public source queried BY POOL ADDRESS. Dashboards that search " +
        "by token name are disqualified by the wrong-pool record.",
    ],
  });
}
