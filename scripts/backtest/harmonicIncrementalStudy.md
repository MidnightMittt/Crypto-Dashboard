# Harmonic Engine — Incremental Value Study (Production)

Reads `DayRecord.harmonic` from results.json — the actual production `buildHarmonicEvidence`/`selectBestHarmonic` output, replayed point-in-time-safe by scripts/backtest/run.ts. No detection logic is reimplemented here.

Total day-records: 2896. With a harmonic pattern present: 2889 (99.8%).

Status distribution: tradeable=1633, approaching=332, confirmed=408, prz-projected=77, confirmation-pending=436, inside-prz=3

### Full sample

| Tier | Horizon | N | Eff. N | Win rate | Mean | Median | naive p | **corrected p** |
|---|---|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 2793 | 1397 | 48% | +0.09% | +0.02% | 0.0584 | **0.0829** |
| Baseline — Daily direction alone | 3d | 2793 | 466 | 49% | +0.24% | +0.15% | 0.1301 | **0.2951** |
| Baseline — Daily direction alone | 7d | 2791 | 199 | 48% | +0.53% | +0.23% | 0.0958 | **0.4283** |
| Baseline — Daily direction alone | 14d | 2777 | 99 | 48% | +1.16% | +0.28% | 0.0629 | **0.5042** |
| Baseline — Daily direction alone | 30d | 2748 | 46 | 50% | +2.66% | +0.71% | 0.6334 | **0.8828** |
| + Harmonic present (any pattern, any status) | 1d | 2889 | 1445 | 50% | +0.07% | +0.01% | 0.6552 | **0.6561** |
| + Harmonic present (any pattern, any status) | 3d | 2889 | 482 | 50% | +0.22% | +0.14% | 0.9407 | **0.9407** |
| + Harmonic present (any pattern, any status) | 7d | 2887 | 206 | 50% | +0.52% | +0.22% | 0.9111 | **0.9367** |
| + Harmonic present (any pattern, any status) | 14d | 2873 | 103 | 50% | +1.14% | +0.25% | 0.6815 | **0.8394** |
| + Harmonic present (any pattern, any status) | 30d | 2841 | 47 | 53% | +2.64% | +0.66% | 0.0061 | **0.2359** |
| + PRZ actually tested by price | 1d | 2477 | 1239 | 51% | +0.11% | +0.04% | 0.4945 | **0.5096** |
| + PRZ actually tested by price | 3d | 2477 | 413 | 51% | +0.25% | +0.18% | 0.4216 | **0.5035** |
| + PRZ actually tested by price | 7d | 2475 | 177 | 50% | +0.50% | +0.24% | 0.8407 | **0.8869** |
| + PRZ actually tested by price | 14d | 2461 | 88 | 50% | +1.23% | +0.27% | 0.7778 | **0.8817** |
| + PRZ actually tested by price | 30d | 2436 | 41 | 53% | +2.56% | +0.74% | 0.0029 | **0.1922** |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 2041 | 1021 | 50% | +0.08% | +0.03% | 0.7905 | **0.7820** |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 2041 | 340 | 50% | +0.19% | +0.13% | 0.7567 | **0.7937** |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 2039 | 146 | 49% | +0.44% | +0.19% | 0.3757 | **0.5427** |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 2027 | 72 | 49% | +1.21% | +0.37% | 0.5940 | **0.7753** |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 2008 | 33 | 53% | +2.55% | +0.94% | 0.0150 | **0.2545** |
| + High geometric quality (>=0.85) | 1d | 624 | 312 | 53% | +0.12% | +0.06% | 0.1611 | **0.1390** |
| + High geometric quality (>=0.85) | 3d | 624 | 104 | 49% | +0.15% | +0.14% | 0.6597 | **0.6568** |
| + High geometric quality (>=0.85) | 7d | 624 | 45 | 51% | +0.19% | +0.50% | 0.6028 | **0.6988** |
| + High geometric quality (>=0.85) | 14d | 624 | 22 | 50% | +0.60% | +0.09% | 0.9044 | **0.9018** |
| + High geometric quality (>=0.85) | 30d | 613 | 10 | 48% | +2.19% | +0.12% | 0.4672 | **0.5943** |
| + Daily/4H confluence (other timeframe agrees) | 1d | 2323 | 1162 | 50% | +0.08% | +0.02% | 0.9009 | **0.8900** |
| + Daily/4H confluence (other timeframe agrees) | 3d | 2323 | 387 | 50% | +0.22% | +0.15% | 0.7088 | **0.7700** |
| + Daily/4H confluence (other timeframe agrees) | 7d | 2321 | 166 | 49% | +0.36% | +0.14% | 0.5611 | **0.7427** |
| + Daily/4H confluence (other timeframe agrees) | 14d | 2307 | 82 | 50% | +0.89% | +0.08% | 0.7391 | **0.8781** |
| + Daily/4H confluence (other timeframe agrees) | 30d | 2284 | 38 | 53% | +2.43% | +0.80% | 0.0061 | **0.3050** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 1633 | 817 | 50% | +0.13% | +0.03% | 0.7665 | **0.7646** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 1633 | 272 | 51% | +0.21% | +0.22% | 0.3223 | **0.4374** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 1632 | 117 | 51% | +0.45% | +0.32% | 0.6381 | **0.7584** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 1626 | 58 | 50% | +1.15% | +0.41% | 0.7850 | **0.8946** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 1611 | 27 | 54% | +2.06% | +0.86% | 0.0033 | **0.2307** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 623 | 312 | 49% | -0.00% | +0.06% | 0.5215 | **0.4996** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 623 | 104 | 47% | +0.19% | +0.07% | 0.1492 | **0.2502** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 622 | 44 | 45% | +0.45% | +0.01% | 0.0115 | **0.1170** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 614 | 22 | 44% | +1.04% | -0.03% | 0.0068 | **0.1795** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 608 | 10 | 48% | +4.14% | +0.85% | 0.3106 | **0.7162** |

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

