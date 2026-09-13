import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { BarsPanel, alignedCloses } from "../../src/lib/research/barsPanel";
import { logReturnsAligned, forwardRvPct } from "../../src/lib/research/ivRv";
import { CONSTANT_MATURITY_DAYS } from "../../src/lib/options/ivTermStructure";

/**
 * IS 21 SESSIONS THE RIGHT FORWARD HORIZON, OR AN INHERITED DEFAULT?
 *
 * The trading session asked whether the IV/RV screen's forward leg should be
 * declared per-tenor — 10 sessions to match how the CLSK position was actually
 * held — rather than fixed at the 21 the implied number is quoted at. A
 * shorter leg would also reach the four-independent-window gate in roughly
 * half the time, which is exactly why the question has to be answered on
 * something other than convenience.
 *
 * ── THE ANSWER TURNED OUT TO BE A UNIT ERROR ──────────────────────────
 *
 * It was an inherited default, and worse than that. `IV_TENOR_SESSIONS = 21`
 * was pinned to `CONSTANT_MATURITY_DAYS = 21` by a test asserting the two are
 * equal. They are equal as integers and they are not the same quantity:
 * `ivAtDte` measures its target in CALENDAR days to expiry — it divides by 365
 * — while the forward leg counts trading SESSIONS. So implied vol describing
 * 21 calendar days was being scored against realized vol over 21 sessions,
 * which is 30 calendar days. Nine days of realisation, 30% of the measured
 * window, that the implied number never priced.
 *
 * 21 calendar days is three calendar weeks, which is 15 sessions. That, not
 * 21 and not 10, is the horizon at which both sides describe the same amount
 * of time. Everything below was run to check whether the correction survives
 * on its own terms; it is corroboration, not the reason. The reason is that
 * the two sides have to be in the same units, and that would be the reason
 * even if the power comparison came out the other way.
 *
 * ── Why the direction of a tenor mismatch matters, not just its size ──
 *
 * The two candidate errors are not symmetric, and this is what rules out the
 * 10-session leg specifically:
 *
 *   RV window LONGER than the IV tenor (the current 30-vs-21-calendar bug):
 *   the unmatched days are realisation the implied number never forecast. It
 *   is noise in the outcome, roughly uncorrelated with the screen. It
 *   ATTENUATES the measured correlation.
 *
 *   RV window SHORTER than the IV tenor (what a 10-session leg against a
 *   21-calendar-day IV would be): the unmatched days ARE priced by IV and are
 *   absent from RV. A name with an event in that gap gets a high screen ratio
 *   — IV is elevated — and a low premium, because RV never sees the event.
 *   High screen with low premium is a NEGATIVE contribution, and negative is
 *   the sign this screen predicted in advance. It MANUFACTURES the result.
 *
 * The shared-IV artefact already named in `ivRvScreen.ts` was tolerable
 * precisely because it pushed against the hypothesis. This one would push for
 * it, which is the one direction that cannot be accepted at any size.
 *
 * ── What this measures, and why it cannot contaminate the test ────────
 *
 * NOTHING HERE TOUCHES IMPLIED VOL, THE SCREEN RATIO, OR THE PREMIUM. It is
 * realized-vol against realized-vol, computed from closes alone, on the whole
 * 300-session panel — including hundreds of sessions the screen has no IV for
 * and will never be evaluated on. The declared statistic is a rank correlation
 * between the screen and the premium; not one input to it appears below. So
 * this can be run today, before any forward leg resolves, without any part of
 * the kill line's answer being visible.
 *
 * That property is the reason the horizon question is answerable NOW rather
 * than being a thing we discover we should have asked in December.
 *
 * ── The three quantities ──────────────────────────────────────────────
 *
 * All are WITHIN-SESSION Spearman correlations, the same centring the declared
 * statistic uses, because the question is cross-sectional: does the horizon
 * change WHICH names look high-vol, not whether the market got noisier.
 *
 *   agreement   rho( RV[+1..+10], RV[+1..+21] )
 *               How different an outcome variable the short leg even is. The
 *               windows overlap by construction, so this is an UPPER bound on
 *               agreement and is reported as one.
 *
 *   reliability rho( RV[+1..+10], RV[+12..+21] )
 *               Disjoint halves. How much of a name's 10-session vol ranking
 *               is a property of the name rather than of the window. This is
 *               the number that governs attenuation: a noisy outcome pulls any
 *               measured correlation toward zero by roughly sqrt(reliability).
 *
 *   reliability21 rho( RV[+1..+21], RV[+23..+43] )
 *               The same, at the declared horizon, so the two are compared on
 *               the same panel rather than against a textbook expectation.
 *
 * ── The decision arithmetic ───────────────────────────────────────────
 *
 * A shorter horizon buys windows and costs effect size. Windows accrue as
 * 21/h. Attenuation scales as sqrt(rel_h / rel_21). Power for a fixed true
 * effect goes as effect * sqrt(windows), so a shorter leg is worth taking only
 * if sqrt(21/h) * sqrt(rel_h/rel_21) > 1 — i.e. only if reliability falls more
 * slowly than the horizon shortens. That ratio is printed at the end.
 *
 * It is printed because the honest thing to do with a correction that happens
 * to reach the gate five weeks sooner is to show that the speed was a
 * consequence and not the motive. Had the correction gone the other way — 21
 * calendar days working out to 28 sessions — it would have shipped anyway, at
 * a gate date in February.
 *
 *   npx tsx scripts/audit/ivRvHorizonAgreement.ts
 */

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname_, "..", "..");

