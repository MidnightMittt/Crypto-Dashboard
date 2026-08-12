# Cross-Asset Research Engine — Statistical Power Analysis

How many assets are required before statistical power becomes meaningful? Answered with the repo's own measured correlation, a model validated against the repo's own measured sample size, and an explicit separation of what is measured from what is assumed.

## 1. The governing number, measured

BTC/ETH daily return correlation over 1448 paired days: **rho = 0.82**.

Because N_eff asymptotes at 1/rho, that correlation caps the crypto universe at **1.22 effective assets — permanently.**

| Crypto assets | N_eff |
|---|---|
| 2 | 1.10 |
| 5 | 1.17 |
| 10 | 1.19 |
| 25 | 1.21 |
| 50 | 1.21 |
| 100 | 1.21 |
| 500 | 1.22 |

The current two-asset universe already delivers 1.10 of a maximum 1.22 — **90.2% of everything crypto can ever provide.** Adding 500 altcoins would move it by roughly 0.12 effective assets. Altcoins typically correlate to BTC even more tightly than ETH does (0.85-0.95), so in practice the gain would be smaller still.

## 2. Model validation — does this arithmetic describe reality?

A planning model nobody has checked is a guess with equations. Predicted independent observations for the CURRENT universe: 1.10 effective assets x 206.7 independent 7-day windows over 4.0 years = **226.9**.

Directly measured by greedy non-overlap on real resolved trades: **354**.

Same order of magnitude, model conservative by 1.56x. The measured figure is the more generous of the two because greedy per-asset selection ignores the cross-asset correlation the model charges for. Close enough to plan with, and the direction of the error is the safe one.

## 3. What the current universe can and cannot resolve

With the 354 MEASURED independent observations split across two arms, the smallest win-rate difference detectable at 80% power is **14.9pp**. The scenario table below uses the model's more conservative 226.9 instead, giving 18.6pp — the two differ only because the model charges for cross-asset correlation that the greedy per-asset measurement ignores. Both are the same story; the honest range for the current engine is 14.9pp-18.6pp.

For context on why that is the binding problem: a genuinely valuable trading edge is a 3-5pp improvement in win rate. The engine currently cannot distinguish a 5pp edge from noise. Every 'underpowered, cannot conclude' verdict across the last three phases traces to this single number.

## 4. What different universes would actually buy

Correlations marked ASSUMED are experience/literature estimates, not measured here — this repo holds no equity, bond, FX or commodity history to measure. They are varied in the sensitivity table in section 5, and no conclusion below depends on a precise value.

| Universe | Assets | rho | N_eff | Years | Independent obs | Detectable effect | vs today |
|---|---|---|---|---|---|---|---|
| Current (BTC + ETH) | 2 | 0.82 *(measured)* | 1.10 | 4 | 229.0 | 18.5pp | 1.0x |
| Crypto broad (50 majors) | 50 | 0.88 | 1.13 | 4 | 236.4 | 18.2pp | 1.0x |
| + US equity sectors (11 SPDRs) | 13 | 0.55 | 1.71 | 25 | 2229.8 | 5.9pp | 9.8x |
| + Single-name equities (50, cross-sector) | 52 | 0.45 | 2.17 | 25 | 2830.3 | 5.3pp | 12.5x |
| Multi-asset-class (equities, bonds, FX, commodities, crypto) | 60 | 0.25 | 3.81 | 25 | 4966.0 | 4.0pp | 21.9x |
| Multi-asset-class, wide (150 instruments) | 150 | 0.20 | 4.87 | 30 | 7618.3 | 3.2pp | 33.6x |

Reading the table:

