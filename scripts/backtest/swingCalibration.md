# Swing Activation Calibration Study

Generated 2026-08-11T08:01:01.411Z · research only, no production threshold changed.

## 1. Baseline (shipped configuration)

Stateless `action` churn over the same days: **1035 changes / 2896 asset-days = 0.36 per day**. That is what the swing layer replaced.

| Asset | Days | Active | Long | Short | No thesis | Theses | Median dur | Mean dur | Act/month |
|---|---|---|---|---|---|---|---|---|---|
| BTC | 1448 | 24.1% | 6.9% | 17.2% | 75.9% | 50 | 6.0d | 7.0d | 1.05 |
| ETH | 1448 | 25.1% | 4.0% | 21.1% | 74.9% | 57 | 5.0d | 6.4d | 1.20 |

### Activation by regime

| Regime | Days | Active | Rate |
|---|---|---|---|
| neutral · low-vol · range-bound | 551 | 144 | 26.1% |
| neutral · normal-vol | 309 | 85 | 27.5% |
| neutral · high-vol | 282 | 40 | 14.2% |
| bear · high-vol | 280 | 75 | 26.8% |
| bull · high-vol | 266 | 15 | 5.6% |
| bear · normal-vol | 170 | 75 | 44.1% |
| bull · normal-vol | 169 | 28 | 16.6% |
| bull · low-vol · range-bound | 162 | 32 | 19.8% |
| bull · low-vol | 155 | 35 | 22.6% |
| neutral · low-vol | 136 | 45 | 33.1% |
| neutral · normal-vol · range-bound | 135 | 19 | 14.1% |
| bear · low-vol · range-bound | 97 | 51 | 52.6% |
| bear · low-vol | 64 | 33 | 51.6% |
| bull · normal-vol · range-bound | 50 | 8 | 16.0% |

## 2. What actually blocks the inactive days

Inactive day-records: **2184** of 2896.

`Mean fwd 7d` is direction-adjusted: positive means the market moved the way the blocked thesis would have pointed.

| Blocking gate | Days | Share | Mean fwd 7d | n |
|---|---|---|---|---|
| bias-neutral | 701 | 32.1% | — | — |
| daily-not-confirming | 513 | 23.5% | +0.24% | 512 |
| conviction-below-activation | 327 | 15.0% | +0.17% | 327 |
| sustain-not-met | 317 | 14.5% | +0.68% | 316 |
| 4h-contradicts | 242 | 11.1% | +0.27% | 242 |
| 4h-weakens | 84 | 3.8% | +0.17% | 84 |

Days passing EVERY gate but short of consecutive confirmation: **317** (14.5% of inactive).

## 3. Activated vs non-activated forward outcomes

| Horizon | Group | N | Win rate | 95% CI | Mean | p10 | p90 |
|---|---|---|---|---|---|---|---|
| 1d | ACTIVATED | 712 | 48.5% | 44.8–52.1% | +0.10% | -2.78% | 3.27% |
| 1d | passed over | 1483 | 53.3% | 50.8–55.9% | +0.11% | -2.94% | 3.29% |
| 3d | ACTIVATED | 712 | 50.8% | 47.2–54.5% | +0.23% | -5.19% | 6.36% |
| 3d | passed over | 1483 | 53.1% | 50.5–55.6% | +0.21% | -5.17% | 5.70% |
| 7d | ACTIVATED | 712 | 51.7% | 48.0–55.3% | +0.28% | -8.86% | 9.42% |
| 7d | passed over | 1481 | 54.0% | 51.5–56.5% | +0.32% | -8.02% | 9.07% |
| 14d | ACTIVATED | 712 | 51.8% | 48.2–55.5% | +0.18% | -14.41% | 13.84% |
| 14d | passed over | 1472 | 54.2% | 51.7–56.7% | +0.24% | -12.10% | 11.94% |
| 30d | ACTIVATED | 712 | 55.1% | 51.4–58.7% | -0.84% | -28.66% | 19.70% |
| 30d | passed over | 1452 | 54.1% | 51.5–56.6% | +0.04% | -20.15% | 18.55% |

## 4. Realized quality of SWING PLANS

**Correction to an earlier reading of this data.** `DayRecord.trade` is resolved from the STATELESS recommendation with an at-market entry, so it is completely invariant to the swing configuration — a sweep over swing thresholds returns byte-identical trade statistics. Those numbers describe the old engine, not this one. Everything below instead resolves the FROZEN swing plan, fill-aware: a plan only becomes a trade if price actually trades into its entry zone within 14 days, and is then held at most 21 days.

| Group | Plans | Fill rate | Med hrs to fill | Filled n | Win rate | 95% CI | Expectancy | MFE | MAE | TP1 | TP2 | Stopped | Timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 107 | 87.9% | 1.5h | 94 | 34.0% | 25.3–44.1% | +0.01% | 7.67% | -6.18% | 16.0% | 0.0% | 48.9% | 35.1% |
| long | 26 | 92.3% | 1.0h | 24 | 41.7% | 24.5–61.2% | +1.03% | 8.66% | -5.44% | 25.0% | 0.0% | 37.5% | 37.5% |
| short | 81 | 86.4% | 3.0h | 70 | 31.4% | 21.8–43.0% | -0.34% | 7.33% | -6.43% | 12.9% | 0.0% | 52.9% | 34.3% |
| BTC | 50 | 90.0% | 1.0h | 45 | 31.1% | 19.5–45.7% | -0.10% | 6.34% | -4.84% | 11.1% | 0.0% | 46.7% | 42.2% |
| ETH | 57 | 86.0% | 8.0h | 49 | 36.7% | 24.7–50.7% | +0.12% | 8.89% | -7.41% | 20.4% | 0.0% | 51.0% | 28.6% |

