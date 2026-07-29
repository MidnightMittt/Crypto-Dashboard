export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function formatUsd(value: number, decimals = 2): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPct(value: number, decimals = 2, forceSign = true): string {
  const sign = forceSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatFundingPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(4)}%`;
}

export function formatCountdown(targetMs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, targetMs - nowMs);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function timeAgo(t: number, nowMs = Date.now()): string {
  const diff = Math.max(0, nowMs - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Renders an unavailable value as an em dash rather than a fake zero. */
export function orDash(
  value: number | null | undefined,
  render: (v: number) => string
): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : render(value);
}

/**
 * Normalize a venue's funding rate to an 8-hour equivalent.
 *
 * Venues settle on different schedules — hourly on Kraken, Hyperliquid, and
 * dYdX; every 8h on most CEXs. Comparing the published rates directly makes
 * an hourly venue look 8x cheaper than it is. Anything that ranks, averages,
 * or color-codes funding across exchanges must normalize first.
 */
export function fundingPer8h(ratePct: number, intervalHours: number): number {
  return ratePct * (8 / intervalHours);
}

/** Basis points — 0.01% = 1bp. Real funding is small; bps keeps it readable. */
export function toBps(pct: number): number {
  return pct * 100;
}

export function formatBps(pct: number, decimals = 1): string {
  const bps = toBps(pct);
  return `${bps >= 0 ? "+" : ""}${bps.toFixed(decimals)}`;
}
