import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { BarsPanel } from "../../src/lib/research/barsPanel";
import { fetchTradierChains } from "../../src/lib/dossier/providers/tradierOptions";
import { latestCompletedSession } from "../../src/lib/asset/priceStaleness";
import {
  AffordabilityEntry,
  AffordabilityView,
  CandidateContract,
  DELTA_BAND,
  EXPIRIES_EXAMINED,
  MAX_SPREAD_PCT_OF_MID,
  MIN_OPEN_INTEREST,
  buildEntry,
  coverageCurve,
  selectAffordabilityExpiries,
} from "../../src/lib/research/affordability";

/**
 * WHICH OF THE PANEL THIS ACCOUNT CAN TRADE AT ALL — swept nightly.
 *
 * ── The problem it exists for ─────────────────────────────────────────
 *
 * The reach screen ranked MU first on excursion asymmetry. MU trades near
 * $190 and its October calls run past $1,500 a contract against an account
 * holding $195.51. A ranking whose first place cannot be bought has a
 * decorative first place, and nothing in the stack knew it, because nothing
 * in the stack had ever looked at a contract price across the whole panel.
 *
 * This script looks. For every name the screen can rank, it finds the
 * cheapest contract in the 0.30-0.50 delta band that also clears the spread
 * and open-interest gates, at each of the nearest expiries long enough to
 * survive the ranking horizon. The result is a stored universe: not "filter
 * today's screen by price" but "here is the set, and here is what each name
 * costs to enter."
 *
 * ── Why the roster comes from the committed panel ─────────────────────
 *
 * `Object.keys(panel.symbols)` is exactly what `/api/screen/reach` iterates.
 * Reading the same committed artifact is what makes "rank inside the
 * affordable set" a real intersection rather than two lists that mostly
 * overlap. A separately declared roster here would drift from the screen's
 * the first time either moved, and the drift would present as names silently
 * missing from a ranking.
 *
 * ── What it refuses to write, and why that matters more than what it writes ──
 *
 * An artifact saying every name is unaffordable is indistinguishable, to
 * every downstream reader, from an artifact saying the venue was down. One is
 * a fact about the account and the other is an outage, and the page would
 * render them identically: an empty universe.
 *
 * So there are two refusals, both non-zero exits that leave the previous file
 * in place:
 *
 *   1. No API key — this cannot produce a universe at all, and a file full of
 *      "no chain" would read as one.
 *   2. Chain coverage under MIN_COVERAGE_PCT of the roster — the shape of an
 *      outage or a rate-limit wall, not of a panel that stopped listing
 *      options overnight.
 *
 * A stale file with an old `generatedAt` is a visible problem. A fresh file
 * full of nulls is an invisible one.
 *
 *   TRADIER_API_KEY=... npx tsx scripts/ingest/buildAffordability.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");
const BARS = path.join(ROOT, "src", "data", "barsPanel.json");
const OUT = path.join(ROOT, "src", "data", "affordability.json");

/**
 * Share of the roster that must return a chain for the sweep to be published.
 *
 * Not a tuning knob. Every name on this panel is a liquid US listing with a
 * listed options market, so the expected coverage is near total; anything
 * under this is the venue, not the universe.
 */
const MIN_COVERAGE_PCT = 70;

/**
 * Pause between symbols, in milliseconds.
 *
 * Each name costs roughly four requests (quote, expirations, then one per
 * expiry). Tradier's sandbox allows on the order of 120 a minute, so a
 * hundred-odd names need pacing or the tail of the sweep comes back as rate
 * limit errors — which would look exactly like an unaffordable universe.
 */
const PACE_MS = 400;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toCandidates(rows: {
  strike: number;
  kind: "call" | "put";
  expiry: string;
  bid: number | null;
  ask: number | null;
  openInterest: number;
  delta: number | null;
}[]): CandidateContract[] {
  return rows.map((r) => ({
    expiry: r.expiry,
    kind: r.kind,
    strike: r.strike,
    bid: r.bid,
    ask: r.ask,
    delta: r.delta,
    openInterest: r.openInterest,
  }));
}

