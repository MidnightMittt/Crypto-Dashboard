# THE DOSSIER ARCHITECTURE — the permanent foundation

The dossier at `/asset/[symbol]` is the centrepiece of the platform and the
canonical destination for every ticker. This document is the standing contract
for how it is built and extended. It governs alongside `ROADMAP.md`: the
roadmap says what to build next, this says where it lands.

The mandate that produced it: **we have reached the point where adding another
isolated research module creates less value than turning what is already built
into a coherent product.** Three measurements make the case concrete.

- The EDGAR after-hours catalyst feed was built, tested, and shipped into
  `/api/pretrade` — and rendered on **zero pages**. A trader deciding whether
  to hold overnight cannot see the one filing that would change the answer.
- `/asset/[symbol]` *redirected ETFs away* to `/markets/[symbol]`. Searching
  SPY took you off the dossier.
- Crypto intelligence — liquidity map, similar setups, category rollups —
  lived only on `/crypto`, so the BTC dossier could not use it.

None of those modules is low-value. The failure is structural: **the dossier
had no slot for them to land in, so they landed on new pages.** Everything
below exists to make that impossible.

---

## 1. Two levels: Section and Module

The single most important rule.

> **Section** — one of the fourteen named slots below. The public contract.
> Changes roughly never. A trader who learns where the plan lives finds it
> there next year.
>
> **Module** — an independent unit of intelligence implementing the interface
> in §2, assigned to exactly one section. This is where the platform grows.

A capability is added by registering a module. It **cannot** create a page,
because no mechanism exists for it to. Adding a *section* requires editing the
manifest — a deliberate, reviewed layout change, never a side effect.

This is what "Trading Plan" being one section and three modules (plan, next
entry, checklist) buys: a stable name for the reader and independent,
separately-testable units for us.

## 2. The module interface

Every module returns the same envelope, whatever it measures.

```ts
type Read<T> =
  | { status: "available"; depth: Depth; data: T; evidence: Evidence; upgrade: Upgrade | null }
  | { status: "unavailable"; blockedBy: BlockedBy; reason: string };

interface Evidence {
  /**
   * null is a real answer: this module reports FACTS and makes no
   * probabilistic claim. Forcing a fundamentals read to invent a confidence
   * grade would fabricate certainty, which is the defect this codebase keeps
   * removing. A null-confidence module must never be summarised as certain.
   */
  confidence: Confidence | null;
  /** Why, in the analyst voice. One clause per claim, never one blob. */
  reasoning: string[];
  /** Where every number came from. Shared primitive — see §3. */
  provenance: Provenance[];
}

interface Confidence {
  /** Input quality: are the feeds fresh and complete. */
  grade: "thin" | "moderate" | "strong";
  /** Whether the signal works at all, out of sample. */
  validated: EvidenceGrade;
  /** Sample size behind the claim. null = not measured, never 0. */
  n: number | null;
}
```

`BlockedBy` and `Depth` are unchanged from the existing contract and remain
load-bearing:

- `blockedBy` distinguishes `no-provider` (a sourcing gap) from
  `not-measured-yet` (our backlog) from `provider-error` (try again) from
  `not-applicable` (funding rates on a stock) from `insufficient-history`.
  The values are, literally, the build queue.
