# Harmonic Pattern Study

Generated 2026-08-11T21:41:51.314Z · research only, nothing wired to production.

## 1. Detection census

Total completed patterns: **2950** (BTC + ETH, Daily + 4H, ~4 years)

| Pattern | 1D | 4H | Bullish | Bearish | Median quality |
|---|---|---|---|---|---|
| Cypher | 100 | 769 | 412 | 457 | 0.48 |
| Gartley | 34 | 279 | 173 | 140 | 0.67 |
| Bat | 44 | 265 | 157 | 152 | 0.64 |
| Shark | 93 | 574 | 340 | 327 | 0.49 |
| Crab | 53 | 220 | 144 | 129 | 0.59 |
| DeepCrab | 28 | 226 | 130 | 124 | 0.64 |
| Butterfly | 29 | 236 | 144 | 121 | 0.66 |

## 2. Look-ahead: what the naive timestamp would have stolen

Every pattern measured twice. The honest row enters at the CLOSE OF THE BAR AT WHICH THE PATTERN BECAME KNOWABLE. The naive row enters at D's own price on D's own bar — which is unobtainable, because a fractal low is only a low once the following bars have printed higher. The gap IS the hindsight, and it is large.

| Timestamp | n | Median maxR | 1R reached | Stopped |
|---|---|---|---|---|
| knownAt + tradeable entry (honest) | 2948 | 0.44 | 31.5% | 70.6% |
| completedAt + D-price (naive) | 2948 | 1.11 | 52.3% | 71.4% |

## 3. Forward outcomes from knownAt (direction-adjusted)

| Segment | n | 1d win | 3d win | 7d win | 14d win | 21d win | 30d win | Median maxR |
|---|---|---|---|---|---|---|---|---|
| ALL harmonics | 2950 | 46.2% | 44.6% | 40.9% | 38.7% | 36.4% | 36.0% | 0.44 |
| 1D only | 381 | 47.0% | 48.3% | 48.8% | 45.9% | 42.3% | 43.8% | 0.18 |
| 4H only | 2569 | 46.1% | 44.1% | 39.8% | 37.7% | 35.5% | 34.8% | 0.50 |
| bullish | 1500 | 44.6% | 43.4% | 38.9% | 36.5% | 33.1% | 33.1% | 0.43 |
| bearish | 1450 | 47.9% | 45.9% | 43.0% | 41.0% | 39.9% | 39.0% | 0.46 |
| quality >= 0.8 | 118 | 44.9% | 44.1% | 46.6% | 41.5% | 37.3% | 38.1% | 0.44 |
| Cypher | 869 | 47.4% | 47.4% | 45.1% | 45.1% | 44.6% | 43.2% | 0.53 |
| Gartley | 313 | 48.9% | 44.4% | 40.3% | 33.2% | 26.2% | 26.5% | 0.58 |
| Bat | 309 | 43.7% | 42.4% | 36.9% | 29.4% | 26.2% | 24.3% | 0.75 |
| Shark | 667 | 44.5% | 41.4% | 34.3% | 31.5% | 28.5% | 28.9% | 0.61 |
| Crab | 273 | 46.2% | 45.4% | 44.7% | 45.4% | 44.0% | 44.7% | 0.10 |
| DeepCrab | 254 | 48.8% | 48.0% | 46.9% | 47.2% | 45.3% | 45.3% | 0.12 |
| Butterfly | 265 | 44.2% | 42.6% | 40.0% | 38.5% | 37.0% | 37.4% | 0.42 |

## 4. Probability of reaching each R level (R defined by the X invalidation)

| Segment | n | 0.5R | 1R | 1.5R | 2R | 3R | Stopped |
|---|---|---|---|---|---|---|---|
| ALL | 2950 | 47.2% | 31.5% | 23.9% | 18.3% | 12.1% | 70.6% |
| 1D | 381 | 29.9% | 16.8% | 13.6% | 10.0% | 5.5% | 55.4% |
| 4H | 2569 | 49.8% | 33.6% | 25.5% | 19.6% | 13.1% | 72.8% |
| quality >= 0.8 | 118 | 45.8% | 38.1% | 28.0% | 24.6% | 16.1% | 83.9% |

## 5. Incremental value over the existing engine

The question is not whether harmonics win — it is whether they say anything the engine does not already know. Baseline is every replayed day with a directional bias; harmonic days are those where a pattern became knowable within the prior 3 days AND pointed the same way as the bias.

| Group | n | 7d win | 95% CI | 7d mean | 14d win | 30d win |
|---|---|---|---|---|---|---|
| BASELINE (all directional days) | 2137 | 53.3% | 51.1–55.4% | +0.28% | 53.3% | 54.5% |
| + harmonic agrees | 1607 | 53.2% | 50.8–55.6% | +0.33% | 54.3% | 53.9% |
| + HIGH-QUALITY harmonic agrees | 65 | 69.2% | 57.2–79.1% | +2.21% | 67.7% | 61.5% |
