/**
 * PHASE 1 — DOES CONFLUENCE PAY? A dose-response test of the live zone engine.
 *
 * ── THE QUESTION ──────────────────────────────────────────────────────────
 * `levels_study.js` (2026-11-27) measured ISOLATED support/resistance levels
 * on 9.1 years of BTC/ETH/SOL and found them sitting on their null: win rates
 * 46.5-51.9% against a 50% null, and deliberately-wrong control lines scored
 * as well or better. That study did NOT test confluence.
 *
 * This one does, and it asks the only question that can distinguish a real
 * confluence effect from a flattering headline number:
 *
 *      DOES WIN RATE RISE MONOTONICALLY WITH CONFLUENCE TAG COUNT?
 *
 * A single "confluent zones win 54%" is cheap — it can come from selection,
 * from regime, from the zones simply being rarer. But if confluence carries
 * information, 3 tags must beat 2, and 2 must beat 1, in order. A flat or
 * non-monotone curve kills the hypothesis regardless of the headline.
 *
 * ── WHY THE BRACKET IS SYMMETRIC ──────────────────────────────────────────
 * Target and stop are both 1.5 x ATR(14), so the random-walk null is EXACTLY
 * 50% and no payoff-ratio assumption can smuggle in an edge. It is also the
 * identical bracket `levels_study.js` used, so the two results are directly
 * comparable: any lift here is attributable to confluence, not to a changed
 * measurement.
 *
 * ── NO LOOKAHEAD ──────────────────────────────────────────────────────────
 * Every call receives `candles.slice(0, i + 1)` — the engine's own documented
 * convention — and the 4H series is advanced by a pointer that never passes
 * the daily bar's timestamp. Zones are rebuilt from scratch at every bar, so
 * a zone can only use touches that had already happened.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 * It does not trade, hold a key, or change the live engine. It measures
 * already-resolved history. Nothing here is evidence for a bot until the
 * dose-response curve says so.
 *
 *   npx tsx scripts/backtest/confluencePhase1.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  buildVolumeProfile,
  buildSupportResistanceZones,
  mergeTimeframeZones,
  SupportResistanceZone,
} from "../../src/lib/technicals/marketStructure";
import { atr, Candle } from "../../src/lib/technicals/indicators";
import { wilsonInterval } from "./metrics";

/* The shim this file once imported is GONE. divergence.ts is readable in this
   working copy, so marketStructure.ts resolves findSwingPoints natively. The
   shim was verified identical to the real implementation across 16,000 cases /
   145,632 swing points before being retired, so Phase 1 results are unaffected. */


const RESEARCH = process.env.RESEARCH_DIR || path.join(process.env.HOME || "", "trading/research");
const ATR_MULT = Number(process.env.ATR_MULT || 1.5);
const MAX_HOLD = Number(process.env.MAX_HOLD || 30);
const COOLDOWN = Number(process.env.COOLDOWN || 20);
const WARMUP = Number(process.env.WARMUP || 320);

type Raw = { t: number; o: number; h: number; l: number; c: number; v: number };

/* OKX index 5 is BASE-currency volume (BTC count), but Candle.volumeUsd wants
   QUOTE currency. close * baseVol is the standard conversion and is what makes
   volume comparable across assets — the volume profile would otherwise weight
   a 60,000-dollar BTC bar the same as a 71-dollar SOL bar. */
const toCandle = (r: Raw): Candle => ({
  t: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volumeUsd: r.v * r.c,
});

interface Trade {
  tags: number;
  status: string;
  strength: number;
  kind: "support" | "resistance";
  timeframe: string;
  win: boolean;
  t: number;
}

/** Symmetric bracket, first touch wins. Both inside one bar is AMBIGUOUS and
    is discarded — awarding it to the favourable side is how a backtest
    manufactures a win rate. */
function resolve(d: Candle[], i: number, up: number, dn: number): "up" | "dn" | "ambig" | "none" {
  for (let j = i + 1; j < Math.min(i + 1 + MAX_HOLD, d.length); j++) {
    const hitU = d[j].high >= up, hitD = d[j].low <= dn;
    if (hitU && hitD) return "ambig";
    if (hitU) return "up";
    if (hitD) return "dn";
  }
  return "none";
}

