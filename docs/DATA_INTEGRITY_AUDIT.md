# Data Integrity Audit — Asset Dossier Pages

**Date:** 2026-08-14
**Scope:** `/asset/{IREN,HUT,CIFR,WULF}` — rendered output cross-checked against an
independent market-data source.
**Method:** Page values compared against 64 sessions of split-adjusted daily OHLCV
(2026-05-14 → 2026-08-14) pulled from Robinhood's trading API, plus same-day
fundamentals and quotes. Indicators recomputed from scratch in a separate runtime.

This is an external correctness check, not a code review. Findings are ordered by
confidence: **CONFIRMED** (reproduced against independent data), **LIKELY** (code path
identified, needs a live payload to prove), **VERIFY** (discrepancy observed, could be
methodology rather than defect).

---

## 0. What validated correctly — do not "fix" these

The volatility engine is **exact** — specifically the one feeding the *narrative* copy.
ATR on every ticker matched an independent recompute to the displayed precision:

| Ticker | Page (narrative) | Independent recompute | Delta |
|---|---|---|---|
| IREN | 9.60% | 9.60% | 0.00pp |
| HUT | 12.80% | 12.80% | 0.00pp |
| CIFR | 14.93% | 14.93% | 0.00pp |
| WULF | 9.47% | 9.46% | 0.01pp |

**Important:** this validates only the narrative path. A second, different typical-move
value feeds stop sizing on every page and does *not* reconcile — see §5. Route the
stop-sizing path into this engine; do not assume "the ATR is fine" globally.

Spot prices, market caps, 52-week range positions, and daily volume all reconcile.
Trend direction (below 20/50/200) is correct on HUT, CIFR, and WULF.

Per the charter's "single source of truth" rule, this engine is the one to route
other consumers through — it is the most trustworthy component measured here.

---

## 1. CONFIRMED — Analyst count and ratings breakdown never reconcile

**Severity:** High. Visible on every equity dossier; the numbers are self-evidently
wrong to any reader.

### Observed

| Ticker | Stated count | Breakdown shown | Breakdown sums to |
|---|---|---|---|
| IREN | 8 analysts | 7 buy · 3 hold · 0 sell | 10 |
| WULF | 5 total | 15 buy · 0 hold · 0 sell | 15 |
| CIFR | 7 analysts | 10 buy · 0 hold · 0 sell | 10 |
| HUT | 4 analysts | 15 buy · 0 hold · 0 sell | 15 |

Four for four. Never off by a rounding error — off by 2×–4×.

### Root cause

`src/lib/dossier/providers/nasdaqStreet.ts:67-71`

```ts
const buy  = o.buy  ?? 0;
const hold = o.hold ?? 0;
const sell = o.sell ?? 0;
const analysts =
  Number(ratings?.ratingsSummary?.match(/(\d+)\s+analysts/)?.[1] ?? NaN) || buy + hold + sell;
```

`buy/hold/sell` come from `o` — the `consensusOverview` block of
**`analyst/{symbol}/targetprice`** (line 177). `analysts` is regex-scraped from the
`ratingsSummary` string of a **different endpoint**, `analyst/{symbol}/ratings`
(line 176).

Those two Nasdaq endpoints describe different populations: the target-price endpoint
counts analysts who published a *price target*; the ratings endpoint counts analysts
who published a *rating*. They also refresh on different cadences. There is no reason
for them to agree, and empirically they never do.

The `|| buy + hold + sell` fallback only fires when the regex misses, so the
self-consistent path is the one that almost never runs.

### Fix

Pick one source and derive everything from it. Preferred: use the ratings endpoint's
own buy/hold/sell distribution if it exposes one, so count and breakdown are
structurally guaranteed to agree. Otherwise drop the scraped `analysts` figure and
render `buy + hold + sell` as the count.

Whatever is chosen, the invariant must hold: **the displayed count equals the sum of
the displayed breakdown.** Do not paper over it by hiding one number.

Also note the regex is scraping prose from an upstream API — that is fragile
independent of this bug. If the sentence wording changes, the count silently falls
back to a different definition with no error surfaced.

### Acceptance test

