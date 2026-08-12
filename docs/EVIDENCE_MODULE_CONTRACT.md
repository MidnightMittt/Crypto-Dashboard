# The Evidence Module contract — design review before implementation

Response to the brief's instruction: *"challenge this design if you believe
there is a better long-term architecture."*

I think three of the nine required exports are wrong, and that the contract
should be an extension of something that already exists rather than a new
interface. I also found a real inconsistency between crypto and equities that
this phase would otherwise cement.

---

## 1. `MetricVerdict` is already 7/9 of the requested contract

| Requested export | Already in `MetricVerdict` |
|---|---|
| Decision | `verdict` |
| Confidence | `confidence` (+ `confidenceBasis`) |
| Evidence Against | `conflicts` |
| Explanation | `explanation` (+ `whyItMatters`) |
| Invalidation | `nextTrigger` |
| Supporting metrics | **missing** (currently prose inside `explanation`) |
| Evidence For | **missing** (currently prose inside `explanation`) |
| Risk contribution | **should not exist — see §2** |
| Score contribution | **should not exist — see §2** |

Eighteen crypto modules and six equity modules already emit `MetricVerdict`.
`buildMarketBias`, `buildAllCategories` and every UI surface consume it.

**Recommendation: extend `MetricVerdict` with two OPTIONAL fields rather than
define a second interface.**

```ts
/** A single structured observation. Optional — 24 existing modules omit it. */
evidenceFor?: EvidencePoint[];
/** Named measurements behind the verdict, for display without re-derivation. */
supporting?: Array<{ label: string; value: string }>;
```

Optional means zero migration, zero behaviour change, and no second contract.
A parallel `EvidenceModule` interface would leave the codebase with two ways
to say the same thing — and note there is *already* an `EvidenceModule` type
in `research/types.ts` used by the research engine. A third would be worse
than the duplication the execution-model work spent a whole phase removing.

---

## 2. Score and risk contribution must NOT be module exports

This is the objection I feel strongest about.

**If a module declares its own score contribution, weighting has moved into
the modules.** Today `METRIC_WEIGHTS` and `CATEGORY_WEIGHTS` own that, in one
place, and `computeWeightedScore` renormalises over whatever actually
reported. That renormalisation is exactly what lets one engine score an
equity on six modules and a crypto asset on eighteen without a branch.

If each module asserts its own contribution:

- twenty-four modules each claim their own importance, and nothing reconciles
  the claims;
- the engine can no longer renormalise when modules are absent, because the
  contributions no longer sum to a known total;
- adding a module silently dilutes or inflates every other one;
- the equity/crypto capability split stops working, since absent modules can
  no longer be "not counted" — they'd be missing a declared share.

Contribution is a property of a module **in a context**, not of the module.
The engine already computes it and can report it back for display:

```ts
// Derived by the engine, not declared by the module.
contributionOf(metric, allMetrics): { sharePct: number; category: Category }
```

**Risk contribution has the same problem plus a definitional one.** "Risk" in
this engine is already two things — the `risk` category, and
`bias.riskLevel`/`riskRationale`. A module self-reporting risk would compete
with both. What a module can honestly report is *what it observes*
("volatility at the 79th percentile of its own history"); translating that
into portfolio risk is an engine-level judgement that needs to see every
module at once.

**Recommendation: seven exports from the module, two derived by the engine.**

---

## 3. The finding this phase would otherwise cement

Crypto and equities currently place market structure at **different levels of
the hierarchy**.

- **Crypto:** structure is a *row inside* the technical read —
  `technicalDimensions` renders "Structure — Lower lows — BEARISH" as one of
  six dimensions feeding the single `technicals` metric.
- **Equities:** structure is a *top-level metric*, `equityMarketStructure`,
  scored directly in the `marketStructure` category alongside relative
  strength and breadth.

So the same concept is a sub-reading in one asset class and a first-class
metric in the other. Consequences:

1. Structure carries **different effective weight** across asset classes —
   diluted by five siblings in crypto, undiluted in equities.
2. The brief's own follow-up question ("should Technical Read become a
   composite built from Market Structure?") is really asking which of these
   two levels is correct. It cannot be both.
3. Making equity market structure the *reference implementation* while crypto
   keeps structure buried inside a composite would enshrine the inconsistency
   in the thing every future module is modelled on.

**Recommendation: resolve the level before writing the reference.** My view is
that structure should be a first-class module in BOTH, and the technical read
should become a composite that *consumes* it rather than recomputing it — see
§4. But that changes crypto scoring, which this brief explicitly forbids
("do not change existing crypto behavior"). So the honest sequence is:

1. Land the contract extension (no behaviour change).
2. Make equity market structure the reference against it (no behaviour change).
3. Raise the crypto structure-level change as its **own** decision, with the
   scoring impact measured, rather than smuggling it in here.

---

## 4. Answers to the four follow-up questions

**Should Technical Read become a composite built from Market Structure?**
Yes — but as a separate, measured change. `technicalDimensions` already
computes structure internally; having a standalone module compute it again
from the same bars is duplicated logic today (it is only not a *bug* because
the equity path and the crypto path never meet). The end state is one
structure module, consumed by the technical read rather than duplicated
inside it. Cost: it changes the crypto composite, so it needs a backtest
delta the way the damping change did.

**Should Support/Resistance remain independent or become a submodule?**
**Independent — and it is not evidence at all.** S/R produces *levels*, not a
verdict. It is consumed by trade planning, by entry quality, and by market
structure. Making it a submodule of structure would hide it from the two
other consumers. The correct classification is **infrastructure, not an
evidence module** — it should never emit a `MetricVerdict`, and it currently
doesn't. That distinction is worth naming explicitly in the architecture:
*level providers* and *evidence modules* are different things.

**Should Swing Thesis consume Market Structure rather than recompute it?**
Yes. It currently derives its own structural view. But it is **blocked**:
`swingThesis.statusForPrice` is gap-blind by documented exception and would
misreport stops on any session market. Fix that first; it is a correctness
prerequisite, not a refactor.

**Duplicated logic identified.**
- Structure computed twice — `technicalDimensions` (crypto) and
  `equityMarketStructure` (equities). Resolve per §3.
- Pivot detection — *was* about to be duplicated; the equity module reuses
  `findSwingPoints` from `divergence.ts` instead. Already correct.
- ATR — computed in `indicators.ts`, in `equityEvidence.ts`'s `atrPctAt`, and
  inside `buildSupportResistanceZones`. Three implementations of one measure.
  Worth consolidating, low risk, no behaviour change if done carefully.

---

## 5. What I recommend building, in order

1. **Extend `MetricVerdict`** with optional `evidenceFor` and `supporting`.
   No migration, no behaviour change.
2. **Add engine-derived `contributionOf`** so the UI can show score
   contribution without modules declaring it.
3. **Make `equityMarketStructure` the reference implementation** — populate
   the new fields fully, and document it in-file as the pattern every future
   module follows.
4. **Write the integration guide** showing how earnings / valuation / macro /
   options / insider buying plug in: extract → emit `MetricVerdict` → register
   an id in `CATEGORY_MAP` → done. That last step is the one that was missing
   and silently returned `null` for the whole equity bias, so it belongs in
   the guide in bold.

Steps 1–3 satisfy the brief's success criteria without changing any score.
Step 4 is what actually makes the platform extensible, and it is a document,
not code.

**Deferred deliberately:** the crypto structure-level change (§3) and the
technical-read composite (§4), because both change crypto scoring and this
brief forbids that. They should be their own phase, with a measured delta.
