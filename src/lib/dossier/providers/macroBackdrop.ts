/**
 * THE MACRO BACKDROP — volatility, rates, the dollar and credit, as four
 * plain sentences.
 *
 * This fulfils the upgrade the macro section has carried since it shipped:
 * "deepens when dollar, interest-rate and credit-spread reads are ingested
 * as per-ticker context." All four series come through the same Yahoo chart
 * endpoint the price history already uses — no new vendor, no key.
 *
 * ── The phrasing discipline ───────────────────────────────────────────
 *
 * Each line states a LEVEL, a one-month DIRECTION, and the conventional
 * mechanism in "tends to" language. The mechanisms (rising yields pressure
 * long-duration equities; a weakening dollar supports risk assets) are
 * well-worn regularities, not laws, and none of them has a measured record
 * on this platform — so they are context sentences, they do not vote, and
 * the section's tier does not rise for having them. Validated is earned by
 * forward records, not by more inputs.
 */

import { Bar } from "@/lib/research/types";

/** One-month lookback in sessions, matching the rotation board's short horizon. */
const CHANGE_SESSIONS = 21;

export interface MacroSeries {
  vix: number[] | null;
  tnx: number[] | null; // 10Y yield, in percent (Yahoo quotes ^TNX as yield*1... actually yield in %)
  dxy: number[] | null;
  hyg: number[] | null;
  tlt: number[] | null;
}

export interface BackdropRead {
  lines: string[];
  /** For the panel's subtitle. */
  asOfNote: string;
}

function changeOver(series: number[], sessions: number): number | null {
  if (series.length < sessions + 1) return null;
  const then = series[series.length - 1 - sessions];
  return then !== 0 ? series[series.length - 1] - then : null;
}

/** Pure composer, so every branch is testable with hand series. */
export function composeBackdrop(s: MacroSeries): BackdropRead | null {
  const lines: string[] = [];

  if (s.vix && s.vix.length > CHANGE_SESSIONS) {
    const level = s.vix[s.vix.length - 1];
    const delta = changeOver(s.vix, CHANGE_SESSIONS)!;
    const state = level < 15 ? "calm" : level < 22 ? "ordinary" : level < 30 ? "stressed" : "panicked";
    lines.push(
      `Market fear (VIX) is at ${level.toFixed(1)} — a ${state} tape, ${
        Math.abs(delta) < 1 ? "little changed" : delta > 0 ? `up ${delta.toFixed(1)} points` : `down ${Math.abs(delta).toFixed(1)} points`
      } over a month. ${
        level < 15
          ? "Calm markets reward trend-following and punish paying up for protection."
          : level >= 30
            ? "Stressed markets break technical levels that hold in calm ones — size smaller than the chart alone suggests."
            : ""
      }`.trim()
    );
  }

  if (s.tnx && s.tnx.length > CHANGE_SESSIONS) {
    const level = s.tnx[s.tnx.length - 1];
    const deltaBps = changeOver(s.tnx, CHANGE_SESSIONS)! * 100;
    lines.push(
      `The 10-year Treasury yields ${level.toFixed(2)}%, ${
        Math.abs(deltaBps) < 5 ? "little changed" : `${deltaBps > 0 ? "up" : "down"} ${Math.abs(deltaBps).toFixed(0)} basis points`
      } over a month. ${
        deltaBps >= 15
          ? "Rising yields tend to pressure growth stocks hardest — their earnings sit furthest in the future."
          : deltaBps <= -15
            ? "Falling yields tend to support long-duration assets — growth stocks and gold benefit first."
            : ""
      }`.trim()
    );
  }

  if (s.dxy && s.dxy.length > CHANGE_SESSIONS) {
    const level = s.dxy[s.dxy.length - 1];
    const deltaPct = (changeOver(s.dxy, CHANGE_SESSIONS)! / s.dxy[s.dxy.length - 1 - CHANGE_SESSIONS]) * 100;
    lines.push(
      `The dollar index sits at ${level.toFixed(1)}, ${
        Math.abs(deltaPct) < 0.5 ? "flat" : `${deltaPct > 0 ? "up" : "down"} ${Math.abs(deltaPct).toFixed(1)}%`
      } over a month. ${
        deltaPct <= -1
          ? "A weakening dollar tends to be a tailwind for commodities, crypto and multinationals' earnings."
          : deltaPct >= 1
            ? "A strengthening dollar tends to be a headwind for commodities, crypto and overseas earnings."
            : ""
      }`.trim()
    );
  }

  if (s.hyg && s.tlt && s.hyg.length > CHANGE_SESSIONS && s.tlt.length > CHANGE_SESSIONS) {
    // Junk vs Treasuries: the market's own price on default risk. The ratio
    // rising means credit is BID — investors are paid to take risk and taking it.
    const ratioNow = s.hyg[s.hyg.length - 1] / s.tlt[s.tlt.length - 1];
    const ratioThen = s.hyg[s.hyg.length - 1 - CHANGE_SESSIONS] / s.tlt[s.tlt.length - 1 - CHANGE_SESSIONS];
    const deltaPct = ((ratioNow - ratioThen) / ratioThen) * 100;
    lines.push(
      `Credit appetite (junk bonds versus Treasuries) is ${
        Math.abs(deltaPct) < 0.5 ? "steady" : deltaPct > 0 ? `improving (+${deltaPct.toFixed(1)}% over a month)` : `deteriorating (${deltaPct.toFixed(1)}% over a month)`
      } — ${
        deltaPct > 0.5
          ? "credit investors are reaching for risk, which usually accompanies a healthy equity tape."
          : deltaPct < -0.5
            ? "credit is backing away from risk, and credit usually smells trouble before equities do."
            : "no message either way from the bond market right now."
      }`
    );
  }

  if (lines.length === 0) return null;
  return {
    lines,
    asOfNote: `levels and one-month changes, ${new Date().toISOString().slice(0, 10)}`,
  };
}

// ── Fetch layer ─────────────────────────────────────────────────────────

async function fetchCloses(symbol: string): Promise<number[] | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 3_600 } }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: { result?: Array<{ indicators?: { quote?: Array<{ close?: (number | null)[] }> } }> | null };
    };
    const closes = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter((c): c is number => c != null);
    return closes && closes.length > 0 ? closes : null;
  } catch {
    return null;
  }
}

export async function fetchBackdrop(): Promise<BackdropRead | null> {
  const [vix, tnx, dxy, hyg, tlt] = await Promise.all([
    fetchCloses("^VIX"),
    fetchCloses("^TNX"),
    fetchCloses("DX-Y.NYB"),
    fetchCloses("HYG"),
    fetchCloses("TLT"),
  ]);
  return composeBackdrop({ vix, tnx, dxy, hyg, tlt });
}
