import { lookupCik } from "./edgarInsiders";

/**
 * AFTER-HOURS EDGAR FILINGS — the catalyst class that decides overnight holds.
 *
 * A filing accepted after the close is precisely the event an overnight
 * position cannot react to: the stop is a statement about continuous tape,
 * and the tape is closed. So the pre-trade payload lists every relevant
 * filing accepted since the prior session's close, each with its form, its
 * 8-K items, its acceptance instant and its accession number — facts a
 * consumer can act on, never a judgement about what they mean.
 *
 * ── Which forms count, and why the list is closed ─────────────────────
 *
 * 8-K items 1.01 (material agreement), 2.02 (results), 3.02 (unregistered
 * sales), 7.01 (Reg FD) and 8.01 (other events) are the items that move
 * these names after hours. 424B* is a prospectus — on this cohort that is
 * usually an offering pricing, i.e. dilution landing tonight. S-3ASR is a
 * shelf going effective immediately. The list is declared and closed rather
 * than "anything that looks important", because an open-ended filter is a
 * sentiment model wearing a compliance costume.
 *
 * ── The window is the PRIOR CLOSE, computed not assumed ───────────────
 *
 * "Since the prior close" means the most recent weekday 16:00 ET strictly
 * before now — Friday's close on a weekend, yesterday's close during a
 * session. Weekday-only counting has no holiday calendar, and that errs
 * INCLUSIVE: on the day after a holiday the window reaches one session
 * further back and lists a filing twice-aged rather than missing one. For a
 * catalyst list, showing too much beats hiding anything.
 */

/** 8-K items that matter after hours on this cohort. Declared, closed. */
export const RELEVANT_8K_ITEMS = ["1.01", "2.02", "3.02", "7.01", "8.01"] as const;

export interface CatalystFiling {
  form: string;
  /** Parsed 8-K items, e.g. ["2.02","9.01"]. Empty for non-8-K forms. */
  items: string[];
  /** ISO instant EDGAR accepted the filing — the moment it became public. */
  filed_at: string;
  accession: string;
}

/** The parallel arrays data.sec.gov/submissions serves. */
export interface RecentFilings {
  accessionNumber: string[];
  form: string[];
  acceptanceDateTime: string[];
  items: string[];
}

/**
 * Epoch ms of 16:00 ET on a given UTC calendar date.
 *
 * 16:00 ET is 20:00 UTC under daylight time and 21:00 UTC under standard
 * time. Rather than encode the DST calendar — a rule that rots at the next
 * transition — both candidates are rendered back into Eastern wall-clock
 * time and the one that reads 16:00 wins.
 */
function closeAtEt(utcYear: number, utcMonth: number, utcDay: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  for (const utcHour of [20, 21]) {
    const t = Date.UTC(utcYear, utcMonth, utcDay, utcHour);
    if (Number(fmt.format(new Date(t))) === 16) return t;
  }
  // Unreachable for any real ET offset; fail toward the EDT candidate.
  return Date.UTC(utcYear, utcMonth, utcDay, 20);
}

/**
 * The most recent weekday 16:00 ET strictly before `now`.
 *
 * Walks back day by day: today's close if it has already happened and today
 * is a weekday, otherwise yesterday's, and so on across weekends. Bounded at
 * a week because more than four consecutive non-sessions does not happen on
 * US exchanges.
 */
export function priorCloseEt(now: number): number {
  const d = new Date(now);
  for (let back = 0; back <= 7; back++) {
    const probe = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
    const dow = probe.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const close = closeAtEt(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate());
    if (close < now) return close;
  }
  return now - 86_400_000; // unreachable; one day back is the safe fallback
}

/** Parse EDGAR's comma-separated items string, tolerating blanks and spaces. */
export function parseItems(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this filing belong on a catalyst list at all?
 *
 * An 8-K counts only when it carries at least one of the declared items — a
 * bare 9.01 (exhibits) is packaging, not news. 424B matches as a prefix
 * because the suffixes (424B2, 424B3, 424B5...) differ only in which rule
 * the prospectus was filed under, not in whether dilution is landing.
 */
export function isRelevantFiling(form: string, items: string[]): boolean {
  const f = form.trim().toUpperCase();
  if (f === "8-K" || f === "8-K/A") {
    return items.some((i) => (RELEVANT_8K_ITEMS as readonly string[]).includes(i));
  }
  if (f.startsWith("424B")) return true;
  if (f === "S-3ASR") return true;
  return false;
}

/**
 * Filter the submissions feed to relevant filings accepted inside the window.
 *
 * Pure, so the window logic and the relevance rules are testable without a
 * network. The feed is newest-first and bounded (~1000 rows), so a full scan
 * is cheap; scanning everything rather than early-exiting also keeps this
 * correct if the ordering assumption ever breaks upstream.
 */
export function filterCatalysts(
  recent: RecentFilings,
  windowStartMs: number,
  nowMs: number
): CatalystFiling[] {
  const out: CatalystFiling[] = [];
  const n = Math.min(
    recent.form.length,
    recent.acceptanceDateTime.length,
    recent.accessionNumber.length,
    recent.items.length
  );
  for (let i = 0; i < n; i++) {
    const accepted = Date.parse(recent.acceptanceDateTime[i]);
    if (!Number.isFinite(accepted) || accepted <= windowStartMs || accepted > nowMs) continue;
    const items = parseItems(recent.items[i] ?? "");
    if (!isRelevantFiling(recent.form[i], items)) continue;
    out.push({
      form: recent.form[i],
      items,
      filed_at: new Date(accepted).toISOString(),
      accession: recent.accessionNumber[i],
    });
  }
  return out.sort((a, b) => b.filed_at.localeCompare(a.filed_at));
}

export type CatalystResult =
  | { ok: true; filings: CatalystFiling[]; windowStart: string }
  | { ok: false; reason: string };

/**
 * Live fetch for one symbol. Failures return a reason, never an empty list —
 * "no filings" and "could not look" are opposite answers for a field whose
 * job is deciding whether tonight is safe.
 */
export async function fetchCatalysts(symbol: string, now = Date.now()): Promise<CatalystResult> {
  try {
    const cik = await lookupCik(symbol);
    if (!cik) return { ok: false, reason: "no_cik_mapping" };

    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": "leverage-terminal admin@leverage.local" },
      // Filings land at any minute after hours; cache briefly, never a day.
      next: { revalidate: 300 },
    });
    if (!res.ok) return { ok: false, reason: `edgar_http_${res.status}` };

    const json = (await res.json()) as { filings?: { recent?: RecentFilings } };
    const recent = json.filings?.recent;
    if (!recent?.form?.length) return { ok: false, reason: "edgar_empty_feed" };

    const windowStart = priorCloseEt(now);
    return {
      ok: true,
      filings: filterCatalysts(recent, windowStart, now),
      windowStart: new Date(windowStart).toISOString(),
    };
  } catch (err) {
    return { ok: false, reason: `edgar_threw_${err instanceof Error ? err.name : "unknown"}` };
  }
}
