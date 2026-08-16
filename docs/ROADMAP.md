# THE EDGE ROADMAP — the standing plan

The single objective: the highest-signal, statistically defensible trading
intelligence platform for crypto and traditional markets. Optimized for
measurable edge, not elegance.

This document is the plan of record. Every session works the earliest phase
with unmet exit criteria unless the user explicitly redirects. Phases are
sequential because each depends on the one before it — the ordering is the
content.

**Where capabilities land is not negotiable per-phase.** Every phase below
delivers its work as dossier modules, under the contract in
`DOSSIER_ARCHITECTURE.md`. A phase that produces a new page has been built
wrong regardless of how good its statistics are.

Grounding facts that produced this ordering (do not re-litigate without new
data):

- The platform's own census shows most directional technical signals sit
  within noise of 50% (market structure 49% @24h n=1762; funding, the
  heaviest-weighted metric, has n=33). Individual indicators are NOT where
  the edge is.
- The only 70%+ cells ever measured here were CONDITIONAL COMBINATIONS
  (funding+OI+structure @7d, overlap-uncorrected, small n — promising,
  unproven).
- Equity edge lives in EVENTS and CROSS-SECTIONAL selection (earnings,
  insiders, revisions, momentum). Crypto edge lives in FLOWS and POSITIONING
  (funding, basis, liquidations). Build asymmetrically.
- The moat is the AUDIT: every signal shipping with an overlap-corrected,
  out-of-sample, public track record — including failures. Competitors sell
  indicators; we sell the audit.

## Standing rules (apply to every phase)

1. **The validation factory is a hard gate.** Every new signal: register in
   `hypothesis.ts` BEFORE the first backtest run → point-in-time replay →
   overlap-corrected significance (block bootstrap, effective n) → FDR across
   the quarter's candidate family → walk-forward OOS → ships as Edge only if
   the Wilson lower bound clears 50% + costs (or EV > 0 at the lower bound).
   Failures ship too — as published negative results. Kill criteria are
   written at birth; demotion to State is automatic when trailing OOS
   significance dies.
2. **State never votes.** State describes, conditions, gates and scales.
   Only Edge modules contribute direction.
3. **No silent repairs; invalid data fails loudly.** The ingest validator's
   refusals are correct by default — fix declarations, never loosen checks.
4. **Deploy discipline** (see memory): `npm run build` before claiming done;
   push at session end; verify production by CONTENT (positive grep for new
   output + negative grep for the wrong surface). "Local" and "live" are
   different words.
5. **Never build:** Elliott Wave, order blocks/FVG as doctrine, harmonics
   expansion, more oscillators, social sentiment, real-time tick/L2 infra,
   options pricing models, unofficial brokerage clients. (One exception:
   Phase 7 contains a single falsifiable liquidity-sweep research sprint,
   published either way.)

---

## PHASE 0 — The Spine: automation + memory  ← START HERE

**Why first:** everything downstream — "since when", event studies,
calibration, the public track record — requires data that is CURRENT and
PERSISTED. Today both snapshots are hand-built; miss two days and the site
silently lies about being an intelligence terminal. Smallest effort of any
item with multiplier value.

Tasks:
1. **GitHub Actions daily cron**: ingest (yahoo needs no secrets; crypto
   fetch needs `COINALYZE_API_KEY` + `FRED_API_KEY` as repo secrets) →
   validate → `buildIntelligence` + `buildMarketsSnapshot` → commit → push
   (Vercel auto-deploys). Refusals fail the job loudly.
2. **Freshness SLA in the UI**: every snapshot-fed page computes staleness;
   > 36h renders a red banner. The terminal must never look live when it
   is not.
3. **Signal history ledger**: each daily run appends the day's regime read,
   rotation states, industry breadth, and equity verdicts to an append-only
   committed store (`src/data/history/`). Committed daily = point-in-time by
   construction, with git provenance.
4. **Delete `/options`** (an internal README leaking into production).

Exit criteria: 5 consecutive green automated runs; staleness banner verified
by faking an old snapshot; ledger accumulating; `/options` gone from prod.

## PHASE 1 — Engine truthfulness: State/Edge/Risk/Execution + event guard

**Why second:** reclassification changes what every later signal is measured
against, so it must precede the signal wave. The event guard is the cheapest
loss-avoidance on the list and is disqualifying to lack.

