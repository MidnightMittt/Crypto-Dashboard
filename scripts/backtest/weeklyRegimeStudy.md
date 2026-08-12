# Phase 6 Research — Weekly Regime as a Strategic Filter

Research only. No production file is modified by this script.

## R1 — Construction, census, and redundancy against the existing daily trend tag

**BTC**: 225 closed weekly bars with a full EMA20 + 4w slope. Thresholds calibrated on the earliest 67 weeks only: flat-slope band = ±5.58% per 4w, strong tier = ±21.5% from the weekly EMA.
**ETH**: 225 closed weekly bars with a full EMA20 + 4w slope. Thresholds calibrated on the earliest 67 weeks only: flat-slope band = ±4.15% per 4w, strong tier = ±17.2% from the weekly EMA.

Day-records classified with a closed weekly regime: 2896 of 2896 (100.0%).

| Weekly regime | Days | Share |
|---|---|---|
| strong-bull | 364 | 12.6% |
| bull | 448 | 15.5% |
| accumulation | 7 | 0.2% |
| neutral | 1373 | 47.4% |
| distribution | 0 | 0.0% |
| bear | 382 | 13.2% |
| strong-bear | 322 | 11.1% |

**Redundancy: weekly regime bias vs the existing daily 20d trend tag (regimes.ts)**

| Weekly bias \ Daily tag | bull | neutral | bear |
|---|---|---|---|
| bullish | 294 | 405 | 113 |
| neutral | 381 | 682 | 317 |
| bearish | 138 | 346 | 220 |

Exact agreement (weekly bias equals daily tag): **41.3%** of days. A high number here would mean the weekly read is a slower restatement of a signal the engine already has.

**Taxonomy sensitivity: can the requested accumulation/distribution states be produced at all?**

| Dead-zone width | neutral | accumulation | distribution | directional |
|---|---|---|---|---|
| calibrated (1.0x) | 204 | 1 | 0 | 245 |
| 0.5x | 92 | 5 | 2 | 351 |
| 0.25x | 43 | 8 | 7 | 392 |
| 0x | 0 | 16 | 17 | 417 |

## R2 — Weekly regime persistence

**BTC**: 43 regime changes over 225 weeks — mean dwell **5.1 weeks** per labelled regime, and **8.3 weeks** per directional bias (26 bias flips; this is the number that matters for a filter that only ever gates direction).
**ETH**: 53 regime changes over 225 weeks — mean dwell **4.2 weeks** per labelled regime, and **8.3 weeks** per directional bias (26 bias flips; this is the number that matters for a filter that only ever gates direction).

**Bias survival: given a directional weekly bias this week, is it the same N weeks later?**

| Asset | +1w | +2w | +4w | +8w |
|---|---|---|---|---|
| BTC | 87.6% (n=105) | 78.1% (n=105) | 65.7% (n=105) | 56.3% (n=103) |
| ETH | 90.7% (n=140) | 81.4% (n=140) | 67.4% (n=138) | 52.2% (n=134) |

## R3 — Do trades aligned with the weekly regime outperform?

Resolved trades with a closed weekly regime: 1382.

| Alignment | N | Win rate | 95% CI | Net expectancy | Profit factor | Median net | p (vs coin flip) |
|---|---|---|---|---|---|---|---|
| aligned | 346 | 43.1% | 38.0–48.3% | -0.60% | 0.77 | -1.06% | 0.0114 |
| counter | 309 | 39.2% | 33.9–44.7% | -0.89% | 0.66 | -1.56% | 0.0002 |
| weekly-neutral | 727 | 51.2% | 47.5–54.8% | 1.17% | 1.59 | 0.17% | 0.5529 |