Add to `src/lib/dossier/providers/` tests: for a fixture payload where the two
endpoints disagree, assert `consensus.analysts === buy + hold + sell`. Cover the case
where `ratingsSummary` is absent entirely.

---

## 2. LIKELY — ATM implied volatility mixes expirations

**Severity:** Medium-high. Produces implausible headline numbers and corrupts the
IV-vs-realised narrative.

### Observed

| Ticker | Page "implied move (ATM IV)" | Realised annualised vol (independent) | Ratio |
|---|---|---|---|
| IREN | 272% | 125% | 2.2× |
| WULF | 216% | 92% | 2.3× |
| CIFR | 300% | 127% | 2.4× |
| HUT | 299% | 102% | 2.9× |

IV running 2–3× realised on four names simultaneously is not a market condition —
typical IV/RV is 1.0–1.3×, and these are already high-volatility names where the ratio
should be *closer* to 1, not further. CIFR at 300% and HUT at 299% sitting a point
apart also looks like a boundary artifact.

### Root cause

`src/lib/dossier/providers/optionsIntelligence.ts:170-175`

```ts
export function atmIv(rows: TradierOptionRow[], spot: number): number | null {
  const near = rows.filter((r) => Math.abs(r.strike - spot) / spot <= 0.05 && r.iv !== null && r.iv > 0);
  if (near.length < 2) return null;
  const mean = near.reduce((s, r) => s + (r.iv ?? 0), 0) / near.length;
  return mean < 3 ? mean * 100 : mean;
}
```

The filter constrains **strike distance only**. There is no expiration filter, so every
expiry in `rows` — front-week, monthly, and Jan-2027/Jan-2028 LEAPS — is averaged into
one mean. Short-dated ATM IV on these names runs far above the term structure's long
end, so an unweighted mean across all expiries is dominated by whichever expiries
happen to be most numerous in the chain, not by any meaningful tenor.

The strike concentrations already surfaced on these pages confirm the chains span wide
tenors: WULF shows 2026-08-21 strikes, CIFR shows Aug 2026 *and* Jan 2027 *and*
Jan 2028 in the same list.

Secondary concern, same function: `return mean < 3 ? mean * 100 : mean;` is a
decimal-vs-percent heuristic. It is correct for ordinary equities, but a genuine IV of
250% arrives as `2.5` and a genuine IV of 250 arrives as `250` — both map correctly
today, yet the threshold sits inside the range these specific names actually trade at.
Prefer normalising at the provider boundary where the unit is known, rather than
guessing downstream. Note `skew()` at line 195 defines its own local `norm()` with the
same `< 3` rule — that is duplicated unit logic and a second source of truth.

### Fix

Filter to a single target tenor before averaging — nearest expiry ≥ N days out (28–30
is conventional), or interpolate between the two bracketing expiries to a constant
30-day tenor. Surface the tenor used in the UI copy, since "implied move" is
meaningless without it.

Normalise IV units once, in the Tradier adapter, and delete the `< 3` heuristics from
both `atmIv` and `skew`.

### Acceptance test

Fixture chain containing one 7-day expiry at 300% IV and one 400-day expiry at 90%.
Assert `atmIv` returns the tenor-selected value, not ~195%.

---

## 3. LIKELY — Two different open-interest aggregates, one label

**Severity:** Medium. The page contradicts itself in a way a reader will notice.

### Observed

- **CIFR:** "Open Interest: 1,348 contracts" — then lists `$30 calls: 49,937 contracts`.
- **HUT:** "Open Interest: 1,928 contracts" — then lists `$150 calls: 18,595 contracts`.

A single strike cannot exceed the whole chain's open interest.

### Root cause

Two separate aggregates exist and only one is chain-wide:

- `optionsIntelligence.ts:152` — `const oi = near.reduce(...)` inside the **liquidity
  scorer**, scoped to strikes within 10% of spot (line 141). Intended as a scoring
  input, not a display value.
- `optionsIntelligence.ts:324-325` — `callOi` / `putOi` reduced over `all`, genuinely
  chain-wide.

