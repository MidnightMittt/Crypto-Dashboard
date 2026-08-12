# Evidence Module Migration — which modules are universal, and in what order

Phase 2 deliverable. Classifies every production evidence module by whether
it can serve a non-crypto asset, and sets the Phase 3 order on measured
evidence rather than on intuition.

The organising rule: **one decision engine, different evidence.** A module
belongs in the shared core only if the thing it measures exists in both
markets *and* is measured from inputs both markets supply.

---

## 1. Classification

| Module | Class | Basis |
|---|---|---|
| **Support / Resistance zones** | **Universal** | Pure OHLCV clustering. Already running on equity bars — the Markets trade plans are built from it. **Shipped.** |
| **Trade planning** (`buildTradePlan`) | **Universal** | Pure geometry over zones + ATR. **Shipped** for equities (SPY 1.81R, DIA 1.82R, IWM 1.73R). |
| **Entry quality** | **Universal, degraded** | Geometry ports cleanly, but one input — `historicalWinRatePct` — has no equity source. Currently passed as `null`. Honest but incomplete; see §3. |
| **Market structure** (higher highs/lows, volume profile) | **Universal** | OHLCV only. Not yet wired to equities. **Highest-value gap.** |
| **Trend** | **Universal** | Shipped for equities as `equityTrendQuality` (Kaufman efficiency). |
| **Momentum** (RSI, MACD) | **Universal** | OHLCV only. Trivially portable. Low marginal value — see §2. |
| **Volatility / ATR regime** | **Universal** | Shipped as `equityVolatilityRegime`. |
| **Divergence** (RSI/MACD vs price) | **Universal** | OHLCV only. Portable, but inherits the momentum caveat. |
| **Technical read** (composite vote) | **Universal** | Aggregates the above. Portable once its inputs are. |
| **Regime** (trend/vol/range tags) | **Universal** | OHLCV only. |
| **Swing thesis** (state machine) | **Needs adaptation** | Logic is asset-agnostic, but `statusForPrice` is **not gap-aware** — documented exception in `swingThesis.ts`. Must route through `levelReached` before serving a session market, or it will report stops honoured at levels the market never offered. **Blocking.** |
| **Harmonics** | **Universal — but see §2** | Geometry is pure price. Portable. Evidence for its value is weak. |
| **Breadth** | **Equity-native** | Shipped as `equityBreadth`. A crypto analogue exists (sector breadth) and already runs. |
| **Relative strength** | **Equity-native** | Shipped. Needs a benchmark; crypto's analogue is BTC-dominance, which exists separately. |
| **Risk appetite** (credit vs duration) | **Equity-native** | Shipped. Crypto's analogue is stablecoin flows. |
| **Funding** | **Crypto-only** | No equity instrument. |
| **Open interest** | **Crypto-only** | Equity OI exists in options, not in the underlying. Revisit under v1.1 options flow. |
| **Liquidations** | **Crypto-only** | No equity analogue. |
| **Basis / perp premium** | **Crypto-only** | Requires a perpetual. |
| **Stablecoin flows** | **Crypto-only** | Equity analogue is money-market fund flows — a different data source, not a port. |
| **On-chain** (exchange flows, network health) | **Crypto-only** | No analogue. |
| **Coinbase premium** | **Crypto-only** | Venue-specific. |

**Totals:** 11 universal, 3 equity-native (shipped), 7 crypto-only, 1 blocked
on adaptation.

---

## 2. Why the requested Phase 3 order should change

The brief sets the order: Harmonics → Market Structure → S/R → Swing Geometry
→ Divergence → Entry Quality → Trade Planning.

Three problems with that, all evidential rather than stylistic.

### Harmonics should not be first

The harmonic engine was graded **D** in this repository's own review, and the
overlap correction recorded its 30-day significance as **unproven** — that
result was computed from daily-overlapping windows treated as independent,
which the correction showed to be systematically optimistic.

Porting it first would spend the most effort on the module with the weakest
evidence, and would put a D-grade signal into a brand-new surface where a
user has no prior context to discount it. Harmonics should port *last* among
the universal set, and should be labelled with its grade wherever it appears.

### S/R and trade planning are already done

Both are live on the Markets pages. Listing them as items 3 and 7 of Phase 3
would schedule work that has shipped.

### Swing geometry is blocked, not merely pending

`swingThesis.statusForPrice` is gap-blind by documented exception. On a
session market it would report a stop honoured at the level when the market
actually reopened past it — an error that flatters results in one direction
and does not average out. This is a correctness prerequisite, not a porting
task, and it must be fixed before any swing state is shown for an equity.

### Momentum and divergence are low marginal value

Both are already inputs to the technical read for crypto. Adding them to
equities as *standalone evidence modules* would add two more metrics that
correlate heavily with trend quality, which the signal philosophy explicitly
warns against: "if it's highly correlated with an existing metric, merge it,
weight it, or remove it rather than adding it alongside."

---

## 3. Revised Phase 3 order

Ordered by decision value per unit of risk, given the above.

1. **Market structure for equities.** The single largest gap. It is what
   turns the Markets page from "five ratios" into a structural read, and it
   feeds S/R quality, which already ships. Pure OHLCV, no new data.
2. **Technical read composite for equities.** Aggregates structure, trend and
   volatility into one directional statement with a confirms/contradicts
   relationship to the composite — the element the crypto page has and the
   equity page visibly lacks.
3. **Fix `statusForPrice` gap-awareness.** Correctness prerequisite. Small,
   bounded, and unblocks everything swing-related for session markets.
4. **Swing thesis for equities.** Only after 3.
5. **Entry quality's missing input.** Either run the execution replay over
   equity bars to produce a real `historicalWinRatePct`, or keep it null and
   keep saying so. The former is a genuine research task; the latter is the
   honest status quo.
6. **Harmonics, labelled with its grade.** Last, and only if 1–5 are done.

Momentum and divergence are deliberately absent as standalone modules. They
enter through the technical read at step 2, where they are weighted rather
than counted twice.

---

## 4. The structural finding

Splitting the universe this way exposes something worth stating plainly.

**Crypto's evidence advantage is almost entirely in the crypto-only column.**
Eleven universal modules serve both markets; the eighteen-vs-five gap is made
of funding, OI, liquidations, basis, stablecoins and on-chain — six modules
with no equity analogue at all.

That has a consequence for the product: **equities will never reach crypto's
evidence count from the shared core.** Completing every universal module
takes equities from five to roughly nine, not eighteen. The remainder has to
come from equity-native sources — earnings, filings, analyst revisions,
valuation — which is exactly the v1.1 scope.

So the honest framing for the Markets surface is not "crypto parity pending"
but "a different evidence base, of a size set by what equities actually
publish." The confidence disparity is structural and permanent, not a
backlog item, and the UI should say so rather than imply it will close.
