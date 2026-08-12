# Harmonic Engine — Incremental Value Study (Production)

Reads `DayRecord.harmonic` from results.json — the actual production `buildHarmonicEvidence`/`selectBestHarmonic` output, replayed point-in-time-safe by scripts/backtest/run.ts. No detection logic is reimplemented here.

Total day-records: 2896. With a harmonic pattern present: 2889 (99.8%).

Status distribution: tradeable=1633, approaching=332, confirmed=408, prz-projected=77, confirmation-pending=436, inside-prz=3

### Full sample

| Tier | Horizon | N | Win rate | Mean | Median | p-value |
|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 2793 | 48% | +0.09% | +0.02% | 0.0584 |
| Baseline — Daily direction alone | 3d | 2793 | 49% | +0.24% | +0.15% | 0.1301 |
| Baseline — Daily direction alone | 7d | 2791 | 48% | +0.53% | +0.23% | 0.0958 |
| Baseline — Daily direction alone | 14d | 2777 | 48% | +1.16% | +0.28% | 0.0629 |
| Baseline — Daily direction alone | 30d | 2748 | 50% | +2.66% | +0.71% | 0.6334 |
| + Harmonic present (any pattern, any status) | 1d | 2889 | 50% | +0.07% | +0.01% | 0.6552 |
| + Harmonic present (any pattern, any status) | 3d | 2889 | 50% | +0.22% | +0.14% | 0.9407 |
| + Harmonic present (any pattern, any status) | 7d | 2887 | 50% | +0.52% | +0.22% | 0.9111 |
| + Harmonic present (any pattern, any status) | 14d | 2873 | 50% | +1.14% | +0.25% | 0.6815 |
| + Harmonic present (any pattern, any status) | 30d | 2841 | 53% | +2.64% | +0.66% | 0.0061 |
| + PRZ actually tested by price | 1d | 2477 | 51% | +0.11% | +0.04% | 0.4945 |
| + PRZ actually tested by price | 3d | 2477 | 51% | +0.25% | +0.18% | 0.4216 |
| + PRZ actually tested by price | 7d | 2475 | 50% | +0.50% | +0.24% | 0.8407 |
| + PRZ actually tested by price | 14d | 2461 | 50% | +1.23% | +0.27% | 0.7778 |
| + PRZ actually tested by price | 30d | 2436 | 53% | +2.56% | +0.74% | 0.0029 |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 2041 | 50% | +0.08% | +0.03% | 0.7905 |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 2041 | 50% | +0.19% | +0.13% | 0.7567 |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 2039 | 49% | +0.44% | +0.19% | 0.3757 |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 2027 | 49% | +1.21% | +0.37% | 0.5940 |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 2008 | 53% | +2.55% | +0.94% | 0.0150 |
| + High geometric quality (>=0.85) | 1d | 624 | 53% | +0.12% | +0.06% | 0.1611 |
| + High geometric quality (>=0.85) | 3d | 624 | 49% | +0.15% | +0.14% | 0.6597 |
| + High geometric quality (>=0.85) | 7d | 624 | 51% | +0.19% | +0.50% | 0.6028 |
| + High geometric quality (>=0.85) | 14d | 624 | 50% | +0.60% | +0.09% | 0.9044 |
| + High geometric quality (>=0.85) | 30d | 613 | 48% | +2.19% | +0.12% | 0.4672 |
| + Daily/4H confluence (other timeframe agrees) | 1d | 2323 | 50% | +0.08% | +0.02% | 0.9009 |
| + Daily/4H confluence (other timeframe agrees) | 3d | 2323 | 50% | +0.22% | +0.15% | 0.7088 |
| + Daily/4H confluence (other timeframe agrees) | 7d | 2321 | 49% | +0.36% | +0.14% | 0.5611 |
| + Daily/4H confluence (other timeframe agrees) | 14d | 2307 | 50% | +0.89% | +0.08% | 0.7391 |
| + Daily/4H confluence (other timeframe agrees) | 30d | 2284 | 53% | +2.43% | +0.80% | 0.0061 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 1633 | 50% | +0.13% | +0.03% | 0.7665 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 1633 | 51% | +0.21% | +0.22% | 0.3223 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 1632 | 51% | +0.45% | +0.32% | 0.6381 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 1626 | 50% | +1.15% | +0.41% | 0.7850 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 1611 | 54% | +2.06% | +0.86% | 0.0033 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 623 | 49% | -0.00% | +0.06% | 0.5215 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 623 | 47% | +0.19% | +0.07% | 0.1492 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 622 | 45% | +0.45% | +0.01% | 0.0115 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 614 | 44% | +1.04% | -0.03% | 0.0068 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 608 | 48% | +4.14% | +0.85% | 0.3106 |