Tasks:
1. Reclassify: market structure, breadth, vol regime, trend quality,
   Fear&Greed (or delete), dominance → **State** (stop voting). Funding,
   squeeze, basis, ETF flows, stablecoins remain **Edge**. Measure the full
   replay delta and publish it, as with every prior engine change.
2. **Risk axis**: event proximity, vol regime, leverage/liquidation heat —
   scales size and vetoes, never directs.
3. **Earnings calendar ingest** (free API) + hard planner veto: no new equity
   plan within 3 sessions of that name's earnings; existing plans flagged.
4. Unify confidence semantics (one meaning: evidence quality of Edge
   modules). Regime-pair spread-confidence gets its own label.

Exit criteria: replay delta measured and published; a test proves no plan
generates through an earnings date; one confidence semantic site-wide.

## PHASE 1.5 — Productization: the dossier becomes the platform

**Why here, ahead of Phase 2:** adding another isolated research module now
creates less value than turning what is already built into a coherent product.
The evidence is not theoretical — the EDGAR catalyst feed shipped into
`/api/pretrade` and renders on zero pages; `/asset/[symbol]` redirected ETFs
away from the dossier entirely; crypto intelligence is reachable only from
`/crypto`. Those modules are not weak. They had nowhere to land.

The architecture is specified in `DOSSIER_ARCHITECTURE.md`, which governs this
phase and every phase after it. Read it before adding anything.

**What happens to Phase 0.** Its exit criteria remain UNMET and are not
waived — `daily-intelligence` has never once completed a green *scheduled*
run, and the signal ledger holds three entries. But its liveness work is
absorbed rather than deferred: the pipeline health surface lands as the
**Audit section of the dossier**, not as another page. Phase 0 closes when
five consecutive green automated runs are visible there.

Tasks:
1. **The interface**: `Section<T>` → `Read<T>`, gaining `evidence`
   (confidence / reasoning / provenance). `Provenance` is imported from the
   pre-trade contract, never redefined.
2. **Section/Module split**: fourteen named sections; today's twenty-one
   sections become modules registered against them, each declaring a
   non-empty `serves`.
3. **Five phases** mapped to the six questions the page answers, with
   `risk` promoted to sit directly under the Trading Plan.
4. **Land the orphans**: EDGAR catalysts into News & Catalysts; pipeline
   liveness into Audit. Both are already built and reach nobody.
5. **Canonical routing**: remove the ETF redirect. No symbol is routed away
   from the dossier. Legacy pages become discovery surfaces that link in, and
   are retired individually on parity — never in one migration.
6. Apply the four-way gate to every existing module; delete what fails it
   (`street` is the standing candidate).

Exit criteria: every module returns `Read<T>` with provenance; a test proves
`serves` is non-empty for all of them; searching any symbol — equity, ETF or
crypto — lands on the dossier; catalysts and liveness render in production;
no new page has been created.

## PHASE 2 — Memory becomes product: The Brief

Tasks:
1. **"Since when" everywhere** — regime shows duration + prior episodes from
   the ledger; rotation states show entry date; breadth shows trend.