| Tier | Horizon | N | Eff. N | Win rate | Mean | Median | naive p | **corrected p** |
|---|---|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 1956 | 978 | 47% | +0.15% | +0.05% | 0.0041 | **0.0075** |
| Baseline — Daily direction alone | 3d | 1956 | 326 | 49% | +0.42% | +0.23% | 0.2136 | **0.3921** |
| Baseline — Daily direction alone | 7d | 1956 | 140 | 48% | +0.96% | +0.44% | 0.1416 | **0.4611** |
| Baseline — Daily direction alone | 14d | 1956 | 70 | 49% | +2.02% | +0.60% | 0.2879 | **0.7175** |
| Baseline — Daily direction alone | 30d | 1956 | 33 | 52% | +4.42% | +1.19% | 0.0740 | **0.5927** |
| + Harmonic present (any pattern, any status) | 1d | 2019 | 1010 | 50% | +0.13% | +0.03% | 0.7894 | **0.7762** |
| + Harmonic present (any pattern, any status) | 3d | 2019 | 337 | 50% | +0.39% | +0.21% | 0.7894 | **0.8128** |
| + Harmonic present (any pattern, any status) | 7d | 2019 | 144 | 50% | +0.93% | +0.42% | 0.7894 | **0.8553** |
| + Harmonic present (any pattern, any status) | 14d | 2019 | 72 | 50% | +1.96% | +0.53% | 0.7894 | **0.8933** |
| + Harmonic present (any pattern, any status) | 30d | 2019 | 34 | 54% | +4.38% | +1.17% | 0.0008 | **0.1661** |
| + PRZ actually tested by price | 1d | 1699 | 850 | 50% | +0.15% | +0.05% | 0.9613 | **0.9438** |
| + PRZ actually tested by price | 3d | 1699 | 283 | 50% | +0.39% | +0.21% | 1.0000 | **0.9843** |
| + PRZ actually tested by price | 7d | 1699 | 121 | 50% | +0.90% | +0.43% | 0.7341 | **0.8116** |
| + PRZ actually tested by price | 14d | 1699 | 61 | 50% | +2.13% | +0.60% | 0.8843 | **0.9325** |
| + PRZ actually tested by price | 30d | 1699 | 28 | 54% | +4.38% | +1.30% | 0.0005 | **0.1408** |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 1392 | 696 | 48% | +0.11% | +0.03% | 0.2718 | **0.2777** |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 1392 | 232 | 48% | +0.28% | +0.14% | 0.2718 | **0.3576** |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 1392 | 99 | 49% | +0.76% | +0.27% | 0.3213 | **0.4981** |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 1392 | 50 | 49% | +2.01% | +0.48% | 0.6487 | **0.7998** |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 1392 | 23 | 53% | +4.53% | +1.63% | 0.0147 | **0.2659** |
| + High geometric quality (>=0.85) | 1d | 430 | 215 | 51% | +0.17% | +0.06% | 0.5958 | **0.5413** |
| + High geometric quality (>=0.85) | 3d | 430 | 72 | 47% | +0.08% | +0.04% | 0.3112 | **0.2963** |
| + High geometric quality (>=0.85) | 7d | 430 | 31 | 50% | +0.27% | +0.43% | 0.8850 | **0.8865** |
| + High geometric quality (>=0.85) | 14d | 430 | 15 | 48% | +1.17% | -0.09% | 0.4695 | **0.5694** |
| + High geometric quality (>=0.85) | 30d | 430 | 7 | 49% | +4.69% | +2.03% | 0.5958 | **0.6804** |
| + Daily/4H confluence (other timeframe agrees) | 1d | 1609 | 805 | 49% | +0.16% | +0.04% | 0.3695 | **0.3792** |
| + Daily/4H confluence (other timeframe agrees) | 3d | 1609 | 268 | 50% | +0.46% | +0.25% | 0.7648 | **0.8049** |
| + Daily/4H confluence (other timeframe agrees) | 7d | 1609 | 115 | 49% | +0.92% | +0.42% | 0.6900 | **0.8044** |
| + Daily/4H confluence (other timeframe agrees) | 14d | 1609 | 57 | 51% | +2.01% | +0.52% | 0.6536 | **0.8405** |
| + Daily/4H confluence (other timeframe agrees) | 30d | 1609 | 27 | 54% | +4.48% | +1.49% | 0.0014 | **0.2426** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 1071 | 536 | 48% | +0.17% | +0.03% | 0.3282 | **0.3446** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 1071 | 179 | 50% | +0.38% | +0.28% | 0.9027 | **0.9024** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 1071 | 77 | 51% | +0.97% | +0.56% | 0.6249 | **0.7363** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 1071 | 38 | 51% | +2.11% | +0.77% | 0.6249 | **0.8187** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 1071 | 18 | 54% | +4.30% | +1.57% | 0.0102 | **0.3013** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 490 | 245 | 51% | +0.03% | +0.08% | 0.8213 | **0.7987** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 490 | 82 | 48% | +0.09% | +0.02% | 0.4980 | **0.5758** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 490 | 35 | 45% | +0.39% | -0.12% | 0.0420 | **0.1968** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 490 | 18 | 44% | +1.39% | -0.12% | 0.0166 | **0.2549** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 490 | 8 | 51% | +5.19% | +1.39% | 0.6844 | **0.8780** |