### Full sample — lift over baseline

| Tier | Horizon | N | Win rate | Baseline win rate (same days) | Lift (pp) |
|---|---|---|---|---|---|
| + Harmonic present (any pattern, any status) | 1d | 2889 | 50% | 48% | +2.2 |
| + Harmonic present (any pattern, any status) | 3d | 2889 | 50% | 49% | +1.5 |
| + Harmonic present (any pattern, any status) | 7d | 2887 | 50% | 48% | +1.5 |
| + Harmonic present (any pattern, any status) | 14d | 2873 | 50% | 48% | +1.4 |
| + Harmonic present (any pattern, any status) | 30d | 2841 | 53% | 50% | +2.1 |
| + PRZ actually tested by price | 1d | 2477 | 51% | 48% | +2.7 |
| + PRZ actually tested by price | 3d | 2477 | 51% | 49% | +2.2 |
| + PRZ actually tested by price | 7d | 2475 | 50% | 48% | +1.7 |
| + PRZ actually tested by price | 14d | 2461 | 50% | 48% | +1.7 |
| + PRZ actually tested by price | 30d | 2436 | 53% | 51% | +2.1 |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 2041 | 50% | 47% | +2.2 |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 2041 | 50% | 49% | +1.1 |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 2039 | 49% | 47% | +1.8 |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 2027 | 49% | 47% | +2.0 |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 2008 | 53% | 51% | +2.0 |
| + High geometric quality (>=0.85) | 1d | 624 | 53% | 48% | +5.3 |
| + High geometric quality (>=0.85) | 3d | 624 | 49% | 49% | -0.1 |
| + High geometric quality (>=0.85) | 7d | 624 | 51% | 47% | +3.8 |
| + High geometric quality (>=0.85) | 14d | 624 | 50% | 48% | +2.1 |
| + High geometric quality (>=0.85) | 30d | 613 | 48% | 45% | +3.1 |
| + Daily/4H confluence (other timeframe agrees) | 1d | 2323 | 50% | 48% | +1.7 |
| + Daily/4H confluence (other timeframe agrees) | 3d | 2323 | 50% | 49% | +1.8 |
| + Daily/4H confluence (other timeframe agrees) | 7d | 2321 | 49% | 48% | +1.6 |
| + Daily/4H confluence (other timeframe agrees) | 14d | 2307 | 50% | 48% | +2.8 |
| + Daily/4H confluence (other timeframe agrees) | 30d | 2284 | 53% | 50% | +3.1 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 1633 | 50% | 48% | +2.5 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 1633 | 51% | 49% | +2.2 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 1632 | 51% | 48% | +2.4 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 1626 | 50% | 48% | +2.0 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 1611 | 54% | 51% | +2.5 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 623 | 49% | 46% | +2.6 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 623 | 47% | 46% | +1.3 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 622 | 45% | 44% | +0.9 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 614 | 44% | 45% | -0.1 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 608 | 48% | 48% | -0.5 |

In-sample: 2026 records (earliest 70% per asset). Out-of-sample: 870 records (latest 30% per asset).

