# FROM INFORMATION PAGE TO DECISION ENGINE

The infrastructure is done. Replay, evidence grading, validation, provenance,
the module registry and the section contract are now plumbing, and plumbing
should be invisible. Every decision from here answers one question: **does
this make the user better at making a trading decision?**

This plan is measured, not theorised. Everything below was read off the live
dossier before it was written.

---

## 1. What the page actually does today

Measured on `/asset/NVDA`, 2026-08-16:

| | measured |
|---|---|
| Text on the page | **37,423 characters** |
| The target mock | ~1,500 characters |
| First screen before the trade appears | ~400 chars of epistemics disclaimer |
| "What changes my mind" as a **price** | **2 of 5** tickers |
| "What changes my mind" as engine jargon | **3 of 5** — every WAIT ticker |

**The gap is not data.** The dossier already carries more than the mock needs:
drift-adjusted analogs with overlap-corrected effective n, Wilson-bounded win
rates, median hold times, a forward record, options intelligence, insider
clusters, short-volume percentiles. The gap is voice, priority, and one
structural hole.

### Finding 1 — the page leads with engine vocabulary

Today's bull-case bullet:

> ↑ Risk Appetite · Over the last 20 trading days riskier corporate bonds are
> beating safe government bonds by 3.1% — money is willing to take risk to
> earn more, which usually accompanies a rising stock market.

35 words, prefixed with a module name. The target is "• Money is moving into
riskier assets" — five words, with the rest available on demand. The writing
is good; the *ordering* is wrong. It puts the mechanism before the answer.

### Finding 2 — the first screen explains the platform, not the trade

The decide group currently opens with two paragraphs of epistemics: "this
platform does not generate summaries with a language model" and "no module
contributing to it has a validated forward record, so treat the direction as
context…". Both statements are true, important, and **in the wrong place**.
They are occupying the single most valuable surface in the product.

### Finding 3 — invalidation collapses on exactly the days it matters most

`composeInvalidation` produces a real price when a plan exists:

> A daily close beyond $294.14 — that level sits past the structure the whole
> idea rests on. *(AAPL, SELL)*

With no plan it falls back to engine internals:

> Price Action Strength 15/100 — below 20 this reports neutral regardless of
> direction. *(APLD, WAIT)*

Since the EV gate landed, **WAIT is the majority state.** So the section
answering the question promoted to position #4 is unusable on most tickers on
most days. This is the single largest decision-quality defect on the page.

---

## 2. The one thing in the brief I will not build as specified

> Trade Quality — **9.2 / 10**

Three measurements say this number cannot be honestly produced today:

1. The live page already states, correctly, that **no module contributing to
   the equity verdict has a validated forward record.**
2. Of nine Edge voters, **one clears its own gate.** 29% of composite weight
   sits on a coin flip and an unjudgeable sample.
3. NVDA's own analogs: median **−0.2%** against **+1.6%** for a random day
   over the same horizon — *worse than random*, on 50 raw matches worth 23.7
   independent observations after overlap correction.

A decimal on a ten-point scale claims resolution of ±0.1. We have ±1 star at
best, on signals that have not beaten a coin. Publishing 9.2 would be the
most damaging thing this platform could ship, because it converts the one
thing that makes it different — refusing to fake precision — into the thing
everyone else already does.

