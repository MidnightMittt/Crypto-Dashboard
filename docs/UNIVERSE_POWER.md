# Universe Power Report

Measures whether each asset class adds INDEPENDENT information, rather than assuming it. Instrument count is not the objective; effective sample size is.

## Ingested and validated

| Class | Instruments |
|---|---|
| bond | TLT, IEF, SHY, TIP, LQD, HYG |
| commodity | GLD, SLV, USO, DBA |
| crypto | SOL, BNB, XRP |
| equity-etf | SPY, QQQ, DIA, IWM, VTI, XLF |

**Not ingested (8):** BTC-USD-PERP, ETH-USD-PERP, EURUSD.FX, USDJPY.FX, GBPUSD.FX, AUDUSD.FX, USDCAD.FX, USDCHF.FX — see the rejection note in the phase report.

## Mean pairwise correlation

| | bond | commodity | crypto | equity-etf |
|---|---|---|---|---|
| **bond** | 0.44 | 0.07 | 0.06 | -0.01 |
| **commodity** | 0.07 | 0.33 | 0.08 | 0.20 |
| **crypto** | 0.06 | 0.08 | 0.48 | 0.24 |
| **equity-etf** | -0.01 | 0.20 | 0.24 | 0.87 |

## Cumulative effective sample size, by tier

Each tier ADDS to the previous. The question at every step is not how many instruments were added but how much independent information they carried.

| Tier | Instruments | Raw n | Sessions | Effective N | n_eff/n | Detectable effect | vs baseline |
|---|---|---|---|---|---|---|---|
| Crypto only (prior baseline) | 3 | 8693 | 3192 | 1445.81 | 0.166 | 1.039% | 1.00x |
| + US equity indices | 9 | 36749 | 5675 | 4211.40 | 0.115 | 0.306% | 2.91x |
| + Treasuries & credit | 15 | 64805 | 5675 | 7451.07 | 0.115 | 0.179% | 5.15x |
| + Commodities (full universe) | 19 | 83509 | 5675 | 8473.09 | 0.101 | 0.157% | 5.86x |

## Marginal contribution of each class

Effective N of the full universe, minus the effective N with that class REMOVED. This is the honest measure of what a class is worth: what is lost by deleting it.

| Class removed | Instruments dropped | Effective N without it | Information lost |
|---|---|---|---|
| Crypto | 3 | 5111.21 | **3361.88** (39.68%) |
| Equity indices | 6 | 8511.23 | **-38.13** (-0.45%) |
| Bonds & credit | 6 | 6076.68 | **2396.41** (28.28%) |
| Commodities | 4 | 7451.07 | **1022.03** (12.06%) |

Full-universe effective N: **8473.09**.