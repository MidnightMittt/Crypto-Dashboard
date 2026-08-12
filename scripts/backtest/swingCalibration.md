# Swing Activation Calibration Study

Generated 2026-08-12T07:54:08.606Z · research only, no production threshold changed.

## 1. Baseline (shipped configuration)

Stateless `action` churn over the same days: **1035 changes / 2896 asset-days = 0.36 per day**. That is what the swing layer replaced.

| Asset | Days | Active | Long | Short | No thesis | Theses | Median dur | Mean dur | Act/month |
|---|---|---|---|---|---|---|---|---|---|
| BTC | 1448 | 15.6% | 3.9% | 11.7% | 84.4% | 37 | 4.0d | 6.1d | 0.78 |
| ETH | 1448 | 18.4% | 1.9% | 16.5% | 81.6% | 44 | 5.0d | 6.0d | 0.92 |

### Activation by regime

| Regime | Days | Active | Rate |
|---|---|---|---|
| neutral · low-vol · range-bound | 551 | 112 | 20.3% |
| neutral · normal-vol | 309 | 61 | 19.7% |
| neutral · high-vol | 282 | 22 | 7.8% |
| bear · high-vol | 280 | 50 | 17.9% |
| bull · high-vol | 266 | 4 | 1.5% |
| bear · normal-vol | 170 | 56 | 32.9% |
| bull · normal-vol | 169 | 5 | 3.0% |
| bull · low-vol · range-bound | 162 | 19 | 11.7% |
| bull · low-vol | 155 | 17 | 11.0% |
| neutral · low-vol | 136 | 34 | 25.0% |
| neutral · normal-vol · range-bound | 135 | 17 | 12.6% |
| bear · low-vol · range-bound | 97 | 39 | 40.2% |
| bear · low-vol | 64 | 28 | 43.8% |
| bull · normal-vol · range-bound | 50 | 4 | 8.0% |

## 2. What actually blocks the inactive days

Inactive day-records: **2404** of 2896.

`Mean fwd 7d` is direction-adjusted: positive means the market moved the way the blocked thesis would have pointed.

| Blocking gate | Days | Share | Mean fwd 7d | n |
|---|---|---|---|---|
| bias-neutral | 729 | 30.3% | — | — |
| daily-not-confirming | 515 | 21.4% | +0.30% | 514 |
| sustain-not-met | 435 | 18.1% | +0.95% | 434 |
| conviction-below-activation | 351 | 14.6% | +0.14% | 351 |
| 4h-contradicts | 276 | 11.5% | +0.16% | 276 |
| 4h-weakens | 98 | 4.1% | +0.06% | 98 |

Days passing EVERY gate but short of consecutive confirmation: **435** (18.1% of inactive).

## 3. Activated vs non-activated forward outcomes

| Horizon | Group | N | Win rate | 95% CI | Mean | p10 | p90 |
|---|---|---|---|---|---|---|---|
| 1d | ACTIVATED | 492 | 46.7% | 42.4–51.2% | +0.02% | -3.13% | 3.44% |
| 1d | passed over | 1675 | 53.3% | 50.9–55.6% | +0.13% | -2.86% | 3.27% |
| 3d | ACTIVATED | 492 | 49.6% | 45.2–54.0% | +0.04% | -5.89% | 6.66% |
| 3d | passed over | 1675 | 53.0% | 50.6–55.3% | +0.26% | -5.05% | 5.70% |
| 7d | ACTIVATED | 492 | 49.0% | 44.6–53.4% | -0.07% | -9.02% | 9.74% |
| 7d | passed over | 1673 | 54.3% | 51.9–56.7% | +0.40% | -7.95% | 8.93% |
| 14d | ACTIVATED | 492 | 48.2% | 43.8–52.6% | -0.64% | -14.80% | 12.80% |
| 14d | passed over | 1664 | 54.9% | 52.5–57.2% | +0.46% | -11.85% | 12.26% |
| 30d | ACTIVATED | 492 | 52.0% | 47.6–56.4% | -1.83% | -29.52% | 19.70% |
| 30d | passed over | 1644 | 55.4% | 52.9–57.7% | +0.29% | -20.24% | 18.66% |

## 4. Realized quality of SWING PLANS

