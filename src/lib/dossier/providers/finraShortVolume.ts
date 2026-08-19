/**
 * DAILY SHORT-SALE VOLUME — FINRA Reg SHO files, keyless.
 *
 * FINRA publishes, every trading day, the share volume that printed as a
 * short sale on its facilities, per symbol. That is NOT the same thing as
 * short interest — and the difference matters enough to put in the module
 * doc and the payload both:
 *
 *   SHORT VOLUME   today's flow: what fraction of today's trading was
 *                  short sales. High readings are routine (market makers
 *                  short to fill buys), so the LEVEL means little; the
 *                  CHANGE against the symbol's own norm is the read.
 *   SHORT INTEREST the standing stock: how many shares are held short.
 *                  Published twice a month, and the input to squeeze math.
 *
 * This module ships the daily flow because it is free and current. The
 * bi-monthly stock is the named upgrade, not a substitute.
 */


import { midRankPercentilePct } from "@/lib/stats/midRankPercentile";
export interface ShortVolumeDay {
  date: string; // YYYYMMDD as published
  shortVolume: number;
  totalVolume: number;
  shortRatioPct: number;
}

/**
 * One pipe-delimited row: Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market.
 * Exempt volume is included in ShortVolume per FINRA's own file spec.
 */
export function parseShortVolumeRow(line: string): ShortVolumeDay | null {
  const parts = line.trim().split("|");
  if (parts.length < 5) return null;
  const [date, , shortRaw, , totalRaw] = parts;
  const shortVolume = Number(shortRaw);
  const totalVolume = Number(totalRaw);
  if (!/^\d{8}$/.test(date) || !Number.isFinite(shortVolume) || !Number.isFinite(totalVolume) || totalVolume <= 0) {
    return null;
  }
  return {
    date,
    shortVolume,
    totalVolume,
    shortRatioPct: (shortVolume / totalVolume) * 100,
  };
}

/**
 * THE BASELINE — today against this symbol's own recent norm.
 *
 * A short-volume LEVEL is nearly meaningless: 40% of volume printing short
 * is routine for one symbol and extraordinary for another, because market-
 * maker hedging differs by name. The informative statement is positional —
 * "higher than N of the last M sessions" — which is the same discipline
 * every percentile band in the equity evidence already applies: unusual FOR
 * THIS SERIES, never against a number someone picked.
 */
export interface ShortVolumeBaseline {
  /** Prior sessions the comparison is against (excludes today). */
  sessions: number;
  /** Mid-rank percentile of today's ratio among those sessions, 0-100. */
  percentile: number;
  /** Mean ratio over the prior sessions, for the "vs typical" phrasing. */
  typicalRatioPct: number;
  /** The read as a sentence, with n attached. */
  signalLine: string;
}

export interface ShortVolumeSummary {
  latest: ShortVolumeDay;
  /** Null when too few prior sessions could be fetched to compare against. */
  baseline: ShortVolumeBaseline | null;
  /** The distinction, carried with the data. */
  meaningNote: string;
}

/** Below this many prior sessions a percentile is noise dressed as a signal. */
export const MIN_BASELINE_SESSIONS = 8;

/**
 * Where today sits among the prior sessions. Mid-rank on ties — the same
 * convention `percentileOf` in equityEvidence uses, and for the same reason:
 * a value that ties everything must read as the middle, not as an extreme.
 */
export function baselineShortRatio(today: ShortVolumeDay, prior: ShortVolumeDay[]): ShortVolumeBaseline | null {
  if (prior.length < MIN_BASELINE_SESSIONS) return null;

  /*
   * EIGHT sessions is this read's own sufficiency bar, deliberately lower
   * than the sixty a directional equity band demands: "heavier than usual for
   * this name" is informative long before a tradeable band would be. The
   * arithmetic is shared, the threshold is not — see midRankPercentile.
   */
  const percentile = midRankPercentilePct(
    today.shortRatioPct,
    prior.map((d) => d.shortRatioPct)
  )!;
  const typical = prior.reduce((s, d) => s + d.shortRatioPct, 0) / prior.length;

  const stance =
    percentile >= 80
      ? `unusually heavy for this name — higher than ${percentile}% of its last ${prior.length} sessions`
      : percentile <= 20
        ? `unusually light for this name — lower than ${100 - percentile}% of its last ${prior.length} sessions`
        : `ordinary for this name — around the middle of its last ${prior.length} sessions`;

  return {
    sessions: prior.length,
    percentile,
    typicalRatioPct: typical,
    signalLine: `Today's short-sale share (${today.shortRatioPct.toFixed(0)}%) is ${stance} (typical: ${typical.toFixed(0)}%).`,
  };
}

export type ShortVolumeResult = { ok: true; summary: ShortVolumeSummary } | { ok: false; reason: string };

/**
 * Calendar days scanned for the baseline. ~26 calendar days holds roughly 18
 * trading sessions; the baseline uses the most recent 12 prior sessions.
 * The daily files are per-DATE, not per-symbol, so the fetch cache shares
 * them across every ticker searched in the hour — the second symbol's
 * baseline costs no upstream traffic at all.
 */
const CALENDAR_LOOKBACK_DAYS = 26;
const MAX_PRIOR_SESSIONS = 12;

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** One day's file -> this symbol's row, or null when unpublished/absent. */
async function fetchDayRow(date: string, symbol: string): Promise<ShortVolumeDay | null> {
  try {
    const res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${date}.txt`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3_600 },
    });
    if (!res.ok) return null; // holiday, or not yet published
    const text = await res.text();
    const line = text.split("\n").find((l) => l.split("|")[1] === symbol);
    return line ? parseShortVolumeRow(line) : null;
  } catch {
    return null; // one bad day costs one observation, never the section
  }
}

export async function fetchShortVolume(symbol: string): Promise<ShortVolumeResult> {
  try {
    const candidates: string[] = [];
    for (let back = 0; back <= CALENDAR_LOOKBACK_DAYS; back++) {
      const d = new Date(Date.now() - back * 86_400_000);
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) candidates.push(yyyymmdd(d));
    }

    // All days in one parallel round trip; the CDN serves static files and
    // the fetch cache absorbs repeats within the hour.
    const rows = (await Promise.all(candidates.map((date) => fetchDayRow(date, symbol))))
      .filter((r): r is ShortVolumeDay => r !== null)
      .sort((a, b) => b.date.localeCompare(a.date));

    if (rows.length === 0) {
      return {
        ok: false,
        reason: `No FINRA short-volume rows exist for ${symbol} over the last ${CALENDAR_LOOKBACK_DAYS} days — it may trade too thinly to appear in the consolidated file, or under a different symbol.`,
      };
    }

    const [latest, ...history] = rows;
    return {
      ok: true,
      summary: {
        latest,
        baseline: baselineShortRatio(latest, history.slice(0, MAX_PRIOR_SESSIONS)),
        meaningNote:
          "This is DAILY short-sale volume — the share of the day's trading that printed as a short sale — not short interest, the standing count of shares held short. High single-day readings are routine because market makers short to fill buy orders, which is why the read above is positional against this symbol's own recent sessions rather than an absolute threshold.",
      },
    };
  } catch (err) {
    return { ok: false, reason: `FINRA could not be reached this request (${err instanceof Error ? err.message : "unknown"}).` };
  }
}
