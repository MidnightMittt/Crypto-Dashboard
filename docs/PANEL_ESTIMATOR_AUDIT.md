# Panel Estimator — Self-Audit (Phase 9)

Attempting to invalidate my own solution. Every limitation below is
**documented, not fixed.** Measured numbers come from a calibration harness
run against cases where the true effective sample size is known analytically.

---

## Calibration — does it discount correctly?

The estimator is only trustworthy if it discounts *neither too much nor too
little*. Both directions were measured against known truth (300 periods,
6,000 bootstrap iterations, seeded):

| ρ within period | Units | Raw n | Effective N | Analytic truth | Ratio |
|---|---|---|---|---|---|
| 0.0 (independent) | 1 | 300 | 300 | 300 | 1.00 |
| 0.0 | 2 | 600 | 596 | 600 | 0.99 |
| 0.0 | 5 | 1500 | 1500 | 1500 | 1.00 |
| 0.0 | 20 | 6000 | 5881 | 6000 | **0.98** |
| 1.0 (identical) | 2 | 600 | 294 | 300 | 0.98 |
| 1.0 | 5 | 1500 | 297 | 300 | 0.99 |
| 1.0 | 20 | 6000 | 300 | 300 | **1.00** |
| 0.5 (moderate) | 1 → 20 | 300 → 6000 | 295 → 1029 | between | sublinear |

**Independent units are not penalised** (ratio 0.98–1.00), and **perfectly
redundant units collapse to the period count** regardless of whether there
are 2 or 20 of them. The moderate-correlation row is the important one for
real use: effective N grows *sublinearly* with universe width — 20× the
observations buys 3.5× the information — which is precisely the behaviour the
Phase 7 correlation analysis predicted.

The residual 2% shortfall at 20 independent units is the ordinary small
upward variance bias of bootstrapping with replacement. It errs conservative,
which is the correct direction for an error of this kind to run.

---

## Limitations

### L1 — Period granularity — CLOSED (was High)

**Resolved by `session.ts`.** Observations are normalised onto a canonical
trading-session key before any statistic is computed, and `sessionOf` is a
REQUIRED field on `StudyRunContext` so it cannot be forgotten — a
single-market study must explicitly declare `() => THAT_SESSION`.

The rule: a bar belongs to the calendar date, in its own session timezone, of
the instant immediately before its close. One rule covers every case.

Worth recording what the real failure was, because it was not what this audit
originally described. Converting 16:00 ET to UTC lands on the *same* calendar
date (20:00–21:00 UTC), so timezone conversion alone changes nothing for US
equities. **The load-bearing part is the one-millisecond step back at
midnight**: a crypto bar closing Tuesday 00:00 UTC covers Monday, and keying
on its raw timestamp files it under Tuesday — splitting one session across
two keys. The timezone machinery matters for markets whose session genuinely
crosses UTC midnight and for correctness under DST, but the midnight rule is
what fixes the crypto-plus-equity case.

Verified end-to-end: a 200-session mixed BTC/SPY panel yields 200 periods
where raw-timestamp keying yields 400, and perfectly correlated cross-market
pairs are counted once.

*Residual:* the caller still chooses the session model per instrument. A
wrong `SessionModel` produces a wrong key. This is now an explicit, typed,
required declaration rather than an invisible default, which is the most that
can be enforced without the framework owning instrument metadata.

### L1-original — Period granularity is a caller choice, and it is load-bearing. (superseded)

The estimator clusters on whatever `period` the caller supplies. In
`executeStudy` that is `entryT`, which works because contemporaneous
observations across instruments share a sampling timestamp. **It breaks
silently if they do not.** Two instruments sampled at different closes — a US
equity at 16:00 ET and a crypto perp at 00:00 UTC — would land in different
periods and be treated as independent when they are not.

Choosing a period *finer* than the true dependence horizon under-corrects;
*coarser* over-corrects. Nothing validates the choice, and a wrong choice
produces a plausible-looking number.

*Mitigation when the universe widens: normalise every instrument to a session
date before study construction.*

### L2 — Time-varying correlation is averaged, not tracked. (Medium)

