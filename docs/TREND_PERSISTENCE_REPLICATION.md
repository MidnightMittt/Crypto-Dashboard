# Replication — does weekly trend persistence hold outside crypto?

The Phase 6 conclusion under test, from BTC and ETH over 225 weeks:

> Mean dwell is **8.3 weeks** per directional bias on BOTH assets independently, with **87-91% survival at +1 week** and **66-67% at +4 weeks**.

Same construction — 20-week EMA, 4-week slope, thresholds from the earliest 30% of each instrument's own history — re-run on every ingested instrument.

**Every survival figure is paired with a permutation null.** A 20-week EMA turns over slowly by construction, so a label derived from it repeats even on noise. The null shuffles each instrument's own weekly returns, rebuilds the path, and recalibrates thresholds. Only the EXCESS over that null is evidence of anything.

## Coverage

| Class | Instruments | Weekly observations | Span |
|---|---|---|---|
| bond | 6 (TLT, IEF, SHY, TIP, LQD, HYG) | 7070 | 2003-01 to 2026-08 |
| commodity | 4 (GLD, SLV, USO, DBA) | 4182 | 2005-05 to 2026-08 |
| crypto | 3 (SOL, BNB, XRP) | 1176 | 2018-04 to 2026-08 |
| equity-etf | 6 (SPY, QQQ, DIA, IWM, VTI, XLF) | 8647 | 1993-07 to 2026-08 |

## Mean dwell per directional bias

The crypto benchmark is 8.3 weeks. Dwell is a descriptive statistic, reported per instrument so a class average cannot hide a split.

| Class | Mean dwell (weeks) | Runs | Per-instrument range |
|---|---|---|---|
| bond | **11.0** | 366 | 9.0 (HYG) to 19.6 (SHY) |
| commodity | **9.3** | 251 | 8.2 (SLV) to 9.9 (GLD) |
| crypto | **9.7** | 64 | 8.1 (XRP) to 12.9 (SOL) |
| equity-etf | **10.6** | 564 | 9.0 (XLF) to 12.0 (QQQ) |

## Survival of a directional bias, against the permutation null

Panel block bootstrap over 26-week blocks of calendar weeks, 2000 iterations — carrying both the survival-window overlap and the EMA's own ~20-week memory, plus cross-sectional dependence between instruments. Null is 200 permutation replicates.

### bond

| Horizon | Observed | 95% CI | Effective N | Null (shuffled) | Null 95% | **Excess** |
|---|---|---|---|---|---|---|
| +1w | 90.9% | 89.0%–92.2% | 1284.6 | 91.2% | 90.2%–92.0% | -0.3pp |
| +2w | 83.8% | 80.7%–86.1% | 712.4 | 84.4% | 83.2%–85.8% | -0.6pp |
| +4w | 72.4% | 67.6%–76.1% | 410.2 | 72.9% | 70.4%–75.4% | -0.5pp |
| +8w | 60.1% | 54.4%–65.4% | 300.1 | 59.8% | 56.3%–62.9% | 0.3pp |
| +13w | 51.9% | 46.2%–58.0% | 291.4 | 51.2% | 47.4%–55.1% | 0.7pp |
| +26w | 40.8% | 34.0%–46.8% | 233.8 | 42.5% | 38.3%–46.4% | -1.8pp |

### commodity

| Horizon | Observed | 95% CI | Effective N | Null (shuffled) | Null 95% | **Excess** |
|---|---|---|---|---|---|---|
| +1w | 89.3% | 87.5%–90.9% | 1236.5 | 90.1% | 89.0%–91.1% | -0.8pp |
| +2w | 80.8% | 77.9%–83.7% | 729.4 | 82.5% | 80.7%–84.5% | -1.7pp |
| +4w | 67.2% | 62.9%–71.7% | 432.4 | 69.9% | 67.0%–72.7% | -2.6pp |
| +8w | 52.9% | 47.5%–58.9% | 292.1 | 55.5% | 51.5%–59.1% | -2.5pp |
| +13w | 44.6% | 38.0%–51.3% | 209.6 | 45.6% | 40.8%–50.4% | -1.1pp |
| +26w | 33.7% | 27.8%–39.5% | 245.3 | 36.7% | 31.7%–43.3% | -2.9pp |

