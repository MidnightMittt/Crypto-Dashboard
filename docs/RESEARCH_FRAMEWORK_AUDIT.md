# Research Framework — Self-Audit

Deliverable 8 and 9 of Phase 8. Weaknesses are **documented, not fixed**, per
instruction 10. Each entry states the risk, its severity, and what fixing it
would cost — so the decision to fix or accept is made deliberately.

---

## Part 1 — Major architectural decisions and why

| Decision | Alternative rejected | Reason |
|---|---|---|
| Every `StudyDeclaration` field required, no optionals | Optional fields with defaults | A default lets an author skip the thinking the field exists to force. A missing null hypothesis should not compile. |
| Studies supply observations; framework owns all statistics | Studies compute their own stats and report them | Three withdrawn results came from hand-built pipelines each missing one step. There is deliberately no API for a study to compute its own p-value. |
| Block length **derived** from hold-to-spacing ratio | Author declares it | A declared block length is a number the author can choose favourably. Deriving it removes the discretion. |
| Grading checks power **before** significance | Grade on p-value, note power as a caveat | This is the exact inversion that produced the withdrawn harmonic C. A significant result on an underpowered sample is more likely noise than signal. |
| Family correction across the **whole ledger** | Correct within each study | Twenty internally-corrected studies still carry ~64% chance of a false positive. The withdrawn results were separate studies; within-study correction would have caught none. |
| Family recomputed on every append | Assign at insertion | Adding a study changes the family, so earlier verdicts must be re-evaluated. A conclusion that only held when it was the only test should stop holding. |
| Reports generated from statistics | Author writes the verdict | The numbers were never wrong on this project; the prose around them was. Generating removes the gap. |
| `runAtISO` fixed at epoch inside results | Real timestamp | Wall-clock inside a result breaks byte-identical reproducibility. The ledger stamps the real time at record. |
| Ledger append-only, superseding by reference | Editable entries | A ledger revisable after seeing results is not evidence. |

---

## Part 2 — Statistical weaknesses

**S1 — Block-length derivation assumes regular spacing. (Medium)**
`deriveBlockLength` uses median hold ÷ median spacing. For irregularly spaced
observations (event-driven studies, earnings) the median is a poor summary and
the correction could be materially wrong in either direction. *Fix cost: low —
accept an explicit override with justification, or compute an autocorrelation-based
block length. Deferred because every current study is regularly spaced.*

**S2 — Family correction may become over-conservative. (Medium, grows over time)**
BH across the entire ledger gets harsher as the ledger grows. After a few
hundred studies, a genuine effect could fail correction purely because many
unrelated questions were asked. The statistically correct family is
"tests bearing on the same question," not "all tests ever." *Fix cost: medium —
requires a defensible study-grouping taxonomy. Documented now because the
threshold at which this bites is roughly 50–100 entries.*

**S3 — Grade boundaries are unvalidated. (Medium)**
The A/B/C/D/F rubric is principled but its thresholds (p<0.05, effect vs
declared target, fold sign-consistency) were chosen by reasoning, not
calibrated against known-good and known-bad studies. No backtest of the
grader exists. *Fix cost: high — needs a labelled corpus of studies.*

**S4 — Walk-forward consistency is sign-only. (Low)**
A study with folds at 51%/52%/51%/99% counts as "consistent" because all
exceed the null. Magnitude instability is invisible. *Fix cost: low — add a
dispersion check.*

**S5 — Only binary outcomes are supported. (Medium)**
`StudyObservation.success` is boolean, so the framework tests rates, not
returns. A strategy can have a poor win rate and excellent expectancy; that
study cannot currently be run. *Fix cost: medium — a parallel continuous-outcome
path with a bootstrap over means. This is the most likely near-term extension.*

**S6 — Cross-sectional correlation is not modelled at the study level. (High)**
Block bootstrap handles serial dependence. It does **not** handle two
instruments moving together on the same day. Existing scripts work around
this by inflating block length (2× horizon for a two-asset universe), but the
framework does not do this automatically, and an author supplying BTC and ETH
observations would get an overstated effective N. *Fix cost: medium — cluster
the bootstrap by date. **This is the most serious statistical gap in the
framework** and is the one I would fix first.*