**Correction to an earlier reading of this data.** `DayRecord.trade` is resolved from the STATELESS recommendation with an at-market entry, so it is completely invariant to the swing configuration — a sweep over swing thresholds returns byte-identical trade statistics. Those numbers describe the old engine, not this one. Everything below instead resolves the FROZEN swing plan, fill-aware: a plan only becomes a trade if price actually trades into its entry zone within 14 days, and is then held at most 21 days.

| Group | Plans | Fill rate | Med hrs to fill | Filled n | Win rate | 95% CI | Expectancy | MFE | MAE | TP1 | TP2 | Stopped | Timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 81 | 82.7% | 36.0h | 67 | 29.9% | 20.2–41.7% | -0.85% | 7.80% | -6.12% | 11.9% | 3.0% | 58.2% | 29.9% |
| long | 15 | 80.0% | 42.0h | 12 | 41.7% | 19.3–68.0% | +0.81% | 9.52% | -4.94% | 16.7% | 0.0% | 33.3% | 50.0% |
| short | 66 | 83.3% | 36.0h | 55 | 27.3% | 17.3–40.2% | -1.22% | 7.42% | -6.38% | 10.9% | 3.6% | 63.6% | 25.5% |
| BTC | 37 | 83.8% | 36.0h | 31 | 32.3% | 18.6–49.9% | -0.56% | 7.17% | -4.65% | 6.5% | 0.0% | 54.8% | 38.7% |
| ETH | 44 | 81.8% | 40.0h | 36 | 27.8% | 15.8–44.0% | -1.11% | 8.34% | -7.38% | 16.7% | 5.6% | 61.1% | 22.2% |

## 5. Candidate sweep — in-sample vs out-of-sample

One parameter moved at a time from the shipped config. IS = first 60% of each asset's timeline, OOS = the rest.

| Candidate | Win | Act% | Theses | MedDur | Plans | Fill% | Filled n | Win rate | 95% CI | Expectancy | Stopped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BASELINE (shipped) | IS | 16.7% | 46 | 5.0d | 46 | 87.0% | 40 | 17.5% | 8.7–32.0% | -3.62% | 70.0% |
| BASELINE (shipped) | OOS | 17.4% | 35 | 4.0d | 35 | 77.1% | 27 | 48.1% | 30.7–66.0% | +3.24% | 40.7% |
| activationBand 7 | IS | 17.5% | 50 | 4.0d | 50 | 86.0% | 43 | 18.6% | 9.7–32.6% | -3.37% | 69.8% |
| activationBand 7 | OOS | 18.4% | 40 | 4.0d | 40 | 80.0% | 32 | 43.8% | 28.2–60.7% | +1.87% | 46.9% |
| activationBand 8 | IS | 16.9% | 47 | 5.0d | 47 | 85.1% | 40 | 17.5% | 8.7–32.0% | -3.62% | 70.0% |
| activationBand 8 | OOS | 17.4% | 37 | 4.0d | 37 | 78.4% | 29 | 44.8% | 28.4–62.5% | +2.57% | 44.8% |
| activationBand 10 | IS | 16.7% | 46 | 5.0d | 46 | 87.0% | 40 | 17.5% | 8.7–32.0% | -3.62% | 70.0% |
| activationBand 10 | OOS | 17.7% | 34 | 4.5d | 34 | 76.5% | 26 | 46.2% | 28.8–64.5% | +2.92% | 42.3% |
| activationBand 11 | IS | 16.9% | 45 | 5.0d | 45 | 86.7% | 39 | 17.9% | 9.0–32.7% | -3.70% | 69.2% |
| activationBand 11 | OOS | 17.2% | 33 | 5.0d | 33 | 72.7% | 24 | 45.8% | 27.9–64.9% | +2.30% | 45.8% |
| sustainCloses 1 | IS | 23.6% | 65 | 5.0d | 65 | 83.1% | 54 | 24.1% | 14.6–36.9% | -1.93% | 59.3% |
| sustainCloses 1 | OOS | 27.2% | 60 | 4.0d | 59 | 78.0% | 46 | 45.7% | 32.2–59.8% | +1.69% | 50.0% |
| sustainCloses 3 | IS | 11.8% | 31 | 6.0d | 31 | 93.5% | 29 | 24.1% | 12.2–42.1% | -2.94% | 72.4% |
| sustainCloses 3 | OOS | 11.2% | 18 | 5.5d | 18 | 77.8% | 14 | 57.1% | 32.6–78.6% | +4.03% | 28.6% |
| deactivationBand 3 | IS | 16.7% | 46 | 5.0d | 46 | 87.0% | 40 | 17.5% | 8.7–32.0% | -3.62% | 70.0% |
| deactivationBand 3 | OOS | 17.4% | 35 | 4.0d | 35 | 77.1% | 27 | 48.1% | 30.7–66.0% | +3.24% | 40.7% |
| deactivationBand 7 | IS | 16.3% | 46 | 5.0d | 46 | 87.0% | 40 | 17.5% | 8.7–32.0% | -3.62% | 70.0% |
| deactivationBand 7 | OOS | 16.1% | 35 | 4.0d | 35 | 77.1% | 27 | 48.1% | 30.7–66.0% | +3.24% | 40.7% |
| maxWeakening 2 | IS | 13.0% | 51 | 4.0d | 51 | 86.3% | 44 | 20.5% | 11.2–34.5% | -2.86% | 68.2% |
| maxWeakening 2 | OOS | 14.3% | 39 | 3.0d | 39 | 74.4% | 29 | 48.3% | 31.4–65.6% | +3.55% | 41.4% |
| maxWeakening 5 | IS | 19.6% | 42 | 6.5d | 42 | 88.1% | 37 | 18.9% | 9.5–34.2% | -3.09% | 67.6% |
| maxWeakening 5 | OOS | 19.9% | 33 | 5.0d | 33 | 78.8% | 26 | 50.0% | 32.1–67.9% | +3.44% | 42.3% |

