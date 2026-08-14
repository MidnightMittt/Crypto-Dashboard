/**
 * INSIDER BUYING — SEC EDGAR Form 4, free and primary-source.
 *
 * Every officer, director and 10% holder must file a Form 4 within two
 * business days of trading their own stock. The filings are public XML, and
 * the signal literature (Form 4 open-market purchase clusters) is one of the
 * better-evidenced free edges — which is why this sat at the top of the
 * platform's own "not built yet" list.
 *
 * ── What is counted, and what deliberately is not ─────────────────────
 *
 * Only OPEN-MARKET transactions: code P (purchase) and code S (sale). Grants
 * (A), option exercises (M), tax withholding (F) and gifts (G) are excluded
 * because they are compensation mechanics, not conviction — an executive
 * receiving scheduled stock says nothing, an executive spending salary to
 * buy more says a great deal. The sale side is kept and shown despite being
 * noisier (sales happen for houses and divorces, purchases mostly for one
 * reason), with that asymmetry stated in the payload.
 *
 * SEC fair-access policy requires a declared User-Agent and modest rates;
 * both are honoured, and results cache for hours because filings arrive on
 * a business-day cadence, not a tick cadence.
 */

const SEC_UA = { "User-Agent": "leverage-terminal research msiburg@alumni.berklee.edu", Accept: "application/json" };

/** How far back the aggregation window reaches. */
export const INSIDER_WINDOW_DAYS = 90;
/** Most Form 4 documents fetched per request — bounded so one page view cannot hammer EDGAR. */
const MAX_FORMS = 8;

export interface InsiderTransaction {
  code: string;
  shares: number;
  pricePerShare: number | null;
  /** A = acquired, D = disposed, from the filing itself. */
  acquiredDisposed: "A" | "D" | null;
}

/**
 * Pull the open-market transactions out of one Form 4 XML.
 *
 * Regex-scoped extraction rather than a DOM parser, deliberately: the
 * ownershipDocument schema is stable, the fields used here are mandatory,
 * and adding an XML dependency for four tags is dead weight. Each
 * <nonDerivativeTransaction> block is isolated first so values can never
 * bleed between transactions.
 */
export function parseForm4(xml: string): InsiderTransaction[] {
  const out: InsiderTransaction[] = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? [];

  for (const block of blocks) {
    const code = block.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1] ?? null;
    if (!code) continue;

    const shares = Number(
      block.match(/<transactionShares>[\s\S]*?<value>\s*([\d.]+)\s*<\/value>/)?.[1] ?? NaN
    );
    if (!Number.isFinite(shares) || shares <= 0) continue;

    const priceRaw = block.match(/<transactionPricePerShare>[\s\S]*?<value>\s*([\d.]+)\s*<\/value>/)?.[1];
    const price = priceRaw !== undefined ? Number(priceRaw) : null;

    const ad = block.match(/<transactionAcquiredDisposedCode>[\s\S]*?<value>\s*([AD])\s*<\/value>/)?.[1] ?? null;

    out.push({
      code,
      shares,
      pricePerShare: price !== null && Number.isFinite(price) && price > 0 ? price : null,
      acquiredDisposed: ad === "A" || ad === "D" ? ad : null,
    });
  }
  return out;
}

export interface InsiderSummary {
  windowDays: number;
  filingsExamined: number;
  buys: { transactions: number; shares: number; valueUsd: number | null };
  sells: { transactions: number; shares: number; valueUsd: number | null };
  lastFilingDate: string | null;
  /** The stated asymmetry: why the buy side means more than the sell side. */
  asymmetryNote: string;
}

