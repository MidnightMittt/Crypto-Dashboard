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

export interface ShortVolumeSummary {
  latest: ShortVolumeDay;
  /** The distinction, carried with the data. */
  meaningNote: string;
}

export type ShortVolumeResult = { ok: true; summary: ShortVolumeSummary } | { ok: false; reason: string };

/** Files appear after each session; walk back over weekends and holidays. */
const MAX_WALKBACK_DAYS = 6;

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export async function fetchShortVolume(symbol: string): Promise<ShortVolumeResult> {
  try {
    for (let back = 0; back <= MAX_WALKBACK_DAYS; back++) {
      const d = new Date(Date.now() - back * 86_400_000);
      const day = d.getUTCDay();
      if (day === 0 || day === 6) continue;

      const res = await fetch(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${yyyymmdd(d)}.txt`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 3_600 },
      });
      if (!res.ok) continue; // not published yet, or holiday — keep walking

      const text = await res.text();
      const line = text.split("\n").find((l) => l.split("|")[1] === symbol);
      if (!line) {
        return { ok: false, reason: `FINRA's consolidated file for ${yyyymmdd(d)} carries no row for ${symbol} — it may trade too thinly to appear, or under a different symbol.` };
      }
      const parsed = parseShortVolumeRow(line);
      if (!parsed) return { ok: false, reason: "FINRA's row for this symbol was malformed." };

      return {
        ok: true,
        summary: {
          latest: parsed,
          meaningNote:
            "This is DAILY short-sale volume — the share of today's trading that printed as a short sale — not short interest, the standing count of shares held short. High single-day readings are routine because market makers short to fill buy orders; the number is informative against the symbol's own norm, not in isolation.",
        },
      };
    }
    return { ok: false, reason: "No FINRA short-volume file was published in the last week — likely a holiday stretch or a publishing delay." };
  } catch (err) {
    return { ok: false, reason: `FINRA could not be reached this request (${err instanceof Error ? err.message : "unknown"}).` };
  }
}
