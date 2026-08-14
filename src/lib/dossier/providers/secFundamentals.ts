import { lookupCik } from "./edgarInsiders";

/**
 * FUNDAMENTALS — SEC XBRL company facts, primary source.
 *
 * Every US issuer's audited numbers, straight from the filings, free. This
 * is the deepest data source on the page in the literal sense: everything
 * else describes the trading of the stock; this describes the business the
 * stock is a claim on. A chart-perfect setup on a company whose revenue is
 * shrinking and whose share count is ballooning is a different trade, and a
 * reader deserves both facts on one page.
 *
 * ── The one technical decision that matters: FRAMES ──────────────────
 *
 * XBRL facts are reported many times — a Q2 revenue figure appears in the
 * 10-Q, again as a comparative in next year's 10-Q, again in the 10-K. Naive
 * extraction double-counts. The SEC solves this itself: canonical values
 * carry a `frame` (CY2026Q1 for quarters, CY2025 for years), exactly one
 * fact per frame. Filtering on frames is what makes the series below clean
 * without any dedup heuristics of our own.
 *
 * ── What is deliberately NOT computed ─────────────────────────────────
 *
 * No fair-value model, no DCF, no "cheap/expensive" verdict. Valuation is a
 * judgement that needs a discount rate nobody can verify; growth, margin and
 * dilution are arithmetic on audited numbers. This section stays on the
 * arithmetic side of that line.
 */

/*
 * Revenue tag varies by filer — and filers MIGRATE tags over time, leaving
 * the old tag populated but stale. NVDA carries
 * RevenueFromContractWithCustomerExcludingAssessedTax ending in 2019 next to
 * a current Revenues series; picking by list order there reported 2019's
 * revenue as today's. Selection is therefore by recency: the tag whose most
 * recent quarterly frame is newest wins.
 */
const REVENUE_TAGS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];

interface XbrlFact {
  val: number;
  frame?: string;
  end?: string;
}

export interface CompanyFacts {
  facts?: {
    "us-gaap"?: Record<string, { units?: Record<string, XbrlFact[]> }>;
    dei?: Record<string, { units?: Record<string, XbrlFact[]> }>;
  };
}

/** A quarterly point, keyed by its canonical frame. */
export interface QuarterPoint {
  frame: string; // CY2026Q1
  val: number;
}

/** Canonical quarterly series for a tag, oldest-first. */
export function quarterlySeries(facts: CompanyFacts, tag: string, unit = "USD"): QuarterPoint[] {
  const entries = facts.facts?.["us-gaap"]?.[tag]?.units?.[unit] ?? [];
  return entries
    .filter((e): e is Required<Pick<XbrlFact, "frame" | "val">> & XbrlFact => !!e.frame && /^CY\d{4}Q\d$/.test(e.frame))
    .map((e) => ({ frame: e.frame, val: e.val }))
    .sort((a, b) => a.frame.localeCompare(b.frame));
}

/** Annual (full fiscal year) facts for a tag, with their period-end dates. */
interface AnnualPoint {
  val: number;
  end: string;
}

function annualSeries(facts: CompanyFacts, tag: string, unit = "USD"): AnnualPoint[] {
  const entries = facts.facts?.["us-gaap"]?.[tag]?.units?.[unit] ?? [];
  return entries
    .filter((e): e is Required<Pick<XbrlFact, "frame" | "val" | "end">> & XbrlFact => !!e.frame && /^CY\d{4}$/.test(e.frame) && !!e.end)
    .map((e) => ({ val: e.val, end: e.end }));
}

/** CY2025Q4 -> CY2026Q1; the frame algebra needed to walk quarters. */
export function nextFrame(frame: string): string {
  const year = Number(frame.slice(2, 6));
  const q = Number(frame.slice(7));
  return q === 4 ? `CY${year + 1}Q1` : `CY${year}Q${q + 1}`;
}

function prevFrame(frame: string): string {
  const year = Number(frame.slice(2, 6));
  const q = Number(frame.slice(7));
  return q === 1 ? `CY${year - 1}Q4` : `CY${year}Q${q - 1}`;
}

/**
 * Which quarterly frame a period ending at `end` belongs to. The SEC assigns
 * frames by majority overlap, so a quarter ending Jan 25 is CY-prior-Q4, not
 * Q1 of the end date's year. Stepping back to the period's midpoint (~45
 * days) before reading off the calendar quarter reproduces that assignment
 * for every real fiscal calendar.
 */
export function frameOfPeriodEnd(end: string): string {
  const mid = new Date(new Date(`${end}T00:00:00Z`).getTime() - 45 * 86_400_000);
  return `CY${mid.getUTCFullYear()}Q${Math.floor(mid.getUTCMonth() / 3) + 1}`;
}

