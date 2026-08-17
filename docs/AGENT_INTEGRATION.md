# WIRING AN AGENT TO THIS SITE

For a program, not a browser. If you are reading the HTML pages you are doing
it wrong — copy changes have already broken a scraper here once, silently
degrading sixteen validation checks to SKIP while the run stayed green.

Base URL: `https://crypto-dashboard-65d9.vercel.app`

---

## 1. One call

```
GET /api/pretrade?symbols=APLD,IREN,MARA
```

Omit `symbols` for the whole scanner universe. Cap is 50 per call. No auth.

Everything an agent needs is in this response. The other routes
(`/api/positioning/{symbol}` for full history, `/api/health`,
`/api/market-data`) are for depth, not for the decision loop.

**Pin the schema.** The response carries `schema_version`, currently `"2.0"`.
Additive changes bump MINOR; a field removal or a change of meaning bumps
MAJOR. Refuse to trade on a MAJOR you have not read.

---

## 2. The envelope contract, and the one rule that matters

Every value is an object, never a bare number:

```json
{ "value": 3.21, "unit": "bp", "as_of": "2026-08-14T23:54:44.000Z",
  "source": "tradier_sandbox_quotes", "method": "top_of_book_snapshot_..." }
```

or

```json
{ "value": null, "reason": "no_spread_history" }
```

> **A null is an answer. It is never a zero.**
>
> `{"value": null, "reason": "no_spread_history"}` means the cost has not been
> measured. Coercing that to 0 turns "I do not know the cost" into "the cost
> is nothing", which is the single most expensive mistake available here.

Correct handling:

```python
def val(field, *, required=True):
    """Return the value, or raise/skip — never silently default."""
    if field.get("value") is None:
        if required:
            raise SkipSymbol(field["reason"])      # do not trade this one
        return None
    return field["value"]
```

`method` exists so two implementations can never disagree silently. A stale
reference file once reported two ATR checks as failures because it used a
simple mean where this site correctly uses Wilder smoothing, and neither side
declared which. If your number differs from ours, compare `method` first.

`as_of` is the instant the VALUE was true, never the time of the response.
That distinction is load-bearing — see §4.

---

## 3. What is ready right now, and what is still accruing

Measured live, 2026-08-17:

| field | state |
|---|---|
| `session.status` / `session.ends_at` | ready — Tradier clock |
| `tradability.book` | ready — bid/ask/sizes/spread_bp/**age_seconds** |
| `price.last` | ready — split-and-dividend-adjusted close |
| `volatility.typical_daily_move_pct` | ready — Wilder ATR-14 |
| `overnight.legs` | ready — 120 and 250-session windows |
| `market_exposure` | ready — beta, alpha, R², power |
| `positioning.*` | ready — gamma, gamma sign, short-sale volume share |
| `catalysts.filings_since_prior_close` | ready — EDGAR |
| `catalysts.earnings_detail` | often `symbol_not_covered` — see §4 |
| `net_edge` | **null** — `no_spread_history` |
| `execution.entry_window` / `exit_window` | **null** — `no_spread_history` |

`net_edge` is the field that decides a trade and it will stay null until the
spread recorder has 20 sessions in both windows. It is deliberately not
falling back to a modelled spread: Corwin-Schultz returns 114-177bp on these
names where the observed book is 2-8bp, so the fallback would be wrong by more
than an order of magnitude and confidently so.

---

## 4. Four traps, each of which has already bitten someone

**Beta before premium.** `overnight.legs` shows APLD at +54.6bp net. Read
alone that looks like an edge. `market_exposure` says beta 4.63 on overnight
SPY against a market that itself returned +6.36bp a night, so 29.5bp of it is
market exposure and the residual is not significant — 0 of 76 alphas across
the cohort clear FDR. **Ranking on realised premium is ranking on beta.**
Multiply `beta` by `proxy_net_bp` yourself; the payload will not interpret for
you.

**The book has an age.** `tradability.book.age_seconds` sits inside the value
so it cannot be separated from it. A weekend quote returns Friday's one-tick
book with nothing else marking it stale — 45 hours old in one measured case.
Sizing against a 3.2bp spread that old is pricing a market that no longer
exists. Also check `session.status`: `"closed"` means the book is a fossil.

**Earnings is three states, never a boolean.** `earnings_status` is
`confirmed_date` | `confirmed_none` | `lookup_failed`. `symbol_not_covered`
arrives as `lookup_failed` and means **we did not find out** — not "no
earnings". Treating it as clear is how a position gets held across a report.

**A null alpha is not zero alpha.** Every statistical row carries a
`detectable_*_at_t3_bp` figure: the smallest effect that test could have
called significant. APLD's alpha is 25.1bp and the detectable floor is 53.6bp,
so the test could never have seen the effect it found. Absence of evidence,
not evidence of absence.

---

## 5. Timing

- Cold: ~13s. The EDGAR sweep dominates — CIK lookup plus a submissions feed
  per symbol.
- Warm: ~130ms for two symbols, ~800ms for sixteen. EDGAR caches 300s.
- Call it **once** per decision cycle for all symbols, not per symbol. The
  Tradier clock and quotes are two requests regardless of symbol count.
- Do not poll faster than the data changes. Positioning and overnight are
  daily; the book is 15-minute delayed on the sandbox key.

---

## 6. What this payload will never contain

No score, no rating, no buy/sell language, no confidence number. A test
asserts their absence structurally, and that is deliberate: of the composite's
own voters a minority clear their own bar, and an unvalidated score sharing a
payload with a measured input invites the first overriding the second.

Verdicts, conviction and trade plans live on the HTML dossier at
`/asset/{SYMBOL}` for a human. **The agent gets facts and provenance and makes
its own decision.**

---

## 7. Portfolio context — the shape, when it lands

This site will not connect to a broker. Robinhood publishes no official API,
so any integration would be an unofficial client, which `ROADMAP.md` forbids,
and it would mean automating credentials.

The inverse works and needs neither: **the agent already holds its positions,
so it POSTs them and receives analysis.** No brokerage client, no credentials,
no scraped session. Given the beta finding, the interesting output is
portfolio-level exposure — four of these names is not a diversified basket, it
is roughly 4x levered SPY overnight with four names' worth of single-name risk
stacked on top.