function run(symbol: string, daily: Candle[], fourH: Candle[]): Trade[] {
  const trades: Trade[] = [];
  const lastTradeBar = new Map<string, number>();
  let p4 = 0;
  let ambig = 0, none = 0;

  for (let i = WARMUP; i < daily.length - 1; i++) {
    const pastD = daily.slice(0, i + 1);
    while (p4 < fourH.length && fourH[p4].t <= daily[i].t) p4++;   // pointer, never past the daily bar
    const past4 = fourH.slice(0, p4);
    const a = atr(pastD);
    if (a === null || a <= 0) continue;

    const profD = buildVolumeProfile(pastD);
    const zonesD = buildSupportResistanceZones(pastD, profD, "1D");
    let zones: SupportResistanceZone[] = zonesD;
    if (past4.length > 60) {
      const prof4 = buildVolumeProfile(past4);
      const zones4 = buildSupportResistanceZones(past4, prof4, "4H");
      zones = mergeTimeframeZones(zonesD, zones4, pastD);
    }

    const bar = daily[i];
    for (const z of zones) {
      /* ONLY ACT ON ACTIVE INTERACTION. "approaching" is not a trade and
         "inactive" is noise; testing/rejecting/reclaiming/breaking are the
         four states where price is actually at the zone. */
      if (z.status === "inactive" || z.status === "approaching") continue;
      const key = `${z.kind}:${Math.round(z.priceLow)}:${Math.round(z.priceHigh)}`;
      const last = lastTradeBar.get(key);
      if (last !== undefined && i - last < COOLDOWN) continue;
      lastTradeBar.set(key, i);

      const entry = bar.close;
      const w = ATR_MULT * a;
      const r = resolve(daily, i, entry + w, entry - w);
      if (r === "ambig") { ambig++; continue; }
      if (r === "none") { none++; continue; }
      const win = z.kind === "support" ? r === "up" : r === "dn";
      trades.push({
        tags: z.confluence.length, status: z.status, strength: z.strength,
        kind: z.kind, timeframe: z.timeframe, win, t: bar.t,
      });
    }
  }
  console.log(`  ${symbol}: ${trades.length} resolved · ${ambig} ambiguous (discarded) · ${none} timed out`);
  return trades;
}

function report(label: string, trades: Trade[]) {
  const w = trades.filter(t => t.win).length;
  const ci = wilsonInterval(w, trades.length);
  const pct = trades.length ? (w / trades.length) * 100 : NaN;
  const lo = ci ? ci.lower * 100 : NaN, hi = ci ? ci.upper * 100 : NaN;
  const sig = ci && (ci.lower > 0.5 || ci.upper < 0.5) ? "  *" : "";
  console.log(
    `    ${label.padEnd(22)} n=${String(trades.length).padStart(5)}  ` +
    `win ${isNaN(pct) ? "  -  " : pct.toFixed(1).padStart(5)}%  ` +
    `95% CI [${isNaN(lo) ? " - " : lo.toFixed(1)}, ${isNaN(hi) ? " - " : hi.toFixed(1)}]${sig}`
  );
}

const dailyRaw = JSON.parse(fs.readFileSync(path.join(RESEARCH, "levels-bars.json"), "utf8"));
const fourRaw = JSON.parse(fs.readFileSync(path.join(RESEARCH, "levels-bars-4h.json"), "utf8"));

console.log("PHASE 1 — CONFLUENCE DOSE-RESPONSE  (live zone engine, walk-forward)");
console.log(`  bracket ±${ATR_MULT}×ATR(14) SYMMETRIC — null = 50% exactly`);
console.log(`  max hold ${MAX_HOLD}d · cooldown ${COOLDOWN}d/zone · warmup ${WARMUP} bars`);
console.log("  THE TEST: win rate must rise MONOTONICALLY with confluence tag count.\n");

const all: Trade[] = [];
for (const sym of Object.keys(dailyRaw)) {
  const daily = (dailyRaw[sym].daily as Raw[]).map(toCandle);
  const fourH = ((fourRaw[sym] || []) as Raw[]).map(toCandle);
  const t = run(sym, daily, fourH);
  all.push(...t);
}

console.log("\n  ── DOSE-RESPONSE: win rate by confluence tag count ──");
for (let n = 0; n <= 4; n++) report(`${n} tag${n === 1 ? "" : "s"}`, all.filter(t => t.tags === n));

console.log("\n  ── by zone status ──");
for (const s of ["testing", "rejecting", "reclaiming", "breaking"])
  report(s, all.filter(t => t.status === s));

console.log("\n  ── by strength decile band ──");
for (const [lo, hi] of [[0, 25], [25, 50], [50, 75], [75, 101]])
  report(`strength ${lo}-${hi - 1}`, all.filter(t => t.strength >= lo && t.strength < hi));

console.log("\n  ── by timeframe ──");
for (const tf of ["1D", "4H", "both"]) report(tf, all.filter(t => t.timeframe === tf));

console.log("\n  ── overall ──");
report("ALL", all);

fs.writeFileSync(path.join(RESEARCH, "confluence_phase1_trades.json"), JSON.stringify(all));
console.log(`\n  wrote ${all.length} trades -> confluence_phase1_trades.json`);
