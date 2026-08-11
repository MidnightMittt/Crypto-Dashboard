# Target Calibration Study

Generated 2026-08-11T21:26:32.998Z · research only, no production target changed.

Every plan resolved with its **production entry and production stop but no target**, held to the stop or 30 days. The maximum favourable excursion in R is then the complete answer to what any target could have achieved: `P(target at X R hits) = P(maxR ≥ X)`. No methodology can beat that curve — each is only a rule for choosing X — so there is nothing here to overfit.

Filled plans analysed: **67** (of 81 plans).

## 1. How far do filled plans actually travel?

| Percentile | max R reached |
|---|---|
| p10 | 0.15R |
| p25 | 0.35R |
| median | 0.91R |
| p75 | 2.26R |
| p90 | 3.39R |
| max | 9.16R |

Stop hit within the horizon: **64.2%**
Median hours to peak excursion: 86.0h
Median hours to stop (when stopped): 103.0h

## 2. Hit rate and expectancy by target distance

This is the whole study in one table. Expectancy is in R.

| Target | Hit rate | 95% CI | Expectancy (R) |
|---|---|---|---|
| 0.5R | 64.2% | 52.2–74.6% | -0.04 |
| 1.0R | 49.3% | 37.7–60.9% | +0.01 |
| 1.5R | 38.8% | 28.0–50.8% | +0.16 |
| 2.0R | 26.9% | 17.7–38.5% | +0.16 |
| 2.5R | 14.9% | 8.3–25.3% | +0.13 |
| 3.0R | 11.9% | 6.2–21.8% | +0.20 |
| 4.0R | 9.0% | 4.2–18.2% | +0.29 |
| 5.0R | 6.0% | 2.3–14.4% | +0.38 |

## 3. Target reachability by holding period

Share of filled plans whose excursion reached each R level WITHIN each horizon.

| Horizon | 0.5R | 1R | 1.5R | 2R | 2.5R | 3R | 4R | 5R |
|---|---|---|---|---|---|---|---|---|
| 1d | 22.4% | 6.0% | 4.5% | 1.5% | 0.0% | 0.0% | 0.0% | 0.0% |
| 3d | 34.3% | 14.9% | 10.4% | 6.0% | 3.0% | 1.5% | 0.0% | 0.0% |
| 7d | 50.7% | 26.9% | 17.9% | 11.9% | 4.5% | 3.0% | 0.0% | 0.0% |
| 14d | 62.7% | 38.8% | 31.3% | 20.9% | 9.0% | 6.0% | 4.5% | 1.5% |
| 21d | 64.2% | 43.3% | 32.8% | 22.4% | 11.9% | 10.4% | 7.5% | 4.5% |
| 30d | 64.2% | 49.3% | 38.8% | 26.9% | 14.9% | 11.9% | 9.0% | 6.0% |

## 4. Segments

| Segment | n | Median maxR | Stop% | 1R hit | 2R hit | 3R hit |
|---|---|---|---|---|---|---|
| all | 67 | 0.91R | 64.2% | 49.3% | 26.9% | 11.9% |
| long | 12 | 1.22R | 50.0% | 66.7% | 25.0% | 8.3% |
| short | 55 | 0.79R | 67.3% | 45.5% | 27.3% | 12.7% |
| BTC | 31 | 1.32R | 64.5% | 54.8% | 25.8% | 6.5% |
| ETH | 36 | 0.67R | 63.9% | 44.4% | 27.8% | 16.7% |

## 5. In-sample / out-of-sample / walk-forward

| Window | n | 1R hit | 2R hit | 3R hit | Best-expectancy target |
|---|---|---|---|---|---|
| IS (first 60%) | 40 | 37.5% | 20.0% | 7.5% | 5.0R (-0.06) |
| OOS (last 40%) | 27 | 66.7% | 37.0% | 18.5% | 5.0R (+1.02) |
| fold 1 | 13 | 38.5% | 7.7% | 7.7% | 5.0R (-0.16) |
| fold 2 | 13 | 15.4% | 15.4% | 0.0% | 2.5R (-0.34) |
| fold 3 | 13 | 61.5% | 38.5% | 15.4% | 1.5R (+0.50) |
| fold 4 | 13 | 61.5% | 38.5% | 15.4% | 5.0R (+0.96) |
| fold 5 | 13 | 69.2% | 38.5% | 23.1% | 5.0R (+1.23) |