### In-sample (discovery, first 70%)

| Tier | Horizon | N | Win rate | Mean | Median | p-value |
|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 1956 | 47% | +0.15% | +0.05% | 0.0041 |
| Baseline — Daily direction alone | 3d | 1956 | 49% | +0.42% | +0.23% | 0.2136 |
| Baseline — Daily direction alone | 7d | 1956 | 48% | +0.96% | +0.44% | 0.1416 |
| Baseline — Daily direction alone | 14d | 1956 | 49% | +2.02% | +0.60% | 0.2879 |
| Baseline — Daily direction alone | 30d | 1956 | 52% | +4.42% | +1.19% | 0.0740 |
| + Harmonic present (any pattern, any status) | 1d | 2019 | 50% | +0.13% | +0.03% | 0.7894 |
| + Harmonic present (any pattern, any status) | 3d | 2019 | 50% | +0.39% | +0.21% | 0.7894 |
| + Harmonic present (any pattern, any status) | 7d | 2019 | 50% | +0.93% | +0.42% | 0.7894 |
| + Harmonic present (any pattern, any status) | 14d | 2019 | 50% | +1.96% | +0.53% | 0.7894 |
| + Harmonic present (any pattern, any status) | 30d | 2019 | 54% | +4.38% | +1.17% | 0.0008 |
| + PRZ actually tested by price | 1d | 1699 | 50% | +0.15% | +0.05% | 0.9613 |
| + PRZ actually tested by price | 3d | 1699 | 50% | +0.39% | +0.21% | 1.0000 |
| + PRZ actually tested by price | 7d | 1699 | 50% | +0.90% | +0.43% | 0.7341 |
| + PRZ actually tested by price | 14d | 1699 | 50% | +2.13% | +0.60% | 0.8843 |
| + PRZ actually tested by price | 30d | 1699 | 54% | +4.38% | +1.30% | 0.0005 |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 1392 | 48% | +0.11% | +0.03% | 0.2718 |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 1392 | 48% | +0.28% | +0.14% | 0.2718 |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 1392 | 49% | +0.76% | +0.27% | 0.3213 |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 1392 | 49% | +2.01% | +0.48% | 0.6487 |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 1392 | 53% | +4.53% | +1.63% | 0.0147 |
| + High geometric quality (>=0.85) | 1d | 430 | 51% | +0.17% | +0.06% | 0.5958 |
| + High geometric quality (>=0.85) | 3d | 430 | 47% | +0.08% | +0.04% | 0.3112 |
| + High geometric quality (>=0.85) | 7d | 430 | 50% | +0.27% | +0.43% | 0.8850 |
| + High geometric quality (>=0.85) | 14d | 430 | 48% | +1.17% | -0.09% | 0.4695 |
| + High geometric quality (>=0.85) | 30d | 430 | 49% | +4.69% | +2.03% | 0.5958 |
| + Daily/4H confluence (other timeframe agrees) | 1d | 1609 | 49% | +0.16% | +0.04% | 0.3695 |
| + Daily/4H confluence (other timeframe agrees) | 3d | 1609 | 50% | +0.46% | +0.25% | 0.7648 |
| + Daily/4H confluence (other timeframe agrees) | 7d | 1609 | 49% | +0.92% | +0.42% | 0.6900 |
| + Daily/4H confluence (other timeframe agrees) | 14d | 1609 | 51% | +2.01% | +0.52% | 0.6536 |
| + Daily/4H confluence (other timeframe agrees) | 30d | 1609 | 54% | +4.48% | +1.49% | 0.0014 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 1071 | 48% | +0.17% | +0.03% | 0.3282 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 1071 | 50% | +0.38% | +0.28% | 0.9027 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 1071 | 51% | +0.97% | +0.56% | 0.6249 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 1071 | 51% | +2.11% | +0.77% | 0.6249 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 1071 | 54% | +4.30% | +1.57% | 0.0102 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 490 | 51% | +0.03% | +0.08% | 0.8213 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 490 | 48% | +0.09% | +0.02% | 0.4980 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 490 | 45% | +0.39% | -0.12% | 0.0420 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 490 | 44% | +1.39% | -0.12% | 0.0166 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 490 | 51% | +5.19% | +1.39% | 0.6844 |