**The superior alternative — Conviction with a ceiling.** The underlying need
is real and is one of the golden-rule questions ("how much conviction should I
have?"). So conviction ships as a word, with a hard rule:

> Conviction is capped by the weakest link in its own evidence chain, and the
> cap is stated. No contributing signal with a forward record ⇒ conviction
> cannot read High.

Rendered: **Moderate** — *capped: no contributing signal has a forward record
yet.* That answers the question, refuses the fiction, and gets better
automatically as signals earn validation — the number rises when the evidence
does, which is the incentive we want.

---

## 3. The Answer Layer — the highest-leverage change on the list

The brief's central rule is *plain English first, evidence second, raw numbers
third*. That is a contract, so it becomes a type.

`MetricVerdict` gains:

```ts
interface Says {
  /** ≤ 8 words. THE ANSWER. "Momentum is becoming crowded." */
  plain: string;
  /** One sentence of mechanism. No raw units. */
  because: string;
  /** The measurement, with units. "RSI 72 (14-day, Wilder)" */
  raw: string;
}
```

- `plain` renders by default, everywhere.
- `because` renders on expand.
- `raw` renders only in Full Evidence.

This single change is what converts every section from a display into an
answer, and it is why it outranks everything else: it touches all fourteen
sections without any of them being rewritten. Section headings become their
questions ("Is institutional money buying?") and the answer is the top
module's `plain`.

**Staged, because it is ~20 evaluators of copy.** Decide/risk-phase metrics
first (~6), which is where the leverage is; the rest follow.

---

## 4. Technical debt to clear first

Three items, and one of them is the kind of bug this codebase keeps finding.

**A. `available()`'s evidence default makes the provenance gap invisible.**
`grep undeclaredEvidence` returns **0** hits outside the type definition — yet
**33** call sites have undeclared provenance, because they take it as a
default parameter. The work queue I described last session does not exist. Fix:
make `evidence` a required argument so every gap is a compile error and the
remaining migration is countable. *This is the same defect shape as the
byte-budget test that measured a payload of nulls: an invisible default that
made a real gap look closed.*

**B. `crossvalidate.py` regexes match page copy.** Every rename in this plan
will break checks silently into SKIP — which is precisely the failure that
motivated `--fail-on-internal-skip`. Patterns must be updated in the **same
commit** as each copy change, never after.

**C. `street` is still registered.** Flagged under the four-way gate two
commits ago and still rendering. Either it earns its slot or it goes.

Deliberately **not** blocking: the ETF redirect and Phase 0's daily job. Both
are real, neither improves a decision on the page.

---

## 5. The sequence, by return on effort

**Step 1 — Invalidation always names a price.** *(highest ROI on the list)*
Every ticker, plan or no plan. With no plan, the invalidation is the level
that would *create* one — `nextEntry` already computes it. Turns the #4
section from unusable to actionable on the majority of tickers. Small, pure,
testable.

**Step 2 — Reclaim the first screen.** Epistemics becomes one line plus an
expandable. Nothing is deleted; ~400 characters of prime surface returns to
the trade. Pure presentation, no engine change.

**Step 3 — Conviction with a ceiling.** Replaces the 9.2/10 ask honestly and
answers a golden-rule question. Pure function, fully testable.

**Step 4 — Debt: `evidence` becomes required.** Makes the remaining
provenance migration countable before more modules are built on top of it.

**Step 5 — The Answer Layer, decide/risk phase.** `Says` on the six metrics
that reach the first two screens. The transformation begins to be visible.

**Step 6 — Sections become questions.** Headings and TL;DR rewritten to the
brief's voice. Ships *with* the crossvalidate pattern updates.

**Step 7 — The Answer Layer, remaining evaluators.** Mechanical once the
pattern is proven.

Options intelligence, portfolio context and the legacy-page migration all sit
behind these, because none of them improves a decision as much as making the
decisions already on the page legible.

---

## 6. A product note worth stating plainly

The mock shows 🟢 BUY at 9.2/10. Today's engine, on the same page, says
🟡 WAIT — *"the target is further than trades like this one usually reach, so
the reward is not realistic."*

**That is the product working.** The most valuable output this platform
currently produces is a well-argued refusal, and the analogs back it: these
setups have not beaten a random day. Building toward a mock that assumes a
strong buy would mean tuning the engine to produce the answer the design
expects.

So the plan above makes the *refusal* excellent — legible, priced, with a
named level that would change it — rather than manufacturing conviction the
evidence does not support. When a signal earns a forward record, the same
surface will carry a real BUY with a real number behind it, and it will be
believable precisely because the platform spent this phase refusing to fake
it.
