/**
 * WHAT THE ADAPTIVE PIVOT ACTUALLY CHANGED.
 *
 * `scripts/audit/shortBook.ts` found the defect: `verdictFromScore` pivots on
 * a hard 50 while the composite's own median is 41, so 61.9% of days shipped
 * a bearish verdict and those bearish days preceded a +0.326% RISE. 9.1.0
 * recentres every score against a point-in-time expanding median of its own
 * history (src/lib/signals/scorePivots.ts). This measures the result against
 * the same replay with the pivots switched off, which is the 9.0.0 engine.
 *
 * The comparison is BETWEEN TWO REPLAYS, so it is not a subset split — the
 * same dates appear in both arms and the same block bootstrap over the date
 * axis applies, with the difference re-formed inside every replicate rather
 * than assembled from two standard errors afterwards.
 *
 * THE CONTROL IS GENERATED, NOT COPIED. An earlier version of this file said
 * to `cp results.json` aside as the baseline, and 9.0.0's own entry records
 * what that costs: the results.json on disk had been produced by an older
 * engine, and comparing against it credited a change with 282 action flips
 * belonging to its predecessor. `--pivots=off` re-runs the CURRENT code with
 * only the thing under test removed, so the two arms differ by one variable.
 *
 * Usage — all three arms from the same tree, in this order:
 *   npx tsx scripts/backtest/run.ts                                        # 9.1.0 point-in-time -> results.json (also writes the artifact)
 *   npx tsx scripts/backtest/run.ts --pivots=off     --out=results-900.json     # the 9.0.0 control
 *   npx tsx scripts/backtest/run.ts --pivots=shipped --out=results-shipped.json # what live will do
 *   npx tsx scripts/audit/pivotEffect.ts scripts/backtest/data/results-900.json
 *
 * Read-only. Regenerates nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Trade {
  side: "long" | "short";
  outcome: string;
  netReturnPct: number;
}

interface Row {
  asset: string;
  date: string;
  action: string;
  biasScore: number | null;
  biasRawScore?: number | null;
  biasVerdict: string | null;
  categories: Array<{ category: string; score: number; rawScore?: number; verdict: string }>;
  trade: Trade | null;
  forwardReturn7d: number | null;
}

const baselinePath = process.argv[2] ?? resolve("scripts/backtest/data/results-900.json");
const load = (p: string): Row[] => JSON.parse(readFileSync(p, "utf8"));
const before = load(baselinePath);
const after = load(resolve("scripts/backtest/data/results.json"));

/* Seeded — Math.random() would make this irreproducible across runs. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const BLOCK_DAYS = 10;
const DRAWS = 4000;

const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * One row per (asset, date), carrying both arms — so a statistic that
 * compares them is paired by construction and the block bootstrap resamples
 * the PAIR. Two independently-resampled replays would not be comparable:
 * they share every date, and treating them as independent is exactly the
 * quadrature error that turned a t of -0.92 into -4.09 on the veto audit.
 */
interface Paired {
  asset: string;
  date: string;
  b: Row;
  a: Row;
}

const key = (r: Row) => `${r.asset}|${r.date}`;
const afterByKey = new Map(after.map((r) => [key(r), r]));
const paired: Paired[] = before
  .map((b) => {
    const a = afterByKey.get(key(b));
    return a ? { asset: b.asset, date: b.date, b, a } : null;
  })
  .filter((x): x is Paired => x !== null);

if (paired.length !== before.length || paired.length !== after.length) {
  console.log(
    `[warn] ${before.length} baseline rows and ${after.length} current rows joined to ${paired.length} pairs — the two replays do not cover the same days.`
  );
}

/**
 * Block bootstrap over the DATE axis, both assets drawn together so
 * cross-sectional correlation is absorbed, block length >= the 7d forward
 * horizon so overlap is absorbed too. `stat` sees a whole resampled panel
 * and returns one number, which is how a difference between two arms — or
 * between two subsets of one arm — gets re-formed inside every replicate.
 */