/**
 * THE FISCAL-Q4 GAP, filled from the 10-K.
 *
 * No filer reports a 10-Q for its final fiscal quarter — that quarter exists
 * only inside the annual report, so the SEC's quarterly frames have a
 * one-quarter hole every fiscal year (AAPL is missing every CY????Q3, NVDA
 * every CY????Q4). Summing "the last four frames" across that hole quietly
 * spans five calendar quarters and is simply not a trailing twelve months.
 *
 * The missing quarter is recoverable by arithmetic on audited numbers: the
 * annual fact minus the three quarterly facts it contains. The annual's own
 * span is located from its period-end date rather than its frame label,
 * because an off-calendar fiscal year (AAPL's ends in September) straddles
 * the label year. A quarter is only filled when exactly one of the four is
 * missing — anything less determined would be guessing.
 */
export function fillFiscalGaps(quarterly: QuarterPoint[], annuals: AnnualPoint[]): QuarterPoint[] {
  const byFrame = new Map(quarterly.map((q) => [q.frame, q.val]));
  for (const annual of annuals) {
    let cursor = frameOfPeriodEnd(annual.end);
    const window: string[] = [];
    for (let i = 0; i < 4; i++) {
      window.unshift(cursor);
      cursor = prevFrame(cursor);
    }
    const missing = window.filter((f) => !byFrame.has(f));
    if (missing.length !== 1) continue;
    const presentSum = window.filter((f) => byFrame.has(f)).reduce((s, f) => s + (byFrame.get(f) ?? 0), 0);
    byFrame.set(missing[0], annual.val - presentSum);
  }
  return [...byFrame.entries()].map(([frame, val]) => ({ frame, val })).sort((a, b) => a.frame.localeCompare(b.frame));
}

/** Gap-filled quarterly series — the only shape safe to compute a TTM from. */
function completedSeries(facts: CompanyFacts, tag: string): QuarterPoint[] {
  return fillFiscalGaps(quarterlySeries(facts, tag), annualSeries(facts, tag));
}

/** Shares outstanding lives under dei, in `shares` units, with instant frames like CY2026Q2I. */
export function sharesSeries(facts: CompanyFacts): QuarterPoint[] {
  const entries = facts.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  return entries
    .filter((e): e is Required<Pick<XbrlFact, "frame" | "val">> & XbrlFact => !!e.frame && /^CY\d{4}Q\dI$/.test(e.frame))
    .map((e) => ({ frame: e.frame, val: e.val }))
    .sort((a, b) => a.frame.localeCompare(b.frame));
}

export interface FundamentalsSummary {
  /** Trailing-twelve-month revenue, and its growth vs the prior TTM window. */
  ttmRevenueUsd: number | null;
  revenueGrowthPct: number | null;
  /** Latest quarter vs the same quarter a year earlier. */
  latestQuarterYoYPct: number | null;
  /** TTM net income and margin. */
  ttmNetIncomeUsd: number | null;
  netMarginPct: number | null;
  profitable: boolean | null;
  /** Share count change over ~a year: negative = buybacks, positive = dilution. */
  shareCountChangePct: number | null;
  quartersCovered: number;
  latestFrame: string | null;
  /** The whole picture as sentences. */
  lines: string[];
}

