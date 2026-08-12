# Execution Validation — unified engine across market types

A controlled comparison, not a strategy study. The same mechanical probe trades over the same bars, resolved twice: once under each instrument's CORRECT session model, and once under the continuous model the legacy engine implicitly assumed for everything. The difference is the error the migration removed.

Instruments: 16 session-based (SPY, QQQ, DIA, IWM, VTI, TLT, IEF, SHY, TIP, LQD, HYG, GLD, SLV, USO, DBA, XLF). Probe: entry every 5 sessions, stop 1.5 ATR, target 3 ATR, max hold 30 days, from 2010-01-01.

## Legacy (continuous assumption) vs unified (correct session model)

| Metric | Legacy — continuous | Unified — session-aware | Difference |
|---|---|---|---|
| Trades resolved | 13328 | 13328 | 0 |
| Win rate | 36.23% | 36.23% | 0.00% |
| Expectancy (gross %) | 0.024% | -0.005% | -0.029% |
| Average R | 0.018 | 0.002 | -0.016 |
| Mean MAE % | -1.683 | -1.600 | 0.083 |
| Mean MFE % | 1.950 | 1.904 | -0.046 |
| Median hold (hours) | 240 | 240 | 0 |
| Ambiguous bars | 2 | 2 | 0 |

**Gap exits under the correct model: 2865 of 13328 (21.5%).** Legacy reported 0, because a continuous market cannot gap by definition.

**Total gap slippage: -388.46 percentage points** across 2865 gapped trades, averaging -0.14pp each. Negative means fills worse than the intended level.

## Which differences are expected, and which would indicate a bug

| Observation | Expected? | Reasoning |
|---|---|---|
| Trade count identical | **Required** | The session model changes only how a trade RESOLVES, never whether it is opened. A different count would mean the plan generation was contaminated. |
| Expectancy lower under session model | **Expected** | Adverse gaps fill worse than the level; favourable gaps fill better, but stops are hit more often than targets in a 1.5/3.0 ATR probe, so the net is negative. |
| Win rate roughly unchanged | **Expected** | A gap changes the exit PRICE, not usually which level was breached. A large win-rate move would suggest the gap branch is picking the wrong level. |
| MAE LESS negative under session model | **Expected — but I predicted the opposite** | A gap exit terminates the trade at the open; the rest of that bar never happens to the position. The continuous model holds through the whole bar and records its full adverse low. So continuous books WORSE heat (-1.68%) while simultaneously booking a BETTER exit (at the stop) — an incoherent pair the migration removes. Both legacy numbers were wrong, in opposite directions. |
| MFE less positive under session model | **Expected** | Same truncation: an early gap exit forgoes favourable excursion later in the bar. |
| Median hold unchanged | **Expected** | Gaps change price, not timing. A change here would mean the break condition moved. |
| Gap exits > 0 for equities | **Required** | Zero would mean the branch never fires and the migration is inert. |
| Any gap exit on a continuous instrument | **BUG** | `gapsPossible` is false; the branch must be unreachable. |
| Exit price outside the exiting bar's range | **BUG** | An unfillable price. Audited separately: 0 of 309 real crypto exits. |
