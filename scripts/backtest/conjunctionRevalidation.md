# Conjunction revalidation — block correction + walk-forward (H5)

Second hurdle for every conjunction cell the scan flagged significant (drift-adjusted, and BH-corrected for automatic pairs). SURVIVES requires the block-bootstrapped p against the exposure-weighted drift null to stay under 0.05 AND a positive edge in both chronological halves. Criteria fixed before running. Survivors become registered FORWARD hypotheses scored against the daily ledger — not immediate engine weight; in-sample survivors still carry the selection bias of having been found in this same history.

| Conjunction | HP | N | Win | Null | Scan p | Block p | H1 edge (n) | H2 edge (n) | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| longShort+etfFlows | 24h | 53 | 77.4% | 49.8% | 0.0001 | 0.0000 | +23.3pp (26) | +31.6pp (27) | **SURVIVES** |
| etfFlows+fearGreed | 24h | 70 | 77.1% | 50.1% | 0.0000 | 0.0000 | +24.0pp (35) | +29.9pp (35) | **SURVIVES** |
| squeezeRisk+technicals | 7d | 85 | 72.9% | 52.5% | 0.0002 | 0.0000 | +23.8pp (42) | +17.1pp (43) | **SURVIVES** |
| longShort+etfFlows | 7d | 53 | 71.7% | 50.8% | 0.0031 | 0.0000 | +14.8pp (26) | +26.8pp (27) | **SURVIVES** |
| squeezeRisk+stablecoins | 7d | 77 | 71.4% | 52.6% | 0.0012 | 0.0000 | +15.9pp (38) | +21.7pp (39) | **SURVIVES** |
| etfFlows+fearGreed | 7d | 70 | 71.4% | 51.6% | 0.0011 | 0.0073 | +8.2pp (35) | +31.5pp (35) | **SURVIVES** |
| squeezeRisk+spotPerpVolume | 7d | 72 | 70.8% | 52.5% | 0.0023 | 0.0009 | +22.7pp (36) | +14.0pp (36) | **SURVIVES** |
| stablecoins+fearGreed | 7d | 156 | 67.9% | 51.4% | 0.0000 | 0.0194 | +1.2pp (78) | +32.0pp (78) | **SURVIVES** |
| etfFlows+marketStructure | 24h | 107 | 66.4% | 50.1% | 0.0010 | 0.0008 | +12.3pp (53) | +20.2pp (54) | **SURVIVES** |
| etfFlows+macroLiquidity | 24h | 107 | 65.4% | 50.1% | 0.0019 | 0.0014 | +8.4pp (53) | +22.2pp (54) | **SURVIVES** |

## Forward record — out-of-sample days since registration

Each registered hypothesis scored ONLY on replay days after its registration timestamp. This is the number that eventually earns (or denies) engine weight; the frozen in-sample stats above never update.

| Hypothesis | Registered | OOS n | OOS win | OOS null | OOS edge |
|---|---|---|---|---|---|
| longShort+etfFlows @ 24h | 2026-08-13 | 0 | — | — | accruing |
| etfFlows+fearGreed @ 24h | 2026-08-13 | 0 | — | — | accruing |
| squeezeRisk+technicals @ 7d | 2026-08-13 | 0 | — | — | accruing |
| longShort+etfFlows @ 7d | 2026-08-13 | 0 | — | — | accruing |
| squeezeRisk+stablecoins @ 7d | 2026-08-13 | 0 | — | — | accruing |
| etfFlows+fearGreed @ 7d | 2026-08-13 | 0 | — | — | accruing |
| squeezeRisk+spotPerpVolume @ 7d | 2026-08-13 | 0 | — | — | accruing |
| stablecoins+fearGreed @ 7d | 2026-08-13 | 0 | — | — | accruing |
| etfFlows+marketStructure @ 24h | 2026-08-13 | 0 | — | — | accruing |
| etfFlows+macroLiquidity @ 24h | 2026-08-13 | 0 | — | — | accruing |

**10 cell(s) survive:** `longShort+etfFlows @ 24h`, `etfFlows+fearGreed @ 24h`, `squeezeRisk+technicals @ 7d`, `longShort+etfFlows @ 7d`, `squeezeRisk+stablecoins @ 7d`, `etfFlows+fearGreed @ 7d`, `squeezeRisk+spotPerpVolume @ 7d`, `stablecoins+fearGreed @ 7d`, `etfFlows+marketStructure @ 24h`, `etfFlows+macroLiquidity @ 24h`.

Next step for survivors (tracked): freeze each as a named forward hypothesis and score it against the daily signal ledger as out-of-sample days accrue. Engine weight only after the forward record supports it — the validation-factory gate, applied to our own best cells.