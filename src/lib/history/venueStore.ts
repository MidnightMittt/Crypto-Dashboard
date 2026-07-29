import fs from "fs/promises";
import path from "path";
import { AssetSymbol, ExchangeSnapshot, FundingPoint } from "@/types/market";
import { kvConfigured, kvGet, kvSet } from "../store/kv";

/**
 * Per-venue history store.
 *
 * Most of our sources (CoinGecko especially) publish only a current
 * snapshot — no funding history, no 24h OI delta. That left every exchange
 * card showing "No funding history published" and "—" for OI change.
 *
 * Rather than depend on upstreams that don't offer it, we record each
 * venue's funding rate and open interest on every poll and derive the
 * sparkline, funding history, and 24h OI change from our own observations.
 *
 * Same tradeoff as the aggregate store: nothing on first run, useful within
 * an hour, fully populated after a day. Upstream-provided history always
 * wins when present — this only fills gaps.
 *
 * Storage: Redis when configured, else .data/venues/<asset>.json. Same
 * reasoning as history/store.ts — the filesystem does not survive on
 * serverless, so per-venue sparklines and 24h OI deltas never accumulated
 * in production. See lib/store/kv.ts.
 */

interface VenuePoint {
  t: number;
  fundingRatePct: number;
  openInterestUsd: number;
}

type VenueHistory = Record<string, VenuePoint[]>;

const DATA_DIR = path.join(process.cwd(), ".data", "venues");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days per venue
const MIN_GAP_MS = 5 * 60 * 1000;
const MAX_POINTS = 2016; // 7d at 5-min spacing

function fileFor(asset: AssetSymbol | "MARKET"): string {
  return path.join(DATA_DIR, `${asset}.json`);
}

function kvKey(asset: AssetSymbol | "MARKET"): string {
  return `venue-history:${asset}`;
}

async function read(asset: AssetSymbol | "MARKET"): Promise<VenueHistory> {
  if (kvConfigured()) {
    const stored = await kvGet<VenueHistory>(kvKey(asset));
    return stored && typeof stored === "object" ? stored : {};
  }

  try {
    const raw = await fs.readFile(fileFor(asset), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Append a point per venue (throttled), then return the updated history so
 * callers can enrich snapshots without a second read.
 */
export async function recordVenueHistory(
  asset: AssetSymbol | "MARKET",
  snapshots: ExchangeSnapshot[]
): Promise<VenueHistory> {
  const history = await read(asset);
  const now = Date.now();
  const cutoff = now - RETENTION_MS;
  let changed = false;

  for (const snap of snapshots) {
    if (!snap.openInterestUsd) continue;

    const series = history[snap.exchangeId] ?? [];
    const last = series[series.length - 1];
    if (last && now - last.t < MIN_GAP_MS) continue;

    series.push({
      t: now,
      fundingRatePct: snap.fundingRatePct,
      openInterestUsd: snap.openInterestUsd,
    });

    history[snap.exchangeId] = series.filter((p) => p.t >= cutoff).slice(-MAX_POINTS);
    changed = true;
  }

  if (changed) {
    if (kvConfigured()) {
      await kvSet(kvKey(asset), history);
    } else {
      try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(fileFor(asset), JSON.stringify(history), "utf8");
      } catch (err) {
        // A failed write must never break the response.
        console.warn(`[venue-history] could not persist ${asset}:`, err);
      }
    }
  }

  return history;
}

/**
 * Fill in sparkline, fundingHistory, and 24h OI change from locally
 * recorded data — but only where the upstream source left a gap.
 */
export function enrichWithVenueHistory(
  snapshot: ExchangeSnapshot,
  history: VenueHistory
): ExchangeSnapshot {
  const series = history[snapshot.exchangeId];
  if (!series || series.length < 2) return snapshot;

  const enriched = { ...snapshot };

  // Sparkline: last ~24 recorded funding readings.
  if (enriched.sparkline.length === 0) {
    enriched.sparkline = series.slice(-24).map((p) => p.fundingRatePct);
  }

  // Funding/OI history for the chart.
  if (enriched.fundingHistory.length === 0) {
    enriched.fundingHistory = series.map(
      (p): FundingPoint => ({
        t: p.t,
        fundingRatePct: p.fundingRatePct,
        openInterestUsd: p.openInterestUsd,
      })
    );
  }

  // 24h OI change — require a point at least 20h old so we never label a
  // 40-minute delta as a "24h change".
  if (enriched.openInterestChange24hPct === null) {
    const target = Date.now() - 24 * 60 * 60 * 1000;
    const old = series.filter((p) => p.t <= Date.now() - 20 * 60 * 60 * 1000);
    if (old.length > 0) {
      const closest = old.reduce((best, p) =>
        Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best
      );
      if (closest.openInterestUsd > 0) {
        enriched.openInterestChange24hPct =
          ((enriched.openInterestUsd - closest.openInterestUsd) / closest.openInterestUsd) * 100;
      }
    }
  }

  return enriched;
}

/** Hours of per-venue history collected, for UI messaging. */
export function venueHistoryHours(history: VenueHistory, exchangeId: string): number {
  const series = history[exchangeId];
  if (!series || series.length < 2) return 0;
  return (series[series.length - 1].t - series[0].t) / 3_600_000;
}
