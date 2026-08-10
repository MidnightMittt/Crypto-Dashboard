# Adaptive component ablation

Each variant is a full replay of the real production engine with one or both adaptive components switched off. Compared on the same 5 purged walk-forward folds (7-day embargo) used in Phase 3. Variant B is what ships today.

| Variant | Trades | Win | Pooled expectancy | Profit factor | Med MAE | Med MFE | Folds positive | Mean fold | Worst fold |
|---|---|---|---|---|---|---|---|---|---|
| A. Fixed weights (control) | 1382 | 46% | +0.073% | 1.03 | -3.7% | +3.8% | 4/5 | +0.305% | -0.573% |
| B. Regime weights (currently shipped) | 1350 | 45% | -0.004% | 1.00 | -3.7% | +3.8% | 3/5 | +0.228% | -0.584% |
| C. Fixed weights + MTF gate | 1228 | 46% | +0.078% | 1.03 | -3.7% | +3.8% | 4/5 | +0.356% | -0.775% |
| D. Regime weights + MTF gate | 1200 | 46% | +0.026% | 1.01 | -3.7% | +3.8% | 3/5 | +0.313% | -0.789% |

## Delta vs the fixed-weight control

| Variant | Δ pooled expectancy | Δ trades | Δ folds positive | Δ worst fold | Verdict |
|---|---|---|---|---|---|
| B. Regime weights (currently shipped) | -0.077% | -32 | -1 | -0.011% | does NOT earn its place |
| C. Fixed weights + MTF gate | +0.005% | -154 | +0 | -0.202% | does NOT earn its place |
| D. Regime weights + MTF gate | -0.047% | -182 | -1 | -0.216% | does NOT earn its place |

A component "earns its place" only by improving pooled expectancy WITHOUT deepening the worst out-of-sample fold. Lifting the average while making bad periods worse is a robustness trade, not an improvement.

## Per-fold detail

| Variant | Fold 1 | Fold 2 | Fold 3 | Fold 4 | Fold 5 |
|---|---|---|---|---|---|
| A. Fixed weights (control) | -0.573% | +0.118% | +0.221% | +0.318% | +1.440% |
| B. Regime weights (currently shipped) | -0.584% | +0.083% | -0.401% | +0.466% | +1.577% |
| C. Fixed weights + MTF gate | -0.775% | +0.227% | +0.114% | +0.533% | +1.683% |
| D. Regime weights + MTF gate | -0.789% | +0.188% | -0.406% | +0.700% | +1.872% |

- **A. Fixed weights (control)** — CATEGORY_WEIGHTS applied unmodified. The true baseline — what the engine does with no regime adaptation at all.
- **B. Regime weights (currently shipped)** — regimeAdjustedCategoryWeights active. This is production today, and has never been measured against A.
- **C. Fixed weights + MTF gate** — Selectivity alone: block ENTER when the 4H read weakens the thesis, no regime weighting.
- **D. Regime weights + MTF gate** — Both components together — tests whether they compose or overlap.
