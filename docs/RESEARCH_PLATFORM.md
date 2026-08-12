# Cross-Asset Research Platform — Architecture & Design

Status: **design only.** No production code changed. Companion to
`scripts/backtest/powerAnalysis.md`, which supplies the evidence for every
sizing claim below.

---

## 0. The headline, and a challenge to the brief

The brief's premise — sample size is the bottleneck, so widen the universe —
is correct. The proposed remedy needs one correction, and it is a large one.

**BTC/ETH daily return correlation is 0.82** (measured, 1,448 paired days).
The effective independent asset count is `N / (1 + (N−1)ρ)`, which
**asymptotes at 1/ρ**. At ρ = 0.82 that ceiling is **1.22 effective assets**,
and the current two-asset universe already delivers 1.10 of it.

> **90% of the statistical power crypto can *ever* provide is already in
> hand.** Adding 500 crypto assets would move the effective count from 1.10
> to 1.22.

So "add more crypto" is close to a no-op. Two things actually move the needle:

| Lever | Effect | Cost |
|---|---|---|
| **Longer history** | 25y vs 4y ≈ 6x observations | Low — free data |
| **Lower ρ across asset classes** | ρ 0.82 → 0.25 ≈ 3.5x | Medium |
| More crypto tickers | ~1.02x | High |

Combined, a ~40-instrument multi-class universe over 25 years yields roughly
**20x** the current statistical resolution: detectable effect falls from
~15-18pp to ~4pp. That is the difference between "cannot evaluate any of our
hypotheses" and "can evaluate most of them."

**Recommended universe** (~40 instruments, est. ρ ≈ 0.25-0.30):
11 US sector SPDRs · 5 broad indices · 4 bond ETFs · 4 commodity ETFs ·
6 FX majors · BTC/ETH + 3 crypto majors.

Note what is *absent*: single-name equities. They introduce survivorship bias
immediately — "today's S&P 500" silently conditions on having survived — and
the brief explicitly lists that hazard. ETFs and indices sidestep it.

---

## 1. Audit — where crypto assumptions live today

### 1a. Hardcoded asset identity

17 files under `scripts/backtest/` reference `BTC`/`ETH` literally, led by
`swingCalibration.ts` (12), `regimeStudy.ts` (9), `run.ts` (8). The pattern is
always the same — `for (const asset of ["BTC", "ETH"] as const)` — so this is
mechanical to fix, not architectural. `AssetSymbol` is a closed union in
`src/types/market.ts:35`.

### 1b. Crypto-only data on the core record

`DayRecord` carries `weightedFundingRatePct`, `fundingPercentile`,
`oiPercentile`, `oiChange24hPct`, `longShortRatio`, `basisPct`,
`squeezeScore`, `squeezeSide` as **required** fields. An equity has none of
them. This is the real coupling: the research record's *shape* assumes a
perpetual-futures market.

### 1c. 24/7 assumptions — the dangerous category

These are not type problems and will not be caught by a compiler:

- **`rollUpToDaily` buckets by UTC calendar date.** Correct for crypto,
  wrong for equities, where the unit is a *session* (09:30-16:00 ET), and
  wrong again for FX (Sunday 17:00 ET open).
- **Forward-return lookups use fixed millisecond offsets with tolerances**
  (`run.ts`). "7 days later" spans a weekend for equities; the bar simply
  does not exist.
- **`execution.ts` resolves stops intrabar.** For crypto this is roughly
  right — it trades continuously. **For equities it is materially
  optimistic**: overnight and weekend gaps jump straight through stop levels,
  so a stop is filled at the *open*, not at the stop price. An equity
  backtest that ignores this will overstate results, and the error is
  systematic rather than random.
- **`costs.ts` models funding.** Perp-only; equities have borrow costs for
  shorts and dividends for longs instead.

> The gap model is the single highest-risk item in this migration. Everything
> else is refactoring; this one silently inflates returns.

---

## 2. Data architecture

### 2.1 Challenge: do not build the full schema now

The brief asks for a data layer supporting OHLCV, breadth, sector membership,
volatility, macro, earnings, economic releases, options, on-chain and
derivatives. Building all of that now is the wrong sequencing, for a reason
that comes straight from the power analysis: **every instrument in the
recommended universe is served by plain OHLCV.** Sector ETFs, indices, bonds,
commodities and FX need no earnings feed, no options chain, no on-chain data.

