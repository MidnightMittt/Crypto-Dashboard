# Decision Engine Redesign — Phase 1 Design Document

Chief-quant review of the scoring engine, written before any implementation.
Every number cited below is from this platform's own published statistics
(the metric census, combination scan, agreement validation, execution replay,
and overlap audit), not from intuition. Where a claim cannot be grounded in
measured output, it is labelled a judgement.

The organizing principle, per the Phase 1 brief: **State describes; Edge
predicts.** These are different epistemic categories, and the current engine
conflates them — its central defect.

---

## 1. Current architecture review

One engine (`buildMarketBias` → `computeWeightedScore`), one evidence
contract (`MetricVerdict`), category rollups, evidence-mass damping, refusal
semantics, and a validation stack (block bootstrap, effective-n, BH-FDR,
metric census, walk-forward harness) that is genuinely ahead of the signals
it measures. 19 declared metrics; 12 have a historical source; crypto scores
on ~18 modules, equities on 6.

What the machine is good at: honesty plumbing. Refusals, damping,
renormalization over absent modules, exact contribution decomposition.

What it is not good at: knowing which of its inputs actually predict
anything — because most of them measurably do not, and the weight table
cannot express that.

## 2. Weaknesses

**W1 — The heaviest weight sits on the least-validated input.** Funding is
weighted 0.15 (highest) with n=33 in the replay — a "Small" sample by our
own labelling. The single most influential directional input is the one we
know least about.

**W2 — 0.33 of the raw weight is unfalsifiable.** Seven declared metrics
(order flow .10, options .06, exchange flow .06, spot CVD .05, Coinbase
premium .03, sector breadth .03, liquidations 0) have **no historical
source**. They vote in production and cannot be tested. A platform whose
philosophy is statistical honesty is running a third of its opinion on
signals that are structurally immune to falsification. This contradicts the
charter more than any single number below.

**W3 — State votes on direction, and the votes are measured losers.**
Market structure standalone: 49% @24h (n=1762, p=0.49). Worse: the
**category-level** Market Structure bullish cell is 44% @24h (n=668,
p=0.0013, BH-significant) — significantly *below* coin flip. We are paying
weight for a signal our own scan flags as an anti-signal at the horizon the
UI treats as primary.