### crypto

| Horizon | Observed | 95% CI | Effective N | Null (shuffled) | Null 95% | **Excess** |
|---|---|---|---|---|---|---|
| +1w | 89.8% | 87.9%–91.9% | 620.0 | 90.4% | 87.9%–92.3% | -0.5pp |
| +2w | 81.3% | 77.8%–84.7% | 486.5 | 82.7% | 79.6%–86.1% | -1.5pp |
| +4w | 67.1% | 61.8%–73.1% | 238.7 | 69.9% | 63.9%–75.4% | -2.8pp |
| +8w | 50.4% | 44.0%–57.7% | 192.9 | 54.7% | 47.6%–62.1% | -4.2pp |
| +13w | 42.8% | 33.6%–51.7% | 117.7 | 45.3% | 36.7%–54.5% | -2.5pp |
| +26w | 33.6% | 23.1%–47.0% | 58.9 | 35.8% | 24.7%–46.9% | -2.2pp |

### equity-etf

| Horizon | Observed | 95% CI | Effective N | Null (shuffled) | Null 95% | **Excess** |
|---|---|---|---|---|---|---|
| +1w | 90.7% | 88.9%–92.1% | 1347.8 | 90.7% | 90.0%–91.4% | -0.0pp |
| +2w | 84.0% | 81.2%–86.5% | 819.1 | 83.4% | 82.3%–84.8% | 0.6pp |
| +4w | 73.1% | 68.5%–77.4% | 404.0 | 71.0% | 68.9%–73.0% | **2.1pp** |
| +8w | 61.8% | 55.5%–67.6% | 239.6 | 57.2% | 54.4%–60.6% | **4.6pp** |
| +13w | 55.3% | 48.2%–61.8% | 211.7 | 47.9% | 44.5%–51.1% | **7.4pp** |
| +26w | 51.2% | 45.1%–58.0% | 223.7 | 38.7% | 35.5%–42.4% | **12.5pp** |

Bold excess means the observed rate sits above the null's 97.5th percentile — persistence beyond what the smoothing alone manufactures.

## Robustness — the equity result is the only positive finding, so it gets the scrutiny

### 1. Is it volatility clustering rather than trend?

The IID shuffle above destroys volatility clustering, which real markets have — and a quiet stretch keeps an EMA label still without any trend behind it. A BLOCK permutation preserves clustering and local drift within 8-week blocks while destroying anything longer, so it is the right null for horizons beyond that block.

| Horizon | Observed | IID null | Block null | Excess over BLOCK null |
|---|---|---|---|---|
| +13w | 55.3% | 47.9% | 50.6% (47.2%–53.7%) | **4.7pp** |
| +26w | 51.2% | 38.7% | 41.3% (37.9%–44.6%) | **9.9pp** |

### 2. Is it one bull market?

Observed survival split by decade. If the effect lives in a single stretch of history it is a period effect, not a property of equity trends.

| Era | n | +8w | +13w | +26w |
|---|---|---|---|---|
| 1993–1999 | 347 | 68.6% | 63.7% | 60.5% |
| 2000–2009 | 1974 | 59.2% | 52.8% | 42.4% |
| 2010–2019 | 2071 | 60.3% | 52.1% | 53.0% |
| 2020–2026 | 1550 | 65.5% | 60.9% | 58.2% |

### 3. Does the null have the same bias composition?

Survival is inflated by an imbalanced base rate — if most weeks are bullish, staying bullish is easy. The null is only a fair comparison if its composition matches.

| Class | Observed bullish / bearish / neutral | Null bullish / bearish / neutral |
|---|---|---|
| bond | 43% / 13% / 43% | 46% / 17% / 37% |
| commodity | 33% / 23% / 44% | 36% / 28% / 36% |
| crypto | 28% / 25% / 47% | 40% / 23% / 38% |
| equity-etf | 53% / 16% / 31% | 43% / 21% / 36% |