function bootstrap(
  pool: Paired[],
  stat: (sample: Paired[]) => number | null,
  seed: number
): { point: number; se: number; t: number } {
  const dates = [...new Set(pool.map((r) => r.date))].sort();
  const byDate = new Map<string, Paired[]>();
  for (const r of pool) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const blocks: Paired[][] = [];
  for (let i = 0; i + BLOCK_DAYS <= dates.length; i += BLOCK_DAYS) {
    blocks.push(dates.slice(i, i + BLOCK_DAYS).flatMap((d) => byDate.get(d) ?? []));
  }
  const point = stat(pool);
  const rand = lcg(seed);
  const reps: number[] = [];
  for (let d = 0; d < DRAWS; d++) {
    const sample: Paired[] = [];
    for (let k = 0; k < blocks.length; k++) sample.push(...blocks[Math.floor(rand() * blocks.length)]);
    const s = stat(sample);
    if (s !== null) reps.push(s);
  }
  const m = mean(reps);
  const se = Math.sqrt(mean(reps.map((x) => (x - m) ** 2)));
  return { point: point ?? NaN, se, t: (point ?? NaN) / se };
}

/** Mean forward 7d return over the rows whose verdict in `arm` matches. */
const fwdFor = (arm: "a" | "b", verdict: string) => (sample: Paired[]) => {
  const v = sample.filter((p) => p[arm].biasVerdict === verdict && p[arm].forwardReturn7d !== null);
  return v.length ? mean(v.map((p) => p[arm].forwardReturn7d as number)) : null;
};

/** bullish-minus-bearish separation within one arm, re-formed per replicate. */
const separation = (arm: "a" | "b") => (sample: Paired[]) => {
  const bull = fwdFor(arm, "bullish")(sample);
  const bear = fwdFor(arm, "bearish")(sample);
  return bull === null || bear === null ? null : bull - bear;
};

console.log(`\n=== ADAPTIVE PIVOT: 9.0.0 vs 9.1.0 ===`);
console.log(`${paired.length} paired asset-days, ${BLOCK_DAYS}-day blocks, ${DRAWS} draws, BTC+ETH together\n`);

/* ── 1. Where the score sits ─────────────────────────────────────────────── */
console.log("── 1. Does 50 mean anything now? ──");
console.log("The defect in one line: a threshold at 50 on a distribution centred at 41.\n");
console.log("scope                     median   %below 50    (target: 50, and near 50%)");
for (const asset of ["BTC", "ETH"]) {
  const rows = paired.filter((p) => p.asset === asset && p.a.biasScore !== null);
  for (const [arm, label] of [
    ["b", "9.0.0"],
    ["a", "9.1.0"],
  ] as const) {
    const s = rows.map((p) => p[arm].biasScore as number);
    const belowPct = (100 * s.filter((x) => x < 50).length) / s.length;
    console.log(
      `${asset} composite ${label}       ${String(median(s)).padStart(4)}      ${belowPct.toFixed(1).padStart(5)}%`
    );
  }
  const cats = new Set(rows.flatMap((p) => p.a.categories.map((c) => c.category)));
  for (const c of [...cats].sort()) {
    for (const [arm, label] of [
      ["b", "9.0.0"],
      ["a", "9.1.0"],
    ] as const) {
      const s = rows.flatMap((p) => p[arm].categories.filter((x) => x.category === c).map((x) => x.score));
      if (!s.length) continue;
      const belowPct = (100 * s.filter((x) => x < 50).length) / s.length;
      console.log(
        `  ${asset} ${c.padEnd(15)} ${label} ${String(median(s)).padStart(4)}      ${belowPct.toFixed(1).padStart(5)}%`
      );
    }
  }
}

/* ── 2. Verdict mix ──────────────────────────────────────────────────────── */
console.log("\n── 2. What the engine says, and what happened next ──");
console.log("verdict     arm      n      share    fwd 7d");
for (const v of ["bullish", "neutral", "bearish"]) {
  for (const [arm, label] of [
    ["b", "9.0.0"],
    ["a", "9.1.0"],
  ] as const) {
    const rows = paired.filter((p) => p[arm].biasVerdict === v);
    const fwd = rows.map((p) => p[arm].forwardReturn7d).filter((x): x is number => x !== null);
    console.log(
      `${v.padEnd(11)} ${label}  ${String(rows.length).padStart(5)}   ${((100 * rows.length) / paired.length).toFixed(1).padStart(5)}%   ${fwd.length ? pct(mean(fwd)) : "—"}`
    );
  }
}