Blocks are drawn uniformly across history, so the resulting SE reflects
*average* dependence over the sample. Real correlation is regime-dependent —
crypto/equity correlation rose materially after 2020, and cross-asset
correlation spikes toward 1 in crises. The estimator will therefore be
slightly optimistic during high-correlation regimes and slightly pessimistic
during calm ones. It does not assume constant correlation (an advantage over
the equicorrelation approach) but it does not *condition* on it either.

### L3 — Mixed-frequency panels are not supported. (Medium)

A universe mixing daily equities with hourly crypto has no single natural
period. Keying on the coarser frequency discards intra-period variation;
keying on the finer one leaves most periods holding a single unit and
silently loses the cross-sectional correction. **The estimator will not warn
about this** — it will produce a number.

### L4 — Lead-lag dependence needs `blockPeriods ≥ lag`. (Medium)

If instrument A leads instrument B by a day, that dependence lives *across*
periods, not within one. At `blockPeriods = 1` it is invisible. Block lengths
derived from holding horizon usually exceed plausible lead-lags, so this is
mostly covered in practice — but it is covered by accident, not by design.

### L5 — Unbalanced panels weight thin periods equally. (Low-Medium)

A period in which only 1 of 40 instruments traded (a holiday, an
inception date) is drawn with the same probability as a full period, and
contributes its single observation to the resample mean. This is defensible —
inventing observations to balance the panel would fabricate evidence — but it
means a panel with many sparse periods has noisier resamples than its raw
count suggests.

### L6 — Effective N is capped at `n`. (Low)

Negatively correlated units can genuinely carry more information per
observation than independent ones. The cap discards that, which is
conservative but arbitrary. It exists so that a diversified universe cannot
report *more* evidence than it has observations, which would be more
confusing than the small loss of precision.

### L7 — Degenerate samples fall back to a structural count. (Low)

When every observation shares an outcome there is no variance to invert, so
effective N falls back to `periods / blockPeriods`. This was a genuine bug
caught by the test suite during implementation: the original fallback was
`n`, which claimed *maximum* information from a sample exhibiting none. The
current fallback is honest but coarse.

### L8 — Only proportions are supported. (Medium — inherited)

`panelBootstrapProportion` handles binary outcomes.
`panelBlockBootstrap` already returns a distribution of means and would
support continuous outcomes, but no continuous wrapper exists. A study of
expectancy rather than win rate cannot yet use the panel path.

---

## Scalability to future universes

| Universe | Behaviour | Concern |
|---|---|---|
| Crypto (2–10) | Correct. ρ≈0.82 collapses to near the period count, matching the Phase 7 finding | None |
| Sector ETFs (11) | Correct. Shared market beta collapses appropriately | None |
| Multi-class (40+) | Correct, and this is where it earns its keep — sublinear growth is exactly right | L1 becomes critical: session alignment across classes |
| Single-name equities (100s) | Works computationally; O(periods × units) per iteration | Survivorship, not the estimator, is the binding risk |
| Intraday | Untested. Period granularity ambiguous | L3 |

Compute at 6,000 iterations × 120 periods × 100 units ran without difficulty.
The cost scales linearly in total observations per iteration, so a 500-unit,
25-year daily panel (~3M observations) would need iteration count reduced or
per-period pre-aggregation. Not a concern at any near-term universe.

---

## What is now genuinely closed, and what is not

**Closed.** The framework can no longer overstate confidence from temporal
dependence (block resampling, validated against the analytic binomial SE) or
from cross-sectional dependence (period clustering, validated against known
truth at ρ = 0, 0.5 and 1). `executeStudy` uses the panel estimator on every
path, so no study can opt out.

**Not closed.** Three things could still produce an overstated result, none
of which are estimator problems:

1. **A wrong `SessionModel` declaration.** No longer silent-by-default — it
   is a required, typed field — but a caller who declares the wrong schedule
   still gets a wrong key. Reduced from "most likely error" to "possible
   misconfiguration".
2. **Survivorship in the universe.** The framework cannot detect a universe
   assembled from currently-listed instruments.
3. **A study that does not use the framework.** Nothing prevents calling the
   statistics helpers directly.

Calling the research engine "statistically complete" would be an
overstatement of the kind this project has been careful to avoid. What is
accurate: **the two dependence structures that produced the withdrawn results
are now corrected by construction, and validated in both directions.** The
remaining risks are about how the framework is *used*, not about what it
computes.
