# Universe Expansion — Evidence Report

Companion to `docs/UNIVERSE_POWER.md` (the measurements) and
`docs/CROSS_ASSET_PROOF.md` (the architecture proof). Answers the questions
the phase brief asked, using measured numbers only.

---

## What was ingested

**19 of 25 registered instruments passed validation and were written.**

| Class | Instruments | Mean pairwise ρ (within) |
|---|---|---|
| Equity ETFs | SPY, QQQ, DIA, IWM, VTI, XLF | **0.87** |
| Bonds & credit | TLT, IEF, SHY, TIP, LQD, HYG | 0.44 |
| Commodities | GLD, SLV, USO, DBA | 0.33 |
| Crypto spot | SOL, BNB, XRP | 0.48 |

Cross-class correlation is where the value is:

| | bond | commodity | crypto | equity |
|---|---|---|---|---|
| **bond** | 0.44 | 0.07 | 0.06 | **−0.01** |
| **commodity** | 0.07 | 0.33 | 0.08 | 0.20 |
| **crypto** | 0.06 | 0.08 | 0.48 | 0.24 |
| **equity** | −0.01 | 0.20 | 0.24 | 0.87 |

Bonds are essentially **uncorrelated with equities (−0.01)**, exactly as the
Phase 7 planning analysis predicted. That is where the independent
information came from.

---

## 1. How much has detectable effect size improved?

| Universe | Effective N | Detectable effect (5-session mean return) |
|---|---|---|
| Crypto only | 1,446 | 1.039% |
| + equity indices | 4,211 | 0.306% |
| + Treasuries & credit | 7,451 | 0.179% |
| **Full (19 instruments)** | **8,473** | **0.157%** |

**6.6× improvement in resolution.** The engine can now distinguish effects
roughly one-sixth the size it could before.

## 2. How much has effective sample size increased?

**5.86×** — 1,446 to 8,473. Note the raw count rose 9.6× (8,693 → 83,509),
so even here the correlation discount is doing real work: `n_eff/n` falls
from 0.166 to 0.101 as more correlated instruments join.

## 3. The surprising result — equity indices contribute ~nothing at the margin

Marginal contribution measured by deletion (effective N of the full universe
minus effective N without that class):

| Class removed | Instruments | Information lost |
|---|---|---|
| Crypto | 3 | **3,362 (39.7%)** |
| Bonds & credit | 6 | **2,396 (28.3%)** |
| Commodities | 4 | **1,022 (12.1%)** |
| **Equity indices** | **6** | **−38 (−0.5%)** |

Deleting all six equity ETFs costs nothing measurable. At ρ = 0.87 internally
they behave as a single factor, and that factor is already partly spanned by
crypto (0.24) and commodities (0.20).

**This does not mean equities were pointless** — the tier table shows they
took the universe from 1,446 to 4,211 when added to crypto alone. It means
equities and (bonds + commodities) are substitutes rather than complements.
Marginal contributions are order-dependent and do not sum to 100% (they sum
to ~80%), which is the usual Shapley caveat and is stated rather than hidden.

**Direct consequence:** adding the remaining sector SPDRs would add
approximately zero. The brief's instruction to defer them was correct, and
this measurement is the reason to keep deferring them permanently rather than
revisiting later.

## 4. What is now testable that previously was not

At ~0.157% detectable effect on 5-session returns, hypotheses expressible as
**panel statistics over price data** are now well powered:

- Regime-conditional return behaviour (the Phase 7 efficiency question, which
  died at 3.5-day dwell on 354 observations)
- Cross-asset trend persistence and its decay
- Volatility-state conditioning
- Seasonality and calendar effects
- Any two-arm comparison where the arms are defined by price-derived features

## 5. Which previous conclusions should be re-tested — and an important caveat

**The caveat first, because it changes the answer.** The expanded universe
contains **price data only**. It contains no trades, no swing theses, no
harmonic PRZs and no entry plans. Every prior conclusion in the list below
was about *the engine's behaviour*, not about price. Re-testing them requires
**replaying the decision engine over the new instruments** — which the
architecture now supports (every module is asset-agnostic and the proof
document demonstrates it) but which has not been done.

So the honest status is *"now re-testable"*, not *"now re-tested"*.

| Component | Re-testable? | What it needs |
|---|---|---|
| **Harmonic PRZ** | Yes, and highest value | `harmonics.ts` is pure geometry and already universal. Replay it on 19 instruments. The Phase 8 verdict was D on 27–47 effective observations at 30 days; this universe should resolve it properly. |
| **Weekly regime** | Yes | Weekly rollup works on any bar series. The Phase 6 study died on 438 independent trades; equities add 30+ years of weekly history. |
| **Trend persistence** | Yes, immediately | Pure price statistic — needs no engine replay at all. The best first study on the new universe. |
| **Pullback quality** | Partially | Needs S/R zones, which are universal, but thresholds are ATR-relative and crypto-calibrated. |
| **Entry quality** | Needs recalibration first | Star thresholds were fit to crypto volatility. Re-deriving them per asset class is itself a study. |
| **Swing engine calibration** | Needs recalibration first | Same issue — activation thresholds are crypto-scaled. |
| **Risk/reward calibration** | Needs the gap model | Equity stops gap overnight. `src/lib/research/execution.ts` handles this; `scripts/backtest/execution.ts` (still used by the legacy replay) does not. **Resolve that before trusting any equity R:R number.** |

## 6. Rejected data — FX

**All six FX pairs were refused and none were written.**

Yahoo's FX OHLC is not internally consistent: 2.73% of raw AUDUSD bars have a
close outside their own [low, high] range, and USDJPY has 2,108 such bars.
Verified against the **untransformed** vendor response, so this is not an
artefact of the adjustment or timestamp handling.

The high/low evidently come from a different snapshot window than the close.
Any range-based feature — ATR, efficiency ratio, S/R zones, harmonic geometry
— computed on this would be silently wrong.

FX remains registered in the universe (the configuration is correct) and
ingestion refuses it every run, which is loud and self-documenting. **FX
requires a different provider**, and given bonds already deliver the
uncorrelated information FX was wanted for, this is not urgent.

## 7. Assumptions and remaining risks

- **Survivorship is untested.** All 19 instruments are survivors. The
  machinery exists (`delistedT`, listing-window validation, a passing test for
  a delisted instrument) but has never met a real dead instrument.
- **Single-vendor adjustment.** Yahoo's split/dividend adjustment is trusted
  without cross-vendor verification.
- **BTC/ETH perps are not in this measurement.** They live in the legacy
  backtest store, so "crypto" above means SOL/BNB/XRP spot only. Including
  the perps would raise raw counts but add little — they correlate ~0.8+ with
  the spot names.
- **Marginal contributions are order-dependent** and sum to ~80%, not 100%.
- **The 2008 start date** was chosen so all classes share a window; it
  discards SPY history back to 1993 for the comparison tables only, not from
  the stored data.

## 8. Recommended next step

**Replay the decision engine over the expanded universe**, starting with
trend persistence (pure price, needs no replay) and then harmonic PRZ (the
highest-value unresolved verdict). Before any equity risk/reward number is
believed, migrate the legacy replay onto the gap-aware execution model.

Do **not** add sector SPDRs. The measurement says they are worth
approximately zero.
