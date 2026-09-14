import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import barsPanelJson from "../../src/data/barsPanel.json";

/**
 * FILING WATCH — the FRMI lesson, generalised to the whole universe.
 *
 * Six weeks of a human watching FRMI's 8-Ks missed a live proxy contest
 * that one species-aware poll caught in its first run. This watches every
 * panel name for the species that change a thesis — the definitive and
 * preliminary proxy families, dissident soliciting material, 8-K, S-3
 * shelves, 424B takedowns, SC 13D/G stakes — one submissions-API request
 * per CIK per night, paced under SEC's 10 req/s guidance.
 *
 * THE TWO DECLARED CONSTRAINTS:
 *
 * Every entry is stamped with the form species AND the filer — who filed
 * is the whole story (a DFAN14A from a founder and one from a proxy
 * advisor are different events). Self-filed species (8-K, S-3, 424B,
 * the company's own proxy) stamp the registrant without a lookup;
 * third-party species (SC 13D/G, DFAN14A, PX14A6G) get one ranged fetch
 * of the filing header's FILED BY block — only for hits inside the
 * window, which are rare.
 *
 * Absence of a watch never renders as absence of filings. Names whose
 * ticker does not resolve to a CIK (several panel members are ETF trusts
 * or foreign listings) are listed in `unwatched` with the reason, exactly
 * the out-of-manifest discipline the earnings calendar uses. A reader
 * sees "not watched", never a clean-looking empty list.
 *
 * DEGRADE, DON'T FAIL: any per-name failure records that name as
 * unpolled-this-run and continues; a total failure leaves the previous
 * artifact in place.
 *
 *   npx tsx scripts/ingest/watchFilings.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "filingWatch.json");
const UA = { "User-Agent": "leverage-terminal research (msiburg@alumni.berklee.edu)" };

/** Species that move a thesis. Declared; adding one is a declaration event. */
const SELF_FILED = [
  "8-K", "S-3", "S-3/A",
  "DEF 14A", "DEFC14A", "DEFM14A", "DEFN14A", "DEFR14A", "DEFA14A",
  "PRE 14A", "PREC14A", "PREN14A", "PRER14A", "PRRN14A", "PREM14A",
];
/*
 * 424B* EXCEPT 424B2. The first sweep returned 3,759 hits of which 3,575
 * were 424B2 — banks' structured-note shelf takedowns, filed by the dozen
 * daily. Those are products, not corporate events; 424B3/5/7/8 (resales,
 * primary offerings) are the dilution signals worth a hit.
 */
const SELF_FILED_PREFIX = ["424B"];
const EXCLUDED_FORMS = ["424B2"];
const THIRD_PARTY = ["SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A", "DFAN14A", "PX14A6G"];
const LOOKBACK_DAYS = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Hit {
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
  filer: string | null;
  filer_basis: "registrant (self-filed species)" | "FILED BY header" | "header fetch failed";
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

/** FILED BY from the submission header — first ~6KB is all the header needs. */
async function filedBy(cik: string, accession: string): Promise<string | null> {
  const acc = accession.replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${accession}.txt`;
  const res = await fetch(url, {
    headers: { ...UA, Range: "bytes=0-6143" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok && res.status !== 206) return null;
  const head = await res.text();
  const m = head.match(/FILED BY:[\s\S]*?COMPANY CONFORMED NAME:\s*([^\n]+)/);
  return m ? m[1].trim() : null;
}

async function main() {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

  let tickerMap: Record<string, { cik_str: number; ticker: string; title: string }>;
  try {
    tickerMap = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  } catch (err) {
    console.warn(`ticker map fetch failed, previous file left in place: ${String(err)}`);
    return;
  }
  const byTicker = new Map(Object.values(tickerMap).map((r) => [r.ticker.toUpperCase(), r]));

  const watched: {
    symbol: string;
    cik: string;
    registrant: string;
    hits: Hit[];
    recentFilingsSeen: number;
  }[] = [];
  const unwatched: { symbol: string; reason: string }[] = [];

  /* The ranked universe (barsPanel) plus the book's SEC-registered name. */
  const universe = [...Object.keys((barsPanelJson as { symbols: Record<string, unknown> }).symbols), "FRMI"];
  unwatched.push({
    symbol: "PONS",
    reason: "on-chain token, no SEC registrant — watched on the desk via slot0/Swap logs instead. Listed so the book's coverage is explicit.",
  });
  for (const symbol of universe) {
    const row = byTicker.get(symbol);
    if (!row) {
      unwatched.push({
        symbol,
        reason: "ticker does not resolve in SEC's company_tickers.json — ETF trust, foreign listing, or symbol mismatch. NOT WATCHED; absence of a watch is not absence of filings.",
      });
      continue;
    }
    const cik = String(row.cik_str).padStart(10, "0");
    try {
      const sub = await fetchJson<{
        name?: string;
        filings?: { recent?: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] } };
      }>(`https://data.sec.gov/submissions/CIK${cik}.json`);
      const r = sub.filings?.recent;
      const hits: Hit[] = [];
      if (r) {
        for (let i = 0; i < r.form.length; i++) {
          if (r.filingDate[i] < cutoff) continue;
          const form = r.form[i];
          if (EXCLUDED_FORMS.includes(form)) continue;
          const self = SELF_FILED.includes(form) || SELF_FILED_PREFIX.some((p) => form.startsWith(p));
          const third = THIRD_PARTY.includes(form);
          if (!self && !third) continue;
          let filer: string | null = sub.name ?? null;
          let basis: Hit["filer_basis"] = "registrant (self-filed species)";
          if (third) {
            filer = await filedBy(cik, r.accessionNumber[i]);
            basis = filer === null ? "header fetch failed" : "FILED BY header";
            await sleep(120);
          }
          hits.push({
            form,
            filingDate: r.filingDate[i],
            accessionNumber: r.accessionNumber[i],
            primaryDocument: r.primaryDocument[i],
            filer,
            filer_basis: basis,
          });
        }
      }
      watched.push({
        symbol,
        cik,
        registrant: sub.name ?? symbol,
        hits,
        recentFilingsSeen: r?.form.length ?? 0,
      });
    } catch (err) {
      unwatched.push({ symbol, reason: `poll failed this run: ${String(err)}` });
    }
    await sleep(150);
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        source: "SEC submissions API, one request per CIK; FILED BY from ranged header fetches",
        lookbackDays: LOOKBACK_DAYS,
        species: { selfFiled: SELF_FILED, selfFiledPrefix: SELF_FILED_PREFIX, thirdParty: THIRD_PARTY },
        watchedCount: watched.length,
        unwatchedCount: unwatched.length,
        watched,
        unwatched,
        note:
          "Hits are watched-species filings inside the lookback, stamped with species and filer. " +
          "A name in `unwatched` has NO watch — that is a coverage fact, never a clean bill. " +
          "FRMI's meeting-anchored proxy watch (edgarWatch.json) is separate and more specific.",
      },
      null,
      1
    )
  );

  const totalHits = watched.reduce((a, w) => a + w.hits.length, 0);
  console.log(
    `filing watch: ${watched.length} watched, ${unwatched.length} unwatched, ` +
      `${totalHits} watched-species hits in ${LOOKBACK_DAYS}d`
  );
  const thirdPartyHits = watched.flatMap((w) => w.hits.filter((h) => h.filer_basis !== "registrant (self-filed species)").map((h) => `${w.symbol} ${h.form} ${h.filingDate} by ${h.filer ?? "?"}`));
  for (const t of thirdPartyHits.slice(0, 12)) console.log("  3rd-party: " + t);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main();
