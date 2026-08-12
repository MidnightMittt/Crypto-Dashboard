# Overlap Audit — which published backtest statistics are affected

Point estimates are NOT affected by overlap; it inflates confidence, not the estimate. So no win rate anywhere in the app changes. What changes is which of those win rates may be called significant, and how large the sample behind them honestly is.

## Per-metric hypothesis stats (report.ts's core table)

| Metric | Holding | N | Eff. N | Win rate | naive p | corrected p | Verdict change |
|---|---|---|---|---|---|---|---|
| Funding Rate | 1h | 33 | 17 | 48.5% | 1.0000 | 0.8774 | no change |
| Funding Rate | 4h | 33 | 17 | 33.3% | 0.0801 | 0.0517 | no change |
| Funding Rate | 24h | 33 | 17 | 30.3% | 0.0351 | 0.0298 | no change |
| Funding Rate | 7d | 33 | 2 | 57.6% | 0.4869 | 0.4216 | no change |
| Open Interest | 1h | 648 | 324 | 44.4% | 0.0052 | 0.0061 | no change |
| Open Interest | 4h | 648 | 324 | 46.3% | 0.0648 | 0.0772 | no change |
| Open Interest | 24h | 648 | 324 | 51.7% | 0.4094 | 0.4324 | no change |
| Open Interest | 7d | 647 | 46 | 48.2% | 0.3871 | 0.4966 | no change |
| Squeeze Setup | 1h | 2340 | 1170 | 49.4% | 0.5767 | 0.5968 | no change |
| Squeeze Setup | 4h | 2340 | 1170 | 48.1% | 0.0658 | 0.0919 | no change |
| Squeeze Setup | 24h | 2340 | 1170 | 50.6% | 0.5488 | 0.5769 | no change |
| Squeeze Setup | 7d | 2338 | 167 | 50.6% | 0.6051 | 0.8031 | no change |
| Long/Short Positioning | 1h | 1271 | 636 | 50.0% | 1.0000 | 0.9791 | no change |
| Long/Short Positioning | 4h | 1271 | 636 | 50.8% | 0.5748 | 0.5788 | no change |
| Long/Short Positioning | 24h | 1271 | 636 | 51.2% | 0.4001 | 0.4180 | no change |
| Long/Short Positioning | 7d | 1270 | 91 | 50.6% | 0.7153 | 0.8468 | no change |
| Basis vs Spot | 1h | 2706 | 1353 | 49.7% | 0.8027 | 0.8160 | no change |
| Basis vs Spot | 4h | 2706 | 1353 | 50.0% | 0.9847 | 0.9734 | no change |
| Basis vs Spot | 24h | 2706 | 1353 | 49.6% | 0.7149 | 0.7461 | no change |
| Basis vs Spot | 7d | 2704 | 193 | 50.1% | 0.8929 | 0.9472 | no change |
| Price Action | 1h | 2196 | 1098 | 48.9% | 0.2957 | 0.3460 | no change |
| Price Action | 4h | 2196 | 1098 | 49.2% | 0.4551 | 0.4880 | no change |
| Price Action | 24h | 2196 | 1098 | 48.0% | 0.0697 | 0.1092 | no change |
| Price Action | 7d | 2195 | 157 | 48.6% | 0.2003 | 0.5401 | no change |
| ETF Flows | 1h | 541 | 271 | 51.8% | 0.4390 | 0.4587 | no change |
| ETF Flows | 4h | 541 | 271 | 52.3% | 0.3021 | 0.3163 | no change |
| ETF Flows | 24h | 541 | 271 | 65.6% | 0.0000 | 0.0000 | no change |
| ETF Flows | 7d | 540 | 39 | 57.0% | 0.0012 | 0.0637 | **LOST significance** |
| Spot vs Perp Volume | 1h | 2066 | 1033 | 50.7% | 0.5525 | 0.5631 | no change |
| Spot vs Perp Volume | 4h | 2066 | 1033 | 49.3% | 0.5525 | 0.5740 | no change |
| Spot vs Perp Volume | 24h | 2066 | 1033 | 48.2% | 0.0989 | 0.1250 | no change |
| Spot vs Perp Volume | 7d | 2065 | 148 | 49.8% | 0.8950 | 0.9359 | no change |
| Stablecoin Supply | 1h | 2262 | 1131 | 51.2% | 0.2475 | 0.3149 | no change |
| Stablecoin Supply | 4h | 2262 | 1131 | 52.3% | 0.0272 | 0.0505 | **LOST significance** |
| Stablecoin Supply | 24h | 2262 | 1131 | 50.1% | 0.9497 | 0.9404 | no change |
| Stablecoin Supply | 7d | 2260 | 161 | 53.5% | 0.0008 | 0.1442 | **LOST significance** |
| Fear & Greed | 1h | 806 | 403 | 50.4% | 0.8602 | 0.8566 | no change |
| Fear & Greed | 4h | 806 | 403 | 52.0% | 0.2749 | 0.3192 | no change |
| Fear & Greed | 24h | 806 | 403 | 53.6% | 0.0446 | 0.0820 | **LOST significance** |
| Fear & Greed | 7d | 806 | 58 | 54.3% | 0.0150 | 0.2941 | **LOST significance** |
| Macro Liquidity | 1h | 2350 | 1175 | 50.8% | 0.4453 | 0.5021 | no change |
| Macro Liquidity | 4h | 2350 | 1175 | 49.5% | 0.6352 | 0.6627 | no change |
| Macro Liquidity | 24h | 2350 | 1175 | 50.6% | 0.5497 | 0.5945 | no change |
| Macro Liquidity | 7d | 2348 | 168 | 50.9% | 0.4209 | 0.7250 | no change |
| Market Structure | 1h | 1762 | 881 | 48.8% | 0.3056 | 0.3341 | no change |
| Market Structure | 4h | 1762 | 881 | 50.1% | 0.9430 | 0.9288 | no change |
| Market Structure | 24h | 1762 | 881 | 49.1% | 0.4897 | 0.4880 | no change |
| Market Structure | 7d | 1761 | 126 | 45.5% | 0.0002 | 0.0541 | **LOST significance** |

