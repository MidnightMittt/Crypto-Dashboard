# Adding an evidence module

The integration pattern for every future evidence source — earnings,
valuation, macro, options flow, insider buying, analyst revisions, on-chain.

Reference implementation: `evaluateMarketStructure` in
`src/lib/markets/equityEvidence.ts`. Design rationale:
`docs/EVIDENCE_MODULE_CONTRACT.md`.

---

## The whole pattern

```
extract  →  emit MetricVerdict  →  register the id  →  done
```

Four steps. Step 3 is the one that silently breaks everything if skipped.

---

## 1. Extract

A pure function over whatever the source provides. No fetching, no caching,
no global state — those belong in a provider adapter, so the evidence logic
stays testable against constructed fixtures.

```ts
export function evaluateEarningsSurprise(
  input: EarningsInput,
  asOf: number
): MetricVerdict | null
```

**Return `null` rather than a neutral verdict when the source is
unavailable.** They are different states. A neutral verdict says "I looked
and found nothing directional"; `null` says "I could not look." The engine
renormalises over modules that reported, so a null costs nothing — but a
fabricated neutral dilutes every other module's weight.

## 2. Emit `MetricVerdict`

The full contract lives in `src/lib/signals/types.ts`. What matters:

| Field | Rule |
|---|---|
| `id` | Stable and unique. Also the registration key in step 3. |
| `verdict` | `bullish` / `bearish` / `neutral`. |
| `confidence` | 0–100 **evidence quality**, not probability of a move. |
| `confidenceBasis` | Plain English: what made the number what it is. |
| `explanation` | One sentence citing the real value behind the verdict. |
| `whyItMatters` | Why a trader should care that this metric exists at all. |
| `conflicts` | Evidence **against** the module's own verdict. |
| `evidenceFor` | Optional. Discrete claims supporting it — one per entry. |
| `supporting` | Optional. Named measurements, so no UI re-derives them. |
| `nextTrigger` | The level or condition that would flip this verdict. |

**Never export a score contribution or a risk contribution.** Contribution
depends on which *other* modules reported, so only the engine can compute it
— call `contributionOf(metric, allMetrics)` from `categories.ts`. A module
that declared its own weight would break the renormalisation that lets one
engine score an equity on six modules and a crypto asset on eighteen.

### Thresholds

If your measure has no established band, derive it from **the measure's own
trailing distribution** rather than picking a round number. See
`percentileOf` in `equityEvidence.ts`. "Unusual for this series" is a claim
the data supports; "above 3%" usually is not.

Watch the tie case: a value equal to its whole distribution must land at the
50th percentile, not the 0th. That bug once produced a maximally bearish
signal out of zero variance.

## 3. Register the id — **do not skip this**

```ts
// src/lib/signals/categories.ts
const CATEGORY_MAP: Record<string, Category[]> = {
  ...
  earningsSurprise: ["leadingDrivers"],
};
```

**An unregistered metric is invisible.** `buildAllCategories` filters by this
map, so an unmapped id contributes to nothing — and if *every* metric is
unmapped, `buildMarketBias` returns `null` and the entire asset has no
decision at all.

This is not hypothetical. The first equity integration emitted five perfectly
valid verdicts and produced a null bias, because the ids had no category. The
modules were right and the engine was right; the registration was missing.

Optionally add a weight to `METRIC_WEIGHTS` in `scoring.ts`. Omitting it gives
the 0.05 default, which is a reasonable starting point for a new source.

## 4. Test against constructed fixtures

Hand-reason each expected value before asserting it. The house standard is
`metrics.test.ts` and `equityEvidence.test.ts`.

Cover at minimum:

- the directional cases, both ways;
- the case where the source is **absent** → `null`, not neutral;
- the case where the reading is genuinely ambiguous → neutral, with the
  ambiguity named in `conflicts`;
- that confidence tracks evidence quality rather than effect size.

Then run it against **real data** before believing it. Every one of the
significant bugs in this codebase passed typecheck and unit tests and was
caught by reading actual output: the zero-variance percentile, the null bias,
equity breadth leaking into Treasuries.

---

## Level providers are not evidence modules

`buildSupportResistanceZones` produces **levels**, not a verdict. It emits no
`MetricVerdict` and is scored by nothing. It is consumed by trade planning,
by entry quality, and by market structure alike.

Keep the distinction. If your source produces prices rather than an opinion,
it is a level provider — expose it as data and let evidence modules consume
it, as market structure does through its optional `levels` argument.

---

## Worked sketch: earnings surprise

```ts
// 1. extract — pure, no fetching
export function evaluateEarningsSurprise(
  history: EarningsReport[],   // provider adapter fetches these
  asOf: number
): MetricVerdict | null {
  if (history.length < 8) return null;          // cannot look → null

  const latest = history[history.length - 1];
  const surprisePct = (latest.actual - latest.consensus) / Math.abs(latest.consensus) * 100;
  const p = percentileOf(surprisePct, history.slice(0, -1).map(surpriseOf));
  if (p === null) return null;

  const verdict = p >= 2 / 3 ? "bullish" : p <= 1 / 3 ? "bearish" : "neutral";

  // 2. emit — no scoreContribution, no riskContribution
  return {
    id: "earningsSurprise",
    label: "Earnings Surprise",
    verdict,
    confidence: confidenceFrom(p, history.length),
    confidenceBasis: `${history.length} prior reports; this one is at their ${ordinal(Math.round(p * 100))} percentile.`,
    explanation: `Beat consensus by ${surprisePct.toFixed(1)}% — the ${ordinal(Math.round(p * 100))} percentile of this company's own history.`,
    whyItMatters: "A beat against a lowered bar is not the same as a beat against a raised one; ranking against the company's own record separates them.",
    asOf,
    evidenceFor: verdict === "bullish" ? [`Beat consensus by ${surprisePct.toFixed(1)}%`] : [],
    supporting: [
      { label: "Actual", value: latest.actual.toFixed(2) },
      { label: "Consensus", value: latest.consensus.toFixed(2) },
    ],
    conflicts: [],
    nextTrigger: `turns neutral below the 67th percentile of its own surprise history`,
  };
}

// 3. register — src/lib/signals/categories.ts
//    earningsSurprise: ["leadingDrivers"],
```

Nothing else. No engine change, no scoring change, no UI change — the metric
appears in evidence-for/against, in its category rollup, and in the
composite, on the crypto and equity surfaces alike, because both render
`MetricVerdict` and neither knows where the evidence came from.