### 4. Chance-corrected — the decisive comparison

Equities sit bullish 53% of weeks against the null's 43%, so some of the excess above is composition, not persistence. Cohen's kappa measures agreement in excess of each series' OWN marginals: 0 is chance, 1 is perfect. Comparing kappa to kappa is composition-free, and this table supersedes the raw excesses above.

| Class | Horizon | Observed κ | Null κ | Δκ |
|---|---|---|---|---|
| bond | +4w | 0.567 | 0.556 | +0.010 |
| bond | +13w | 0.246 | 0.204 | +0.042 |
| bond | +26w | 0.071 | 0.065 | +0.007 |
| commodity | +4w | 0.539 | 0.554 | -0.015 |
| commodity | +13w | 0.220 | 0.200 | +0.020 |
| commodity | +26w | 0.069 | 0.064 | +0.005 |
| crypto | +4w | 0.553 | 0.548 | +0.005 |
| crypto | +13w | 0.221 | 0.183 | +0.038 |
| crypto | +26w | 0.096 | 0.028 | +0.068 |
| equity-etf | +4w | 0.513 | 0.551 | -0.038 |
| equity-etf | +13w | 0.191 | 0.193 | -0.002 |
| equity-etf | +26w | 0.116 | 0.048 | **+0.068** |

## Verdict

**1. The published numbers replicate exactly — and that is the problem.** The Phase 6 headline (87-91% at +1w, 66-67% at +4w, 8.3-week dwell) reproduces in every asset class: bonds 90.9%/72.4%, commodities 89.3%/67.2%, crypto spot 89.8%/67.1%, equities 90.7%/73.1%, dwell 9.3-11.0 weeks. A result that is identical across bonds, gold, oil, farm goods, equity indices and three altcoins is not describing any of those markets.

**2. The permutation null reproduces it too.** On the same instruments' own weekly returns SHUFFLED into a trendless path, survival is 90-91% at +1w and 70-73% at +4w. The 20-week EMA is what persists. Phase 6's finding #3 measured the smoothing constant of its own indicator.

**3. After correcting for base-rate composition, the last positive finding nearly vanishes too.** Raw excess suggested equities had genuine persistence (+2.1pp at 4w, +7.4pp at 13w, +12.5pp at 26w). But equities sit bullish 53% of weeks against the null's 43%, and staying bullish is mechanically easier when bullish is more common. Chance-corrected: Δκ = **-0.038** at 4w and **-0.002** at 13w. Both disappear. Only +26w survives, at κ = 0.116 against a null of 0.048.

**4. That surviving cell should not be leaned on.** κ = 0.116 is 'slight' agreement in absolute terms, it is 12 tests deep into this table alone, and crypto shows the same Δκ (+0.068) without clearing its own wider null. A six-month horizon is also irrelevant to a days-to-weeks product.

### CONCLUSION: THE PHASE 6 PERSISTENCE FINDING DOES NOT SURVIVE

Phase 6 kept two findings on the record after declining to build the filter: that the weekly regime is non-redundant, and that it is highly persistent. **The persistence leg is now retired.** It was an artefact of a slow moving average, and no honest measurement of it exceeds chance at any horizon this product trades.

Non-redundancy is untouched by this study — a 41.3% agreement rate with the daily tag is a statement about two labels, not about persistence — and remains on the record.

**What this does NOT say.** It does not say higher-timeframe context is worthless, and it does not revisit Phase 6's decision, which already declined to build the filter for a different reason. It says one specific supporting claim was not evidence, and that any future argument for a weekly filter must rest on outcomes rather than on stability.

**Methodological finding, applicable beyond this study.** Any persistence, dwell, or regime-stability statistic computed from a smoothed indicator is inflated by the smoothing and by the base rate. Neither correction was applied anywhere in this repository before now. Every such number previously published should be read as descriptive only.