### Out-of-sample (validation, last 30%)

| Tier | Horizon | N | Eff. N | Win rate | Mean | Median | naive p | **corrected p** |
|---|---|---|---|---|---|---|---|---|
| Baseline — Daily direction alone | 1d | 837 | 419 | 52% | -0.05% | -0.02% | 0.3688 | **0.3947** |
| Baseline — Daily direction alone | 3d | 837 | 140 | 49% | -0.18% | -0.05% | 0.4068 | **0.5874** |
| Baseline — Daily direction alone | 7d | 835 | 60 | 49% | -0.48% | -0.25% | 0.4465 | **0.7303** |
| Baseline — Daily direction alone | 14d | 821 | 29 | 47% | -0.89% | -0.58% | 0.0809 | **0.5255** |
| Baseline — Daily direction alone | 30d | 792 | 13 | 47% | -1.69% | -0.73% | 0.0596 | **0.5609** |
| + Harmonic present (any pattern, any status) | 1d | 870 | 435 | 52% | -0.06% | -0.03% | 0.2097 | **0.2265** |
| + Harmonic present (any pattern, any status) | 3d | 870 | 145 | 51% | -0.18% | -0.03% | 0.5644 | **0.6644** |
| + Harmonic present (any pattern, any status) | 7d | 868 | 62 | 50% | -0.44% | -0.21% | 0.8652 | **0.9098** |
| + Harmonic present (any pattern, any status) | 14d | 854 | 31 | 49% | -0.81% | -0.44% | 0.7581 | **0.8602** |
| + Harmonic present (any pattern, any status) | 30d | 822 | 14 | 50% | -1.63% | -0.77% | 0.9167 | **0.9531** |
| + PRZ actually tested by price | 1d | 778 | 389 | 52% | +0.01% | +0.02% | 0.1846 | **0.2210** |
| + PRZ actually tested by price | 3d | 778 | 130 | 53% | -0.06% | +0.07% | 0.1620 | **0.2872** |
| + PRZ actually tested by price | 7d | 776 | 55 | 50% | -0.38% | -0.06% | 0.9142 | **0.9345** |
| + PRZ actually tested by price | 14d | 762 | 27 | 49% | -0.78% | -0.44% | 0.7998 | **0.8777** |
| + PRZ actually tested by price | 30d | 737 | 12 | 50% | -1.63% | -0.85% | 0.9413 | **0.9611** |
| + Confirmed (genuine rejection reaction at PRZ) | 1d | 649 | 325 | 52% | +0.02% | +0.03% | 0.2717 | **0.2951** |
| + Confirmed (genuine rejection reaction at PRZ) | 3d | 649 | 108 | 52% | -0.03% | +0.13% | 0.3074 | **0.4309** |
| + Confirmed (genuine rejection reaction at PRZ) | 7d | 647 | 46 | 50% | -0.27% | +0.09% | 0.9373 | **0.9426** |
| + Confirmed (genuine rejection reaction at PRZ) | 14d | 635 | 23 | 49% | -0.54% | +0.04% | 0.8118 | **0.8776** |
| + Confirmed (genuine rejection reaction at PRZ) | 30d | 616 | 10 | 51% | -1.94% | -0.80% | 0.4934 | **0.7250** |
| + High geometric quality (>=0.85) | 1d | 194 | 97 | 56% | +0.02% | +0.05% | 0.0984 | **0.0988** |
| + High geometric quality (>=0.85) | 3d | 194 | 32 | 53% | +0.31% | +0.46% | 0.5183 | **0.5727** |
| + High geometric quality (>=0.85) | 7d | 194 | 14 | 55% | -0.01% | +0.75% | 0.2222 | **0.3440** |
| + High geometric quality (>=0.85) | 14d | 194 | 7 | 53% | -0.68% | +0.39% | 0.4297 | **0.3849** |
| + High geometric quality (>=0.85) | 30d | 183 | 3 | 48% | -3.71% | -2.02% | 0.6575 | **0.7643** |
| + Daily/4H confluence (other timeframe agrees) | 1d | 714 | 357 | 53% | -0.11% | -0.05% | 0.1075 | **0.1267** |
| + Daily/4H confluence (other timeframe agrees) | 3d | 714 | 119 | 52% | -0.34% | -0.15% | 0.2460 | **0.4106** |
| + Daily/4H confluence (other timeframe agrees) | 7d | 712 | 51 | 49% | -0.90% | -0.47% | 0.6802 | **0.8224** |
| + Daily/4H confluence (other timeframe agrees) | 14d | 698 | 25 | 50% | -1.68% | -0.86% | 0.9698 | **0.9731** |
| + Daily/4H confluence (other timeframe agrees) | 30d | 675 | 11 | 50% | -2.48% | -1.32% | 0.9386 | **0.9639** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 1d | 562 | 281 | 54% | +0.05% | +0.04% | 0.0576 | **0.0722** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 3d | 562 | 94 | 53% | -0.13% | +0.01% | 0.1398 | **0.2717** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 7d | 561 | 40 | 50% | -0.53% | -0.03% | 0.9327 | **0.9432** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 14d | 555 | 20 | 50% | -0.70% | -0.16% | 0.8652 | **0.9232** |
| + Full production gate: TRADEABLE (confirmed + regime-aligned) | 30d | 540 | 9 | 53% | -2.38% | -0.91% | 0.1555 | **0.5114** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 1d | 133 | 67 | 41% | -0.13% | +0.01% | 0.0560 | **0.0552** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 3d | 133 | 22 | 42% | +0.57% | +0.21% | 0.0825 | **0.1238** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 7d | 132 | 9 | 43% | +0.68% | +0.27% | 0.1387 | **0.3955** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 14d | 124 | 4 | 44% | -0.35% | +0.86% | 0.2429 | **0.4093** |
| (diagnostic) Counter-trend harmonics only — must NOT be quietly good | 30d | 118 | 2 | 35% | -0.20% | -0.17% | 0.0012 | **0.0005** |

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