## 5. Candidate sweep — in-sample vs out-of-sample

One parameter moved at a time from the shipped config. IS = first 60% of each asset's timeline, OOS = the rest.

| Candidate | Win | Act% | Theses | MedDur | Plans | Fill% | Filled n | Win rate | 95% CI | Expectancy | Stopped |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BASELINE (shipped) | IS | 22.5% | 59 | 5.0d | 59 | 89.8% | 53 | 26.4% | 16.4–39.6% | -2.68% | 56.6% |
| BASELINE (shipped) | OOS | 27.7% | 48 | 6.0d | 48 | 85.4% | 41 | 43.9% | 29.9–59.0% | +3.49% | 39.0% |
| activationBand 7 | IS | 24.0% | 69 | 4.0d | 69 | 89.9% | 62 | 27.4% | 17.9–39.6% | -2.82% | 56.5% |
| activationBand 7 | OOS | 29.1% | 56 | 5.0d | 56 | 85.7% | 48 | 41.7% | 28.8–55.7% | +2.62% | 41.7% |
| activationBand 8 | IS | 23.7% | 65 | 5.0d | 65 | 89.2% | 58 | 27.6% | 17.8–40.2% | -2.81% | 55.2% |
| activationBand 8 | OOS | 27.2% | 52 | 5.0d | 52 | 84.6% | 44 | 43.2% | 29.7–57.8% | +3.27% | 40.9% |
| activationBand 10 | IS | 21.6% | 57 | 5.0d | 57 | 89.5% | 51 | 27.5% | 17.1–40.9% | -2.68% | 56.9% |
| activationBand 10 | OOS | 28.7% | 47 | 6.0d | 47 | 85.1% | 40 | 42.5% | 28.5–57.8% | +3.29% | 40.0% |
| activationBand 11 | IS | 21.6% | 55 | 6.0d | 55 | 89.1% | 49 | 28.6% | 17.8–42.4% | -2.52% | 55.1% |
| activationBand 11 | OOS | 26.8% | 44 | 5.5d | 44 | 81.8% | 36 | 41.7% | 27.1–57.8% | +2.54% | 41.7% |
| sustainCloses 1 | IS | 35.8% | 106 | 5.0d | 106 | 91.5% | 97 | 33.0% | 24.4–42.8% | -1.62% | 50.5% |
| sustainCloses 1 | OOS | 41.9% | 81 | 5.0d | 79 | 86.1% | 68 | 52.9% | 41.2–64.3% | +2.94% | 39.7% |
| sustainCloses 3 | IS | 15.0% | 37 | 6.0d | 37 | 97.3% | 36 | 30.6% | 18.0–46.9% | -2.61% | 52.8% |
| sustainCloses 3 | OOS | 15.6% | 24 | 6.0d | 24 | 83.3% | 20 | 55.0% | 34.2–74.2% | +2.90% | 30.0% |
| deactivationBand 3 | IS | 22.5% | 59 | 5.0d | 59 | 89.8% | 53 | 26.4% | 16.4–39.6% | -2.68% | 56.6% |
| deactivationBand 3 | OOS | 27.7% | 48 | 6.0d | 48 | 85.4% | 41 | 43.9% | 29.9–59.0% | +3.49% | 39.0% |
| deactivationBand 7 | IS | 22.2% | 60 | 5.0d | 60 | 90.0% | 54 | 27.8% | 17.6–40.9% | -2.53% | 55.6% |
| deactivationBand 7 | OOS | 25.1% | 49 | 5.0d | 49 | 85.7% | 42 | 45.2% | 31.2–60.1% | +3.80% | 38.1% |
| maxWeakening 2 | IS | 19.0% | 68 | 4.0d | 68 | 89.7% | 61 | 29.5% | 19.6–41.9% | -2.05% | 55.7% |
| maxWeakening 2 | OOS | 21.3% | 55 | 4.0d | 55 | 81.8% | 45 | 46.7% | 32.9–60.9% | +4.45% | 37.8% |
| maxWeakening 5 | IS | 26.9% | 53 | 6.0d | 53 | 90.6% | 48 | 27.1% | 16.6–41.0% | -2.50% | 54.2% |
| maxWeakening 5 | OOS | 32.0% | 45 | 8.0d | 45 | 86.7% | 39 | 46.2% | 31.6–61.4% | +3.78% | 38.5% |

## 6. Walk-forward

5 sequential folds per asset with a 7-day embargo at each boundary (trades are held up to 7 days, so an unpurged boundary would leak).

| Candidate | Folds w/ >=8 filled | Mean fold win | Worst | Best | Mean expectancy |
|---|---|---|---|---|---|
| BASELINE (shipped) | 5/5 | 33.5% | 0.0% | 45.5% | -0.06% |
| activationBand 7 | 5/5 | 33.2% | 5.0% | 44.0% | -0.47% |
| activationBand 8 | 5/5 | 33.4% | 0.0% | 47.8% | -0.26% |
| activationBand 10 | 5/5 | 33.0% | 0.0% | 43.8% | -0.24% |
| activationBand 11 | 5/5 | 32.9% | 0.0% | 46.2% | -0.45% |
| sustainCloses 1 | 5/5 | 41.6% | 27.8% | 60.0% | +0.24% |
| sustainCloses 3 | 5/5 | 40.8% | 20.0% | 62.5% | +0.20% |
| deactivationBand 3 | 5/5 | 33.5% | 0.0% | 45.5% | -0.06% |
| deactivationBand 7 | 5/5 | 34.5% | 0.0% | 47.8% | +0.10% |
| maxWeakening 2 | 5/5 | 36.7% | 5.0% | 48.0% | +0.78% |
| maxWeakening 5 | 5/5 | 34.7% | 0.0% | 50.0% | +0.13% |
