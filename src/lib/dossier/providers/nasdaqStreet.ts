/**
 * THE WALL STREET VIEW — Nasdaq's public quote APIs, keyless.
 *
 * Analyst consensus, price targets, earnings-surprise history, and the
 * size/liquidity snapshot. All of it is REPORTED opinion and reported
 * mechanics, not measurement of ours — which sets both the depth tier
 * (basic) and the caveat this module refuses to drop:
 *
 *   Analyst targets herd and lag. Consensus lives above the price most of
 *   the time in most markets, upgrades cluster AFTER moves, and the mean
 *   target is best read as sentiment among professionals, not a forecast
 *   with a record. The payload says so; the panel prints it.
 *
 * The quietly important piece here is the EARNINGS DATE. The platform's
 * earnings veto previously ran off a calendar covering only the tracked
 * universe, so a searched ticker could carry a plan straight across its own
 * report undetected. The date fetched here is merged into that same
 * calendar upstream, so the ONE existing earningsVeto function fires for
 * any searched symbol — same function, same rules, absence still never
 * vetoes.
 */

const NASDAQ_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

const REVALIDATE = 21_600; // consensus moves on a days scale

async function nasdaqJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.nasdaq.com/api/${path}`, {
      headers: NASDAQ_HEADERS,
      next: { revalidate: REVALIDATE },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── Pure pieces, testable without HTTP ──────────────────────────────────

export interface ConsensusView {
  analysts: number;
  meanRating: string;
  buy: number;
  hold: number;
  sell: number;
  targetPrice: number;
  lowTarget: number;
  highTarget: number;
  /** Implied move to the mean target from the supplied price, percent. */
  impliedMovePct: number;
}

export function buildConsensus(
  ratings: { meanRatingType?: string; ratingsSummary?: string } | null,
  target: { consensusOverview?: { priceTarget?: number; lowPriceTarget?: number; highPriceTarget?: number; buy?: number; hold?: number; sell?: number } } | null,
  currentPrice: number
): ConsensusView | null {
  const o = target?.consensusOverview;
  if (!o || typeof o.priceTarget !== "number" || o.priceTarget <= 0 || currentPrice <= 0) return null;

  const buy = o.buy ?? 0;
  const hold = o.hold ?? 0;
  const sell = o.sell ?? 0;
  const analysts =
    Number(ratings?.ratingsSummary?.match(/(\d+)\s+analysts/)?.[1] ?? NaN) || buy + hold + sell;

  return {
    analysts,
    meanRating: ratings?.meanRatingType ?? "unrated",
    buy,
    hold,
    sell,
    targetPrice: o.priceTarget,
    lowTarget: o.lowPriceTarget ?? o.priceTarget,
    highTarget: o.highPriceTarget ?? o.priceTarget,
    impliedMovePct: ((o.priceTarget - currentPrice) / currentPrice) * 100,
  };
}

export interface SurpriseHistory {
  quarters: number;
  beats: number;
  line: string;
}

/** Count beats among reported quarters — actual above consensus. */
export function buildSurpriseHistory(
  eps: Array<{ period?: string; consensus?: number | null; earnings?: number | null }> | null
): SurpriseHistory | null {
  const reported = (eps ?? []).filter(
    (q) => typeof q.consensus === "number" && typeof q.earnings === "number"
  ) as Array<{ period?: string; consensus: number; earnings: number }>;
  if (reported.length === 0) return null;

  const beats = reported.filter((q) => q.earnings > q.consensus).length;
  return {
    quarters: reported.length,
    beats,
    line: `Beat the analyst earnings estimate in ${beats} of the last ${reported.length} reported quarter${reported.length === 1 ? "" : "s"}.`,
  };
}

/** "Oct 28, 2025" out of Nasdaq's announcement sentence -> ISO date. */
export function parseEarningsAnnouncement(announcement: string | null | undefined): string | null {
  const m = announcement?.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${m[3]} 12:00:00 UTC`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/** Nasdaq formats numbers as display strings ("$584.73", "29,205,102"). */
export function parseDisplayNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface StreetSummary {
  consensus: ConsensusView | null;
  surprises: SurpriseHistory | null;
  marketCapUsd: number | null;
  averageVolume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  /** Where price sits in its 52-week range, 0-100. */
  rangePositionPct: number | null;
  sector: string | null;
  nextEarningsDate: string | null;
  herdingCaveat: string;
  lines: string[];
}