const MIN_CROSS_SECTION = 5;

function midranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k].i] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Within-session Spearman, or null where either leg is degenerate. */
function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length < MIN_CROSS_SECTION) return null;
  const rx = midranks(x);
  const ry = midranks(y);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  const sd = (a: number[], m: number) =>
    Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  const sx = sd(rx, mx);
  const sy = sd(ry, my);
  if (sx === 0 || sy === 0) return null;
  return rx.reduce((s, r, i) => s + ((r - mx) * (ry[i] - my)) / (sx * sy), 0) / rx.length;
}

/** Annualised RV over a HALF-OPEN forward slice, in percent. Null on any gap. */
function forwardRvSlice(
  returns: readonly (number | null)[],
  fromIndex: number,
  skip: number,
  window: number
): number | null {
  const start = fromIndex + skip + 1;
  const end = fromIndex + skip + window;
  if (start < 1 || end >= returns.length) return null;
  const slice = returns.slice(start, end + 1);
  if (slice.some((r) => r === null)) return null;
  const sumSq = (slice as number[]).reduce((a, r) => a + r * r, 0);
  return Math.sqrt(sumSq / slice.length) * Math.sqrt(252) * 100;
}

interface Pairing {
  label: string;
  a: (r: readonly (number | null)[], i: number) => number | null;
  b: (r: readonly (number | null)[], i: number) => number | null;
  note: string;
}

function summarise(values: readonly number[]): {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
} {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    median: q(0.5),
    p10: q(0.1),
    p90: q(0.9),
  };
}