## Verdict

**This verdict supersedes an earlier one that graded the harmonic engine a C on the strength of a 30-day result at p<0.01. That p-value was wrong** — not miscomputed, but computed under an independence assumption the data does not satisfy. It is restated here from the corrected numbers, and the verdict moves down as a result.

**Coverage.** A harmonic pattern of some kind is present on 99.8% of days (2889/2896). With nine patterns, two timeframes and an 8% intermediate-leg tolerance, X-A-B-C structure is nearly always findable in noisy price data. "Harmonic present" is not a filter, it is close to a constant, and carries no information by itself. Everything below concerns the tiers that restrict that population.

**The overlap correction changes the headline completely.** A 30-day forward return sampled daily shares 29 of its 30 days with its neighbour, and BTC/ETH are two correlated views of the same day. The `Eff. N` column is the honest independent count: at the 30-day horizon the TRADEABLE tier's 1,611 rows are worth **27** independent observations, not 1,611. Every 30-day result that read p<0.01 lands between p=0.19 and p=0.31 once that is accounted for:

| Tier (30d) | Naive p | Corrected p | Eff. N |
|---|---|---|---|
| Harmonic present | 0.0061 | 0.2359 | 47 |
| PRZ tested | 0.0029 | 0.1922 | 41 |
| Confirmed | 0.0150 | 0.2545 | 33 |
| Daily/4H confluence | 0.0061 | 0.3050 | 38 |
| TRADEABLE (full production gate) | 0.0033 | 0.2307 | 27 |