const fmtUsd = (v: number) =>
  Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${Math.round(v).toLocaleString()}`;

/**
 * TTM = the last four quarterly points; prior TTM = the four before those.
 * The window must be four CONSECUTIVE calendar quarters — a window that
 * silently spans a gap sums something, but not a trailing twelve months, so
 * a broken window returns null rather than a wrong number.
 */
function ttm(series: QuarterPoint[], offset = 0): number | null {
  const window = series.slice(series.length - 4 - offset, series.length - offset);
  if (window.length !== 4) return null;
  for (let i = 1; i < 4; i++) {
    if (window[i].frame !== nextFrame(window[i - 1].frame)) return null;
  }
  return window.reduce((s, q) => s + q.val, 0);
}

/** The revenue tag the filer CURRENTLY reports under: newest last frame wins. */
function pickRevenueSeries(facts: CompanyFacts): QuarterPoint[] {
  let best: QuarterPoint[] = [];
  for (const tag of REVENUE_TAGS) {
    const series = completedSeries(facts, tag);
    if (series.length < 4) continue;
    if (best.length === 0 || series[series.length - 1].frame > best[best.length - 1].frame) {
      best = series;
    }
  }
  return best;
}

export function buildFundamentals(facts: CompanyFacts): FundamentalsSummary | null {
  const revenue = pickRevenueSeries(facts);
  const income = completedSeries(facts, "NetIncomeLoss");
  const shares = sharesSeries(facts);

  if (revenue.length < 4) return null;

  const ttmRev = ttm(revenue);
  const priorTtmRev = ttm(revenue, 4);
  const revenueGrowthPct =
    ttmRev !== null && priorTtmRev !== null && priorTtmRev > 0 ? ((ttmRev - priorTtmRev) / priorTtmRev) * 100 : null;

  const latest = revenue[revenue.length - 1];
  const yearAgoFrame = `CY${Number(latest.frame.slice(2, 6)) - 1}${latest.frame.slice(6)}`;
  const yearAgo = revenue.find((q) => q.frame === yearAgoFrame) ?? null;
  const latestQuarterYoYPct = yearAgo && yearAgo.val > 0 ? ((latest.val - yearAgo.val) / yearAgo.val) * 100 : null;

  const ttmNi = ttm(income);
  const netMarginPct = ttmNi !== null && ttmRev !== null && ttmRev > 0 ? (ttmNi / ttmRev) * 100 : null;
  const profitable = ttmNi !== null ? ttmNi > 0 : null;

  let shareCountChangePct: number | null = null;
  if (shares.length >= 2) {
    const latestShares = shares[shares.length - 1];
    // The instant nearest four quarters back; fall back to earliest available.
    const target = shares.length >= 5 ? shares[shares.length - 5] : shares[0];
    if (target.val > 0) shareCountChangePct = ((latestShares.val - target.val) / target.val) * 100;
  }

  const lines: string[] = [];
  if (ttmRev !== null) {
    lines.push(
      revenueGrowthPct !== null
        ? `Revenue over the last four reported quarters was ${fmtUsd(ttmRev)}, ${
            revenueGrowthPct >= 0 ? "up" : "down"
          } ${Math.abs(revenueGrowthPct).toFixed(0)}% on the year before${
            latestQuarterYoYPct !== null
              ? ` — and the most recent quarter ${latestQuarterYoYPct >= 0 ? "grew" : "shrank"} ${Math.abs(latestQuarterYoYPct).toFixed(0)}% year over year, so the trend is ${
                  revenueGrowthPct >= 0 === (latestQuarterYoYPct >= revenueGrowthPct) ? "holding or accelerating" : "decelerating"
                }.`
              : "."
          }`
        : `Revenue over the last four reported quarters was ${fmtUsd(ttmRev)}; not enough prior history to state a growth rate.`
    );
  }
  if (profitable !== null && ttmNi !== null) {
    lines.push(
      profitable
        ? `The business is profitable: ${fmtUsd(ttmNi)} of net income over the same period${netMarginPct !== null ? `, a ${netMarginPct.toFixed(0)}% net margin — of every dollar of sales, about ${Math.max(0, Math.round(netMarginPct))} cents reach the bottom line` : ""}.`
        : `The business is NOT currently profitable: ${fmtUsd(ttmNi)} over the last four quarters. A setup here is a trade on the stock, not a claim the company earns money yet.`
    );
  }
  if (shareCountChangePct !== null) {
    lines.push(
      shareCountChangePct <= -0.5
        ? `The share count fell ${Math.abs(shareCountChangePct).toFixed(1)}% over the past year — the company is buying back its own stock, which concentrates each remaining share's claim.`
        : shareCountChangePct >= 2
          ? `The share count GREW ${shareCountChangePct.toFixed(1)}% over the past year — existing holders are being diluted, and price has to climb that hill before a holder makes anything.`
          : `The share count is roughly stable (${shareCountChangePct >= 0 ? "+" : ""}${shareCountChangePct.toFixed(1)}% over the past year).`
    );
  }

  return {
    ttmRevenueUsd: ttmRev,
    revenueGrowthPct,
    latestQuarterYoYPct,
    ttmNetIncomeUsd: ttmNi,
    netMarginPct,
    profitable,
    shareCountChangePct,
    quartersCovered: revenue.length,
    latestFrame: latest.frame,
    lines,
  };
}

// ── Fetch layer ─────────────────────────────────────────────────────────

const SEC_UA = { "User-Agent": "leverage-terminal research msiburg@alumni.berklee.edu", Accept: "application/json" };

export type FundamentalsResult = { ok: true; summary: FundamentalsSummary } | { ok: false; reason: string };

export async function fetchFundamentals(symbol: string): Promise<FundamentalsResult> {
  try {
    const cik = await lookupCik(symbol);
    if (!cik) {
      return { ok: false, reason: `${symbol} is not in the SEC's company register — ETFs and foreign listings without US filings have no XBRL facts.` };
    }
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: SEC_UA,
      next: { revalidate: 43_200 }, // filings arrive quarterly; half a day is generous
    });
    if (!res.ok) return { ok: false, reason: `EDGAR returned HTTP ${res.status} for ${symbol}'s company facts.` };

    const summary = buildFundamentals((await res.json()) as CompanyFacts);
    if (!summary) {
      return { ok: false, reason: `${symbol} files with the SEC, but fewer than four canonical quarterly revenue points exist — common for recent IPOs and for filers using non-standard revenue tags.` };
    }
    return { ok: true, summary };
  } catch (err) {
    return { ok: false, reason: `EDGAR company facts could not be reached (${err instanceof Error ? err.message : "unknown"}).` };
  }
}