/* ── 3. Separation ───────────────────────────────────────────────────────── */
console.log("\n── 3. Bullish-minus-bearish separation — the number that matters ──");
console.log("A verdict is only worth publishing if the two directions precede different outcomes.\n");
const sepBefore = bootstrap(paired, separation("b"), 20260913);
const sepAfter = bootstrap(paired, separation("a"), 20260913);
console.log(`9.0.0 (hard 50)       ${pct(sepBefore.point)}   SE ${sepBefore.se.toFixed(3)}   t = ${sepBefore.t.toFixed(2)}`);
console.log(`9.1.0 (own history)   ${pct(sepAfter.point)}   SE ${sepAfter.se.toFixed(3)}   t = ${sepAfter.t.toFixed(2)}`);

/*
 * The improvement is the difference of two separations measured on the SAME
 * dates. Re-formed inside each replicate for the same reason everything else
 * here is: the two arms are not independent samples.
 */
const delta = bootstrap(
  paired,
  (s) => {
    const a = separation("a")(s);
    const b = separation("b")(s);
    return a === null || b === null ? null : a - b;
  },
  20260913
);
console.log(`improvement           ${pct(delta.point)}   SE ${delta.se.toFixed(3)}   t = ${delta.t.toFixed(2)}`);
console.log(
  "\nThe improvement's own t is the honest one. Two separations both measured on\n" +
    "the same 1448 days share most of their sampling noise, so the gap between\n" +
    "them is estimated far better than either level is."
);

/* ── 4. The book ─────────────────────────────────────────────────────────── */
console.log("\n── 4. The trade book this produced ──");
console.log("side     arm      n     expectancy   profit factor");
for (const side of ["long", "short"] as const) {
  for (const [arm, label] of [
    ["b", "9.0.0"],
    ["a", "9.1.0"],
  ] as const) {
    const t = paired.map((p) => p[arm].trade).filter((x): x is Trade => x?.side === side);
    const wins = t.filter((x) => x.netReturnPct > 0).reduce((s, x) => s + x.netReturnPct, 0);
    const losses = -t.filter((x) => x.netReturnPct < 0).reduce((s, x) => s + x.netReturnPct, 0);
    console.log(
      `${side.padEnd(8)} ${label}  ${String(t.length).padStart(4)}   ${t.length ? pct(mean(t.map((x) => x.netReturnPct))) : "—"}     ${losses > 0 ? (wins / losses).toFixed(3) : "—"}`
    );
  }
}

const bookDelta = bootstrap(
  paired,
  (s) => {
    const a = s.map((p) => p.a.trade).filter((x): x is Trade => x !== null);
    const b = s.map((p) => p.b.trade).filter((x): x is Trade => x !== null);
    return a.length && b.length ? mean(a.map((x) => x.netReturnPct)) - mean(b.map((x) => x.netReturnPct)) : null;
  },
  20260913
);
console.log(
  `\nwhole book, 9.1.0 minus 9.0.0: ${pct(bookDelta.point)}   SE ${bookDelta.se.toFixed(3)}   t = ${bookDelta.t.toFixed(2)}`
);
console.log(
  "READ THIS LAST AND TRUST IT LEAST. The book is an in-sample count of trades\n" +
    "the engine took on days it also chose, so it moves for reasons that have\n" +
    "nothing to do with whether the verdicts got better — see the 8.0.0 entry in\n" +
    "scripts/backtest/version.ts, where the record improved and that was NOT the\n" +
    "evidence. Section 3 is the claim; this is a consequence of it."
);

