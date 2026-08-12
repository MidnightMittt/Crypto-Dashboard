# Decision Attribution Engine — Architecture

**Status: design only. Nothing here is implemented, and nothing in production
references it.** Deliverable 7 of Phase 8.

---

## Purpose

Every recommendation should eventually answer six questions:

1. Why was this trade recommended?
2. Which evidence increased confidence?
3. Which evidence reduced confidence?
4. Which evidence conflicted?
5. Which evidence was unavailable?
6. What single change would have flipped the decision?

Question 6 is the hard one and the valuable one. The first five are
bookkeeping — record what each module said. The sixth requires knowing the
decision's *sensitivity* to each input, which is a different thing from
knowing each input's value.

---

## Core insight: attribution must be recorded, not reconstructed

The tempting design is to re-derive attribution after the fact by re-running
the engine with inputs perturbed. That is wrong here, for a reason this
project has already been bitten by: **the engine's inputs are point-in-time,
and they are gone.** Re-running tomorrow against today's data answers a
different question. Order book state, funding, and SWR-cached reads are not
reproducible after the fact.

So attribution must be **captured at decision time**, as a by-product of the
decision, and stored. This is the same discipline that makes
`TradeResearchRecord` work.

---

## Data model

```ts
/** One module's contribution to one decision. Recorded, never inferred. */
interface EvidenceContribution {
  moduleId: string;
  /** What the module concluded, in plain language. */
  statement: string;
  /** Direction relative to the decision that was actually made. */
  effect: "supports" | "opposes" | "neutral";
  /**
   * How much the decision would move if this module were removed, in the
   * decision's own units. Signed. This is the sensitivity, and it is what
   * distinguishes attribution from a list of opinions.
   */
  marginalImpact: number;
  /** Present when the module could not run. */
  unavailableReason: CapabilityKey[] | null;
}

interface DecisionAttribution {
  decisionId: string;
  asOf: number;
  instrumentId: string;
  decision: string;              // e.g. "enter-long"
  confidence: number;
  contributions: EvidenceContribution[];
  /** Modules that disagreed with the decision AND had non-trivial impact. */
  conflicts: string[];
  /** The single smallest change that flips the decision — see below. */
  pivotalFactor: { moduleId: string; requiredChange: string } | null;
  /** Feature vector at decision time, so attribution joins to research records. */
  features: FeatureVector;
}
```

---

## Computing `marginalImpact` — leave-one-out, not weights

The naive approach reads each module's configured weight. That is wrong
whenever the aggregation is non-linear (gates, thresholds, hysteresis — all
of which this engine has). A module with a small weight sitting exactly on a
gate boundary can be decisive; a module with a large weight can be irrelevant
because another gate already closed.

The correct computation is **leave-one-out at decision time**:

```
for each module m:
    recompute the decision with m's contribution withheld
    marginalImpact(m) = decision_with_all − decision_without_m
```

This costs N+1 evaluations of the aggregation step per decision. That is
acceptable because the aggregation is pure and cheap — it is the *data
fetching* that is expensive, and that is already done by this point.

`pivotalFactor` follows directly: the module with the smallest
`|marginalImpact|` that is nonetheless large enough to cross the decision
boundary. If no single module can flip it, the decision is robust and
`pivotalFactor` is null — which is itself worth displaying.

---

## Why this must not become a score

The engine already reports confidence. Attribution explains it; it must not
add a second, competing number. Specifically:

- Attribution is **read-only with respect to the decision.** It observes; it
  never feeds back. A feedback loop would make the explanation part of what
  it explains.
- `marginalImpact` is expressed in the decision's existing units, not a new
  normalised 0–100 scale, so it cannot be mistaken for a fresh score.
- No aggregation across contributions is provided. "Total supporting
  evidence: 62" would be exactly the opaque composite the charter forbids.

---

## Integration points (when eventually built)

| Stage | Change |
|---|---|
| Aggregation | Emit `EvidenceContribution[]` alongside the existing decision |
| Storage | Append `DecisionAttribution` to a store, keyed by decision id |
| Research | Join attribution to `TradeResearchRecord` on `decisionId` |
| UI | One expandable block inside the existing decision area — no new card |

The research join is the point. Once attribution and outcome share a key,
"which evidence was present when we were right?" becomes a query rather than
a study.

---

## Deliberately excluded

- **Counterfactual replay of data.** Only the aggregation is re-run, never
  the data fetch. Re-fetching would answer a different question.
- **Multi-module counterfactuals.** "Which *pair* of changes flips it" is
  combinatorial and would reintroduce the mining problem currently deferred.
- **Natural-language generation beyond templates.** Each module already
  states its own conclusion; attribution orders and annotates them.

---

## Open questions to resolve before implementing

1. **Decision identity.** The swing thesis persists across days. Is a
   decision the activation, or each daily reaffirmation? Attribution for a
   standing thesis probably wants both: one at activation, and a diff each
   day thereafter.
2. **Storage growth.** One attribution per instrument per poll is large.
   Recording only on *change* — the pattern `biasHistory` already uses —
   is the likely answer.
3. **Gate semantics.** For a hard gate, `marginalImpact` is either zero or
   the whole decision, with nothing in between. Whether that reads as
   informative or as a bug to users needs testing before it ships.
