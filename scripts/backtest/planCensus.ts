import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { replayAsset, RawAssetData, MarketWideData, DayRecord } from "./run";

/**
 * Plan census — what the swing thesis actually produced, and how much of it
 * is a genuine forward-looking entry.
 *
 * Exists to make the at-market fallback removal PROVABLE rather than
 * asserted: run it, change one line, run it again, diff the output. Every
 * figure comes from the real replay, not a reconstruction.
 *
 * Run: npx tsx scripts/backtest/planCensus.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

type Plan = NonNullable<DayRecord["swingPlan"]>;
interface Bar { t: number; high: number; low: number; close: number }

const q = (a: number[], f: number) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * f)] : NaN);
const pct = (n: number, d: number) => (d > 0 ? (100 * n) / d : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");

/**
 * An at-market plan is identifiable by geometry alone: `buildEntryZone`'s
 * fallback is exactly [anchor - 0.25·ATR, anchor + 0.25·ATR], so the zone is
 * centred on the anchor and exactly 0.5 ATR wide. No structural zone lands
 * there by coincidence to floating-point equality.
 */
function isAtMarket(p: Plan): boolean {
  const mid = (p.entryLow + p.entryHigh) / 2;
  const width = p.entryHigh - p.entryLow;
  return Math.abs(mid - p.anchorPrice) < 1e-6 && Math.abs(width - 0.5 * p.atrAbs) < 1e-6;
}

function standoffAtr(p: Plan): number {
  const nearEdge = p.direction === "long" ? p.entryHigh : p.entryLow;
  return Math.abs(p.anchorPrice - nearEdge) / p.atrAbs;
}

/** First bar that trades into the entry zone, in hours from the plan's close. */
function hoursToFill(p: Plan, bars: Bar[], fromT: number, windowDays = 14): number | null {
  for (const b of bars) {
    if (b.t <= fromT) continue;
    if (b.t - fromT > windowDays * 86_400_000) return null;
    if (b.low <= p.entryHigh && b.high >= p.entryLow) return (b.t - fromT) / 3_600_000;
  }
  return null;
}

function main() {
  const mw: MarketWideData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "MARKET.json"), "utf8"));
  const assets = (["BTC", "ETH"] as const).map((a) => ({
    data: JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${a}.json`), "utf8")) as RawAssetData,
  }));

  const records: DayRecord[] = [];
  const barsByAsset = new Map<string, Bar[]>();
  for (const { data } of assets) {
    records.push(...replayAsset(data, mw));
    barsByAsset.set(data.asset, data.futuresKlines as unknown as Bar[]);
  }

  const withPlan = records.filter((r) => r.swingPlan);
  const plans = withPlan.map((r) => r.swingPlan!);

  const atMarket = plans.filter(isAtMarket);
  const pullback = plans.filter((p) => !isAtMarket(p));
  const inside = plans.filter((p) => p.anchorPrice >= p.entryLow && p.anchorPrice <= p.entryHigh);

  const fills = withPlan
    .map((r) => hoursToFill(r.swingPlan!, barsByAsset.get(r.asset) ?? [], r.t))
    .filter((h): h is number => h !== null);

  console.log("=== SWING PLAN CENSUS ===");
  console.log(`total plans                      ${plans.length}`);
  console.log(`  at-market fallback             ${atMarket.length} (${f1(pct(atMarket.length, plans.length))}%)`);
  console.log(`  structural pullback            ${pullback.length} (${f1(pct(pullback.length, plans.length))}%)`);
  console.log(`  price ALREADY INSIDE zone      ${inside.length} (${f1(pct(inside.length, plans.length))}%)`);
  console.log("");
  console.log(`median standoff (all)            ${f2(q(plans.map(standoffAtr), 0.5))} ATR`);
  console.log(`median standoff (pullback only)  ${f2(q(pullback.map(standoffAtr), 0.5))} ATR`);
  console.log(`fill rate (14d window)           ${f1(pct(fills.length, plans.length))}%`);
  console.log(`median hours to fill             ${f1(q(fills, 0.5))}h`);
  console.log("");

  const dir = (d: "long" | "short") => plans.filter((p) => p.direction === d).length;
  console.log(`long / short                     ${dir("long")} / ${dir("short")}`);
  const byAsset = (a: string) => withPlan.filter((r) => r.asset === a).length;
  console.log(`BTC / ETH                        ${byAsset("BTC")} / ${byAsset("ETH")}`);
  console.log("");

  console.log("plans by regime");
  const regimes = new Map<string, number>();
  for (const r of withPlan) {
    const key = r.regimeTags?.join(" · ") || "unlabelled";
    regimes.set(key, (regimes.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...regimes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(38)} ${v}`);
  }
}

main();