---

## Part 3 — Architectural weaknesses

**A1 — `src/lib/research/study.ts` imports from `scripts/backtest/`. (High, structural)**
A layering inversion: library code depends on scripts. It typechecks and
`next build` passes (nothing in the app imports it), but it is backwards and
will eventually break — a build tool that excludes `scripts/` from the app
graph would fail. The stats layer (`overlap.ts`, `multipleTesting.ts`,
`metrics.ts`) is universal research infrastructure and belongs in
`src/lib/research/`. *Fix cost: low — move three files and update imports in
~8 scripts. Not done here because it modifies existing files and instruction 10
says document rather than silently fix.*

**A2 — Two parallel execution engines now exist. (Medium)**
`scripts/backtest/execution.ts` (intrabar, crypto) and
`src/lib/research/execution.ts` (gap-aware, universal). They implement the
same concept with different semantics. Until the old one is retired, a study
could use either and get different answers. *Fix cost: medium — migrate
callers to the gap-aware version with `gapsPossible: false` for crypto, which
is behaviourally identical.*

**A3 — Feature versioning is declared but not enforced. (Medium)**
`ReproducibilityStamp.featureVersions` is a free-form record the caller
populates. Nothing verifies it matches the features actually used, and
nothing prevents a feature's logic changing while its version string stays
put — which would silently invalidate every prior conclusion that used it.
*Fix cost: medium — hash each feature's source or require a version field on
`FeatureDefinition` and populate the stamp automatically.*

**A4 — No runtime study registry. (Low)**
Mandatory declaration is enforced by the type system, which is strong, but a
study could still be executed outside the framework entirely by calling the
statistics helpers directly. Nothing forbids it. *Fix cost: low — but the
honest answer is that no type system prevents someone determined to bypass it;
this is a code-review concern.*

---

## Part 4 — Other risks

**Scalability.** Leave-one-out attribution (designed, not built) is O(modules)
per decision. Block bootstrap at 2,000 iterations × ledger-wide recomputation
on every append is O(entries) per write — fine at hundreds, not at millions.
Neither binds now.

**Survivorship.** The framework carries `delistedT` and the design warns
against single-name equities, but **nothing enforces inclusion of dead
instruments.** A universe assembled from currently-listed tickers would pass
every check in this framework while being silently biased. This is a data-
ingestion discipline the framework cannot police.

**Look-ahead.** Structurally strong: `bars(id, tf, until)` has no escape
hatch, features receive only a bounded context, and truncation tests exist at
three layers. The residual risk is a *capability* series whose `knownAtT` is
set to the period it describes rather than its release time — earnings and
economic releases are the obvious hazards. The field is named `knownAtT`
rather than `t` to make this hard to get wrong, but nothing validates it.

**Reproducibility.** Seeded RNG, no wall-clock in results, determinism test
present. Residual risk: `Object.keys` ordering feeds group ordering, which is
insertion-ordered in practice but not guaranteed by spec for all key types.
Low, but real.

**Maintenance.** The framework is ~900 lines across four files with 47 tests.
The main burden is that every new outcome type (S5) or correction method (S6)
touches `executeStudy`, which is already the longest function. It should be
decomposed before the next extension, not after.

---

## Part 5 — Honest limits of what was built

Instruction 2 asked that no study bypass any of twelve pipeline steps. The
framework enforces steps 5–12 (everything statistical) because it owns them.
Steps 1–4 — point-in-time loading, feature generation, capability validation,
outcome generation — are performed by the study and only *validated* by the
framework: it checks that required features arrived, but it cannot verify
that a study loaded its data point-in-time.

That is a real limit and it should be stated plainly rather than implied
away. The mitigations are `MarketDataSource` having no untruncated read path,
and the truncation-test convention. Neither is enforcement.

**The single highest-value follow-up is S6** (date-clustered bootstrap),
because a multi-asset study run today would overstate its own effective
sample — the precise error this framework was built to prevent.
