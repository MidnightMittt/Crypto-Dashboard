import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DayRecord } from "./run";
import { detectableDifference, nonOverlappingByTime } from "./overlap";

/**
 * CROSS-ASSET RESEARCH ENGINE — how large a universe is actually required
 * before statistical power becomes meaningful? Research only; writes a
 * markdown report and changes nothing.
 *
 * Three phases of research (weekly regime, harmonics, regime persistence)
 * independently hit the same wall, and the brief's proposed fix is to widen
 * the asset universe. That fix is right in spirit but the naive version of
 * it — "add more crypto" — does almost nothing, and this script exists to
 * show why with measured numbers rather than assert it.
 *
 * ── The governing arithmetic ────────────────────────────────────────────
 *
 * Correlated assets are not independent observations. For N assets with
 * average pairwise correlation rho, the effective number of independent
 * cross-sectional units is
 *
 *     N_eff = N / (1 + (N - 1) * rho)
 *
 * which is the standard variance-of-an-equally-weighted-average result. The
 * consequence that matters: as N grows, N_eff does not. It ASYMPTOTES at
 * 1/rho. High correlation imposes a hard ceiling on how much information a
 * universe can ever contain, no matter how many tickers are added to it.
 *
 * Everything below follows from that one fact.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const HOUR_MS = 3_600_000;

/** N / (1 + (N-1)rho). Asymptotes at 1/rho. */
function effectiveAssets(n: number, rho: number): number {
  if (n <= 1) return n;
  const r = Math.max(0, Math.min(0.999, rho));
  return n / (1 + (n - 1) * r);
}

/** Independent time windows one asset contributes over `years` at a given holding period. */
function independentWindows(years: number, holdingDays: number): number {
  return (years * 365) / holdingDays;
}

interface Scenario {
  name: string;
  assets: number;
  rho: number;
  years: number;
  /** MEASURED means rho came from this repo's own data; ASSUMED means it is a literature/experience estimate and is varied in the sensitivity table below. */
  rhoSource: "MEASURED" | "ASSUMED";
  note: string;
}

const HOLDING_DAYS = 7;

const f2 = (x: number) => x.toFixed(2);
const f1 = (x: number) => x.toFixed(1);
const pp = (x: number) => `${(100 * x).toFixed(1)}pp`;

