import {
  Hypothesis,
  meanVolume,
  panelBreadth,
  realisedVol,
  ret,
  trailingHigh,
} from "../../src/lib/research/signalLab";

/**
 * THE DECLARED FAMILY.
 *
 * Every entry below was written, with its direction, horizon, cost charge and
 * kill criteria, BEFORE the first run of this file. They are corrected
 * against each other as one family, which is the only reason any individual
 * result here is quotable.
 *
 * ONE PARAMETERISATION EACH. No entry sweeps a lookback and reports its best.
 * Where a literature-standard window exists it is used and cited in the
 * rationale; where it does not, the roundest defensible number is used. The
 * point is that the choice is not a free variable once results are visible.
 *
 * COSTS ARE 2pp OF WIN RATE THROUGHOUT, matching the crypto gate so a verdict
 * here means the same thing as a verdict there. Every hypothesis is a decile
 * long-short rebalanced at its holding period, which is a real four-legged
 * trade; 2pp is conservative for the monthly ones and arguably light for the
 * weekly ones, and that asymmetry is stated rather than tuned away.
 */

const COST_PP = 2;

export const FAMILY: Hypothesis[] = [
  {
    id: "momentum-12-1",
    statement:
      "Stocks with the highest trailing 12-month return excluding the most recent month outperform the lowest over the following month.",
    rationale:
      "Jegadeesh-Titman. The skipped month removes short-horizon reversal, which points the other way and otherwise cancels part of the effect. Re-tested inside this family because its earlier standalone run could only be corrected against its own variants.",
    hold: 21,
    warmup: 273,
    costPp: COST_PP,
    killCriteria:
      "Retire if the Wilson lower bound fails to clear 50% + costs, or if it does not survive FDR across this family.",
    rank: ({ series, i }) => ret(series, i - 252, i - 21),
  },


  /*
   * THE REGIME PAIR. Both halves are declared, and that is not politeness —
   * testing only the up-regime and reporting it is the selection this whole
   * apparatus exists to prevent. Together they partition every period, so
   * whatever the answer is, it is on the record.
   *
   * The prior: momentum's worst outcomes cluster in bear-to-bull reversals,
   * where yesterday's losers rip and the short leg is run over. If that is
   * what drags the unconditional mean (+0.13%) so far below its median
   * (+0.91%), gating on breadth should recover it. If the two halves look
   * alike, the tail is not a regime phenomenon and this idea is dead.
   */
  {
    id: "momentum-12-1-broad-up",
    statement:
      "12-1 momentum outperforms when MORE than half the panel trades above its own 200-session average.",
    rationale:
      "Momentum crashes are concentrated in reversals off broad weakness. Breadth measured from the panel itself rather than an index, because an index can be carried by a few mega-caps while most names fall — and it is the many that the short leg holds.",
    hold: 21,
    warmup: 273,
    costPp: COST_PP,
    killCriteria:
      "Retire if it fails the gate. If BOTH regime halves look like the unconditional result, the tail is not a regime effect and conditioning is not the answer.",
    periodGate: ({ panel, decisionTime }) => {
      const b = panelBreadth(panel, decisionTime);
      return b !== null && b > 0.5;
    },
    rank: ({ series, i }) => ret(series, i - 252, i - 21),
  },

  {
    id: "momentum-12-1-broad-down",
    statement:
      "12-1 momentum outperforms when HALF OR FEWER of the panel trades above its own 200-session average.",
    rationale:
      "The complement, declared so the pair partitions all periods. The prior says this is where momentum should be weakest or negative; if it is instead the stronger half, the received explanation for momentum crashes is wrong on this panel and that is worth knowing.",
    hold: 21,
    warmup: 273,
    costPp: COST_PP,
    killCriteria:
      "Retire if it fails the gate. A NEGATIVE spread here is a finding rather than a failure — it would locate the crash risk precisely.",
    periodGate: ({ panel, decisionTime }) => {
      const b = panelBreadth(panel, decisionTime);
      return b !== null && b <= 0.5;
    },
    rank: ({ series, i }) => ret(series, i - 252, i - 21),
  },

  {
    id: "reversal-5d",
    statement:
      "Stocks with the WORST return over the last 5 sessions outperform the best over the following 5 sessions.",
    rationale:
      "Short-horizon reversal from liquidity provision — sharp moves overshoot as market makers demand compensation for absorbing flow. Ranked so the losers score highest, because the claim is that they win. The momentum study's skipped month is indirect evidence this exists.",
    hold: 5,
    warmup: 30,
    costPp: COST_PP,
    killCriteria:
      "Retire if the spread is not positive, OR if reversal-5d-skip1 fails — passing alone is the signature of a bid-ask bounce rather than information.",
    requires: ["reversal-5d-skip1"],
    // Negated: the most negative prior return ranks highest, i.e. gets bought.
    rank: ({ series, i }) => {
      const r = ret(series, i - 5, i);
      return r === null ? null : -r;
    },
  },


  {
    id: "reversal-5d-skip1",
    statement:
      "The 5-day reversal effect survives when entry is delayed one session after the signal.",
    rationale:
      "THE FALSIFICATION TEST for reversal-5d, declared before either was run. Close-to-close reversal at short horizons is substantially bid-ask bounce: a stock closing on the bid and then on the ask shows a reversal nobody could trade. Delaying entry one session steps over the bounce. If reversal-5d survives and this does not, the effect was microstructure and neither is tradeable.",
    hold: 5,
    warmup: 30,
    costPp: COST_PP,
    killCriteria:
      "If this fails while reversal-5d passes, BOTH are retired — that pattern is the signature of a bounce artifact, and shipping the unskipped version would be shipping a spread that only exists between the quotes.",
    entryOffset: 1,
    rank: ({ series, i }) => {
      const r = ret(series, i - 5, i);
      return r === null ? null : -r;
    },
  },

  {
    id: "high-52w-proximity",
    statement:
      "Stocks trading closest to their 52-week high outperform those furthest below it over the following month.",
    rationale:
      "George & Hwang: the 52-week high acts as an anchor, and traders under-react to news that pushes price through it. Distinct from momentum — a stock can be near its high without a large trailing return.",
    hold: 21,
    warmup: 273,
    costPp: COST_PP,
    killCriteria:
      "Retire if it fails the gate, or if it survives only where momentum also survives — that would make it a momentum proxy rather than its own signal.",
    rank: ({ series, i }) => {
      const hi = trailingHigh(series, i, 252);
      return hi && hi > 0 && series.close[i] > 0 ? series.close[i] / hi : null;
    },
  },

  {
    id: "vol-contraction",
    statement:
      "Stocks whose 20-session realised volatility is lowest relative to their own 60-session volatility outperform over the following month.",
    rationale:
      "Volatility clusters and mean-reverts. A contracted stock is either coiling before expansion or genuinely de-risking; the claim is that the average outcome is favourable. Ratio rather than level, so the ranking is not a proxy for 'low-beta stocks'.",
    hold: 21,
    warmup: 90,
    costPp: COST_PP,
    killCriteria:
      "Retire if the spread is not positive. A negative spread would mean expansion is the tradeable side and should be declared as its own hypothesis, not this one with a flipped sign.",
    rank: ({ series, i }) => {
      const short = realisedVol(series, i, 20);
      const long = realisedVol(series, i, 60);
      if (short === null || long === null || long <= 0) return null;
      // Negated: the MOST contracted ranks highest.
      return -(short / long);
    },
  },

  {
    id: "volume-expansion",
    statement:
      "Stocks whose 5-session average volume most exceeds their 60-session average outperform over the following month.",
    rationale:
      "Volume expansion marks the arrival of informed flow, and price tends to follow participation. The weakest form of the family's ideas and included precisely so a null result is on the record.",
    hold: 21,
    warmup: 90,
    costPp: COST_PP,
    killCriteria:
      "Retire if it fails the gate. Volume without direction is the most likely of these to be pure noise.",
    rank: ({ series, i }) => {
      const fast = meanVolume(series, i, 5);
      const slow = meanVolume(series, i, 60);
      return fast !== null && slow !== null && slow > 0 ? fast / slow : null;
    },
  },

  {
    id: "momentum-risk-adjusted",
    statement:
      "Stocks with the highest 12-1 momentum PER UNIT of realised volatility outperform the lowest over the following month.",
    rationale:
      "Raw momentum loads on high-volatility names, so part of its spread may be a volatility premium rather than momentum. Dividing by 60-session volatility asks whether the effect survives once that loading is removed. Declared alongside raw momentum specifically so the comparison is corrected, not chosen.",
    hold: 21,
    warmup: 273,
    costPp: COST_PP,
    killCriteria:
      "Retire if it fails the gate. If it survives where raw momentum does not, the honest reading is that the volatility scaling — not momentum — is doing the work, and that must be said.",
    rank: ({ series, i }) => {
      const m = ret(series, i - 252, i - 21);
      const v = realisedVol(series, i, 60);
      return m === null || v === null || v <= 0 ? null : m / v;
    },
  },
];