- **Crypto broad is nearly worthless.** 50 crypto assets at rho=0.88 yields 1.13 effective assets against the current 1.10. Twenty-five times the data ingestion, storage and maintenance for a rounding error in power. This is the single most important result here.
- **History is doing more work than breadth.** Moving to 11 equity sector ETFs raises N_eff only modestly, but 25 years instead of 4 multiplies the time dimension by ~6x. Depth of history is cheaper and more powerful than width of universe.
- **Diversification across asset CLASSES is what compounds.** Bonds, FX and commodities are the components that actually drag average pairwise correlation down, and rho is the term that sets the ceiling.

## 5. Sensitivity — the conclusion does not depend on the assumed correlations

Detectable effect for a 60-instrument, 25-year universe across a wide range of average pairwise correlation:

| rho | N_eff | Independent obs | Detectable effect |
|---|---|---|---|
| 0.10 | 8.70 | 11335.4 | 2.6pp |
| 0.15 | 6.09 | 7940.5 | 3.1pp |
| 0.20 | 4.69 | 6110.5 | 3.6pp |
| 0.30 | 3.21 | 4182.6 | 4.3pp |
| 0.40 | 2.44 | 3179.4 | 5.0pp |
| 0.55 | 1.79 | 2338.2 | 5.8pp |
| 0.70 | 1.42 | 1849.0 | 6.5pp |
| 0.85 | 1.17 | 1529.1 | 7.2pp |

Across the entire plausible range the ordering never changes: any genuinely multi-class universe beats any crypto-only universe by a wide margin, and the gap is driven by rho rather than by asset count.

## 6. Requirements to hit a given detectable effect

Working backwards from the effect size worth detecting, at 25 years of history. Note the top row: a SINGLE instrument with 25 years of history already resolves a 10pp effect better than the current two-asset four-year universe does — history alone is that powerful.

| Target detectable effect | Independent obs needed | rho=0.2 | rho=0.3 | rho=0.5 |
|---|---|---|---|---|
| 10.0pp | 785.1 | 1 asset | 1 asset | 1 asset |
| 7.0pp | 1602.3 | 2 assets | 2 assets | 2 assets |
| 5.0pp | 3140.5 | 4 assets | 7 assets | impossible at this rho |
| 3.0pp | 8723.6 | impossible at this rho | impossible at this rho | impossible at this rho |
| 2.0pp | 19628.0 | impossible at this rho | impossible at this rho | impossible at this rho |

**"impossible at this rho"** is not a formatting artefact — it is the asymptote doing its work. Beyond a certain precision, no number of correlated instruments suffices and the only remaining levers are longer history or genuinely lower correlation.

## 7. Recommended target universe

Optimising for statistical power per unit of engineering effort, not for ticker count:

| Tier | Instruments | Why |
|---|---|---|
| Equity sector ETFs | 11 US SPDR sectors | 25+ years of clean, free, survivorship-bias-free daily data. The single cheapest power increase available. |
| Broad indices | SPY, QQQ, IWM, EFA, EEM | Different beta profiles; EFA/EEM add geography. |
| Bonds | TLT, IEF, LQD, HYG | The strongest diversifiers on this list — frequently negatively correlated to equities. |
| Commodities | GLD, SLV, USO, DBA | Genuinely different drivers. |
| FX | 6 major pairs | Near-zero correlation to equities; deep history. |
| Crypto | BTC, ETH + 3-5 majors | Keep for the product; expect near-zero marginal research power. |

That is roughly 40 instruments at an estimated average pairwise rho near 0.25-0.30, over 25 years: about 4522.4 independent observations, a detectable effect near 4.2pp, roughly 19.9x the current statistical resolution.

**Survivorship bias warning, since the brief listed it as a hazard to avoid:** single-name equities introduce it immediately — a universe of "today's S&P 500" silently conditions on having survived. ETFs and indices largely sidestep this, which is a second reason to start there rather than with single names.

**The one-line answer to "how many assets?":** roughly 40, but the count is the wrong question. The right target is average pairwise correlation below ~0.3 and history beyond 20 years. A 40-instrument multi-class universe beats a 500-asset crypto universe by more than an order of magnitude.