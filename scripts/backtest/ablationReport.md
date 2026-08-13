# Per-voter ablation — marginal contribution of each Edge voter

Each row removes ONE voter entirely and replays the full history. Edge is win rate minus the drift null, in percentage points; Δedge is (baseline − ablated): POSITIVE means the composite was BETTER with the voter present (it contributes), NEGATIVE means the composite improved when the voter was removed (it detracts). All in-sample, descriptive, uncorrected for the 9-way scan — an input to weight re-derivation, not a verdict on its own.

Baseline: bullish n=393 win 57.0% vs null 50.2% (edge 6.8pp) · bearish n=1428 win 51.3% vs null 49.9% (edge 1.4pp) · directional days 1821.

| Removed voter | Bull n | Bull edge (pp) | Δ bull edge | Bear n | Bear edge (pp) | Δ bear edge | Directional days |
|---|---|---|---|---|---|---|---|
| funding | 317 | 5.8 | +1.0 | 1688 | 0.5 | +0.9 | 2005 |
| squeezeRisk | 787 | 3.8 | +2.9 | 992 | 2.6 | -1.2 | 1779 |
| openInterest | 335 | 7.9 | -1.2 | 1512 | 1.2 | +0.2 | 1847 |
| basis | 437 | 5.8 | +0.9 | 1374 | 1.0 | +0.4 | 1811 |
| longShort | 343 | 5.1 | +1.7 | 1564 | 0.9 | +0.5 | 1907 |
| etfFlows | 408 | 3.7 | +3.1 | 1349 | -0.2 | +1.6 | 1757 |
| spotPerpVolume | 402 | 7.7 | -1.0 | 1615 | 1.9 | -0.5 | 2017 |
| stablecoins | 405 | 7.6 | -0.9 | 1752 | 2.3 | -0.9 | 2157 |
| macroLiquidity | 765 | 1.7 | +5.0 | 1175 | 1.7 | -0.3 | 1940 |

Reading guide: a voter whose removal RAISES the composite's edge on both sides is a candidate for weight reduction at the next re-derivation; one whose removal collapses an edge is doing real work. Small deltas (<1pp) are noise at these sample sizes — do not rank on them.