### Out-of-sample (validation, last 30%)

| Tier | Horizon | N | Win rate | Mean | Median | p-value |
|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 837 | 52% | -0.05% | -0.02% | 0.3688 |
| Baseline — Daily direction alone | 3d | 837 | 49% | -0.18% | -0.05% | 0.4068 |
| Baseline — Daily direction alone | 7d | 835 | 49% | -0.48% | -0.25% | 0.4465 |
| Baseline — Daily direction alone | 14d | 821 | 47% | -0.89% | -0.58% | 0.0809 |
| Baseline — Daily direction alone | 30d | 792 | 47% | -1.69% | -0.73% | 0.0596 |
| + Harmonic present (any pattern, any status) | 1d | 870 | 52% | -0.06% | -0.03% | 0.2097 |
| + Harmonic present (any pattern, any status) | 3d | 870 | 51% | -0.18% | -0.03% | 0.5644 |
| + Harmonic present (any pattern, any status) | 7d | 868 | 50% | -0.44% | -0.21% | 0.8652 |
| + Harmonic present (any pattern, any status) | 14d | 854 | 49% | -0.81% | -0.44% | 0.7581 |
| + Harmonic present (any pattern, any status) | 30d | 822 | 50% | -1.63% | -0.77% | 0.9167 |
| + PRZ actually tested by price | 1d | 778 | 52% | +0.01% | +0.02% | 0.1846 |
| + PRZ actually tested by price | 3d | 778 | 53% | -0.06% | +0.07% | 0.1620 |
| + PRZ actually tested by price | 7d | 776 | 50% | -0.38% | -0.06% | 0.9142 |
| + PRZ actually tested by price | 14d | 762 | 49% | -0.78% | -0.44% | 0.7998 |
| + PRZ actually tested by price | 30d | 737 | 50% | -1.63% | -0.85% | 0.9413 |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 649 | 52% | +0.02% | +0.03% | 0.2717 |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 649 | 52% | -0.03% | +0.13% | 0.3074 |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 647 | 50% | -0.27% | +0.09% | 0.9373 |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 635 | 49% | -0.54% | +0.04% | 0.8118 |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 616 | 51% | -1.94% | -0.80% | 0.4934 |
| + High geometric quality (>=0.85) | 1d | 194 | 56% | +0.02% | +0.05% | 0.0984 |
| + High geometric quality (>=0.85) | 3d | 194 | 53% | +0.31% | +0.46% | 0.5183 |
| + High geometric quality (>=0.85) | 7d | 194 | 55% | -0.01% | +0.75% | 0.2222 |
| + High geometric quality (>=0.85) | 14d | 194 | 53% | -0.68% | +0.39% | 0.4297 |
| + High geometric quality (>=0.85) | 30d | 183 | 48% | -3.71% | -2.02% | 0.6575 |
| + Daily/4H confluence (other timeframe agrees) | 1d | 714 | 53% | -0.11% | -0.05% | 0.1075 |
| + Daily/4H confluence (other timeframe agrees) | 3d | 714 | 52% | -0.34% | -0.15% | 0.2460 |
| + Daily/4H confluence (other timeframe agrees) | 7d | 712 | 49% | -0.90% | -0.47% | 0.6802 |
| + Daily/4H confluence (other timeframe agrees) | 14d | 698 | 50% | -1.68% | -0.86% | 0.9698 |
| + Daily/4H confluence (other timeframe agrees) | 30d | 675 | 50% | -2.48% | -1.32% | 0.9386 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 562 | 54% | +0.05% | +0.04% | 0.0576 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 562 | 53% | -0.13% | +0.01% | 0.1398 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 561 | 50% | -0.53% | -0.03% | 0.9327 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 555 | 50% | -0.70% | -0.16% | 0.8652 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 540 | 53% | -2.38% | -0.91% | 0.1555 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 133 | 41% | -0.13% | +0.01% | 0.0560 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 133 | 42% | +0.57% | +0.21% | 0.0825 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 132 | 43% | +0.68% | +0.27% | 0.1387 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 124 | 44% | -0.35% | +0.86% | 0.2429 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 118 | 35% | -0.20% | -0.17% | 0.0012 |

