# Per-voter ablation — marginal contribution of each Edge voter

Each row removes ONE voter entirely and replays the full history. Edge is win rate minus the drift null, in percentage points; Δedge is (baseline − ablated): POSITIVE means the composite was BETTER with the voter present (it contributes), NEGATIVE means the composite improved when the voter was removed (it detracts). All in-sample, descriptive, uncorrected for the 7-way scan — an input to weight re-derivation, not a verdict on its own.

Engine `9.0.0`, 7 Edge voters: funding, squeezeRisk, openInterest, basis, etfFlows, stablecoins, macroLiquidity. Regenerate after any change that moves the composite, or the deltas below describe an engine that no longer ships.

Baseline: bullish n=377 win 57.8% vs null 50.3% (edge 7.6pp) · bearish n=1793 win 51.4% vs null 49.9% (edge 1.4pp) · directional days 2170.

| Removed voter | Bull n | Bull edge (pp) | Δ bull edge | Bear n | Bear edge (pp) | Δ bear edge | Directional days |
|---|---|---|---|---|---|---|---|
| funding | 252 | 3.9 | +3.6 | 2153 | 0.2 | +1.2 | 2405 |
| squeezeRisk | 715 | 4.6 | +2.9 | 1164 | 2.6 | -1.2 | 1879 |
| openInterest | 249 | 8.2 | -0.6 | 1927 | 1.4 | +0.1 | 2176 |
| basis | 440 | 4.8 | +2.8 | 1810 | 1.4 | -0.0 | 2250 |
| etfFlows | 447 | 3.7 | +3.8 | 1712 | -0.1 | +1.5 | 2159 |
| stablecoins | 396 | 7.2 | +0.4 | 2134 | 2.2 | -0.7 | 2530 |
| macroLiquidity | 760 | 2.5 | +5.1 | 1333 | 2.6 | -1.2 | 2093 |

Reading guide: a voter whose removal RAISES the composite's edge on both sides is a candidate for weight reduction at the next re-derivation; one whose removal collapses an edge is doing real work. Small deltas (<1pp) are noise at these sample sizes — do not rank on them.