export function composeStreetLines(s: Omit<StreetSummary, "lines">): string[] {
  const lines: string[] = [];

  if (s.consensus) {
    const c = s.consensus;
    lines.push(
      `${c.analysts} analysts average "${c.meanRating}" (${c.buy} buy · ${c.hold} hold · ${c.sell} sell). Their mean price target of $${c.targetPrice.toFixed(2)} sits ${Math.abs(c.impliedMovePct).toFixed(0)}% ${c.impliedMovePct >= 0 ? "above" : "BELOW"} the current price, with individual targets running $${c.lowTarget.toFixed(0)}–$${c.highTarget.toFixed(0)}.`
    );
  }
  if (s.surprises) lines.push(s.surprises.line);
  if (s.marketCapUsd !== null && s.averageVolume !== null) {
    const size =
      s.marketCapUsd >= 200e9 ? "mega-cap" : s.marketCapUsd >= 10e9 ? "large-cap" : s.marketCapUsd >= 2e9 ? "mid-cap" : "small-cap";
    lines.push(
      `A ${size} ($${(s.marketCapUsd / 1e9).toFixed(0)}B) trading about ${(s.averageVolume / 1e6).toFixed(1)}M shares a day${
        s.rangePositionPct !== null
          ? `, currently ${s.rangePositionPct.toFixed(0)}% of the way up its 52-week range`
          : ""
      }.`
    );
  }
  if (s.nextEarningsDate) lines.push(`Next earnings report: ${s.nextEarningsDate} — the trade-plan engine refuses plans within three sessions of it.`);
  return lines;
}

// ── Fetch layer ─────────────────────────────────────────────────────────

export type StreetResult = { ok: true; summary: StreetSummary } | { ok: false; reason: string };

interface RatingsResponse { data?: { meanRatingType?: string; ratingsSummary?: string } }
interface TargetResponse { data?: { consensusOverview?: { priceTarget?: number; lowPriceTarget?: number; highPriceTarget?: number; buy?: number; hold?: number; sell?: number } } }
interface EpsResponse { data?: { earningsPerShare?: Array<{ period?: string; consensus?: number | null; earnings?: number | null }> } }
interface SummaryResponse { data?: { summaryData?: Record<string, { value?: string }> } }
interface EarningsDateResponse { data?: { announcement?: string } }

export async function fetchStreet(symbol: string, currentPrice: number): Promise<StreetResult> {
  const [ratings, target, eps, summary, earnings] = await Promise.all([
    nasdaqJson<RatingsResponse>(`analyst/${symbol}/ratings`),
    nasdaqJson<TargetResponse>(`analyst/${symbol}/targetprice`),
    nasdaqJson<EpsResponse>(`quote/${symbol}/eps`),
    nasdaqJson<SummaryResponse>(`quote/${symbol}/summary?assetclass=stocks`),
    nasdaqJson<EarningsDateResponse>(`analyst/${symbol}/earnings-date`),
  ]);

  if (!ratings && !target && !eps && !summary) {
    return { ok: false, reason: `Nasdaq's quote APIs returned nothing for ${symbol} — no analyst coverage data is available.` };
  }

  const sd = summary?.data?.summaryData ?? {};
  const range = sd.FiftTwoWeekHighLow?.value?.match(/\$?([\d,.]+)\/\$?([\d,.]+)/);
  const high = range ? parseDisplayNumber(range[1]) : null;
  const low = range ? parseDisplayNumber(range[2]) : null;
  const rangePositionPct =
    high !== null && low !== null && high > low && currentPrice > 0
      ? Math.min(100, Math.max(0, ((currentPrice - low) / (high - low)) * 100))
      : null;

  const base: Omit<StreetSummary, "lines"> = {
    consensus: buildConsensus(ratings?.data ?? null, target?.data ?? null, currentPrice),
    surprises: buildSurpriseHistory(eps?.data?.earningsPerShare ?? null),
    marketCapUsd: parseDisplayNumber(sd.MarketCap?.value),
    averageVolume: parseDisplayNumber(sd.AverageVolume?.value),
    fiftyTwoWeekHigh: high,
    fiftyTwoWeekLow: low,
    rangePositionPct,
    sector: sd.Sector?.value ?? null,
    nextEarningsDate: parseEarningsAnnouncement(earnings?.data?.announcement),
    herdingCaveat:
      "Analyst targets herd and lag: the consensus sits above the market most of the time, and upgrades cluster after moves rather than before them. Read this as professional sentiment, not as a forecast with a track record.",
  };

  const lines = composeStreetLines(base);
  if (lines.length === 0) {
    return { ok: false, reason: `Nasdaq responded for ${symbol} but every field needed for a readable summary was empty.` };
  }
  return { ok: true, summary: { ...base, lines } };
}