2. **What-changed diffs at every level** (the ledger makes yesterday
   queryable — extend the scanner's change feed to regime/rotation/industry).
3. **The Brief** replaces `/`: state line + duration + overnight diffs; risk
   events today; ≤3 actionable items (Edge-qualified only — "Nothing
   qualifies today" is a proud conclusion); watchlist deltas. Current
   intelligence page moves one click down.
4. **Watchlist** (prerequisite for The Brief's row 4 and later portfolio
   risk).
5. **Evidence sparklines**: every claim carries its 120px ratio/level chart
   with the measurement window shaded — kills the 90-second TradingView exit.

Exit criteria: The Brief live as `/`; a regime flip in the ledger renders
duration + episode count; watchlist persists.

## PHASE 3 — Free-data positioning wave (the government-data arbitrage)

All through the validation factory; expect and publish failures.

1. **Form 4 insider cluster buying** (SEC EDGAR, free) — highest-confidence
   new Edge candidate.
2. **FINRA short interest + days-to-cover** (free, biweekly).
3. **FRED wave**: HY OAS credit spreads, VIX/VIX3M term structure, MOVE,
   DXY — regime/State modules, cheap and immediate.
4. **COT positioning extremes** (CFTC, free) — FX/commodities/BTC futures.
5. Cheap seasonality overlays registered and tested: pre-FOMC drift,
   turn-of-month. Ship only what survives.

Exit criteria: each module shipped as Edge or State or killed, with its
verdict published on a negative-results page.

## PHASE 4 — Universe: the engine finally gets something to chew

1. **S&P 500 constituent ingest** via the existing adapter (batched,
   rate-limited, same validate-refuse path).
2. **Real breadth internals** (% above 50/200dma, net highs-lows across 500
   names) replacing the 5-ETF proxy.
3. **Cross-sectional 12-1 momentum** ranking; **short-horizon (1–5d)
   reversal** — both documented anomalies, both need the universe.
4. Industry constituent lists widened to ~20 names each (fixes COPX-class
   "too few names" gaps); per-ticker stub pages so constituents stop being
   dead text.

Exit criteria: breadth computed from 500 names; momentum/reversal through the
factory; every industry ≥ 3 measurable constituents.

## PHASE 5 — Calibration + planner rebuilt on its own excursion data

1. **Calibrated probability layer**: score → empirical win rate with Wilson
   bounds, per regime. Replaces raw scores as the headline number site-wide.
2. **Planner v2**: stops from p80–p90 MAE of historical winners (reconciled
   with structure); targets from MFE distributions per regime; **time stops**
   from timeout statistics; **EV gating** (refuse plans with lower-bound
   EV ≤ 0); fixed-fractional vol-adjusted position sizing, scaled by regime
   and event proximity. Test scaling rules in-replay before shipping them.
3. **Level reaction-rate backtesting**: run every historical level type
   through `levelReached` → publish measured reaction rates per type and
   confluence count. Add prior-day/week/month H/L and mechanical anchored
   VWAPs (YTD, earnings, structure-found swings) to the stack; round numbers
   only if they clear baseline.

Exit criteria: every displayed probability carries a CI and n_eff; plans
show EV; each S/R level renders its measured reaction rate.

## PHASE 6 — Options layer + PEAD + the public audit

1. **Delayed options chains** (CBOE/vendor): IV rank, put/call per ticker.
2. **GEX regime** (positive → mean-reversion/pinning; negative → trend/vol
   expansion) as State; **gamma walls** into the S/R stack with reaction-rate
   measurement like every other level.
3. **PEAD module** (needs the earnings-surprise history Phase 1's calendar
   started accumulating).
4. **Shadow ledger goes public**: every published plan and Edge verdict
   recorded at publication and scored — the audited track record page,
   losses included.
5. **Alerts** (email): regime flips, rotation state changes, plan triggers,
   event proximity.

Exit criteria: GEX regime live with its validation verdict; track-record page
public; first alert delivered.

## PHASE 7 — Crypto flows + conditional edges

1. **Real exchange-netflow provider**; **MVRV/realized-price cycle
   percentile** (State/context).
2. **ETH/BTC + dominance rotation** through the existing rotation engine.
3. **Estimated liquidation clusters** as crypto levels (reaction-rate
   tested).
4. **Conditional-edge promotion**: re-validate the combination cells
   (funding+OI+structure class) with overlap correction and walk-forward on
   the now-larger history; survivors ship as first-class Edge modules — the
   platform's only measured 70%+ material.
5. The one ICT research sprint: do prior swing extremes get swept-then-
   reversed above chance? Register, test, publish either way. No vocabulary
   ships regardless.

Exit criteria: conditional edges published with corrected statistics;
negative-results page updated.

## PHASE 8+ — Scale the audit (the three-year direction)

Analyst revision momentum (first paid dataset — only once revenue or clear
need); 13F crowding; portfolio-aware Risk (correlation to the user's book);
themes as graphs across industries (only now — industries have history);
eventually the validated-signal layer as an API. Perpetual: quarterly
re-validation demotes decayed Edge modules automatically and publicly.

---

## Top-50 → phase map

P0: #1 2 6 · P1: #3 4 · P2: #17 18 23 33 · P3: #8 12 13 16 27 37 38 43 44 ·
P4: #7 28 29 30 31 · P5: #5 14 15 20 21 24 26 32 39 40 · P6: #9 10 11 22 25
36 41 48 · P7: #19 34 35 45 46 50 · P8+: #42 47 49.