/* ── 5. Window sensitivity ───────────────────────────────────────────────── */
console.log("\n── 5. Sensitivity of the estimator choice ──");
console.log(
  "READ THIS AS A SENSITIVITY CHECK, NOT A SELECTION PROCEDURE. Expanding was\n" +
    "chosen because the pivot describes the ENGINE, whose distribution is fixed\n" +
    "for as long as ENGINE_VERSION is, and because it needs no fitted window\n" +
    "length. Reading a length off the `sep` column would be picking a constant\n" +
    "off an outcome table, which is the thing this codebase keeps catching.\n" +
    "It is printed so the cost of that choice is visible: shorter windows centre\n" +
    "the score better and separate worse, monotonically.\n"
);
const rawOf = (p: Paired) => p.b.biasScore as number; // 9.0.0 score IS the raw score
console.log("window       n   median  %bear  %bull   bearFwd   bullFwd      sep");
for (const window of [90, 180, 365, 545, 730, Infinity]) {
  const out: Array<{ v: string; fwd: number | null }> = [];
  for (const asset of ["BTC", "ETH"]) {
    const rows = paired.filter((p) => p.asset === asset && p.b.biasScore !== null).sort((x, y) => (x.date < y.date ? -1 : 1));
    const hist: number[] = [];
    for (const p of rows) {
      const w = hist.slice(Math.max(0, hist.length - (window === Infinity ? hist.length : window)));
      const piv = w.length >= 30 ? median(w) : 50;
      const s = Math.max(0, Math.min(100, Math.round(rawOf(p) - piv + 50)));
      out.push({ v: s >= 56 ? "bullish" : s <= 44 ? "bearish" : "neutral", fwd: p.b.forwardReturn7d });
      hist.push(rawOf(p));
    }
  }
  const scores = out.length;
  const bear = out.filter((o) => o.v === "bearish");
  const bull = out.filter((o) => o.v === "bullish");
  const bearFwd = mean(bear.map((o) => o.fwd).filter((x): x is number => x !== null));
  const bullFwd = mean(bull.map((o) => o.fwd).filter((x): x is number => x !== null));
  const label = window === Infinity ? "expanding" : String(window);
  console.log(
    `${label.padEnd(9)} ${String(scores).padStart(5)}   ${"—".padStart(5)}  ${((100 * bear.length) / scores).toFixed(1).padStart(5)}  ${((100 * bull.length) / scores).toFixed(1).padStart(5)}   ${pct(bearFwd).padStart(8)}  ${pct(bullFwd).padStart(8)}  ${pct(bullFwd - bearFwd).padStart(8)}`
  );
}
console.log(
  "\n(This section applies ONE pivot, to the composite only, so it isolates the\n" +
    "window choice. The shipped 9.1.0 recentres the categories too, which is why\n" +
    "its section-3 numbers are not the `expanding` row here.)"
);

/* ── 6. The measured engine vs the engine that will run ──────────────────── */
/*
 * Everything above measures the POINT-IN-TIME arm, which is the only arm with
 * no look-ahead and therefore the only one whose separation is evidence. But
 * live does not walk a history — it reads the committed artifact, which is
 * the pivot set the walk ENDED on. Those two engines are not the same one
 * whenever a scope qualified partway through and no longer qualifies at the
 * end: leadingDrivers did exactly that, so a stretch of the honest arm was
 * scored with a pivot the artifact does not contain.
 *
 * This section is not a second measurement of the fix — the shipped arm is
 * contaminated by construction, since its pivots were estimated from the days
 * it is scoring. It measures the DISTANCE between what I measured and what
 * will ship. A large distance would mean the section-3 result does not
 * describe the deployed engine, which is a reason not to deploy it.
 *
 * Requires: npx tsx scripts/backtest/run.ts --pivots=shipped --out=results-shipped.json
 */
let shipped: Row[] | null = null;
try {
  shipped = load(resolve("scripts/backtest/data/results-shipped.json"));
} catch {
  shipped = null;
}