async function main(): Promise<void> {
  if (!process.env.TRADIER_API_KEY?.trim()) {
    console.error(
      "REFUSING TO WRITE: TRADIER_API_KEY is unset. Without a chain venue every\n" +
        "name would be recorded as having no contract, and an artifact saying the\n" +
        "account can trade nothing is not distinguishable downstream from one\n" +
        "saying the venue was unreachable. Leaving the previous file in place."
    );
    process.exit(1);
  }

  const panel = JSON.parse(fs.readFileSync(BARS, "utf8")) as BarsPanel;
  /*
   * `--limit N` is for smoke-testing the venue join without a full sweep. It
   * deliberately implies `--dry-run`: a partial roster written to the artifact
   * would report every unswept name as unaffordable, which is the same
   * invisible failure the coverage floor exists to prevent.
   */
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : null;
  const dryRun = limit !== null || process.argv.includes("--dry-run");
  const full = Object.keys(panel.symbols).sort();
  const roster = limit !== null && limit > 0 ? full.slice(0, limit) : full;
  const panelSession = panel.sessions[panel.sessions.length - 1] ?? "";
  const now = Date.now();
  const session = latestCompletedSession(new Date(now));

  console.log(`affordability sweep: ${roster.length} names, ${EXPIRIES_EXAMINED} expiries each`);

  const entries: AffordabilityEntry[] = [];
  let withChain = 0;
  const expiriesSeen = new Set<string>();

  for (const [i, symbol] of roster.entries()) {
    const result = await fetchTradierChains(symbol, EXPIRIES_EXAMINED, (expirations, at) =>
      selectAffordabilityExpiries(expirations, at)
    );

    if (!result.ok) {
      entries.push(buildEntry(symbol, null, [], result.reason));
    } else {
      withChain++;
      for (const c of result.chains) expiriesSeen.add(c.expiry);
      const byExpiry = result.chains
        .slice()
        .sort((a, b) => a.expiry.localeCompare(b.expiry))
        .map((c) => toCandidates(c.rows));
      entries.push(buildEntry(symbol, result.spot, byExpiry));
    }

    if ((i + 1) % 20 === 0 || i === roster.length - 1) {
      console.log(`  ${i + 1}/${roster.length} — ${withChain} with a chain`);
    }
    await pause(PACE_MS);
  }

  const coveragePct = roster.length > 0 ? (withChain / roster.length) * 100 : 0;
  if (coveragePct < MIN_COVERAGE_PCT) {
    console.error(
      `REFUSING TO WRITE: only ${withChain}/${roster.length} names (${coveragePct.toFixed(0)}%) ` +
        `returned a chain, under the ${MIN_COVERAGE_PCT}% floor.\n` +
        "Every name here is a liquid US listing with a listed options market, so this\n" +
        "is the shape of an outage or a rate-limit wall rather than of a panel that\n" +
        "stopped listing options. Publishing it would render as an empty universe.\n" +
        `First refusal seen: ${entries.find((e) => e.missReason === "no_chain")?.detail ?? "none"}`
    );
    process.exit(1);
  }

  const view: AffordabilityView = {
    generatedAt: now,
    session,
    panelSession,
    deltaBand: DELTA_BAND,
    maxSpreadPctOfMid: MAX_SPREAD_PCT_OF_MID,
    minOpenInterest: MIN_OPEN_INTEREST,
    expiriesExamined: EXPIRIES_EXAMINED,
    entries: entries.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    coverage: coverageCurve(entries),
  };

  if (dryRun) {
    console.log(`\nDRY RUN — nothing written${limit !== null ? ` (--limit ${limit})` : ""}.`);
  } else {
    fs.writeFileSync(OUT, `${JSON.stringify(view, null, 2)}\n`);
    console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
  }

  const priced = entries.filter((e) => e.cheapest !== null);
  const cheapest = [...priced].sort((a, b) => a.cheapest!.costUsd - b.cheapest!.costUsd);
  console.log(`  quotes as of ${session} · roster from panel ${panelSession} · expiries ${[...expiriesSeen].sort().join(", ")}`);
  console.log(`  ${priced.length} of ${roster.length} names have a qualifying contract`);
  console.log("\n  budget   tradeable");
  for (const rung of view.coverage) {
    console.log(`  $${String(rung.budgetUsd).padStart(5)}   ${rung.tradeable}/${rung.of}`);
  }
  console.log("\n  cheapest ten:");
  for (const e of cheapest.slice(0, 10)) {
    console.log(`    ${e.symbol.padEnd(6)} $${e.cheapest!.costUsd.toFixed(0).padStart(6)}  ${e.cheapest!.expiry} ${e.cheapest!.strike}${e.cheapest!.kind[0]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