**6 of 48** metric x holding-period cells lose significance under correction.

Cells that were significant and are not: `ETF Flows @ 7d`, `Stablecoin Supply @ 4h`, `Stablecoin Supply @ 7d`, `Fear & Greed @ 24h`, `Fear & Greed @ 7d`, `Market Structure @ 7d`.

## Does any of this reach a user?

Four lookups feed the UI (`lookupMetricPerformance`, `lookupBiasVerdictStat`, `lookupCategoryStat`, `lookupCalibrationBucket`). Taking each field the panels actually render:

| Rendered field | Where | Affected? |
|---|---|---|
| `winRate24h` | HistoricalPerformancePanel | **No** — point estimate, and 24h windows do not overlap in time |
| `winRate7d` | HistoricalPerformancePanel | **Point estimate fine**; but it is one of two win rates shown side by side with no uncertainty attached, and its honest sample is 1/7 of the printed occurrence count |
| `n24h` ("Occurrences") | HistoricalPerformancePanel | Literally correct, but overstates independent evidence ~2x (BTC+ETH same day) |
| `sampleSizeLabel` | HistoricalPerformancePanel | **Yes** — derived from raw n against 200/1000 cut points; see below |
| Category / bias verdict win rates | CategoryCard, AiMarketSummary | Point estimates, all at 24h — unaffected |
| Calibration buckets | AiMarketSummary | Point estimates — unaffected |

### sampleSizeLabel — now a standing check, not a finding

This section originally reported that the shipped label was computed on the RAW occurrence count and would change tier for two metrics if computed honestly. That has been applied: `deriveSampleSizeLabel` now takes the effective sample, and report.ts feeds it one.

So the table below no longer recomputes what the label *would* be. It reads the label actually shipped in `src/data/backtestMetricStats.json` and checks it against what this audit derives independently. A DRIFT row means the published file and this audit disagree about how much evidence a metric has — which is the failure this section now exists to catch.

| Metric | n (24h) | Effective n | Shipped label | Audit's label | |
|---|---|---|---|---|---|
| Funding Rate | 33 | 17 | Small | Small | ok |
| Open Interest | 648 | 324 | Medium | Medium | ok |
| Squeeze Setup | 2340 | 1170 | Large | Large | ok |
| Long/Short Positioning | 1271 | 636 | Medium | Medium | ok |
| Basis vs Spot | 2706 | 1353 | Large | Large | ok |
| Price Action | 2196 | 1098 | Large | Large | ok |
| ETF Flows | 541 | 271 | Medium | Medium | ok |
| Spot vs Perp Volume | 2066 | 1033 | Large | Large | ok |
| Stablecoin Supply | 2262 | 1131 | Large | Large | ok |
| Fear & Greed | 806 | 403 | Medium | Medium | ok |
| Macro Liquidity | 2350 | 1175 | Large | Large | ok |
| Market Structure | 1762 | 881 | Medium | Medium | ok |

**No drift.** Every shipped label matches what this audit derives from the replay independently.

## Conclusion

The blast radius is smaller than feared, for one structural reason: the UI's headline horizon is 24h, and 24-hour windows sampled daily do not overlap each other. The badly affected horizon — 7d, which shares six days in seven — is used in research reports and shown as a bare win rate, never as a significance claim.

So: **no win rate displayed anywhere in the app is wrong, and none needs to change.** What was wrong was the confidence attached to research conclusions drawn from overlapping horizons — most consequentially the harmonic study's 30-day headline, which has been restated (see harmonicIncrementalStudy.md).

Recommended follow-ups, in value order:

1. Route report.ts's hypothesis section through `blockBootstrapProportion` so future reports cannot repeat the error. This is the durable fix.
2. ~~Recompute `sampleSizeLabel` on the effective count.~~ **DONE.** `deriveSampleSizeLabel` takes the effective sample and report.ts feeds it one; the section above is now a standing drift check rather than a finding. Long/Short Positioning and Market Structure both moved Large -> Medium, and their `confidenceLabel` moved with them.
3. Leave every displayed win rate exactly as it is. Overlap inflates confidence, never the point estimate — this remains true and nothing about item 2 changed a single win rate.

One caveat worth carrying forward: the Medium/Large cut point of 1000 was fixed against the OLD raw distribution and was not re-drawn for the effective one, deliberately — re-drawing a threshold after seeing which metrics it demotes would be choosing a cut to obtain a label. But it does mean the boundary is currently sensitive: Market Structure sits at 881, 12% below it. Read that "Medium" as near-the-boundary rather than as a verdict. See `deriveSampleSizeLabel`'s own note.