## 6. Walk-forward

5 sequential folds per asset with a 7-day embargo at each boundary (trades are held up to 7 days, so an unpurged boundary would leak).

| Candidate | Folds w/ >=8 filled | Mean fold win | Worst | Best | Mean expectancy |
|---|---|---|---|---|---|
| BASELINE (shipped) | 5/5 | 30.4% | 0.0% | 53.3% | -0.69% |
| activationBand 7 | 5/5 | 29.3% | 6.3% | 46.2% | -1.08% |
| activationBand 8 | 5/5 | 29.0% | 0.0% | 50.0% | -0.98% |
| activationBand 10 | 5/5 | 29.8% | 0.0% | 50.0% | -0.81% |
| activationBand 11 | 5/5 | 29.6% | 0.0% | 50.0% | -1.15% |
| sustainCloses 1 | 5/5 | 32.8% | 18.2% | 50.0% | -0.54% |
| sustainCloses 3 | 4/5 | 33.7% | 22.2% | 62.5% | -1.16% |
| deactivationBand 3 | 5/5 | 30.4% | 0.0% | 53.3% | -0.69% |
| deactivationBand 7 | 5/5 | 30.4% | 0.0% | 53.3% | -0.69% |
| maxWeakening 2 | 5/5 | 32.6% | 5.9% | 52.9% | -0.07% |
| maxWeakening 5 | 5/5 | 32.1% | 0.0% | 57.1% | -0.32% |

## 7. Entry-methodology comparison

Activation set held FIXED — only the choice of entry zone varies. Every methodology turns its chosen zone into levels by the same rules production uses (stop beyond the retested zone, R:R from the worst fill), so differences are attributable to zone choice alone.

**Harness acceptance test** — control reproduced 81/81 production plans exactly (entry, stop, TP1, TP2). PASS — differences below are attributable to zone choice alone.