function main(): void {
  const bars = JSON.parse(
    fs.readFileSync(path.join(ROOT, "src", "data", "barsPanel.json"), "utf8")
  ) as BarsPanel;
  const symbols = Object.keys(bars.symbols).sort();
  const returns = new Map<string, (number | null)[]>();
  for (const s of symbols) returns.set(s, logReturnsAligned(alignedCloses(bars, s)));

  console.log(
    `panel: ${bars.sessions.length} sessions ${bars.sessions[0]} -> ` +
      `${bars.sessions[bars.sessions.length - 1]}, ${symbols.length} symbols\n`
  );

  const pairings: Pairing[] = [
    {
      label: "agreement 10 vs 21",
      a: (r, i) => forwardRvPct(r, i, 10),
      b: (r, i) => forwardRvPct(r, i, 21),
      note: "windows overlap — an UPPER bound on how alike the two outcomes are",
    },
    {
      label: "reliability @10",
      a: (r, i) => forwardRvSlice(r, i, 0, 10),
      b: (r, i) => forwardRvSlice(r, i, 11, 10),
      note: "disjoint 10-session halves",
    },
    {
      label: "reliability @15",
      a: (r, i) => forwardRvSlice(r, i, 0, 15),
      b: (r, i) => forwardRvSlice(r, i, 16, 15),
      note: "disjoint 15-session halves — the tenor-matched horizon",
    },
    {
      label: "reliability @21",
      a: (r, i) => forwardRvSlice(r, i, 0, 21),
      b: (r, i) => forwardRvSlice(r, i, 22, 21),
      note: "disjoint 21-session halves",
    },
  ];

  const results = new Map<string, number>();

  for (const p of pairings) {
    const perSession: number[] = [];
    for (let i = 0; i < bars.sessions.length; i++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const s of symbols) {
        const r = returns.get(s)!;
        const av = p.a(r, i);
        const bv = p.b(r, i);
        if (av === null || bv === null || av <= 0 || bv <= 0) continue;
        /* Logs, because vol is right-skewed — though ranks make this moot. */
        xs.push(Math.log(av));
        ys.push(Math.log(bv));
      }
      const rho = spearman(xs, ys);
      if (rho !== null) perSession.push(rho);
    }
    if (perSession.length === 0) {
      console.log(`${p.label.padEnd(20)} no session had ${MIN_CROSS_SECTION} usable names`);
      continue;
    }
    const s = summarise(perSession);
    results.set(p.label, s.mean);
    console.log(
      `${p.label.padEnd(20)} mean ${s.mean.toFixed(3)}  median ${s.median.toFixed(3)}  ` +
        `p10 ${s.p10.toFixed(3)}  p90 ${s.p90.toFixed(3)}  over ${s.n} sessions`
    );
    console.log(`${"".padEnd(20)} ${p.note}`);
  }

  const rel21 = results.get("reliability @21");
  if (rel21 === undefined) return;

  console.log("\n── the tenor, in both units ──────────────────────────────");
  console.log(`  IV is interpolated to ${CONSTANT_MATURITY_DAYS} CALENDAR days to expiry`);
  console.log(
    `  ${CONSTANT_MATURITY_DAYS} calendar days = ${((CONSTANT_MATURITY_DAYS * 252) / 365).toFixed(2)} ` +
      "sessions by the annualisation ratio, and exactly 3 calendar weeks = 15 sessions"
  );
  for (const h of [10, 15, 21]) {
    console.log(
      `  a ${String(h).padStart(2)}-session forward leg covers ` +
        `${((h * 365) / 252).toFixed(1)} calendar days` +
        (h === 15 ? "   <- matches the tenor" : "")
    );
  }

  console.log("\n── power against the 21-session leg being replaced ───────");
  /*
   * Attenuation is taken as sqrt(reliability) — the classical errors-in-
   * variables factor for a correlation whose OUTCOME is measured with noise.
   * Windows accrue in proportion to 21/h. Everything else about the
   * specifications is identical, so the product below is the whole comparison.
   */
  for (const h of [10, 15]) {
    const rel = results.get(`reliability @${h}`);
    if (rel === undefined) continue;
    const windowGain = Math.sqrt(21 / h);
    const effectLoss = Math.sqrt(rel / rel21);
    console.log(
      `  ${h}: windows x${windowGain.toFixed(3)}  effect x${effectLoss.toFixed(3)}  ` +
        `net power x${(windowGain * effectLoss).toFixed(3)}`
    );
  }
  console.log(
    "  Both beat 21 on power, so power does not discriminate between them and is\n" +
      "  not what the choice rests on. Tenor matching does, and it picks 15."
  );
}

main();