function main() {
  const lines: string[] = [];
  const say = (l = "") => { lines.push(l); console.log(l); };

  say("# Cross-Asset Research Engine — Statistical Power Analysis");
  say("");
  say("How many assets are required before statistical power becomes meaningful? Answered with the repo's own measured correlation, a model validated against the repo's own measured sample size, and an explicit separation of what is measured from what is assumed.");
  say("");

  // ── 1. Measure the governing correlation ─────────────────────────────
  const records: DayRecord[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "results.json"), "utf8"));
  const byDate = new Map<string, Record<string, number>>();
  for (const r of records) {
    const e = byDate.get(r.date) ?? {};
    e[r.asset] = r.priceChange24hPct;
    byDate.set(r.date, e);
  }
  const paired = [...byDate.values()].filter((x) => x.BTC != null && x.ETH != null);
  const btc = paired.map((x) => x.BTC);
  const eth = paired.map((x) => x.ETH);
  const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
  const mb = mean(btc), me = mean(eth);
  let cov = 0, vb = 0, ve = 0;
  for (let i = 0; i < btc.length; i++) {
    cov += (btc[i] - mb) * (eth[i] - me);
    vb += (btc[i] - mb) ** 2;
    ve += (eth[i] - me) ** 2;
  }
  const rhoMeasured = cov / Math.sqrt(vb * ve);

  say("## 1. The governing number, measured");
  say("");
  say(`BTC/ETH daily return correlation over ${paired.length} paired days: **rho = ${f2(rhoMeasured)}**.`);
  say("");
  say(`Because N_eff asymptotes at 1/rho, that correlation caps the crypto universe at **${f2(1 / rhoMeasured)} effective assets — permanently.**`);
  say("");
  say("| Crypto assets | N_eff |");
  say("|---|---|");
  for (const n of [2, 5, 10, 25, 50, 100, 500]) {
    say(`| ${n} | ${f2(effectiveAssets(n, rhoMeasured))} |`);
  }
  say("");
  say(`The current two-asset universe already delivers ${f2(effectiveAssets(2, rhoMeasured))} of a maximum ${f2(1 / rhoMeasured)} — **${f1((100 * effectiveAssets(2, rhoMeasured)) / (1 / rhoMeasured))}% of everything crypto can ever provide.** Adding 500 altcoins would move it by roughly ${f2(effectiveAssets(500, rhoMeasured) - effectiveAssets(2, rhoMeasured))} effective assets. Altcoins typically correlate to BTC even more tightly than ETH does (0.85-0.95), so in practice the gain would be smaller still.`);
  say("");

  // ── 2. Validate the model against measured reality ───────────────────
  const tradeRows = records.filter((r) => r.trade !== null);
  let measuredIndependent = 0;
  for (const asset of ["BTC", "ETH"] as const) {
    measuredIndependent += nonOverlappingByTime(
      tradeRows.filter((r) => r.asset === asset),
      (r) => r.t,
      (r) => r.t + r.trade!.hoursHeld * HOUR_MS
    ).length;
  }
  const years = (records[records.length - 1].t - records[0].t) / (365 * 24 * HOUR_MS);
  const predicted = effectiveAssets(2, rhoMeasured) * independentWindows(years, HOLDING_DAYS);

  say("## 2. Model validation — does this arithmetic describe reality?");
  say("");
  say(`A planning model nobody has checked is a guess with equations. Predicted independent observations for the CURRENT universe: ${f2(effectiveAssets(2, rhoMeasured))} effective assets x ${f1(independentWindows(years, HOLDING_DAYS))} independent ${HOLDING_DAYS}-day windows over ${f1(years)} years = **${f1(predicted)}**.`);
  say("");
  say(`Directly measured by greedy non-overlap on real resolved trades: **${measuredIndependent}**.`);
  say("");
  say(`Same order of magnitude, model ${predicted < measuredIndependent ? "conservative" : "optimistic"} by ${f2(Math.max(predicted, measuredIndependent) / Math.min(predicted, measuredIndependent))}x. The measured figure is the more generous of the two because greedy per-asset selection ignores the cross-asset correlation the model charges for. Close enough to plan with, and the direction of the error is the safe one.`);
  say("");

  // ── 3. Where the current engine sits ─────────────────────────────────
  const currentFloor = detectableDifference(measuredIndependent / 2);
  say("## 3. What the current universe can and cannot resolve");
  say("");
  say(`With the ${measuredIndependent} MEASURED independent observations split across two arms, the smallest win-rate difference detectable at 80% power is **${pp(currentFloor)}**. The scenario table below uses the model's more conservative ${f1(predicted)} instead, giving ${pp(detectableDifference(predicted / 2))} — the two differ only because the model charges for cross-asset correlation that the greedy per-asset measurement ignores. Both are the same story; the honest range for the current engine is ${pp(currentFloor)}-${pp(detectableDifference(predicted / 2))}.`);
  say("");
  say("For context on why that is the binding problem: a genuinely valuable trading edge is a 3-5pp improvement in win rate. The engine currently cannot distinguish a 5pp edge from noise. Every 'underpowered, cannot conclude' verdict across the last three phases traces to this single number.");
  say("");

  // ── 4. Scenarios ─────────────────────────────────────────────────────
  say("## 4. What different universes would actually buy");
  say("");
  say("Correlations marked ASSUMED are experience/literature estimates, not measured here — this repo holds no equity, bond, FX or commodity history to measure. They are varied in the sensitivity table in section 5, and no conclusion below depends on a precise value.");
  say("");

  const scenarios: Scenario[] = [
    { name: "Current (BTC + ETH)", assets: 2, rho: rhoMeasured, years: 4, rhoSource: "MEASURED", note: "Where we are." },
    { name: "Crypto broad (50 majors)", assets: 50, rho: 0.88, years: 4, rhoSource: "ASSUMED", note: "The naive fix. Altcoins are MORE correlated to BTC than ETH is." },
    { name: "+ US equity sectors (11 SPDRs)", assets: 13, rho: 0.55, years: 25, rhoSource: "ASSUMED", note: "Sector ETFs share heavy market beta, but 25 years of clean history." },
    { name: "+ Single-name equities (50, cross-sector)", assets: 52, rho: 0.45, years: 25, rhoSource: "ASSUMED", note: "Idiosyncratic risk lowers average pairwise correlation." },
    { name: "Multi-asset-class (equities, bonds, FX, commodities, crypto)", assets: 60, rho: 0.25, years: 25, rhoSource: "ASSUMED", note: "Bonds and FX are the genuine diversifiers." },
    { name: "Multi-asset-class, wide (150 instruments)", assets: 150, rho: 0.2, years: 30, rhoSource: "ASSUMED", note: "Practical ceiling for a solo research platform." },
  ];

  say("| Universe | Assets | rho | N_eff | Years | Independent obs | Detectable effect | vs today |");
  say("|---|---|---|---|---|---|---|---|");
  for (const s of scenarios) {
    const nEff = effectiveAssets(s.assets, s.rho);
    const obs = nEff * independentWindows(s.years, HOLDING_DAYS);
    const floor = detectableDifference(obs / 2);
    say(`| ${s.name} | ${s.assets} | ${f2(s.rho)}${s.rhoSource === "MEASURED" ? " *(measured)*" : ""} | ${f2(nEff)} | ${s.years} | ${f1(obs)} | ${pp(floor)} | ${f1(obs / predicted)}x |`);
  }
  say("");
  say("Reading the table:");
  say("");
  say(`- **Crypto broad is nearly worthless.** 50 crypto assets at rho=0.88 yields ${f2(effectiveAssets(50, 0.88))} effective assets against the current ${f2(effectiveAssets(2, rhoMeasured))}. Twenty-five times the data ingestion, storage and maintenance for a rounding error in power. This is the single most important result here.`);
  say(`- **History is doing more work than breadth.** Moving to 11 equity sector ETFs raises N_eff only modestly, but 25 years instead of 4 multiplies the time dimension by ~6x. Depth of history is cheaper and more powerful than width of universe.`);
  say(`- **Diversification across asset CLASSES is what compounds.** Bonds, FX and commodities are the components that actually drag average pairwise correlation down, and rho is the term that sets the ceiling.`);
  say("");

  // ── 5. Sensitivity ───────────────────────────────────────────────────
  say("## 5. Sensitivity — the conclusion does not depend on the assumed correlations");
  say("");
  say("Detectable effect for a 60-instrument, 25-year universe across a wide range of average pairwise correlation:");
  say("");
  say("| rho | N_eff | Independent obs | Detectable effect |");
  say("|---|---|---|---|");
  for (const rho of [0.1, 0.15, 0.2, 0.3, 0.4, 0.55, 0.7, 0.85]) {
    const nEff = effectiveAssets(60, rho);
    const obs = nEff * independentWindows(25, HOLDING_DAYS);
    say(`| ${f2(rho)} | ${f2(nEff)} | ${f1(obs)} | ${pp(detectableDifference(obs / 2))} |`);
  }
  say("");
  say("Across the entire plausible range the ordering never changes: any genuinely multi-class universe beats any crypto-only universe by a wide margin, and the gap is driven by rho rather than by asset count.");
  say("");

  // ── 6. Requirements ──────────────────────────────────────────────────
  say("## 6. Requirements to hit a given detectable effect");
  say("");
  say("Working backwards from the effect size worth detecting, at 25 years of history. Note the top row: a SINGLE instrument with 25 years of history already resolves a 10pp effect better than the current two-asset four-year universe does — history alone is that powerful.");
  say("");
  say("| Target detectable effect | Independent obs needed | rho=0.2 | rho=0.3 | rho=0.5 |");
  say("|---|---|---|---|---|");
  for (const target of [0.1, 0.07, 0.05, 0.03, 0.02]) {
    // detectableDifference(n) = 2.802*sqrt(0.5/n)  =>  n = 0.5*(2.802/target)^2 per arm
    const perArm = 0.5 * (2.802 / target) ** 2;
    const obsNeeded = perArm * 2;
    const assetsFor = (rho: number) => {
      const nEffNeeded = obsNeeded / independentWindows(25, HOLDING_DAYS);
      if (nEffNeeded >= 1 / rho) return "impossible at this rho";
      // invert N_eff = N/(1+(N-1)rho)
      const n = (nEffNeeded * (1 - rho)) / (1 - nEffNeeded * rho);
      const k = Math.max(1, Math.ceil(n));
      return `${k} asset${k === 1 ? "" : "s"}`;
    };
    say(`| ${pp(target)} | ${f1(obsNeeded)} | ${assetsFor(0.2)} | ${assetsFor(0.3)} | ${assetsFor(0.5)} |`);
  }
  say("");
  say("**\"impossible at this rho\"** is not a formatting artefact — it is the asymptote doing its work. Beyond a certain precision, no number of correlated instruments suffices and the only remaining levers are longer history or genuinely lower correlation.");
  say("");

  // ── 7. Recommendation ────────────────────────────────────────────────
  say("## 7. Recommended target universe");
  say("");
  say("Optimising for statistical power per unit of engineering effort, not for ticker count:");
  say("");
  say("| Tier | Instruments | Why |");
  say("|---|---|---|");
  say("| Equity sector ETFs | 11 US SPDR sectors | 25+ years of clean, free, survivorship-bias-free daily data. The single cheapest power increase available. |");
  say("| Broad indices | SPY, QQQ, IWM, EFA, EEM | Different beta profiles; EFA/EEM add geography. |");
  say("| Bonds | TLT, IEF, LQD, HYG | The strongest diversifiers on this list — frequently negatively correlated to equities. |");
  say("| Commodities | GLD, SLV, USO, DBA | Genuinely different drivers. |");
  say("| FX | 6 major pairs | Near-zero correlation to equities; deep history. |");
  say("| Crypto | BTC, ETH + 3-5 majors | Keep for the product; expect near-zero marginal research power. |");
  say("");
  say(`That is roughly 40 instruments at an estimated average pairwise rho near 0.25-0.30, over 25 years: about ${f1(effectiveAssets(40, 0.27) * independentWindows(25, HOLDING_DAYS))} independent observations, a detectable effect near ${pp(detectableDifference((effectiveAssets(40, 0.27) * independentWindows(25, HOLDING_DAYS)) / 2))}, roughly ${f1((effectiveAssets(40, 0.27) * independentWindows(25, HOLDING_DAYS)) / predicted)}x the current statistical resolution.`);
  say("");
  say("**Survivorship bias warning, since the brief listed it as a hazard to avoid:** single-name equities introduce it immediately — a universe of \"today's S&P 500\" silently conditions on having survived. ETFs and indices largely sidestep this, which is a second reason to start there rather than with single names.");
  say("");
  say("**The one-line answer to \"how many assets?\":** roughly 40, but the count is the wrong question. The right target is average pairwise correlation below ~0.3 and history beyond 20 years. A 40-instrument multi-class universe beats a 500-asset crypto universe by more than an order of magnitude.");

  const outPath = path.join(__dirname, "powerAnalysis.md");
  fs.writeFileSync(outPath, lines.join("\n"));
  console.log(`\n[powerAnalysis] wrote ${outPath}`);
}

main();
