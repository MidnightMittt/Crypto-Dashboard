import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * EDGAR POLL — does the FRMI proxy exist yet?
 *
 * The desk carries frmi-proxy-statement as a DEADLINE (due before the
 * 2026-10-30 annual meeting), and a deadline whose watchable is the
 * filing itself should flip on the filing, not on the calendar. This
 * polls the SEC's submissions API for CIK 0002071778 nightly and records
 * whether a DEF 14A has landed — that form is the declared event; the
 * rest of the 14A family (PRE 14A, DEFA14A, ...) is recorded as context
 * because a preliminary proxy is the strongest possible tell that the
 * definitive one is imminent.
 *
 * DEGRADE, DON'T FAIL — same contract as the earnings fetch. On any
 * error the committed file is left exactly as it was: its generatedAt
 * then reads honestly stale rather than freshly empty, and a missing
 * poll never deletes a found filing.
 *
 * SEC etiquette: the API is keyless but REQUIRES a descriptive
 * User-Agent with contact information, and rate-limits above 10 req/s.
 * This makes one request a night.
 *
 *   npx tsx scripts/ingest/pollEdgarFrmi.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname_, "..", "..", "src", "data", "edgarWatch.json");

const CIK = "0002071778";
const URL = `https://data.sec.gov/submissions/CIK${CIK}.json`;

/*
 * THE WATCH IS SPECIES-AGNOSTIC AND DATE-ANCHORED, and the first poll is
 * why. The naive rule — watch "DEF 14A" — assumed a routine solicitation.
 * The filing history says otherwise: Fermi ran a full CONTESTED proxy
 * cycle this spring (PREC/PREN/PRRN preliminaries through May, definitive
 * DEFC14A on 06-10 and 06-12, 47 dissident DFAN14A filings into July),
 * and a PX14A6G exempt solicitation landed 2026-09-11 — the contest is
 * alive going into the 10-30 meeting. In a contested solicitation the
 * definitive proxy files as DEFC14A; plain "DEF 14A" might never appear,
 * and a watch pinned to it would wait forever while the event happened
 * under another name.
 *
 * So: the EVENT is any definitive proxy species filed after the 8-K that
 * announced the meeting (2026-08-31) — spring's filings are the previous
 * fight, not this one. Preliminary species after the anchor are the TELL.
 * Dissident soliciting material (DFAN14A, PX14A6G) is context, never the
 * event: the deadline the desk carries is about the company's proxy.
 */
const MEETING_8K_DATE = "2026-08-31";
const DEFINITIVE_FORMS = ["DEF 14A", "DEFC14A", "DEFM14A", "DEFN14A", "DEFR14A"];
const PRELIMINARY_FORMS = ["PRE 14A", "PREC14A", "PREN14A", "PRER14A", "PRRN14A", "PREM14A"];

interface RecentFilings {
  form: string[];
  filingDate: string[];
  accessionNumber: string[];
  primaryDocument: string[];
}

async function main() {
  let body: { name?: string; filings?: { recent?: RecentFilings } };
  try {
    const res = await fetch(URL, {
      headers: {
        "User-Agent": "leverage-terminal research (msiburg@alumni.berklee.edu)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`EDGAR ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.warn(`edgar poll failed, previous file left in place: ${String(err)}`);
    return;
  }

  const recent = body.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) {
    console.warn("edgar poll: response carried no recent filings block; previous file left in place");
    return;
  }

  const rows = recent.form.map((form, i) => ({
    form,
    filingDate: recent.filingDate[i],
    accessionNumber: recent.accessionNumber[i],
    primaryDocument: recent.primaryDocument[i],
  }));

  const fourteenA = rows.filter((r) => /14A/i.test(r.form));
  const afterAnchor = (r: { filingDate: string }) => r.filingDate > MEETING_8K_DATE;
  const found = rows.find((r) => DEFINITIVE_FORMS.includes(r.form) && afterAnchor(r)) ?? null;
  const tells = rows.filter((r) => PRELIMINARY_FORMS.includes(r.form) && afterAnchor(r));
  const solicitingSinceAnchor = fourteenA.filter(
    (r) => afterAnchor(r) && !DEFINITIVE_FORMS.includes(r.form) && !PRELIMINARY_FORMS.includes(r.form)
  );

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: Date.now(),
        cik: CIK,
        registrant: body.name ?? null,
        source: `SEC submissions API, ${URL}`,
        watch: {
          event: `any of ${DEFINITIVE_FORMS.join("/")} filed after ${MEETING_8K_DATE} (the 8-K announcing the 2026-10-30 meeting)`,
          tell: `any of ${PRELIMINARY_FORMS.join("/")} after the same anchor`,
          anchor_reason:
            "Fermi ran a full contested proxy cycle May-July 2026 (DEFC14A 06-10/06-12, 47 " +
            "dissident DFAN14A filings); those belong to the previous fight. A PX14A6G exempt " +
            "solicitation on 2026-09-11 says the contest is alive going into this meeting, so " +
            "the definitive proxy may well arrive as DEFC14A rather than DEF 14A — the watch " +
            "must not be pinned to one species.",
        },
        /** The event: null until a definitive proxy for THIS meeting lands, then pinned. */
        found,
        /** Preliminary proxies after the anchor — the strongest tell the definitive is imminent. */
        tells,
        /** Non-proxy soliciting material since the anchor — contest-temperature context. */
        solicitingSinceAnchor,
        /** Full recent 14A family, for inspection. */
        fourteenA,
        recentFilingsSeen: rows.length,
      },
      null,
      1
    )
  );
  console.log(
    `edgar poll: ${rows.length} recent filings for ${body.name ?? CIK}; ` +
      `definitive proxy for the 10-30 meeting: ${found ? `FILED ${found.filingDate} as ${found.form}` : "not yet"}; ` +
      `tells since anchor: ${tells.length}; soliciting material since anchor: ${solicitingSinceAnchor.length}`
  );
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main();