/** Aggregate parsed transactions across filings into the 90-day picture. */
export function aggregateInsiderActivity(
  filings: Array<{ transactions: InsiderTransaction[] }>,
  lastFilingDate: string | null
): InsiderSummary {
  const buys = { transactions: 0, shares: 0, valueKnown: 0, valueUsd: 0 };
  const sells = { transactions: 0, shares: 0, valueKnown: 0, valueUsd: 0 };

  for (const f of filings) {
    for (const t of f.transactions) {
      // Open-market only. Everything else is compensation mechanics.
      const bucket = t.code === "P" ? buys : t.code === "S" ? sells : null;
      if (!bucket) continue;
      bucket.transactions++;
      bucket.shares += t.shares;
      if (t.pricePerShare !== null) {
        bucket.valueKnown++;
        bucket.valueUsd += t.shares * t.pricePerShare;
      }
    }
  }

  return {
    windowDays: INSIDER_WINDOW_DAYS,
    filingsExamined: filings.length,
    buys: {
      transactions: buys.transactions,
      shares: buys.shares,
      // A dollar figure is only quoted when every counted transaction
      // carried a price — a partial sum would understate silently.
      valueUsd: buys.transactions > 0 && buys.valueKnown === buys.transactions ? buys.valueUsd : null,
    },
    sells: {
      transactions: sells.transactions,
      shares: sells.shares,
      valueUsd: sells.transactions > 0 && sells.valueKnown === sells.transactions ? sells.valueUsd : null,
    },
    lastFilingDate,
    asymmetryNote:
      "Insider sales are noisy — executives sell for houses, taxes and diversification. Open-market purchases have essentially one explanation, which is why the buy side carries the signal.",
  };
}

// ── Fetch layer ─────────────────────────────────────────────────────────

export type InsiderResult = { ok: true; summary: InsiderSummary } | { ok: false; reason: string };

interface SubmissionsRecent {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

/** Ticker -> zero-padded CIK, via the SEC's own mapping file. Cached a day. */
async function lookupCik(symbol: string): Promise<string | null> {
  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: SEC_UA,
    next: { revalidate: 86_400 },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
  const hit = Object.values(json).find((x) => x.ticker === symbol);
  return hit ? String(hit.cik_str).padStart(10, "0") : null;
}

export async function fetchInsiderSummary(symbol: string): Promise<InsiderResult> {
  try {
    const cik = await lookupCik(symbol);
    if (!cik) {
      return { ok: false, reason: `${symbol} is not in the SEC's company register, so it has no insider filings — common for ETFs, which have no insiders to file.` };
    }

    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: SEC_UA,
      next: { revalidate: 21_600 },
    });
    if (!res.ok) return { ok: false, reason: `EDGAR returned HTTP ${res.status} for ${symbol}'s filings.` };
    const subs = (await res.json()) as { filings?: { recent?: SubmissionsRecent } };
    const recent = subs.filings?.recent;
    if (!recent) return { ok: false, reason: "EDGAR returned no recent filings." };

    const cutoff = Date.now() - INSIDER_WINDOW_DAYS * 86_400_000;
    const form4s: Array<{ accession: string; doc: string; date: string }> = [];
    for (let i = 0; i < recent.form.length && form4s.length < MAX_FORMS; i++) {
      if (recent.form[i] !== "4") continue;
      if (Date.parse(recent.filingDate[i]) < cutoff) break; // list is newest-first
      form4s.push({ accession: recent.accessionNumber[i], doc: recent.primaryDocument[i], date: recent.filingDate[i] });
    }

    if (form4s.length === 0) {
      // A real finding, not an error: nobody inside traded in the window.
      return {
        ok: true,
        summary: aggregateInsiderActivity([], null),
      };
    }

    // Small, sequential-ish fan-out — SEC asks for restraint and gets it.
    const filings: Array<{ transactions: InsiderTransaction[] }> = [];
    for (const f of form4s) {
      const acc = f.accession.replace(/-/g, "");
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${f.doc}`;
      const r = await fetch(url, { headers: { ...SEC_UA, Accept: "application/xml" }, next: { revalidate: 86_400 } });
      if (!r.ok) continue;
      filings.push({ transactions: parseForm4(await r.text()) });
    }

    return { ok: true, summary: aggregateInsiderActivity(filings, form4s[0]?.date ?? null) };
  } catch (err) {
    return { ok: false, reason: `EDGAR could not be reached this request (${err instanceof Error ? err.message : "unknown error"}).` };
  }
}
