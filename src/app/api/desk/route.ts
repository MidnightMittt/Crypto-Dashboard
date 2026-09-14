import { NextResponse } from "next/server";
import deskTriggersJson from "@/data/deskTriggers.json";
import earningsJson from "@/data/earningsCalendar.json";
import ivRvJson from "@/data/ivRvHistory.json";
import asymmetryJson from "@/data/asymmetryForward.json";
import barsPanelJson from "@/data/barsPanel.json";
import { BarsPanel } from "@/lib/research/barsPanel";
import { DeclaredTrigger, TriggerReading, evaluateTrigger } from "@/lib/desk/triggers";
import {
  EthUsdReading,
  PoolState,
  ROBINHOOD_CHAIN,
  fetchEthUsd,
  ponsUsdAtTick,
  readPoolState,
} from "@/lib/desk/poolReader";
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
 * The LP price triggers are read from the chain itself: one eth_call for
 * slot0(), by pool ADDRESS, against DESK_RPC_URL or the public Robinhood
 * Chain endpoint. No token-name search exists anywhere in this path —
 * the wrong-pool fallback is the documented dashboard failure this
 * design refuses to inherit. A transport failure renders as
 * attempted-and-failed with the error, which is a different fact from
 * unwired and is never collapsed into it.
 */

export const dynamic = "force-dynamic";

const panel = barsPanelJson as unknown as BarsPanel;
const store = deskTriggersJson as unknown as {
  triggers: DeclaredTrigger[];
  declared_events: {
    id: string;
    subject: string;
    date: string;
    date_precision: string;
    source: string;
    declared_by: string;
    why_it_matters: string;
  }[];
};
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