**W4 — `technicals` is 13 correlated votes wearing one hat.** RSI, MACD,
Bollinger, Stochastic, OBV, Supertrend, PSAR, Ichimoku, Fibonacci,
divergence, plus trend reads — all derived from the same daily closes,
internally averaged, then given weight 0.13. The signal philosophy ("if
correlated, merge or remove") was applied between modules but never inside
this one. Its census row (n=2196) shows no meaningful standalone edge.

**W5 — The composite barely clears chance and the UI oversells it.**
Agreement-quartile hit rates: 56/52/55/57%. The scanner's
`ACTIONABLE_OPPORTUNITY=10` bar is so low the "nothing qualifies" state
almost never fires — the hero recently led with 16/100 at 39% confidence
under the words "Best opportunity now."

**W6 — Three unrelated quantities all render as "confidence %".**
Module evidence quality (0–100, conjunctive completeness×agreement),
regime-pair spread strength (5–24% recently), and conviction×confidence
opportunity. A user calibrates one scale; we show three, identically styled.

**W7 — Weights are hand-set constants.** `METRIC_WEIGHTS` encodes a 2025
judgement, not measured performance, and nothing decays a weight when a
signal's out-of-sample record dies.

## 3. Hidden statistical problems

**H1 — The 50% null is wrong under drift.** Every sign test asks "better
than a coin flip?" But BTC's replay window has a long-side drift: the base
rate of up-days is not 50%. A bullish signal printing 53% may be *worse*
than owning the asset blindly, and a bearish signal printing 48% may be
adding value. Every directional cell must be re-tested against the asset's
own base rate over the same window (and, stricter, against the signal's
exposure-matched benchmark). This likely *reduces* several bullish cells and
*rescues* some bearish ones. It is the highest-priority correction in this
document.

> **MEASURED (2026-08-12, implemented).** Every directional cell now tests
> against a Poisson-binomial null where each occurrence's probability is the
> base rate of ITS direction for ITS asset at that horizon (per-asset, with
> tags conditioned on tag-filtered days; `buildNullLookup` in
> scripts/backtest/metrics.ts). The outcome was NOT what the paragraph above
> predicted at the headline level, and both halves matter:
>
> - **Unconditional cells barely moved (0 of 48 hypothesis cells flip).**
>   The replay window (2019→present) nets out to ~no daily drift — BTC's 1d
>   up-rate is 50.7%, ETH's 49.6% — so the 24h census was never materially
>   flattered. At 7d BTC drifts (52.7%) and several 7d p-values shifted
>   without crossing 0.05.
> - **Regime-conditional cells moved a lot: 23 of 336 crosstab cells flip.**
>   Drift hides inside regime tags, not the pooled window. Lost significance:
>   cells that were regime drift wearing a signal costume — e.g.
>   squeezeRisk:bear @24h won 56.9% against a 57.5% blind rate,
>   spotPerpVolume:bull @7d 57.1% vs 55.8%, stablecoins:bull @24h 54.0% vs
>   53.9%. Gained significance: anti-signals drift had been masking — e.g.
>   openInterest:bear @24h won only 41.0% when blind shorts won 51.1%, and
>   fearGreed:bull @24h's 56.0% is genuinely large against bull-tag days'
>   45.6% next-day up-rate.
> - **5 of 712 conjunction cells lose significance** (all 7d/4h automatic
>   pairs — the family that inherited drift as free credit).
>
> The report prints `p (vs null)` beside the legacy `p (vs 50%)` for one
> transition so the correction is auditable; the overlap audit's bootstrap
> uses the same exposure-weighted null. Downstream consequence for step 2+:
> the regime crosstab, not the pooled table, is where claims must be
> re-checked before anything earns weight.

**H2 — Confidence has never been validated against outcomes.** We assert
that evidence quality should scale conviction (damping), but we have never
published the calibration curve: realized hit rate by confidence decile. If
confidence does not correlate with accuracy, the damping is aesthetics. The
agreement-quartile table (52→57%) suggests the correlation is weak at best.

> **MEASURED (2026-08-12, post-taxonomy replay).** The curve is not merely
> flat — it is DEGENERATE: 1,788 of 1,826 scoreable days (98%) fall in one
> band (40–60, observed hit rate 52.5%, Wilson [50.2%, 54.8%]); the only
> other populated band is 20–40 with n=38. Technically monotonic
> (39% → 53%), but a number that takes one value cannot rank setups.
> Verdict per §8.5: confidence measures data completeness and is now
> LABELLED that way — every surface that printed "Confidence" beside the
> composite now prints "Data Quality" (§9's first bullet, implemented).
> The calibrated-probability headline (score-bucket × regime hit rate with
> Wilson bound and n_eff, "uncalibrated" where thin) remains the open half
> of §9. Agreement, by contrast, showed real lift in its top quartile on
> the post-taxonomy replay (56.4%, n=328) and stays a live candidate.

**H3 — Unexamined constants.** DIRECTIONAL_THRESHOLD=6 (chosen for display
stability), the 10pp full-strength cap in regime pairs (stated judgement),
HIGH_CONFIDENCE=50 (midpoint, admitted uncalibrated), ACTIONABLE=10 (too
low). None are load-tested against outcomes. Each should either earn its
value from the calibration layer or be labelled cosmetic in-code.

**H4 — Regime "independence" is overstated.** Of the three pairs, XLY/XLP
and SMH/SPY are both equity-internal ratios; in a beta selloff they agree
for a shared reason. Effective independent sources ≈ 2, not 3. The headline
"2 of 3 independent pairs" should not use the word independent.

**H5 — Combination cells are uncorrected.** The only 70%+ material ever
measured here (Positioning+Structure+LeadingDrivers bullish @7d: 73%, n=30;
Positioning+Structure @7d: 70%, n=61; Structure+Leading+Risk @24h: 73%,
n=26) is at 7d (overlap-inflated) or tiny n, BH-corrected across the scan
but not block-corrected. Promising, unproven — currently quoted nowhere in
the UI, which is correct, and must stay correct until revalidated.

## 4. Correlated signals (double-counting map)

| Cluster | Members | Shared factor |
|---|---|---|
| Leverage crowding | funding, basis, squeezeRisk (uses funding percentile + OI + L/S), longShort | one leveraged-demand phenomenon, counted ~4× |
| Price-derived | technicals (13 internal votes), marketStructure, trendQuality (eq), relativeStrength (eq) | same close series |
| Liquidity backdrop | stablecoins, macroLiquidity | global liquidity, counted 2× |
| Borrowed direction | spotPerpVolume explicitly borrows technicals' direction | double-counts technicals by construction |
| Regime/rotation/industry | SMH appears in a regime pair, the rotation board, and an industry | one semis selloff paints three surfaces |

The engine's renormalization treats these as independent opinions. They are
not, and agreement is inflated exactly when these clusters move together —
which is when a user most needs the number to be honest.

## 5. Signals that become STATE (stop voting)

Effective immediately upon implementation, with the replay delta measured
and published as with every prior engine change:

- **marketStructure** — the strongest case in the file: 44% bullish @24h,
  BH-significant. It describes shape; it is what stops are placed against.
  State.
- **technicals** — demote to a described technical read (it already renders
  as one); its residual predictive kernel, if any, must re-enter as a
  narrow, tested Edge module (see §8), not as a 13-vote blob.
- **trendQuality, volatilityRegime, breadth (all levels), relativeStrength,
  riskAppetite (equity)** — regime/selection context. State.
- **fearGreed** — see §7 (remove outright).
- **liquidations** — already non-voting. Correct; unchanged.
- **Regime pairs, rotation, industry reads** — already non-voting. Correct.

State's new, explicit jobs: select which Edge statistics apply
(regime-conditional cells), scale position size, gate the planner, set stop
context. Codified, not implied.

## 6. Signals that deserve MORE weight (conditionally)

- **squeezeRisk** — the platform's best-connected signal: large sample
  (n=2340) and a participant in every 70%+ conjunction cell. Weight should
  rise *if* it survives drift-adjusted revalidation.
- **basis** — largest sample in the census (n=2706); cheap to keep, likely
  survivor.
- **Conjunction cells as first-class conditional Edge modules** — the only
  measured 70%+ material. Each becomes a registered hypothesis
  ("Positioning AND Structure bullish → 7d long"), revalidated with block
  correction and walk-forward. If they survive, they carry more weight than
  any single metric. If they don't, the negative result is published.
- Structurally: **weights stop being constants.** Edge weight = a bounded
  function of audited, overlap-corrected, out-of-sample performance,
  re-earned quarterly, decaying to State on failure. Hand-set ratios remain
  only as priors for signals too young to have a record.

## 7. Signals to REMOVE entirely

> **IMPLEMENTED (2026-08-12) — measured replay delta.** §5 and §7 landed
> together as the METRIC_ROLES taxonomy in scoring.ts: nine Edge voters
> remain (funding, squeezeRisk, openInterest, basis, longShort, etfFlows,
> spotPerpVolume, stablecoins, macroLiquidity); technicals and
> marketStructure are State; everything else is context, weight 0. The five
> equity evidence modules are classified State but hold a TRACKED
> transitional vote (TRANSITIONAL_STATE_VOTERS) because the Markets/Scanner
> surfaces present nothing but the composite yet — that redesign is its own
> task, and the exception is in code, named, with this rationale.
>
> Full-history replay, before → after:
> - Bullish composite days 298 → 358, win rate 59.7% → 58.1%, mean 1d
>   +0.62% → +0.52%.
> - Bearish composite days 1,196 → 1,468, win rate 53.4% → 50.8%, mean 1d
>   −0.15% → 0.00%.
> - Risk category buckets disappear from the stats entirely (context-only —
>   no verdict to bucket), as designed.
>
> Read honestly: the subtraction made the composite MORE willing to call a
> direction (fewer neutral days) and its bearish calls in-sample LESS
> accurate by ~2.6pp. That difference is ~1.3σ given the bucket sizes —
> statistically indistinguishable from no change, on buckets whose
> composition also changed — and the in-sample composite win rate of an
> engine containing unfalsifiable voters was never a defensible number to
> optimize in the first place; being unable to test a voter is not evidence
> it helps. But it is a real, published observation, and the per-metric
> ablation (remove one voter at a time, measure each) is the follow-up that
> would attribute it.
>
> One call REVERSED in degree by the drift census (H1 note above):
> fearGreed's "no edge at the primary horizon" claim below is outdated —
> the corrected census shows 53.6% vs a 50.1% null at 24h, p=0.048. That is
> nominal-only (it does not survive BH-FDR across the 48-cell scan, q
> threshold ≈0.009 at its rank), so it still does not earn a vote — but it
> was demoted to displayed context rather than physically deleted, because
> a nominal positive that might firm up with more history is worth
> continuing to display and measure.

- **fearGreed** — n=806, no edge at the primary horizon, contrarian story
  unvalidated, and the most retail-coded element on the platform. Delete.
- **sectorBreadth (crypto)** — unfalsifiable (paid-gated history), tiny
  weight, duplicated by dominance/rotation context. Delete or move to
  display-only.
- **coinbasePremium** — unfalsifiable, venue quirk, 0.03 weight. Display
  context at most.
- **orderFlow, spotCvd, options (Deribit), exchangeFlow** — *as voters.*
  Keep as displayed context (they are genuinely informative live reads),
  but a metric with no historical source cannot vote in an engine whose
  claim is statistical honesty. This single change removes ~0.33 of raw
  weight from the unfalsifiable column. When a historical source lands, they
  re-enter through the factory like anything else.
- **Harmonics** — stays buried. The brief lists "validated harmonic
  reversals" as an Edge example; ours were graded D and the 30-day headline
  was voided by overlap correction. Not until revalidated, and there is no
  current plan to spend on that.

## 8. Signals requiring NEW validation before any status change

1. **Drift-adjusted re-census** of every measurable metric (H1). Nulls =
   per-asset base rates, not 50%. This re-decides several of the calls above
   and runs first.
2. **Funding** — extend history (longer Coinalyze pulls / alternate archive)
   before its weight is trusted at all; n=33 is not a basis for 0.15.
3. **Conjunction cells** — block-corrected, walk-forward (H5).
4. **A narrow momentum-continuation hypothesis** to replace `technicals`'
   voting role: one registered, falsifiable claim (e.g., N-day
   continuation conditional on regime + relative volume) rather than 13
   oscillators. Built only through the factory.
5. **Confidence calibration curve** (H2) — publish hit rate by confidence
   decile; if flat, damping constants get re-derived or confidence is
   relabelled as data-completeness, which is what it actually measures.

## 9. Confidence redesign

One word, one meaning. Three distinct quantities, named and displayed
distinctly:

- **Data Quality** (rename of current module confidence): completeness ×
  source agreement. Never implies accuracy. Shown small, grey.
- **Calibrated Probability**: the headline number. Empirical hit rate of
  the current score bucket, in the current regime, with **Wilson lower
  bound and n_eff always attached**. Where the bucket lacks sample, the
  display says "uncalibrated" rather than borrowing the global rate.
- **Agreement**: kept, but computed over *decorrelated clusters* (§4), not
  raw modules — funding+basis+squeeze agreeing is one cluster agreeing,
  not three signals.

Regime-pair "confidence" is renamed **spread strength**. The scanner's
opportunity score keeps its name but its bar moves: `ACTIONABLE` rises until
the "nothing qualifies today" state fires on a typical flat day, because a
scanner that always has a "best opportunity" is an ad, not an instrument.

## 10. Trade planning redesign

The planner owns the rarest asset in the codebase — a session-aware
execution replay with per-trade MAE/MFE excursions (944 resolved trades) —
and uses almost none of it. Everything below is derivable from data already
collected:

- **Stop quality, measured**: place stops beyond the p80–p90 MAE of
  *winning* trades in the current vol regime, reconciled with the structural
  level; report "expected drawdown" as the MAE distribution of winners.
  Geometry proposes, excursion data disposes.
- **Target quality, measured**: targets sanity-checked against the MFE
  distribution per regime; a 3.5R target where winners' median MFE is 2.1R
  is fantasy priced as a plan.
- **P(target before stop)**: computed directly — `reachedTp2BeforeStop`
  machinery already exists; generalize per bucket and display it.
- **Time stops**: from timeout statistics; if unresolved trades at day N
  win <45% forward, the plan says "exit by day N."
- **Expected R / EV gating**: EV per unit risk from the calibrated bucket's
  **Wilson lower bound**; plans with lower-bound EV ≤ 0 are refused with the
  named reason (the refusal vocabulary already exists). EV replaces stars as
  the headline; stars become its summary.
- **Support/resistance confidence & reaction probability, measured**: replay
  every historical level of each type through `levelReached` → publish
  per-type and per-confluence-count reaction rates. "Confluence score"
  stops being an assumption and becomes a measured multiplier — and if
  confluence does *not* improve reaction rates in our data, we will be the
  only platform honest enough to say so.
- **Execution quality**: spread/venue-liquidity check (crypto walls exist),
  session-aware entries (built), event veto (earnings/FOMC within N
  sessions; the roadmap's Phase 1 item).
- **Position sizing**: fixed-fractional risk, vol-adjusted, scaled down by
  Risk state (regime, event proximity, leverage heat). Never Kelly-labelled;
  the calibration isn't tight enough to claim it.

## 11. Missing data audit (ranked by expected edge per unit cost)

| Rank | Source | Edge | Difficulty | Cost | Evidence | Priority |
|---|---|---|---|---|---|---|
| 1 | Earnings calendar + surprises | Med (loss-avoid + PEAD) | S | ~free | Strong (PEAD literature) | Now |
| 2 | Form 4 insider clusters | Med | M | free (EDGAR) | Strong | Now |
| 3 | FRED: HY OAS, curve; CBOE: VIX term structure, MOVE | Low-Med (regime depth) | S | free | Strong | Now |
| 4 | FINRA short interest + DTC | Low-Med | M | free | Strong (Boehmer et al.) | Soon |
| 5 | COT positioning extremes | Low | M | free | Moderate | Soon |
| 6 | Options chains → IV rank, put/call, skew | Med | L | delayed free / $ | Strong for IV-rank regime | Q3 |
| 7 | Dealer gamma (GEX) + gamma walls | Med | L | needs #6 | Moderate-strong (mechanical) | Q3 |
| 8 | Relative volume / up-down volume / A-D (from bars we have) | Low-Med | S | free | Moderate | Soon |
| 9 | Breadth thrusts, % >50/200dma | Med | M | needs S&P500 universe | Strong (thrust literature) | With P4 |
| 10 | Crypto exchange netflows (real provider) | Low-Med | M | $ | Moderate | Q4 |
| 11 | MVRV / SOPR / realized cap | Low (cycle context, State) | S-M | $ / partial free | Moderate as context | Q4 |
| 12 | 13F crowding | Low | M | free | Weak-moderate, slow | Later |
| 13 | Dark pool (FINRA ATS weekly) | Low | S | free, lagged | Weak | Later |
| 14 | Analyst revisions | Med | M | paid | Strong | When revenue |
| — | Anchored VWAP, volume/market profile | n/a (level providers) | S | free | n/a — feed §10's reaction-rate test, never vote | With planner |
| — | Whale wallets, miner flows, social sentiment | — | — | — | Insufficient evidence | Not planned |

## 12. Implementation order (for the phase that follows this document)

1. Drift-adjusted nulls in the census (H1) — re-decides everything else.
2. Taxonomy: State/Edge/Risk/Execution in the engine; unfalsifiable voters
   → context; fearGreed/sectorBreadth/coinbasePremium removed. Full replay
   delta measured and published.
3. Confidence split (§9) + calibration curve publication (H2).
4. Earnings calendar + event veto (only new data in this phase).
5. Planner: EV gating + MAE/MFE stops/targets + time stops (§10).
6. Conjunction-cell revalidation (H5) — the only new Edge candidates this
   phase; everything else is subtraction.

The theme is deliberate: **Phase 1 adds almost nothing and removes a lot.**
The measured edge of this platform currently lives in a handful of
positioning signals, their conjunctions, and the execution machinery — not
in the twelve other things voting. The redesign makes the engine say only
what it can defend, which is the entire brand.
