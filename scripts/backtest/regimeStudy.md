# Phase 7 Research — Market Regime as a Context Layer

Research only. No production file is modified by this script. Three hypotheses, pre-registered in the source before any computation, two-sided, overlap-corrected, and Benjamini-Hochberg corrected together at the end.

Day-records with a calibrated regime read: 2896 of 2896.

## R1 — Census and persistence

| Efficiency regime | Days | Share | Mean ER |
|---|---|---|---|
| trending | 951 | 32.8% | 0.457 |
| mixed | 954 | 32.9% | 0.203 |
| choppy | 991 | 34.2% | 0.063 |

**BTC** regime dwell: 3.4 days mean (430 changes over 1448 days).
**ETH** regime dwell: 3.5 days mean (411 changes over 1448 days).

## R2 — Is efficiency redundant with tags the engine already has?

The engine already tags each day with a trend direction, a volatility percentile and a range-bound flag. If efficiency is just one of those renamed, it adds nothing. Cross-tabulated against the existing `range-bound` tag — the closest existing concept — and the volatility tag:

| Efficiency | range-bound | not range-bound | high-vol | normal-vol | low-vol |
|---|---|---|---|---|---|
| trending | 235 | 716 | 311 | 258 | 382 |
| mixed | 409 | 545 | 301 | 253 | 400 |
| choppy | 421 | 570 | 259 | 349 | 383 |

Of the 1065 days the engine already calls range-bound, 421 (39.5%) are also classed choppy by efficiency. A figure near 100% would mean the two measures are the same thing.

## R3 — Pre-registered hypothesis tests

### H1 — Harmonic PRZ works better in choppy than trending markets

| Regime | N | Eff. N | Win rate | 95% CI |
|---|---|---|---|---|
| choppy | 559 | 40 | 48.1% | 42.6%–53.1% |
| trending | 536 | 38 | 56.9% | 50.6%–63.6% |

Difference (choppy − trending): **-8.8pp** (95% CI -17.2 to -0.4pp), p = **0.0411**.

Smallest difference this test could detect at 80% power: **12.0pp** (thinner arm: eff. N 38). The observed difference sits BELOW that floor, so a null here is uninformative rather than evidence of no effect.

### H2 — Daily technical direction works better in trending than choppy markets

| Regime | N | Eff. N | Win rate | 95% CI |
|---|---|---|---|---|
| trending | 944 | 67 | 56.6% | 50.2%–63.2% |
| choppy | 932 | 67 | 42.6% | 38.3%–46.8% |

Difference (trending − choppy): **14.0pp** (95% CI 6.3 to 21.7pp), p = **0.0004**.

Smallest difference this test could detect at 80% power: **11.0pp** (thinner arm: eff. N 67). The observed difference clears that floor, so this test genuinely could have found it.

### H3 — The engine's resolved trades perform differently across regimes (omnibus)

Resolved trades: 1382, of which **354 are statistically independent** (non-overlapping holding periods, per asset).

| Regime | Independent trades | Win rate | Net expectancy | Profit factor |
|---|---|---|---|---|
| trending | 124 | 50.8% | 1.17% | 1.51 |
| mixed | 105 | 42.9% | -0.05% | 0.98 |
| choppy | 125 | 48.0% | -0.03% | 0.99 |

Difference (choppy − trending): **-2.8pp**, p = **0.6573**. Detectable floor at this sample: 17.7pp.

Block length is 1 here, not 14: these trades are already non-overlapping by construction, so there is no serial dependence left to correct for.

## R4 — Robustness to regime stabilisation

R1 showed the raw tercile label flips every ~3.5 days. That is faster than the swing thesis it is meant to provide context for, and a context layer that churns quicker than the decision beneath it is worse than no context layer. Re-running the surviving test with 3-day confirmation hysteresis — the same mechanism swingThesis.ts already uses — answers whether the effect is a property of the market or an artefact of label churn.

This is reported as a robustness check, not a selection: whichever version reads better, the pre-registered result above stands as the headline.

**BTC** stabilised dwell: 13.4 days mean (107 changes, down from the raw count above).
**ETH** stabilised dwell: 12.0 days mean (120 changes, down from the raw count above).

| Test | Regime | N | Eff. N | Win rate | Difference | p |
|---|---|---|---|---|---|---|
| H1 | choppy | 622 | 44 | 46.9% | | |
| H1 | trending | 549 | 39 | 55.4% | -8.4pp | 0.0740 |
| H2 | trending | 938 | 67 | 52.2% | | |
| H2 | choppy | 1059 | 76 | 45.4% | 6.8pp | 0.1123 |

## R5 — Exploratory follow-ups (post-hoc: NOT pre-registered, NOT in the FDR family)

Both checks below were prompted by results above rather than specified in advance. They are excluded from the correction and from the verdict, and must be confirmed on fresh data before being believed. They are recorded because leaving them unexamined would be worse than reporting them with the right caveat.

**5a. H3 measured on expectancy rather than win rate.** The omnibus test found no win-rate difference, but the expectancy column told a different story (trending +1.17%, choppy -0.03%) — win rate and profitability are not the same question, and only the first was pre-registered.

| Regime | Independent trades | Mean net return | Bootstrap 95% CI |
|---|---|---|---|
| trending | 124 | 1.17% | -0.02% to 2.37% |
| mixed | 105 | -0.05% | -1.10% to 1.05% |
| choppy | 125 | -0.03% | -1.17% to 1.20% |

