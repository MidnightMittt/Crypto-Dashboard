import { DeribitOptionsSummary } from "@/types/market";
import { DeribitOptionRow } from "../providers/deribitOptions";

/**
 * Turns Deribit's flat list of option rows into a put/call ratio, max pain,
 * and OI summary for one asset.
 *
 * Split from the fetch layer for the same reason every other derived signal
 * in sentiment/ is: pure computation, testable against fixed input, no
 * network dependency.
 */

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

interface ParsedInstrument {
  strike: number;
  type: "call" | "put";
  /** ISO date (YYYY-MM-DD). */
  expiry: string;
  /** For chronological sorting — midnight UTC of the expiry date. */
  expiryMs: number;
}

/**
 * Parses Deribit's "BTC-25DEC26-20000-P" naming convention. Day is 1-2
 * digits (Deribit doesn't zero-pad single-digit days, e.g. "2AUG26"), month
 * is a 3-letter abbreviation, year is 2 digits (assumed 20XX — Deribit has
 * no listings from last century to disambiguate against).
 *
 * Returns null for anything that doesn't match, rather than throwing — a
 * single malformed or unexpected instrument name (Deribit occasionally
 * lists non-standard structures) shouldn't take down the whole summary.
 */
export function parseInstrumentName(name: string): ParsedInstrument | null {
  const parts = name.split("-");
  if (parts.length !== 4) return null;

  const [, expiryRaw, strikeRaw, typeChar] = parts;

  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(expiryRaw);
  if (!match) return null;
  const [, dayStr, monthStr, yearStr] = match;
  const month = MONTHS[monthStr];
  if (!month) return null;
  const day = Number(dayStr);
  const year = 2000 + Number(yearStr);
  const expiryMs = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(expiryMs)) return null;

  const strike = Number(strikeRaw);
  if (!Number.isFinite(strike) || strike <= 0) return null;

  const type = typeChar === "C" ? "call" : typeChar === "P" ? "put" : null;
  if (!type) return null;

  const expiry = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { strike, type, expiry, expiryMs };
}

interface EnrichedRow extends DeribitOptionRow {
  parsed: ParsedInstrument;
}

/**
 * Nearest expiry with at least `minOiContracts` total open interest across
 * both calls and puts. Skipping past a "nearest" expiry with negligible OI
 * matters because Deribit lists an expiry the moment it opens for trading,
 * often with near-zero interest for days — max pain computed from a couple
 * of stray contracts is noise, not a signal.
 */
function pickExpiry(rows: EnrichedRow[], minOiContracts: number): string | null {
  const byExpiry = new Map<string, { totalOi: number; expiryMs: number }>();
  for (const r of rows) {
    const existing = byExpiry.get(r.parsed.expiry);
    if (existing) {
      existing.totalOi += r.openInterest;
    } else {
      byExpiry.set(r.parsed.expiry, { totalOi: r.openInterest, expiryMs: r.parsed.expiryMs });
    }
  }

  const candidates = [...byExpiry.entries()]
    .filter(([, v]) => v.totalOi >= minOiContracts)
    .sort((a, b) => a[1].expiryMs - b[1].expiryMs);

  return candidates[0]?.[0] ?? null;
}

/** Put OI / call OI for the rows already filtered to one expiry. */
function computePutCallRatio(expiryRows: EnrichedRow[]): number {
  const putOi = expiryRows.filter((r) => r.parsed.type === "put").reduce((s, r) => s + r.openInterest, 0);
  const callOi = expiryRows.filter((r) => r.parsed.type === "call").reduce((s, r) => s + r.openInterest, 0);
  return callOi > 0 ? putOi / callOi : putOi > 0 ? Infinity : 0;
}

/**
 * The strike at which option WRITERS collectively lose the least (an
 * equivalent way to state the standard "max pain" definition) if the
 * underlying settled there at expiry.
 *
 * Candidate settlement prices are every strike listed for this expiry —
 * the standard approach, since max pain can only meaningfully land on a
 * price where OI is actually concentrated. Returns null only when there
 * are no strikes to evaluate (shouldn't happen once callers already
 * checked minOiContracts, but stays honest about the edge case).
 */
function computeMaxPain(expiryRows: EnrichedRow[]): number | null {
  const strikes = [...new Set(expiryRows.map((r) => r.parsed.strike))];
  if (strikes.length === 0) return null;

  let best: { strike: number; payout: number } | null = null;

  for (const candidate of strikes) {
    let payout = 0;
    for (const r of expiryRows) {
      if (r.parsed.type === "call" && candidate > r.parsed.strike) {
        payout += (candidate - r.parsed.strike) * r.openInterest;
      } else if (r.parsed.type === "put" && candidate < r.parsed.strike) {
        payout += (r.parsed.strike - candidate) * r.openInterest;
      }
    }
    if (!best || payout < best.payout) best = { strike: candidate, payout };
  }

  return best?.strike ?? null;
}

/** ATM IV: the mark IV of whichever listed strike sits closest to the underlying price. */
function computeAtmIv(expiryRows: EnrichedRow[], underlyingPrice: number): number | null {
  const withIv = expiryRows.filter((r) => r.markIv > 0);
  if (withIv.length === 0) return null;

  const closest = withIv.reduce((best, r) =>
    Math.abs(r.parsed.strike - underlyingPrice) < Math.abs(best.parsed.strike - underlyingPrice) ? r : best
  );
  return closest.markIv;
}

/**
 * Minimum total OI (contracts) an expiry needs before its put/call ratio
 * and max pain are treated as meaningful rather than noise from a
 * freshly-listed, barely-traded expiry.
 */
const MIN_EXPIRY_OI_CONTRACTS = 50;

export function summarizeDeribitOptions(
  asset: "BTC" | "ETH",
  rows: DeribitOptionRow[],
  now: number
): DeribitOptionsSummary | null {
  if (rows.length === 0) return null;

  const enriched: EnrichedRow[] = rows
    .map((r) => {
      const parsed = parseInstrumentName(r.instrumentName);
      return parsed ? { ...r, parsed } : null;
    })
    .filter((r): r is EnrichedRow => r !== null);

  if (enriched.length === 0) return null;

  const expiry = pickExpiry(enriched, MIN_EXPIRY_OI_CONTRACTS);
  if (!expiry) return null;

  const expiryRows = enriched.filter((r) => r.parsed.expiry === expiry);
  const underlyingPrice = expiryRows[0].underlyingPrice;

  const maxPain = computeMaxPain(expiryRows);
  if (maxPain === null) return null;

  const totalOpenInterestContracts = enriched.reduce((s, r) => s + r.openInterest, 0);

  return {
    asset,
    expiry,
    putCallRatio: computePutCallRatio(expiryRows),
    maxPain,
    atmIvPct: computeAtmIv(expiryRows, underlyingPrice),
    totalOpenInterestContracts,
    totalOpenInterestUsd: totalOpenInterestContracts * underlyingPrice,
    updatedAt: now,
  };
}