console.log("\n── 6. Does the shipped artifact reproduce the measured engine? ──");
if (!shipped) {
  console.log(
    "results-shipped.json absent — run:\n" +
      "  npx tsx scripts/backtest/run.ts --pivots=shipped --out=results-shipped.json"
  );
} else {
  const shippedByKey = new Map(shipped.map((r) => [key(r), r]));
  /* b = point-in-time (the measured engine), a = shipped (what live does). */
  const gapPool: Paired[] = paired
    .map((p) => {
      const s = shippedByKey.get(`${p.asset}|${p.date}`);
      return s ? { asset: p.asset, date: p.date, b: p.a, a: s } : null;
    })
    .filter((x): x is Paired => x !== null);

  const disagree = gapPool.filter((p) => p.a.biasVerdict !== p.b.biasVerdict);
  console.log(
    `${gapPool.length} paired asset-days; verdicts differ on ${disagree.length} (${((100 * disagree.length) / gapPool.length).toFixed(1)}%).`
  );
  const scoreGap = gapPool
    .filter((p) => p.a.biasScore !== null && p.b.biasScore !== null)
    .map((p) => Math.abs((p.a.biasScore as number) - (p.b.biasScore as number)));
  console.log(
    `composite score |gap|: median ${median(scoreGap)}, mean ${mean(scoreGap).toFixed(2)}, max ${Math.max(...scoreGap)} points.`
  );

  console.log("\nverdict     arm            n      share    fwd 7d");
  for (const v of ["bullish", "neutral", "bearish"]) {
    for (const [arm, label] of [
      ["b", "point-in-time"],
      ["a", "shipped      "],
    ] as const) {
      const rows = gapPool.filter((p) => p[arm].biasVerdict === v);
      const fwd = rows.map((p) => p[arm].forwardReturn7d).filter((x): x is number => x !== null);
      console.log(
        `${v.padEnd(11)} ${label}  ${String(rows.length).padStart(5)}   ${((100 * rows.length) / gapPool.length).toFixed(1).padStart(5)}%   ${fwd.length ? pct(mean(fwd)) : "—"}`
      );
    }
  }

  const sepPit = bootstrap(gapPool, separation("b"), 20260913);
  const sepShip = bootstrap(gapPool, separation("a"), 20260913);
  const gapDelta = bootstrap(
    gapPool,
    (s) => {
      const a = separation("a")(s);
      const b = separation("b")(s);
      return a === null || b === null ? null : a - b;
    },
    20260913
  );
  console.log(`\npoint-in-time         ${pct(sepPit.point)}   SE ${sepPit.se.toFixed(3)}   t = ${sepPit.t.toFixed(2)}`);
  console.log(`shipped artifact      ${pct(sepShip.point)}   SE ${sepShip.se.toFixed(3)}   t = ${sepShip.t.toFixed(2)}`);
  console.log(`gap (shipped − pit)   ${pct(gapDelta.point)}   SE ${gapDelta.se.toFixed(3)}   t = ${gapDelta.t.toFixed(2)}`);

  /*
   * THE NUMBER THAT DECIDES WHETHER TO SHIP.
   *
   * Section 3's improvement is measured on the point-in-time arm, which is
   * the honest arm but not the deployed one. This is the same statistic with
   * the deployed arm substituted: the control against what the artifact will
   * actually do. Same dates, same pairing, difference re-formed per replicate.
   */
  const deployPool: Paired[] = paired
    .map((p) => {
      const s = shippedByKey.get(`${p.asset}|${p.date}`);
      return s ? { asset: p.asset, date: p.date, b: p.b, a: s } : null;
    })
    .filter((x): x is Paired => x !== null);
  const deployDelta = bootstrap(
    deployPool,
    (s) => {
      const a = separation("a")(s);
      const b = separation("b")(s);
      return a === null || b === null ? null : a - b;
    },
    20260913
  );
  console.log(
    `\nDEPLOYED improvement (shipped − 9.0.0):  ${pct(deployDelta.point)}   SE ${deployDelta.se.toFixed(3)}   t = ${deployDelta.t.toFixed(2)}`
  );
  console.log(
    `  vs section 3's measured improvement:   ${pct(delta.point)}   SE ${delta.se.toFixed(3)}   t = ${delta.t.toFixed(2)}`
  );

  /*
   * WHAT THE CHANGELOG ACTUALLY CLAIMS, PRINTED HERE SO IT IS QUOTABLE.
   *
   * Separation is flat, so the case for shipping rests on the LEGS, not on
   * the spread between them: the bearish verdict stops preceding a rise. That
   * is a per-leg paired delta and it was previously computed out-of-band,
   * which meant the version.ts entry quoted three numbers no script printed.
   * Every number the entry claims is now emitted by this block.
   *
   * Each delta is re-formed inside the replicate, same as everything else —
   * the two arms share all 2,896 days and differencing them afterwards from
   * two standard errors is the quadrature error this file exists to avoid.
   */
  const legDelta = (verdict: string) =>
    bootstrap(
      deployPool,
      (s) => {
        const a = fwdFor("a", verdict)(s);
        const b = fwdFor("b", verdict)(s);
        return a === null || b === null ? null : a - b;
      },
      20260913
    );
  const shareDelta = bootstrap(
    deployPool,
    (s) => {
      if (!s.length) return null;
      const share = (arm: "a" | "b") => (100 * s.filter((p) => p[arm].biasVerdict === "bearish").length) / s.length;
      return share("a") - share("b");
    },
    20260913
  );
  const legFwd = (arm: "a" | "b", verdict: string) => fwdFor(arm, verdict)(deployPool);
  const bearShare = (arm: "a" | "b") =>
    (100 * deployPool.filter((p) => p[arm].biasVerdict === "bearish").length) / deployPool.length;

  console.log("\nthe claim, per leg — control against shipped, paired:");
  console.log("statistic                     control    shipped        d       SE        t");
  for (const v of ["bearish", "bullish"]) {
    const d = legDelta(v);
    console.log(
      `${(v + " verdict, mean fwd 7d").padEnd(28)} ${pct(legFwd("b", v) as number).padStart(8)}  ${pct(legFwd("a", v) as number).padStart(8)}  ${pct(d.point).padStart(8)}   ${d.se.toFixed(3).padStart(6)}  ${d.t.toFixed(2).padStart(7)}`
    );
  }
  console.log(
    `${"share of days called bearish".padEnd(28)} ${bearShare("b").toFixed(1).padStart(7)}%  ${bearShare("a").toFixed(1).padStart(7)}%  ${shareDelta.point.toFixed(1).padStart(7)}pp   ${shareDelta.se.toFixed(3).padStart(6)}  ${shareDelta.t.toFixed(2).padStart(7)}`
  );

  /*
   * The DEPLOYED book. Section 4 prints the point-in-time arm's book, which
   * is not the one that ships; quoting it beside a deployed separation would
   * mix the arms. Same caveat as section 4 and it is not weaker here: this is
   * in-sample and it is a consequence of the claim, not evidence for it.
   */
  console.log("\nthe deployed book (in-sample, a consequence — not the evidence):");
  console.log("side     arm         n     expectancy   profit factor");
  for (const side of ["long", "short"] as const) {
    for (const [arm, label] of [
      ["b", "control"],
      ["a", "shipped"],
    ] as const) {
      const t = deployPool.map((p) => p[arm].trade).filter((x): x is Trade => x?.side === side);
      const wins = t.filter((x) => x.netReturnPct > 0).reduce((s, x) => s + x.netReturnPct, 0);
      const losses = -t.filter((x) => x.netReturnPct < 0).reduce((s, x) => s + x.netReturnPct, 0);
      console.log(
        `${side.padEnd(8)} ${label}  ${String(t.length).padStart(4)}   ${t.length ? pct(mean(t.map((x) => x.netReturnPct))) : "—"}     ${losses > 0 ? (wins / losses).toFixed(3) : "—"}`
      );
    }
  }

  /*
   * Which scopes the point-in-time arm actually recentred, and for how long.
   * A scope that was corrected for most of the walk and then stopped
   * qualifying is the whole explanation for a gap between the two arms.
   */
  console.log("\nwhat the point-in-time arm recentred (score !== rawScore):");
  const catStats = new Map<string, { n: number; hit: number; shifts: number[]; first: string; last: string }>();
  for (const p of gapPool) {
    for (const c of p.b.categories) {
      if (c.rawScore === undefined) continue;
      const e = catStats.get(c.category) ?? { n: 0, hit: 0, shifts: [], first: "", last: "" };
      e.n++;
      if (c.score !== c.rawScore) {
        e.hit++;
        e.shifts.push(c.score - c.rawScore);
        if (!e.first || p.date < e.first) e.first = p.date;
        if (p.date > e.last) e.last = p.date;
      }
      catStats.set(c.category, e);
    }
  }
  for (const [c, e] of [...catStats].sort()) {
    const inArtifact = shipped.length > 0;
    console.log(
      `  ${c.padEnd(16)} ${String(e.hit).padStart(5)}/${e.n} days (${((100 * e.hit) / e.n).toFixed(1)}%), median shift ${e.shifts.length ? median(e.shifts) : "—"}${e.hit ? `, ${e.first} -> ${e.last}` : ""}${inArtifact ? "" : ""}`
    );
  }
  console.log(
    "\nA scope whose window ENDS before the walk does is the gap. It was corrected\n" +
      "for that stretch under point-in-time and is absent from the final artifact,\n" +
      "so live will never apply it. Section 3's separation belongs to an engine\n" +
      "that includes it; the deployed line above belongs to the one that does not."
  );
}
console.log("");