export async function GET() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const ageSeconds = (t: number | string) =>
    Math.max(0, Math.round((now - (typeof t === "string" ? Date.parse(t) : t)) / 1000));

  /*
   * Live reads, each failing independently. The tick needs no ETH price —
   * a Kraken outage degrades the USD convenience, never the trigger.
   */
  const rpcUrl = process.env.DESK_RPC_URL ?? ROBINHOOD_CHAIN.publicRpc;
  let pool: PoolState | null = null;
  let poolError: string | null = null;
  let ethUsd: EthUsdReading | null = null;
  let ethError: string | null = null;
  const [poolResult, ethResult] = await Promise.allSettled([
    readPoolState(rpcUrl, ROBINHOOD_CHAIN.ponsWethPool),
    fetchEthUsd(),
  ]);
  if (poolResult.status === "fulfilled") pool = poolResult.value;
  else poolError = String(poolResult.reason?.message ?? poolResult.reason);
  if (ethResult.status === "fulfilled") ethUsd = ethResult.value;
  else ethError = String(ethResult.reason?.message ?? ethResult.reason);

  /*
   * §1 TRIGGERS. Tick triggers read the live slot0; the fee-yield
   * falsifier still has no reading source (the Swap-log scan is the
   * remaining build) and keeps its named refusal.
   */
  const tickReading: TriggerReading | null = pool
    ? { value: pool.tick, source: pool.source, observed_at: pool.observedAt }
    : null;
  const evaluated = store.triggers.map((t) => {
    const base =
      t.kind === "pool_tick"
        ? pool
          ? evaluateTrigger(t, tickReading, now)
          : {
              ...evaluateTrigger(t, null, now),
              refusal:
                `Attempted and FAILED — eth_call against ${rpcUrl} raised: ${poolError}. ` +
                "The source is wired; this reading did not arrive. Retry, or set DESK_RPC_URL " +
                "to a less rate-limited endpoint.",
            }
        : evaluateTrigger(t, null, now);

    /*
     * USD beside the tick, never instead of it. Two figures, one stamped
     * assumption: what the LEVEL means in dollars at the live ETH print,
     * and what the CURRENT tick means. Both drift with ETH — which is
     * exactly why the tick is the declared form.
     */
    const usd =
      t.kind === "pool_tick" && ethUsd
        ? {
            level_usd: Math.round(ponsUsdAtTick(t.level, ethUsd.value) * 10000) / 10000,
            current_usd:
              pool === null
                ? null
                : Math.round(ponsUsdAtTick(pool.tick, ethUsd.value) * 10000) / 10000,
            eth_usd_assumed: ethUsd.value,
            eth_source: ethUsd.source,
            eth_age_seconds: ageSeconds(ethUsd.observedAt),
            note:
              "Convenience only. These dollars move with ETH; the tick does not, which is why " +
              "the tick is the declared trigger.",
          }
        : t.kind === "pool_tick"
          ? { unavailable: `ETH/USD fetch failed: ${ethError}. The tick trigger is unaffected.` }
          : null;

    return usd === null ? base : { ...base, usd_equivalent: usd };
  });

  /*
   * §2 LP ORACLE. Position state read live where one eth_call covers it;
   * fee yield still refused pending the Swap-log build, counting nothing.
   */
  const [lowerTick, upperTick] = ROBINHOOD_CHAIN.positionTicks;
  const falsifier = store.triggers.find((t) => t.id === "lp-fee-yield-falsifier") ?? null;
  const lpOracle = {
    position: {
      id: "#1109566",
      pool: `PONS/WETH 0.3% ${ROBINHOOD_CHAIN.ponsWethPool}`,
      chain_id: ROBINHOOD_CHAIN.chainId,
      ticks: [lowerTick, upperTick],
      baseline: "0.0429 WETH + 190.2 PONS at PONS $0.630",
      minted: "2026-09-09T22:40:00-04:00",
      source: "trading session declaration, 2026-09-10 OUTBOX entry, restated by Mitchell 2026-09-14",
    },
    live: pool
      ? {
          tick: pool.tick,
          in_range: pool.tick >= lowerTick && pool.tick <= upperTick,
          /* Toward the FLOOR (upper tick = lower price). 100% = at the floor. */
          pct_through_range_toward_floor:
            Math.round(((pool.tick - lowerTick) / (upperTick - lowerTick)) * 1000) / 10,
          ticks_to_floor: upperTick - pool.tick,
          active_liquidity: pool.activeLiquidity,
          pons_usd_at_live_eth:
            ethUsd === null ? null : Math.round(ponsUsdAtTick(pool.tick, ethUsd.value) * 10000) / 10000,
          source: pool.source,
          age_seconds: ageSeconds(pool.observedAt),
          not_read:
            "uncollected fees and position composition — those need the position NFT contract " +
            "and are part of the fee-yield build, not this one.",
        }
      : { failed: `eth_call against ${rpcUrl}: ${poolError}` },
    falsifier: falsifier
      ? {
          rule: falsifier.on_breach,
          level: falsifier.level,
          unit: falsifier.unit,
          consecutive_readings_required: falsifier.consecutive_readings ?? null,
          readings_recorded: 0,
          consecutive_under: 0,
          status: "declared, not counting: " + falsifier.source_required,
        }
      : null,
  };

  /*
   * §3 CALENDAR. Committed artifacts plus the DECLARED events store —
   * dated, sourced, precision-stamped. Still no invented macro dates: the
   * gas-waiver entry exists because the trading session declared it with
   * a source, not because a date was typed to fill a section.
   */
  const upcomingEarnings = earnings.entries
    .filter((e) => e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const ivRvSessionIndex = new Map(ivRv.observationSessions.map((o) => [o.date, o.sessionIndex]));
  const ivRvStanding = evaluateIvRvScreen(ivRv.points, (d) => ivRvSessionIndex.get(d));
  const asymmetryStanding = evaluateAsymmetryScreen(asymmetry);

  const declaredEvents = store.declared_events
    .map((e) => ({
      ...e,
      days_until: Math.ceil((Date.parse(`${e.date}T00:00:00Z`) - now) / 86_400_000),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const calendar = {
    declared_events: declaredEvents,
    earnings: {
      upcoming: upcomingEarnings,
      known_through: earnings.sweep?.throughDate ?? null,
      universe_size: earnings.sweep?.universe?.length ?? null,
      source: "Nasdaq public calendar, nightly sweep, degrade-don't-fail",
      age_seconds: ageSeconds(earnings.generatedAt),
      note:
        "Past known_through the catalyst columns on the contracts screen go null, not false — " +
        "an absence is only a fact inside the swept window. Non-earnings catalysts live in " +
        "declared_events above, each with its own source and precision stamp.",
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
    rpc: {
      url: rpcUrl,
      overridden: process.env.DESK_RPC_URL !== undefined,
      note:
        "Public endpoint is rate-limited (429s under load, 10k-log cap on eth_getLogs). Fine " +
        "for one slot0 read per request; the fee-yield log scan needs DESK_RPC_URL or windowing.",
    },
    triggers: evaluated,
    lp_oracle: lpOracle,
    calendar,
    blocked_on: [
      "Fee-yield readings: the Swap-log scan against active liquidity is unbuilt. The public " +
        "RPC's 10,000-log cap forces windowed scans; a DESK_RPC_URL with higher limits makes it " +
        "simpler. Until then the falsifier holds its declaration and counts nothing.",
    ],
  });
}