The rendered figure is small enough to be the `near`-scoped number (or a single
expiry's) surfaced under a chain-wide label.

**Action:** trace what `DossierSections.tsx` / `PositioningIntelligence.tsx` actually
bind to and confirm which of these reaches the page. If it is the line-152 value,
either relabel it precisely ("open interest within 10% of spot") or bind to
`callOi + putOi`.

This is the charter's "quietly computing its own competing opinion" defect — two
aggregates, one name.

### Acceptance test

Invariant test: rendered total OI ≥ `max(strike OI)` across the displayed
concentration list. This one assertion catches the whole class.

---

## 4. CONFIRMED — CIFR support/resistance is degenerate

**Severity:** Medium. The levels are unusable, and the page presents them as if they
were actionable.

### Observed (CIFR at $17.85)

- "Nearest Support: **$7.10** (60.2% below; 4.3 daily ranges away)"
- "No mapped resistance overhead; last structural level cleared"
- "Last Resistance Tested: **$15.38–$25.56**" (strength 98/100, 21 reactions)
- "Last Support Level: **$11.01–$18.65**" (strength 99/100, 21 reactions)

Three problems:

1. The two zones **overlap** ($15.38–$18.65 is inside both) and both **straddle spot**.
   A level that contains the current price is not a level.
2. The support zone spans $11.01–$18.65 — **70% of the share price**. A band that wide
   carries no information.
3. Nearest actionable support 60% below spot, with nothing overhead, means the
   structure detector found nothing usable but the UI still rendered a levels section.

Compare WULF, where the same engine produces tight, sane zones ($16.01–$16.55,
strength 44, 2 reactions). So this is CIFR-specific — most likely the clustering step
merging too aggressively when a name has many reactions (21 here vs 2 for WULF), or a
lookback that spans CIFR's full 4.91→30.14 52-week range and treats the entire thing
as one zone.

### Fix

Cap zone width as a fraction of spot (or in ATR units — the ATR engine is reliable, use
it) and reject zones containing spot. When nothing survives, render an explicit "no
usable structure" state rather than degenerate numbers. The engine already knows how to
say "this is a finding rather than a failure" elsewhere — do that here.

---

## 5. CONFIRMED — Two competing "typical daily move" values on every page, and the one used for stop sizing is the unvalidated one

**Severity: High.** Initially logged as a CIFR-only cosmetic issue. Automated checking
across all four tickers shows it is systemic, and that the divergent figure is the one
driving risk advice.

### Observed

Each page renders the quantity twice, from two different computations:

| Ticker | Narrative — "typically moves X% in a day" | Stop sizing — "Typical daily move · X% of price" | Delta |
|---|---|---|---|
| IREN | 9.60% | 9.21% | 0.39pp |
| HUT | 12.80% | 12.15% | 0.65pp |
| CIFR | 14.93% | 14.04% | 0.89pp |
| WULF | 9.47% | 9.77% | 0.30pp |

Note WULF diverges in the *opposite* direction, so this is not a constant offset or a
rounding convention — they are genuinely separate calculations.

### Why this is high severity, not cosmetic

The **narrative** figure is the one that validated exactly against independent data
(§0 — all four matched to 0.00–0.01pp). The **stop-sizing** figure is the one that did
not, and it is attached to this copy:

> "Typical daily move · 9.21% of price. A stop closer than that would be hit by
> ordinary moves."

So the number the product uses to tell a user where to put a stop is the one that
does not reconcile with reality, while the validated number is used only for prose.
On CIFR the gap is 0.89pp against a ~15% ATR — a stop placed on the wrong figure sits
roughly 6% tighter in relative terms than intended.

### Fix

Find both call sites and route the stop-sizing path through the validated ATR engine.
Per the charter: one calculation, one source of truth. Do not reconcile them by
adjusting tolerances — delete one.

### Acceptance test

Assert the two rendered values are byte-identical, not merely close. Covered
automatically by `crossvalidate.py` → "single typical-move value".

---

## 6. VERIFY — IREN moving-average claim disagrees with independent recompute

**Not yet confirmed as a defect. Needs checking against the app's own bar history
before any code change.**

The IREN page states: *"Trading above 20, 50, and 200-day moving averages."*

Independent recompute over 64 sessions, IREN last = $44.03:

| | Value | Verdict |
|---|---|---|
| SMA20 | 39.23 | above ✓ |
| SMA50 | 44.89 | **below** |
| EMA20 | 40.65 | above ✓ |
| EMA50 | 45.87 | **below** |

Both conventions put price below the 50-period average. The other three tickers'
MA claims all verified correct, so this is not a broken function.

**Caveat that must be resolved first:** `indicators.ts:44` seeds EMA with the SMA of
the first `period` values, and `okxCandles.ts:14` notes the app fetches 200+ bars. The
recompute above had only 64 bars, so its EMA50 ran just 14 iterations past seed — not
equivalent to the app's. A longer history could legitimately produce a different answer.

**Action:** log the app's own EMA20/50/200 for IREN and compare. If the app also
computes below-EMA50, the defect is in the narrative layer (`technicalDimensions.ts:89`,
`types/market.ts:573`) rather than the indicator. If it computes above, this entry
closes as a methodology difference, not a bug.

---

## 7. Low priority — earnings-date coverage is inconsistent

IREN surfaces a concrete next-earnings date (2026-08-27). HUT, CIFR, and WULF all
render variants of "no report known inside the veto window" / "not explicitly stated."

Three sector peers with no known earnings date, while the fourth has one, suggests the
`analyst/{symbol}/earnings-date` call (`nasdaqStreet.ts:180`) is failing or returning
empty for some symbols and the UI is rendering that absence as a positive finding —
"✅ No earnings in holding period" on the WULF page is an affirmative check that passed
because data was *missing*.

Missing data must not satisfy a safety check. Distinguish "confirmed no earnings in
window" from "earnings date unknown," and fail the check closed on unknown.

---

## Suggested order

1. **#5 typical-move split** — the product's stop-placement advice runs on the
   unvalidated of two competing figures. Highest real-world consequence.
2. **#7 earnings-unknown check** — safety-relevant: a missing date currently passes a
   gate that exists to protect a position.
3. **#1 analyst counts** — highest visibility, smallest fix, fully diagnosed.
4. **#3 open-interest label** — one invariant test covers it.
5. **#2 IV tenor** — most involved; corrupts a headline number and its narrative.
6. **#4 CIFR levels** — user-visible nonsense on one symbol.
7. **#6 IREN MA** — investigate before touching code.

---

## Automated regression suite

`crossvalidate.py` reproduces this audit on demand. It splits checks into **internal**
(the page contradicting itself — no external data needed, safe for CI) and **external**
(the page vs an independent Robinhood OHLCV snapshot in `bars.json`).

```
python3 crossvalidate.py                    # all tickers
python3 crossvalidate.py IREN WULF          # subset
python3 crossvalidate.py --base http://localhost:3000
```

Exit code 1 on any failure, so it can gate a deploy. Current run: **32 checks,
11 pass, 17 fail, 3 warn, 1 skip.**

Two deliberate design choices worth preserving if this moves into the repo:

- **A missing pattern reports SKIP, never PASS.** If page copy changes, the check
  announces that it could no longer find what it was measuring rather than silently
  going green. The HUT MA check currently SKIPs for exactly this reason — that page
  uses different phrasing.
- **The MA check downgrades to WARN below 200 bars.** Our SMA50 and EMA50 come from
  the same short snapshot, so their agreement is one piece of evidence, not two. It
  will only assert FAIL once `bars.json` is deep enough to converge an EMA the way
  the app does.

`bars.json` cannot be refreshed by the script — it has no Robinhood credentials.
Regenerate it from the MCP tools; the script warns when the snapshot is over 5 days old.

---

## Note on the verdict engine

All four pages returned "no trade" (setup quality 1–3 of 9), and the pages label their
own forward record honestly: predictions registered from 2026-08-12, none through the
10-session scoring window, aggregate data quality 25–39% ("thin"), every number flagged
as hypothesis rather than track record.

That self-labeling is good practice and should be preserved as the forward record
accumulates. The backtested figure quoted on the long setups — 25% win rate, −1.7%
median across 14,957 comparable trades — is in-sample and should keep carrying that
caveat prominently until forward results exist to compare against. It currently does.