Building nine schemas to unlock a universe that needs one is speculative
generality — and each unused schema is surface area that has to be kept
compiling, tested and migrated for years before it earns anything.

**Recommendation:** build the OHLCV core plus one extension mechanism.
Additional families attach later without touching the core, which is the
property the brief actually wants ("nothing should require rewriting the
engine later"). That property comes from the *extension point*, not from
enumerating every future field today.

### 2.2 The core interfaces

```ts
/** The one thing every instrument in the recommended universe has. */
interface Bar {
  t: number;            // session close, epoch ms, UTC
  open: number; high: number; low: number; close: number;
  volume: number | null;   // null where genuinely unavailable (some FX)
}

/** How a series must be interpreted — replaces every implicit 24/7 assumption. */
interface SessionModel {
  kind: "continuous" | "session-based";
  /** Continuous markets cannot gap; session markets can, and execution must model it. */
  gapsPossible: boolean;
  /** Bars per year — drives annualisation, ATR windows, percentile baselines. */
  barsPerYear: number;
  timezone: string;
}

interface InstrumentMeta {
  id: string;                 // "SPY", "BTC-USD" — opaque to the engine
  assetClass: AssetClass;
  sessionModel: SessionModel;
  /** Prices adjusted for splits/dividends? Unadjusted equity series silently corrupt returns. */
  adjustment: "none" | "splits" | "splits-and-dividends";
  /** First date the instrument existed — guards against backfilled phantom history. */
  inceptionT: number;
}

/** Everything the research engine may read. Sole entry point. */
interface MarketDataSource {
  meta(id: string): InstrumentMeta;
  bars(id: string, timeframe: Timeframe, until: number): Bar[];  // <= until, always
  /** Optional evidence families, absent by default. */
  capability<T>(id: string, key: CapabilityKey): T | null;
}
```

Two design points worth defending:

- **`bars(..., until)` takes a cutoff rather than returning everything.**
  Point-in-time correctness becomes the *default* rather than a discipline
  each caller must remember. Every look-ahead bug this project has hit came
  from a caller forgetting to truncate.
- **`SessionModel.gapsPossible` is a first-class field**, because the
  execution engine must branch on it. It is not metadata; it is a correctness
  input.

### 2.3 Point-in-time is harder for equities than crypto

Crypto has none of the following, and all of them silently corrupt results:

| Hazard | Mitigation |
|---|---|
| Splits | Require `adjustment: "splits"` minimum; reject unadjusted series |
| Dividends | Total-return series, or model separately — never mix |
| Delisting | Include dead instruments; excluding them *is* survivorship bias |
| Index reconstitution | Membership must be as-of-date, never current |
| Ticker reuse | Key on a stable internal id, never the ticker string |

---

## 3. Asset classification and capabilities

### 3.1 Challenge: invert the direction of the declaration

The brief describes each asset class declaring what it has:

```
Crypto:   ✓ on-chain ✓ funding ✓ OI ✓ liquidations
Equities: ✓ earnings ✓ sector rotation ✓ breadth ✓ options
```

This is the right *idea* with the wrong *direction of dependency*. As written,
adding one new evidence module means editing every asset class — the classic
O(classes × modules) maintenance problem, and it puts knowledge of modules
inside the asset taxonomy, where it does not belong.

**Invert it: each module declares what it requires; the engine resolves.**

```ts
interface EvidenceModule<TOut> {
  id: string;
  requires: CapabilityKey[];      // e.g. ["ohlcv"] or ["ohlcv", "funding"]
  compute(ctx: ResearchContext): TOut | null;
}

// The engine decides availability. No asset class knows any module exists.
const applicable = modules.filter((m) =>
  m.requires.every((k) => source.hasCapability(instrument.id, k))
);
```

Now adding a module is a **single-file, zero-touch** change, and the brief's
requirement — "the decision engine should automatically ignore unavailable
modules instead of requiring special cases" — falls out of the filter rather
than needing per-class special cases.

### 3.2 Taxonomy

`AssetClass` should stay deliberately coarse — `crypto | equity | equity-etf |
index | bond | commodity | fx`. It exists only to carry defaults (session
model, cost model, typical volatility). It must **not** gate evidence; that is
the capability system's job. Style boxes like "growth"/"value" are *attributes*
for cross-sectional grouping, not classes.

---

## 4. Module review — universal vs asset-specific

Direct answer to deliverable 6, by inspection of actual dependencies:

### Universal today (pure OHLCV math — portable unchanged)

`indicators.ts` · `marketStructure.ts` · `harmonics.ts` · `divergence.ts` ·
`regimeModel.ts` · `metrics.ts` · `overlap.ts` · `multipleTesting.ts` ·
`tradeStats.ts` · `walkForward.ts` · `similarity.ts`

These read only price series. They are already asset-agnostic and constitute
the bulk of the intellectual value in the repo.

### Universal logic, crypto-calibrated constants (portable, must re-derive)

`swingThesis.ts` · `technicals.ts` (`buildTechnicalRead` vote weights) ·
`entryQuality.ts` · `plannedSetup.ts` · `tradePlan.ts` · `regimes.ts`

The *logic* transfers; the *numbers* do not. Crypto's daily volatility is
roughly 3-5x an equity index's, so every ATR multiple, percentile band and
activation threshold is implicitly crypto-scaled. Each needs re-derivation
per asset class — which is exactly why thresholds should be expressed in
volatility-relative units (ATR multiples, percentiles) rather than absolutes.
Most already are; that work pays off here.

### Genuinely asset-specific

**Crypto-only:** funding · open interest · liquidations · long/short ratio ·
basis · squeeze · on-chain flows · stablecoin supply · Deribit options.
**Equity-only (future):** earnings · sector rotation · breadth · short
interest · options flow.

### Needs a per-class implementation

`execution.ts` — the gap problem from §1c. `costs.ts` — funding vs
borrow/dividends.

---

## 5. The mandatory research pipeline

The brief asks that nothing bypass this again. Making it a *convention* will
fail; it should be a **type-level obligation**.

```ts
interface ResearchStudy<TResult> {
  hypothesis: string;              // written before results exist
  preRegisteredAt: string;
  falsificationCriterion: string;  // what result would kill it
  blockLength(horizonDays: number): number;   // forces overlap awareness
  run(ctx: ResearchContext): TResult;
}
```

A study cannot be constructed without stating its hypothesis and its own
falsification criterion. The harness then applies, uniformly and without the
author's involvement:

1. **Point-in-time validation** — truncation test, must be byte-identical
2. **Overlap correction** — `blockBootstrapProportion`, block length from the study
3. **Walk-forward** — sequential folds
4. **Out-of-sample** — chronological holdout
5. **Multiple-testing correction** — BH across the study's whole family
6. **Power reporting** — detectable effect printed next to every null

Step 6 is not optional decoration. Three phases produced "no effect found"
where the truthful statement was "no effect *findable*", and only reporting
the detectable floor alongside the p-value makes that distinction unavoidable.

---

## 6. Sequencing

Ordered by power gained per unit of work, not by architectural tidiness:

| # | Step | Why here |
|---|---|---|
| 1 | `MarketDataSource` + `Bar` + `SessionModel` interfaces | Everything else depends on it |
| 2 | Adapt existing crypto loader behind that interface | Proves the abstraction against a known-good dataset before new data lands |
| 3 | Ingest 11 sector SPDRs + 5 indices, 25y daily | **Biggest single power jump.** Free, clean, survivorship-safe |
| 4 | Gap-aware `execution.ts` | Must precede any equity result being believed |
| 5 | Re-derive thresholds per asset class | Crypto constants are meaningless on SPY |
| 6 | Add bonds / commodities / FX | Drops ρ; where the compounding is |
| 7 | `ResearchStudy` harness | Codifies the pipeline |
| 8 | Re-run weekly / harmonic / regime studies | The payoff — three unresolved questions become answerable |

Steps 1-3 alone take the detectable effect from ~15pp to roughly 6pp.

---

## 7. Recommendation summary

1. **Do not scale the crypto universe.** Measured ρ = 0.82 caps it at 1.22
   effective assets; 90% of that is already banked.
2. **Target ρ, not ticker count.** ~40 instruments across six asset classes.
3. **Build OHLCV + one extension point**, not nine speculative schemas.
4. **Invert the capability declaration** so modules declare requirements.
5. **Treat the equity gap model as a correctness bug**, not a refinement — it
   is the one item here that silently inflates results.
6. **Encode the research pipeline in types**, since convention already failed
   once.
7. **Prefer history over breadth.** A single instrument with 25 years of data
   resolves a 10pp effect better than today's entire two-asset, four-year
   universe.