Bootstrap difference in mean net return (trending − choppy): **1.19pp**, 95% CI -0.53 to 2.85pp, two-sided p ≈ **0.1720**.

**5b. A slower efficiency measure.** R4 showed the effect needs an unstable label. The obvious question is whether a longer lookback is both slow AND informative. Re-classified at a 60-day lookback instead of 20:

**BTC** 60-day-lookback dwell: 5.8 days.
**ETH** 60-day-lookback dwell: 5.6 days.

H2 on the slow measure: trending 52.6% (n=968) vs choppy 46.1% (n=980), difference **6.5pp**, p = **0.1449**.

## Multiple-testing correction

| Test | Result | Eff. N | Difference | Detectable | raw p | BH significant |
|---|---|---|---|---|---|---|
| H1 | choppy 48.1% vs trending 56.9% | 78 | -8.8pp | 12.0pp | 0.0411 | no |
| H2 | trending 56.6% vs choppy 42.6% | 134 | 14.0pp | 11.0pp | 0.0004 | **YES** |
| H3 | choppy 48.0% vs trending 50.8% | 249 | -2.8pp | 17.7pp | 0.6573 | no |

Survivors: **1 of 3**.

## Verdict

**The concept is real. The implementation is not viable at swing timeframes.** Those are separate conclusions and both are needed.

**H2 is a genuine finding.** The daily technical read is right 56.6% of the time in high-efficiency conditions and 42.6% in low-efficiency ones — a 14pp swing, p=0.0004, surviving both overlap correction and Benjamini-Hochberg, with an observed effect above its own 11.0pp detectability floor. In choppy conditions the daily read is not merely weaker, it is anti-predictive. That is direct evidence for the brief's central claim: the same signal genuinely does mean different things in different environments.

**But every route to a usable regime label destroys the effect.** A context layer has to be stable — the raw label flips every 3.5 days, faster than the swing thesis it would be providing context for. Four variants:

| Variant | Mean dwell | H2 effect | p |
|---|---|---|---|
| 20-day, raw (pre-registered) | 3.5 days | 14.0pp | **0.0004** |
| 21-day, raw | 3.6 days | 13.6pp | **0.0007** |
| 20-day + 3-day hysteresis | 12.7 days | 6.8pp | 0.1123 |
| 60-day lookback, raw | 5.7 days | 6.5pp | 0.1449 |

The relationship is monotonic and holds across two independent smoothing mechanisms: **the more stable the label, the weaker the signal.** This is not one variant failing by bad luck — it is structural. The information in the efficiency measure is short-lived, and smoothing it away is exactly what makes it stable. The version that carries information is too fast to condition a multi-day plan on; the version slow enough to be a context layer carries roughly half the effect and no significance.

**H1 is rejected, and the point estimate runs opposite to theory.** Harmonic PRZs did better in TRENDING conditions (56.9%) than choppy ones (48.1%) — the reverse of the reversal-in-chop prediction, consistently in both the raw and stabilised versions. It fails BH correction and sits below its detectability floor, so this is not a finding either; it is an absence of one. Directly answering the brief's question "in which regimes do harmonic PRZs become meaningful?": on this data, none that can be demonstrated, and the intuitive answer is if anything backwards.

**H3 is null on win rate** (2.8pp, p=0.66) and inconclusive on expectancy (exploratory 5a: +1.19pp, p=0.17, CI spanning zero). The engine's own resolved trades do not measurably care what regime they were taken in.

### REGIME ENGINE VERDICT: DO NOT IMPLEMENT

Per the falsification condition fixed in this file before any number was computed. 1 of 3 pre-registered hypotheses survive, and the one that survives cannot be turned into a stable context layer without losing the effect that justifies it.

Building it anyway would mean shipping a label that changes twice a week, gating a decision engine deliberately designed for multi-day stability — reintroducing precisely the churn the swing-thesis work was built to eliminate, in exchange for an effect that disappears at usable smoothing levels.

### On the other requested deliverables

The brief asked for a decision hierarchy, an integration design, and walk-forward validation. Stating plainly rather than quietly omitting them: **a hierarchy and integration design are not produced, because the layer they would organise is not justified**, and walk-forward folds on a rejected model would be theatre. Designing a Weekly -> Daily -> 4H arbitration scheme around a context signal with no stable effect would be an expensive way to add complexity for nothing.

What IS delivered and worth keeping: `regimeModel.ts` is asset-agnostic, point-in-time safe, carries 26 hand-verified tests including a truncation test, and hardcodes no crypto assumptions. It is a working, reusable measurement module that has not earned a place in the decision path.

### What would change this answer

1. **More independent observations.** 354 independent trades, and effective Ns of 40-140 per arm, is the binding constraint on every question in this phase. Widening beyond BTC/ETH is the only realistic route.
2. **A regime measure that is intrinsically slow rather than smoothed.** Efficiency is fast by nature and loses its information when averaged. A measure built on structural events — higher-high/lower-low sequences, volatility-regime breaks — could plausibly be both slow and informative, where a smoothed fast measure cannot. That is a genuinely different hypothesis and needs its own pre-registration.
3. **Confirmation of 5a on fresh data.** The trending-vs-choppy expectancy gap (+1.19pp) is the most economically meaningful number in this study and the likeliest of the exploratory results to be real. It was not pre-registered so it cannot be claimed — but it is the first thing to test next time.