**Per weekly regime (the same trades, unpooled — checks the aligned/counter split isn't driven by one regime):**

| Weekly regime | Trades | Win rate | Net expectancy |
|---|---|---|---|
| strong-bull | 127 | 44.1% | 0.17% |
| bull | 207 | 39.6% | -1.07% |
| accumulation | 0 | insufficient data | — |
| neutral | 727 | 51.2% | 1.17% |
| distribution | 0 | insufficient data | — |
| bear | 179 | 42.5% | -0.30% |
| strong-bear | 142 | 39.4% | -1.61% |

**Swing-plan activations with a closed weekly regime: 81.** 

| Alignment | Activations |
|---|---|
| aligned | 15 |
| counter | 26 |
| weekly-neutral | 40 |

## R4 — Is the weekly filter INCREMENTAL to the daily trend tag?

Each resolved trade is cross-classified by whether it aligns with the DAILY trend tag the engine already has, and separately by whether it aligns with the WEEKLY regime. If weekly carries independent information, the weekly split should still separate outcomes WITHIN a fixed daily-alignment bucket.

| Daily alignment | Weekly alignment | N | Win rate | Net expectancy | p |
|---|---|---|---|---|---|
| daily aligned | weekly aligned | 188 | 43.1% | -0.50% | 0.0680 |
| daily aligned | weekly counter | 104 | 39.4% | -1.35% | 0.0390 |
| daily aligned | weekly weekly-neutral | 367 | 56.7% | 1.93% | 0.0121 |
| daily counter | weekly aligned | 6 | insufficient data | | |
| daily counter | weekly counter | 24 | 25.0% | -1.79% | 0.0227 |
| daily counter | weekly weekly-neutral | 29 | 44.8% | -0.50% | 0.7111 |
| daily weekly-neutral | weekly aligned | 152 | 42.1% | -0.81% | 0.0617 |
| daily weekly-neutral | weekly counter | 181 | 40.9% | -0.51% | 0.0171 |
| daily weekly-neutral | weekly weekly-neutral | 331 | 45.6% | 0.47% | 0.1237 |

## R5 — Confound checks on the R3/R4 result

R3/R4 produced a counterintuitive finding, so before it is believed it has to survive the three ways it could be an artefact: a direction split in disguise, the existing volatility tag in disguise, or one lucky stretch of calendar. Plus the overlap problem that inflates every p-value above.

**5a. Side composition.** The engine fired ~4x more shorts than longs, so an alignment split could easily be a long/short split wearing a different name.

| Alignment | Longs | Shorts | Long share |
|---|---|---|---|
| aligned | 73 | 273 | 21.1% |
| counter | 48 | 261 | 15.5% |
| weekly-neutral | 174 | 553 | 23.9% |

**5b. Is `weekly-neutral` just the existing low-volatility tag?**

| Weekly bias | high-vol | normal-vol | low-vol |
|---|---|---|---|
| bullish | 129 | 107 | 98 |
| neutral | 197 | 212 | 318 |
| bearish | 99 | 81 | 141 |

**5c. The decisive one — does the weekly split still separate outcomes WITHIN a fixed volatility bucket?** If it vanishes here, weekly is the volatility tag under another name and should not be built.

| Vol tag | Weekly | N | Win rate | Net expectancy |
|---|---|---|---|---|
| high-vol | weekly directional | 228 | 41.7% | -0.59% |
| high-vol | weekly neutral | 197 | 51.8% | 1.28% |
| normal-vol | weekly directional | 188 | 44.7% | -0.34% |
| normal-vol | weekly neutral | 212 | 51.4% | 1.49% |
| low-vol | weekly directional | 239 | 38.1% | -1.20% |
| low-vol | weekly neutral | 318 | 50.6% | 0.88% |

**5d. Calendar concentration.** If the profitable weekly-neutral bucket lives in one stretch of history, it is a period effect, not a regime effect.

| Year | Weekly-neutral trades | Win rate | Net expectancy |
|---|---|---|---|
| 2022 | 14 | 85.7% | 2.04% |
| 2023 | 223 | 39.5% | -0.87% |
| 2024 | 165 | 49.7% | 0.42% |
| 2025 | 210 | 53.3% | 2.04% |
| 2026 | 115 | 67.8% | 4.50% |

**5e. Overlap.** Trades are opened near-daily and held for days, so the 1,382 'independent' observations above are nothing of the kind and every p-value in R3/R4 is optimistic. Re-run on a strictly NON-OVERLAPPING subsample (greedy: take a trade, skip every trade that opens before it closes), per asset.

Non-overlapping trades: **438** of 1382 (31.7%) — this is the honest effective sample size.

| Alignment | N | Win rate | Net expectancy | p (vs coin flip) |
|---|---|---|---|---|
| aligned | 104 | 53.8% | 1.53% | 0.4926 |
| counter | 94 | 42.6% | -0.62% | 0.1797 |
| weekly-neutral | 240 | 53.3% | 0.85% | 0.3329 |

## Multiple-testing correction

Every win-rate test above is a separate shot at significance. Benjamini-Hochberg at q=0.05 across all 14 of them:

| Test | N | Win rate | raw p | BH significant |
|---|---|---|---|---|
| R3 aligned | 346 | 43.1% | 0.0114 | no |
| R3 counter | 309 | 39.2% | 0.0002 | **YES** |
| R3 weekly-neutral | 727 | 51.2% | 0.5529 | no |
| R4 daily-aligned/weekly-aligned | 188 | 43.1% | 0.0680 | no |
| R4 daily-aligned/weekly-counter | 104 | 39.4% | 0.0390 | no |
| R4 daily-aligned/weekly-weekly-neutral | 367 | 56.7% | 0.0121 | no |
| R4 daily-counter/weekly-counter | 24 | 25.0% | 0.0227 | no |
| R4 daily-counter/weekly-weekly-neutral | 29 | 44.8% | 0.7111 | no |
| R4 daily-weekly-neutral/weekly-aligned | 152 | 42.1% | 0.0617 | no |
| R4 daily-weekly-neutral/weekly-counter | 181 | 40.9% | 0.0171 | no |
| R4 daily-weekly-neutral/weekly-weekly-neutral | 331 | 45.6% | 0.1237 | no |
| R5e non-overlapping aligned | 104 | 53.8% | 0.4926 | no |
| R5e non-overlapping counter | 94 | 42.6% | 0.1797 | no |
| R5e non-overlapping weekly-neutral | 240 | 53.3% | 0.3329 | no |

Survivors after correction: **1 of 14**.

At least one effect survives multiple-testing correction — see the verdict for whether it is the one the brief needs.

## Verdict

**1. Is a weekly regime non-redundant? YES.** It agrees with the daily 20d trend tag on only 41.3% of days. This is genuinely new information, not a slower restatement — the first hurdle is cleared.

**2. Is the requested 8-state taxonomy achievable? NO — and this is structural, not a tuning problem.** Accumulation and distribution together cover 7 of 2,896 days (0.2%). The sensitivity table is the proof it isn't the dead zone's fault: even with the dead zone set to ZERO, the two transitional states are 33 of 450 weekly bars (7.3%). Price is either above a rising weekly average or below a falling one ~93% of the time. Weekly EMA geometry yields a FIVE-state model (strong-bull / bull / neutral / bear / strong-bear), and any 8-state taxonomy built on it would be mostly empty labels.

**3. Does the weekly regime persist? YES, strongly — the brief's core premise is validated.** Mean dwell is 8.3 weeks per directional bias on BOTH assets independently, with 87-91% survival at +1 week and 66-67% at +4 weeks. A weekly filter genuinely would change rarely.

**4. Does it improve trade outcomes? NOT DEMONSTRABLE — and this is what decides the phase.**

On the raw 1,382 trades the effect looked large and backwards from theory: weekly-neutral was the only profitable bucket (51.2%, +1.17%) while both aligned (43.1%) and counter (39.2%) lost money. That result does not survive scrutiny:

- **Overlap destroys it.** Trades open near-daily and are held for days, so those 1,382 observations are really 438 independent ones. On the non-overlapping subsample the ordering flips to the conventional one — aligned 53.8%, weekly-neutral 53.3%, counter 42.6% — and nothing is significant (p = 0.49 / 0.33 / 0.18).
- **Multiple testing destroys most of the rest.** 1 of 14 tests survives Benjamini-Hochberg, and it is only the unsurprising "counter-trend trades lose".
- **Calendar concentration is severe.** The weekly-neutral bucket runs from -0.87% expectancy in 2023 to +4.50% in 2026. That is a period effect sitting on top of any regime effect.
- Two confounds are cleanly ruled out, to be fair to the hypothesis: the split is NOT a long/short proxy (long share is 21% / 16% / 24% across buckets), and weekly-neutral is NOT the existing low-volatility tag (it spans all three volatility buckets).

**5. Is this absence of an effect, or absence of power? Honestly, partly the latter.** With ~100 non-overlapping trades per arm the study can only resolve differences of roughly 15pp. The observed aligned-vs-counter gap is 11.2pp (53.8% vs 42.6%) — the sign theory predicts, at about 1.6 sigma. So the correct statement is not "weekly regime does not work", it is: **at the evidence available, no effect can be demonstrated, and the study could only have detected an effect substantially larger than the one observed.**

### WEEKLY REGIME VERDICT: DO NOT IMPLEMENT (as a filter)

The brief's own rule is "if evidence is weak, do not implement", and the evidence is weak. Specifically: do NOT gate, weight, boost, or suppress any setup by weekly regime, because there is no measured basis for choosing how much to boost or suppress, and inventing one would be exactly the curve-fitting the brief prohibits.

Two findings ARE solid and worth keeping on the record: the weekly regime is non-redundant (41.3% agreement) and highly persistent (8.3-week dwell). That combination is what would make it a good filter IF an outcome effect were ever demonstrated. What is missing is only the third leg.

**What would change this answer:** more independent swing observations. The binding constraint is 438 non-overlapping trades and only 81 swing activations across four years — not the quality of the weekly read. This should be revisited once the swing engine has accumulated materially more activations, and the test to re-run is R5e, not R3.

### Cross-cutting methodological finding

The overlap correction in R5e changed the conclusion of this study completely. That problem is not specific to this study: every backtest report in this repo — including the harmonic incremental-value study shipped immediately before this one, whose headline was a p<0.01 result at a 30-day horizon computed from daily-overlapping windows — treats overlapping observations as independent. A 30-day forward return sampled daily overlaps its neighbour by 29/30. Those p-values are systematically optimistic, and the harmonic study's 30D significance in particular should be considered unproven until recomputed on non-overlapping windows. This is the highest-value statistical fix available in the codebase and is worth more than any new signal.