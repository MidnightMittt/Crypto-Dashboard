# Cross-Asset Ingestion — Architecture Proof

Demonstrates that the research engine runs unchanged on equities. No branch on asset class exists anywhere below; the only per-instrument input is the universe registry entry.

## 1. Ingested universe

| Instrument | Class | Session | Bars | From | To |
|---|---|---|---|---|---|
| SPY.US | equity-etf | US equity RTH | 8440 | 1993-01-29 | 2026-08-11 |
| QQQ.US | equity-etf | US equity RTH | 6898 | 1999-03-10 | 2026-08-11 |
| DIA.US | equity-etf | US equity RTH | 7184 | 1998-01-20 | 2026-08-11 |
| IWM.US | equity-etf | US equity RTH | 6590 | 2000-05-26 | 2026-08-11 |
| XLF.US | equity-etf | US equity RTH | 6950 | 1998-12-22 | 2026-08-11 |

## 2. The universal feature library runs unmodified

These are the same `UNIVERSAL_FEATURES` written for crypto, reading through the same `BoundedMarketView`. No equity-specific feature was added.

| Instrument | trend_medium | return_20d | efficiency_20d | atr_percentile |
|---|---|---|---|---|
| SPY.US | flat | 2.67% | 0.35 | 0.63 |
| QQQ.US | up | 6.02% | 0.53 | 0.49 |
| DIA.US | flat | -3.05% | 0.34 | 0.89 |
| IWM.US | flat | -4.16% | 0.24 | 0.59 |
| XLF.US | flat | -3.63% | 0.28 | 0.82 |

## 3. The panel estimator discounts real correlated instruments

Five US equity index/sector ETFs share most of their variance. If the estimator is working, five instruments must deliver far less than five times the information. This is the Phase 7 correlation finding, now measured on real equity data rather than crypto.

| Panel | Instruments | n | Periods | Effective N | n_eff / n | SE |
|---|---|---|---|---|---|---|
| SPY only | 1 | 2913 | 2913 | 929.40 | 0.32 | 0.07 |
| All five | 5 | 14565 | 2913 | 1091.62 | 0.07 | 0.08 |

Five times the observations (2913 to 14565) buys **1.17x** the effective sample, not 5x. Standard error falls only from 0.07 to 0.08. That is the cross-sectional correction operating on real, genuinely correlated instruments — and it is exactly the behaviour that makes "add more tickers" a weak strategy for statistical power.

## 4. A mixed crypto/equity panel keys onto shared trading sessions

SPY sessions since 2015: 2913. BTC sessions available: 1738 (2021-11-01 to 2026-08-04).

Within the window both cover, **1193 of 1193 SPY sessions (100.00%) find a matching BTC session key.**

Near-total alignment is the correct result and is the whole point of session normalisation: a crypto bar closing at 00:00 UTC covers the PREVIOUS day, so keying on its raw timestamp would file it a day late and this figure would collapse. Crypto additionally trades 545 sessions with no equity counterpart (weekends and market holidays), which is expected and correctly leaves those periods holding a single unit.

## 5. `executeStudy` runs end-to-end on equities

The same pipeline used for every crypto study: declaration, session normalisation, panel estimation, overlap correction, walk-forward, IS/OOS and mechanical grading. Nothing is passed to indicate that these are equities.

| Field | Value |
|---|---|
| Raw observations | 14565 |
| Trading sessions | 2913 |
| Mean units per session | 5.00 |
| Derived block length | 7 |
| **Effective N** | **912.52** |
| Strictly independent N | 583 |
| Point estimate | 0.29% |
| 95% CI (BCA) | 0.10% to 0.44% |
| Corrected p | 0.0040 |
| Detectable effect | 0.25% |
| **Grade** | **B** |

Grading reasons, generated mechanically:

- Statistically significant after overlap correction: p = 0.0040.
- Observed effect 0.2869 against a detectable floor of 0.2488.
- Reproducible: walk-forward folds agree in direction.
- Out-of-sample agrees with in-sample in direction.
- Effect is statistically real but below the declared practical threshold: 0.2869 against a 0.5000 target.

**Recommendation.** Implement only if the cost of doing so is near zero. The effect is credible but too small to justify added complexity on its own.

The grade is the point, not the finding: a real 5-session index drift is nowhere near the 0.5% practical threshold declared above, so the rubric correctly refuses to call this actionable. The pipeline executed on equities and reached a defensible verdict without a single asset-class branch.