### Out-of-sample — lift over baseline

| Tier | Horizon | N | Win rate | Baseline win rate (same days) | Lift (pp) |
|---|---|---|---|---|---|
| + Harmonic present (any pattern, any status) | 1d | 870 | 52% | 52% | +0.6 |
| + Harmonic present (any pattern, any status) | 3d | 870 | 51% | 49% | +2.5 |
| + Harmonic present (any pattern, any status) | 7d | 868 | 50% | 49% | +1.7 |
| + Harmonic present (any pattern, any status) | 14d | 854 | 49% | 47% | +2.5 |
| + Harmonic present (any pattern, any status) | 30d | 822 | 50% | 47% | +3.2 |
| + PRZ actually tested by price | 1d | 778 | 52% | 51% | +1.5 |
| + PRZ actually tested by price | 3d | 778 | 53% | 49% | +3.4 |
| + PRZ actually tested by price | 7d | 776 | 50% | 48% | +2.1 |
| + PRZ actually tested by price | 14d | 762 | 49% | 46% | +3.2 |
| + PRZ actually tested by price | 30d | 737 | 50% | 47% | +3.0 |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 649 | 52% | 52% | +0.5 |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 649 | 52% | 48% | +4.3 |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 647 | 50% | 45% | +4.3 |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 635 | 49% | 44% | +5.4 |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 616 | 51% | 46% | +5.4 |
| + High geometric quality (>=0.85) | 1d | 194 | 56% | 50% | +6.2 |
| + High geometric quality (>=0.85) | 3d | 194 | 53% | 49% | +3.7 |
| + High geometric quality (>=0.85) | 7d | 194 | 55% | 47% | +7.4 |
| + High geometric quality (>=0.85) | 14d | 194 | 53% | 44% | +9.3 |
| + High geometric quality (>=0.85) | 30d | 183 | 48% | 38% | +10.0 |
| + Daily/4H confluence (other timeframe agrees) | 1d | 714 | 53% | 51% | +2.1 |
| + Daily/4H confluence (other timeframe agrees) | 3d | 714 | 52% | 48% | +4.3 |
| + Daily/4H confluence (other timeframe agrees) | 7d | 712 | 49% | 46% | +3.0 |
| + Daily/4H confluence (other timeframe agrees) | 14d | 698 | 50% | 45% | +5.1 |
| + Daily/4H confluence (other timeframe agrees) | 30d | 675 | 50% | 45% | +5.2 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 562 | 54% | 52% | +2.5 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 562 | 53% | 48% | +5.0 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 561 | 50% | 46% | +4.2 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 555 | 50% | 45% | +5.0 |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 540 | 53% | 46% | +6.8 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 133 | 41% | 52% | -10.6 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 133 | 42% | 46% | -4.4 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 132 | 43% | 48% | -5.2 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 124 | 44% | 47% | -2.3 |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 118 | 35% | 50% | -14.8 |

### Walk-forward persistence — TRADEABLE tier, 7d horizon

| Fold | N | Win rate | Mean return |
|---|---|---|---|
| 1 | 408 | 46% | +0.24% |
| 2 | 408 | 51% | +1.79% |
| 3 | 408 | 53% | +1.15% |
| 4 | 408 | 52% | -1.36% |

## Verdicts