- `depth` grades EVIDENCE QUALITY, not polish: `basic` (descriptive, computed
  from the asset's own history), `advanced` (measured, with an n),
  `institutional` (forward-validated or independently corroborated). A
  beautifully rendered descriptive read is still `basic`.
- `upgrade` states what would lift the module a tier, so the roadmap stays
  self-documenting at every level rather than only at zero.

**Naming note.** The existing type `Section<T>` is renamed `Read<T>`, freeing
the word "section" for the fourteen slots. It matches vocabulary already in
use — `TechnicalRead`, `IndustryRead`, `LiquidityMapRead`.

## 3. One provenance primitive, shared with the API

`/api/pretrade` already serves rigorous provenance: `{value, unit, as_of,
source, method}`, with null always carrying a machine-readable reason. The
dossier had none. Two contracts for one idea is precisely the drift this
architecture exists to prevent, so there is now one:

```ts
interface Provenance {
  field: string;
  unit: string;
  as_of: string;
  source: string;
  /** How it was computed. Absent only for raw passthroughs. */
  method?: string;
}
```

The dossier imports it from the pre-trade contract. It is not redefined. This
also resolves the open question from the pre-trade spec — "the dossier must
render FROM this endpoint, so the page and the API cannot drift" — better than
the literal reading would have: the endpoint is verdict-free by design and the
page is not, so they share the *primitive* rather than one consuming the other.

## 4. The four-way gate, enforced by the compiler

> If a module does not materially improve decision quality, confidence, risk
> management, or execution, it does not get built.

This is a type, not a doctrine nobody rereads:

```ts
type Serves = "decision" | "confidence" | "risk" | "execution";

interface ModuleDef {
  id: ModuleId;
  section: SectionId;
  /** Non-empty by construction. */
  serves: readonly [Serves, ...Serves[]];
}
```

A module that cannot name what it improves **does not compile.** Interesting
is not a reason. A statistic with no consequence for what a trader does next
belongs in `docs/`, not in a section.

## 5. Phases answer the six questions, in order

The page answers, in this order: What should I do? Why? What could invalidate
this? How has this type of setup performed? What evidence supports it? How
deep do I want to go?

| Phase | Question | Presentation |
|---|---|---|
| `decide` | Q1 + Q2 | no heading — it IS the answer |
| `risk` | Q3 | visible, directly under the plan |
| `verify` | Q4 | visible |
| `evidence` | Q5 | visible |
| `audit` | Q6 | folded, server-rendered |

Q2 ("Why?") does not get its own phase. Under §2 *every* module carries
`reasoning`, so the why lives inside the Verdict card rather than in six
separate cards between the plan and the risks. That is what lets Risk Factors
sit immediately after the Trading Plan, where a trader needs it.

Q6 is not a phase either — it is the `depth` ladder, which already exists.

**Phase choice sets prominence.** A section that cannot justify `decide` does
not get the first screen. The manifest is where that argument has to be won.

## 6. Silence is cheap

A design rule, because six evidence sections at equal weight would recreate
the flat-dump problem the phase system was built to fix:

> **A section with nothing to report costs one line, never a card.** Visual
> weight is proportional to what a section has to say — not to whether it
> exists.

"No unusual flow" is one line. Unusual flow is a card. Nothing disappears
silently; an absent section that vanishes is indistinguishable from one never
built, and the reader cannot tell whether "no options data" means calm
positioning or no provider.

## 7. The fourteen sections

| # | Section | Phase | Modules |
|---|---|---|---|
| 1 | TL;DR | decide | `tldr` |
| 2 | Verdict | decide | `verdict` (+ `reasons`, `engineBars` as its expansion) |
| 3 | Trading Plan | decide | `plan`, `nextEntry`, `checklist` |
| 4 | Risk Factors | risk | `invalidation`, `passRules` |
| 5 | Historical Analogs | verify | `analogs` |
| 6 | Validation Record | verify | `validatedSignal`, forward record |
| 7 | Money Flow | evidence | short-sale volume, CVD, exchange netflow |
| 8 | Options Intelligence | evidence | `optionsIntel`, `options` |
| 9 | Institutional Activity | evidence | `ownership` (incl. Form 4 clusters) |
| 10 | News & Catalysts | evidence | `attention`, **EDGAR catalysts** |
| 11 | Technical Structure | evidence | `levels` |
| 12 | Macro & Industry | evidence | `macro`, `business` |
| 13 | Full Evidence | audit | `evidence` |
| 14 | Audit | audit | `gaps`, **pipeline liveness** |

This is the requested section list in the requested order, with one move: Risk
Factors from #11 to #4, following the question order over the list order.

Two entries in bold are already-built work that currently reaches nobody.
Landing them is the first proof the architecture works.

**`street` (analyst price targets) is flagged for deletion** pending the §4
test. It is not obvious that a consensus target improves decision, confidence,
risk or execution for a swing trade, and the burden is on the module.

## 8. Migration policy — canonical now, retire on parity

`/asset/[symbol]` is the canonical page for every ticker. **One exception
remains and is tracked, not tolerated:** `/asset/[ETF]` still redirects to
`/markets/[symbol]`, so searching SPY leaves the dossier. Removing it is the
next migration step and is deliberately sequenced after the module registry
rather than bundled with it — the ETF pages are validated and daily-refreshed,
and reversing the redirect without first checking that the dossier serves them
at least as well would trade one honest page for a worse one.

Existing pages (`/crypto`, `/markets`, `/markets/[symbol]`, `/industries`,
`/industry/[slug]`, `/intelligence`, `/scanner`) remain as **discovery and
navigation surfaces that link into the dossier.** They are not deleted on a
schedule. Each is retired only once its content has reached parity as dossier
modules. No big-bang migration.

**Every new feature lands inside the dossier first.** A feature that appears
first on a legacy page is a defect in this process, not a style choice.

## 9. Adding a capability — the whole procedure

1. Build the provider. It returns `Read<T>` with evidence and provenance.
2. Register it: `{ id, section, serves }`. Non-empty `serves` or it will not
   compile.
3. Write the module component. It renders its own unavailable, basic,
   advanced and institutional states.

There is no step four. **The page does not change.** The module appears at the
prominence its section's phase dictates, with its own absence reason, its own
provenance, and its own upgrade path — and `/api/pretrade` can serve the same
`Read` because they share the primitive of §3.

## 10. Standing prohibitions

Everything in `ROADMAP.md` §"Never build" still applies. Two additions
specific to this architecture:

- **No new page.** If a capability seems to need one, it needs a section, and
  that argument is made in the manifest.
- **No statistic without a consequence.** See §4. The question is never "is
  this interesting" but "what would a trader do differently".