| Methodology | Plans | Med standoff | Med R:R | Fill% | Med hrs to fill | n | Win | 95% CI | Expectancy | MFE | MAE | TP1 | TP2 | Stop | Med days held |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A control (production, unfiltered) | 81 | 0.53 ATR | 3.13 | 82.7% | 36.0h | 67 | 29.9% | 20.2–41.7% | -0.85% | 7.80% | -6.12% | 11.9% | 3.0% | 58.2% | 9.3d |
| B strongest zone | 51 | 0.62 ATR | 2.50 | 78.4% | 31.5h | 40 | 37.5% | 24.2–53.0% | -0.66% | 8.56% | -6.93% | 12.5% | 0.0% | 50.0% | 13.4d |
| C daily-dominant | 48 | 0.61 ATR | 2.49 | 79.2% | 35.0h | 38 | 39.5% | 25.6–55.3% | -0.40% | 8.91% | -6.99% | 13.2% | 0.0% | 47.4% | 13.8d |
| D daily+4H confluence | 48 | 0.61 ATR | 2.49 | 79.2% | 35.0h | 38 | 39.5% | 25.6–55.3% | -0.40% | 8.91% | -6.99% | 13.2% | 0.0% | 47.4% | 13.8d |
| E min standoff 1 ATR | 52 | 1.85 ATR | 4.29 | 36.5% | 120.0h | 19 | 26.3% | 11.8–48.8% | -1.31% | 5.63% | -5.99% | 5.3% | 0.0% | 68.4% | 4.7d |
| F most touched zone | 44 | 0.74 ATR | 2.35 | 84.1% | 48.0h | 37 | 29.7% | 17.5–45.8% | -2.22% | 8.01% | -7.39% | 10.8% | 0.0% | 51.4% | 13.3d |
| G hybrid quality | 66 | 0.83 ATR | 2.74 | 72.7% | 46.5h | 48 | 37.5% | 25.2–51.6% | -0.08% | 8.71% | -6.63% | 10.4% | 0.0% | 50.0% | 13.4d |

### Long vs short, per methodology

| Methodology | Long n | Long win | Long exp | Short n | Short win | Short exp |
|---|---|---|---|---|---|---|
| A control (production, unfiltered) | 12 | 41.7% | +0.81% | 55 | 27.3% | -1.22% |
| B strongest zone | 7 | 42.9% | -0.22% | 33 | 36.4% | -0.75% |
| C daily-dominant | 7 | 42.9% | -0.22% | 31 | 38.7% | -0.44% |
| D daily+4H confluence | 7 | 42.9% | -0.22% | 31 | 38.7% | -0.44% |
| E min standoff 1 ATR | 4 | 50.0% | -0.42% | 15 | 20.0% | -1.55% |
| F most touched zone | 6 | 33.3% | -0.49% | 31 | 29.0% | -2.56% |
| G hybrid quality | 8 | 50.0% | +1.13% | 40 | 35.0% | -0.32% |

### Walk-forward per methodology

| Methodology | Folds w/ >=8 | Mean fold win | Worst | Best | Mean expectancy |
|---|---|---|---|---|---|
| A control (production, unfiltered) | 5/5 | 29.3% | 0.0% | 53.3% | -0.70% |
| B strongest zone | 4/5 | 39.6% | 22.2% | 66.7% | -0.96% |
| C daily-dominant | 4/5 | 43.1% | 22.2% | 75.0% | -0.57% |
| D daily+4H confluence | 4/5 | 43.1% | 22.2% | 75.0% | -0.57% |
| E min standoff 1 ATR | 0/5 | — | — | — | — |
| F most touched zone | 2/5 | 16.7% | 11.1% | 22.2% | -3.59% |
| G hybrid quality | 4/5 | 37.7% | 20.0% | 54.5% | -0.44% |

## 8. TP2 diagnosis

Everything in R, so target distance and realized excursion are directly comparable. `MFE p90` is the 90th percentile favourable excursion actually achieved — if TP2 sits beyond even that, it is not a target the market declined to reach, it is a target the methodology never made reachable.

| Methodology | TP1 dist | TP2 dist | MFE median | MFE p90 | MFE max | TP2 within MFE p90? | TP1 hit% | TP2 hit% |
|---|---|---|---|---|---|---|---|---|
| A control (production, unfiltered) | 3.13R | 5.56R | 0.82R | 2.61R | 5.18R | **no** | 11.9% | 3.0% |
| B strongest zone | 2.39R | 4.21R | 0.78R | 2.50R | 5.18R | **no** | 12.5% | 0.0% |
| C daily-dominant | 2.39R | 4.05R | 0.82R | 2.50R | 5.18R | **no** | 13.2% | 0.0% |
| D daily+4H confluence | 2.39R | 4.05R | 0.82R | 2.50R | 5.18R | **no** | 13.2% | 0.0% |
| E min standoff 1 ATR | 3.41R | 5.59R | 0.67R | 1.93R | 4.79R | **no** | 5.3% | 0.0% |
| F most touched zone | 2.24R | 3.82R | 0.67R | 2.34R | 3.00R | **no** | 10.8% | 0.0% |
| G hybrid quality | 2.55R | 4.62R | 0.78R | 2.50R | 5.18R | **no** | 10.4% | 0.0% |