**Nothing in this study is statistically significant at any horizon after correction.** That includes the counter-trend diagnostic, which the earlier verdict called "the cleanest result in this study": its 7d and 14d p-values move from 0.0115 and 0.0068 to 0.1170 and 0.1795. The claim that counter-trend suppression was empirically validated was overstated and is withdrawn.

What survives is weaker and purely descriptive: the point estimates still lean the direction theory predicts (TRADEABLE beats baseline by +2 to +7pp out-of-sample; counter-trend harmonics remain the worst bucket in every cut), and the walk-forward folds are mixed (46/51/53/52% win rate, one with a negative mean return). Directionally encouraging, statistically unproven.

### HARMONIC VERDICT: D — no demonstrable incremental value

Not "harmonics are useless" — **"this dataset cannot tell us whether harmonics are useful"**, which is a different and more honest claim. At 27-47 effective observations per 30-day cell, only an enormous effect would be detectable, and no such effect is present.

**Recommendation: keep the engine, change nothing, and fix the copy.** Three reasons it stays. It is architecturally correct (forward-looking PRZ, geometry and confirmation held separate, regime-non-overriding, point-in-time safe). It gates nothing — it is additive evidence, so an unproven signal in this position costs nothing but a line of text. And the cost of removing and rebuilding it later would exceed the cost of leaving it in place while evidence accumulates.

What must change is the claim, not the code: no UI or reasoning copy may describe harmonic evidence as improving outcomes at any horizon, because that is not established. The live summary line is already phrased as corroborating evidence rather than a prediction, which is the correct framing and should stay that way.

**What would change this answer:** effective sample size, not better geometry. Reaching ~200 independent 30-day windows requires roughly 16 years of two-asset history, or a wider asset universe. Broadening beyond BTC/ETH is the only realistic route to settling this, and is worth more than any refinement of the pattern detector.