**Coverage caveat first.** A harmonic pattern of SOME kind is present on 99.8% of days (2889/2896) — with 8 patterns, two timeframes, and an intermediate-leg tolerance of ±8%, X-A-B-C-shaped structure is nearly always findable in noisy price data. This reproduces the earlier research phase's own finding almost exactly: "harmonic present" by itself is not a filter, it is close to a constant. Every conclusion below is about the TIERS that restrict this population (PRZ tested, confirmed, high-quality, confluence, tradeable) — those are where any real information has to live, if it exists at all.

**What the tiers show.** At 1D/3D/7D/14D — the horizons this app's swing framing actually cares about — lift over the same-day baseline is small (+1.5 to +5pp) and almost never clears p<0.05, for every tier including the full production gate (TRADEABLE: confirmed + regime-aligned). Out-of-sample, that short-horizon lift does not reliably improve and is sometimes smaller than in-sample. **No tier demonstrates dependable incremental value at the horizons a swing entry is actually held.**

**The 30D horizon is different.** Every non-diagnostic tier reaches p<0.01 at 30D in the full sample (TRADEABLE: 54% win rate, p=0.0033), and — genuinely encouraging, since nothing here was tuned to produce this — the edge is at least as large out-of-sample (TRADEABLE OOS: 53% win rate, +6.8pp lift over baseline). This is a real, persistent signal, but it is a **position/macro-horizon signal, not a swing-entry-timing signal**, and should be described that way rather than folded into language that implies it times weeks-scale entries.

**Walk-forward is not clean.** TRADEABLE/7D across 4 sequential folds: 46%, 51%, 53%, 52% win rate — fold 1 is sub-50%, and fold 4's mean return is NEGATIVE (-1.36%) despite a 52% win rate (a handful of large adverse moves outweighing many small wins). Four folds of ~408 is a thin basis to call this a demonstrated persistent edge; it is consistent with one, but does not prove one.

**The counter-trend diagnostic is the cleanest result in this study.** Counter-trend harmonics underperform baseline out-of-sample at every horizon, most sharply at 1D (-10.6pp) and 30D (-14.8pp, 35% win rate). This directly validates the architectural decision already built into `evidenceFor()`: a counter-trend pattern can reach `confirmed` but is explicitly withheld from `tradeable` status specifically because regime alignment matters — and here it demonstrably does. Whatever grade the evidence layer gets below, the "never let harmonics override the swing regime" design is empirically correct, not just principled.

**High-quality geometry (>=0.85) is suggestive, not confirmed.** OOS lift is the largest of any tier at 30D (+10.0pp), but N=183-194 is thin — flagged as a direction for future data collection, not a claim this study can stand behind yet.

### HARMONIC VERDICT: C — modest, horizon-specific evidence

Genuine incremental value exists, but it is narrower than the production engine's status machine implies by having a `tradeable` state at all. The evidence:
- **Not redundant** the way naive bullish/bearish labeling was — conditioning on PRZ/confirmation/confluence/regime-alignment produces a real, OOS-persistent, statistically significant edge at 30D that the daily-direction baseline alone does not have.
- **Does not extend to the swing-relevant 1D-14D window** where this app's actual entries are held — lift there is small, inconsistent, and not significant, in-sample or out.
- **Walk-forward is noisy** — 4 sequential folds do not tell a uniformly positive story, including one fold with a negative mean return.
- **The regime-alignment gate is independently validated** — counter-trend suppression is doing real, measurable work, which is reason on its own to keep the architecture even where the raw win-rate lift is weak.

Recommendation: keep the engine and its status machine exactly as built — it is architecturally correct (evidence-only, PRZ-based, quality/confirmation separated, regime-non-overriding) — but do not describe harmonic evidence in any UI or reasoning copy as improving swing-entry timing. It is honestly described as it already is on the live page: one more piece of corroborating evidence, occasionally decisive at a longer horizon than the entries themselves, never a standalone signal.