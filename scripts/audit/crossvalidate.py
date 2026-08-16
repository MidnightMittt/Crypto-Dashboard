#!/usr/bin/env python3
"""
Cross-validate the leverage-terminal dossier pages against independent market data.

Two classes of check:

  INTERNAL  — the page contradicting itself. Needs no external data, so these are
              always runnable and are the ones worth wiring into CI.
  EXTERNAL  — the page disagreeing with an independent source. Needs bars.json,
              a snapshot of Robinhood daily OHLCV. The script cannot refresh that
              itself (no Robinhood credentials here); regenerate it from the MCP
              tools and it will be picked up automatically.

Usage:
    python3 crossvalidate.py                 # all tickers in bars.json
    python3 crossvalidate.py IREN WULF       # subset
    python3 crossvalidate.py --base http://localhost:3000

Exit code 1 if any check FAILs, so this can gate a deploy.
"""

import json, math, os, re, sys, urllib.request, urllib.error
from datetime import date, datetime

BASE = "https://crypto-dashboard-qvs6.vercel.app"
HERE = os.path.dirname(os.path.abspath(__file__))
BARS = os.path.join(HERE, "bars.json")

# How far the page may drift from the independent recompute before it's a failure.
TOL_PRICE_PCT = 0.5    # spot price, percent
TOL_ATR_PP    = 0.5    # ATR, percentage points
IV_RV_MAX     = 1.8    # implied/realised ratio above this is implausible
ZONE_MAX_PCT  = 25.0   # a support/resistance band wider than this % of spot is not a level
BARS_MAX_AGE  = 5      # days before the reference snapshot is considered stale

# ─────────────────────────── extraction ───────────────────────────
# Patterns match the server-rendered RSC payload. If the copy changes these go
# SKIP rather than silently passing — a missing pattern is reported, never assumed OK.

PATTERNS = {
    "price":        r'font-mono text-sm text-ink">\$(\d+\.\d+)<',
    "move_a":       r'typically moves (\d+\.\d+)% in a day',
    "move_b":       r'Typical daily move · </span>(\d+\.\d+)% of price',
    # Copy drifted 2026-08: "analysts average" -> "analysts publish price targets".
    # Both forms accepted so the check keeps working across the change.
    "analysts":     r'(\d+) analysts (?:average|publish price targets)[^(]*'
                    r'\((\d+) buy · (\d+) hold · (\d+) sell\)',
    # Copy drifted: the ATM-IV <dl> row was replaced by narrative prose.
    "iv":           r'on the \d+-day expiry imply (\d+)% annualised volatility',
    # Copy drifted: "N contracts · CBOE" -> "N contracts listed · CBOE".
    # NOTE: this label reads "contracts LISTED", which is an instrument count, not an
    # open-interest total. See the semantic caveat on the chain-OI check below.
    # Instrument count — how many strikes/expiries are listed. NOT an OI total.
    # Kept only so the semantic distinction stays visible in the output.
    "listed_count": r'(\d[\d,]*) contracts listed · CBOE',
    # ANSWERED FROM THE APP SIDE 2026-08-15: `contractCount` in
    # cboeOptions.ts is `parsed.length`, an instrument count, so the old
    # comparison was apples-to-oranges and no verdict from it meant anything.
    # The page now states the real aggregate — callOi + putOi — beside the
    # ratio it divides, which IS the quantity a per-strike OI can be measured
    # against. This check is a genuine invariant again.
    "oi_total":     r'across (\d[\d,]*) contracts of open interest',
    # Per-strike OI, from the largest-strikes list: "$21 calls (open interest 49,937, ...)".
    # The bare "N contracts" form was dropped because it also matches today's VOLUME,
    # a different quantity that must never be compared against an OI total. The
    # "against N open" form in the opening-flow sentence is also per-strike OI but is
    # only present when unusual activity fired, so it is not relied on.
    "oi_strikes":   r'open interest (\d[\d,]*)',
    "earnings":     r'Next earnings report: (\d{4}-\d{2}-\d{2})',
    # A page ADMITTING it could not confirm. Checked BEFORE `no_earnings`,
    # because the admission's own wording ("No earnings date came back...")
    # matches that looser pattern and would otherwise be scored as the very
    # overclaim it is refusing to make.
    "earnings_unknown": r'(Earnings date could not be confirmed'
                        r'|No earnings date came back'
                        r'|not a clear calendar)',
    "no_earnings":  r'(No (?:known )?earnings|no report (?:known|scheduled))',
    "ma_claim":     r'(above|below) (?:its |all )?(?:20,? 50,? and 200|20/50/200)[- ]day',
}

def fetch(sym, base):
    url = f"{base}/asset/{sym}"
    req = urllib.request.Request(url, headers={"User-Agent": "crossvalidate/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        raw = r.read().decode("utf-8", "replace")
    html = raw.replace('\\"', '"').replace("\\u0026", "&")
    #
    # STRIP REACT'S EXPRESSION SEPARATORS.
    #
    # Server-rendered React emits `<!-- -->` between adjacent JSX expressions,
    # so copy that reads "across 1,568,163 contracts of open interest" arrives
    # as:
    #
    #     across<!-- --> <!-- -->1,568,163<!-- --> contracts of open interest
    #
    # Any pattern spanning an expression boundary then fails silently and gets
    # logged as "pattern drift — the page copy likely changed", which sends the
    # next reader hunting for a copy change that never happened. This is the
    # real cause of a good share of the drift this checker keeps reporting.
    #
    # Comments only. Tags are NOT stripped, because several patterns key off
    # them deliberately (the price pattern anchors on a class attribute, the
    # ATM-IV one on a <dt>/<dd> pair) and removing them would trade one class
    # of false skip for another.
    html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
    # Collapse the whitespace those separators leave behind.
    return re.sub(r"[ \t]+", " ", html)

def grab(html, key, all_matches=False):
    m = re.findall(PATTERNS[key], html)
    if not m:
        return None
    return m if all_matches else m[0]

def num(s):
    return float(str(s).replace(",", ""))

# ─────────────────────────── independent recompute ───────────────────────────

def true_ranges(bars):
    trs = []
    for i in range(1, len(bars)):
        o, h, l, c = bars[i]
        pc = bars[i - 1][3]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return trs


def atr_pct(bars, period=14, method="wilder"):
    """ATR as a percent of last close.

    The app computes WILDER-smoothed ATR, which is the standard definition. This
    reference previously used a simple mean of the last `period` true ranges, which is
    a different statistic — that mismatch, not any app bug, produced the CIFR and HUT
    ATR failures. Verified 2026-08-15 against fresh Robinhood bars:

        sym    simple   wilder    page
        CIFR   14.93%   14.06%   14.04%
        HUT    12.80%   12.18%   12.15%
        IREN    9.60%    9.24%    9.21%
        WULF    9.47%    9.78%    9.77%

    The page tracks Wilder to within 0.03pp on all four. Do NOT "fix" the app to match
    the simple mean.
    """
    trs = true_ranges(bars)
    if not trs:
        return None
    if method == "simple":
        a = sum(trs[-period:]) / period
    else:
        a = sum(trs[:period]) / period
        for x in trs[period:]:
            a = (a * (period - 1) + x) / period
    return a / bars[-1][3] * 100

def realised_vol(bars):
    c = [b[3] for b in bars]
    rets = [c[i] / c[i - 1] - 1 for i in range(1, len(c))]
    m = sum(rets) / len(rets)
    var = sum((r - m) ** 2 for r in rets) / (len(rets) - 1)
    return math.sqrt(var) * math.sqrt(252) * 100

def sma(vals, p):
    return sum(vals[-p:]) / p if len(vals) >= p else None

def ema(vals, p):
    if len(vals) < p:
        return None
    k = 2 / (p + 1)
    acc = sum(vals[:p]) / p
    for v in vals[p:]:
        acc = v * k + acc * (1 - k)
    return acc

# ─────────────────────────── check harness ───────────────────────────

RESULTS = []

def record(sym, kind, name, status, detail):
    RESULTS.append((sym, kind, name, status, detail))
    icon = {"PASS": "  ok  ", "FAIL": " FAIL ", "WARN": " warn ", "SKIP": " skip "}[status]
    print(f"  [{icon}] {name:<34} {detail}")

# ─────────────────────────── the checks ───────────────────────────

def check_internal(sym, html):
    # 1. Analyst count must equal its own breakdown.
    a = grab(html, "analysts")
    if a is None:
        record(sym, "internal", "analyst count == breakdown", "SKIP", "pattern not found")
    else:
        total, buy, hold, sell = (int(x) for x in a)
        s = buy + hold + sell
        record(sym, "internal", "analyst count == breakdown",
               "PASS" if total == s else "FAIL",
               f"stated {total}, breakdown {buy}+{hold}+{sell}={s}")

    # 2. Chain open interest cannot be smaller than a single strike within it.
    tot = grab(html, "oi_total")
    strikes = grab(html, "oi_strikes", all_matches=True)
    if tot is None or not strikes:
        record(sym, "internal", "chain OI >= max strike OI", "SKIP", "pattern not found")
    else:
        t = num(tot)
        others = [num(x) for x in strikes if num(x) != t]
        biggest = max(others) if others else 0
        # SEMANTIC CAVEAT RESOLVED. Both sides are now open interest: `t` is the
        # chain total the page prints beside the put/call ratio, `biggest` is the
        # largest single strike. A total below one of its own components is a real
        # defect, so this is a FAIL again rather than a WARN.
        ok = t >= biggest
        record(sym, "internal", "chain OI >= max strike OI",
               "PASS" if ok else "FAIL",
               f"chain OI {t:,.0f} vs largest strike {biggest:,.0f}")

    # 3. "Typical daily move" must have exactly one value.
    ma_, mb = grab(html, "move_a"), grab(html, "move_b")
    if ma_ is None or mb is None:
        record(sym, "internal", "single typical-move value", "SKIP", "pattern not found")
    else:
        d = abs(float(ma_) - float(mb))
        record(sym, "internal", "single typical-move value",
               "PASS" if d < 0.05 else "FAIL",
               f"narrative {ma_}% vs stop-sizing {mb}% (delta {d:.2f}pp)")

    # 4. A "no earnings in window" pass must rest on a known date, not a missing one.
    #
    # CORRECTED 2026-08-15. This warned on CIFR, and the site was right: the
    # checklist has three distinct states, and the third is an explicit
    # "Earnings date could not be confirmed ... do not read it as 'no report
    # scheduled'". The old order matched that admission with the loose
    # `no_earnings` pattern and reported the page as making the exact overclaim
    # it was refusing to make.
    #
    # A page that says it cannot confirm is PASSING this check — that is the
    # behaviour the check exists to require. Only an unqualified "no earnings"
    # with no date behind it is a warn.
    has_date = grab(html, "earnings")
    admits_unknown = grab(html, "earnings_unknown")
    says_none = grab(html, "no_earnings")
    if has_date:
        record(sym, "internal", "earnings gate has real data", "PASS", f"date known: {has_date}")
    elif admits_unknown:
        record(sym, "internal", "earnings gate has real data", "PASS",
               "no date retrieved, and the page says so rather than claiming a clear calendar")
    elif says_none:
        record(sym, "internal", "earnings gate has real data", "WARN",
               "claims no earnings, but no date was retrieved and the page does not admit it — "
               "cannot distinguish 'confirmed none' from 'lookup failed'")
    else:
        record(sym, "internal", "earnings gate has real data", "SKIP", "pattern not found")

def check_external(sym, html, bars):
    closes = [b[3] for b in bars]
    spot_ref = closes[-1]

    # 5. Spot price agreement.
    p = grab(html, "price")
    if p is None:
        record(sym, "external", "spot price vs reference", "SKIP", "pattern not found")
    else:
        drift = abs(float(p) - spot_ref) / spot_ref * 100
        record(sym, "external", "spot price vs reference",
               "PASS" if drift <= TOL_PRICE_PCT else "FAIL",
               f"page ${float(p):.2f} vs ref ${spot_ref:.2f} ({drift:.2f}%)")

    # 6. ATR agreement — the engine that matters most for stop sizing.
    ref_atr = atr_pct(bars, method="wilder")
    alt_atr = atr_pct(bars, method="simple")
    page_atr = grab(html, "move_a")
    if page_atr is None or ref_atr is None:
        record(sym, "external", "ATR vs reference", "SKIP", "pattern not found")
    else:
        d = abs(float(page_atr) - ref_atr)
        detail = (f"page {float(page_atr):.2f}% vs Wilder {ref_atr:.2f}% "
                  f"(delta {d:.2f}pp; simple mean would be {alt_atr:.2f}%)")
        record(sym, "external", "ATR vs reference",
               "PASS" if d <= TOL_ATR_PP else "FAIL", detail)

    # 7. Implied vol sanity against realised.
    rv = realised_vol(bars)
    iv = grab(html, "iv")
    if iv is None:
        record(sym, "external", "IV/RV ratio plausible", "SKIP", "pattern not found")
    else:
        ratio = float(iv) / rv
        record(sym, "external", "IV/RV ratio plausible",
               "PASS" if ratio <= IV_RV_MAX else "FAIL",
               f"IV {float(iv):.0f}% / RV {rv:.0f}% = {ratio:.2f}x (max {IV_RV_MAX})")

    # 8. Moving-average claim. Reported both conventions; only FAIL when they agree
    #    against the page, since the app seeds EMA over a longer history than bars.json.
    claim = grab(html, "ma_claim")
    s50, e50 = sma(closes, 50), ema(closes, 50)
    if claim is None or s50 is None or e50 is None:
        record(sym, "external", "MA direction vs reference", "SKIP",
               "pattern not found" if claim is None else "need 50+ bars")
    else:
        ref_s = "above" if spot_ref > s50 else "below"
        ref_e = "above" if spot_ref > e50 else "below"
        detail = f"page says {claim}; ref SMA50 {ref_s} (${s50:.2f}), EMA50 {ref_e} (${e50:.2f})"
        # The app seeds EMA over 200+ bars (okxCandles.ts:14). With fewer than that,
        # our EMA runs too few iterations past seed to be independent of our SMA —
        # so agreement between the two is not two votes, it's one. Disagreement with
        # the page can only be a WARN until the snapshot is deep enough.
        deep = len(bars) >= 200
        if ref_s == ref_e == claim:
            record(sym, "external", "MA direction vs reference", "PASS", detail)
        elif ref_s == ref_e:
            record(sym, "external", "MA direction vs reference",
                   "FAIL" if deep else "WARN",
                   detail + ("  <- both conventions disagree with the page" if deep else
                             f"  <- disagrees, but only {len(bars)} bars; EMA50 is "
                             "under-converged. Deepen bars.json to 200+ to make this decisive."))
        else:
            record(sym, "external", "MA direction vs reference", "WARN",
                   detail + "  <- conventions split; check the app's own EMA")

# ─────────────────────────── main ───────────────────────────

def main():
    # `--base <url>` takes a value. The old filter only dropped tokens beginning with
    # "--", so the URL survived as a positional and was treated as a ticker — the run
    # then fetched /asset/https://... and reported a bogus 308 FAIL. Consume the value.
    base, args, i = BASE, [], 1
    fail_on_internal_skip = False
    argv = sys.argv
    while i < len(argv):
        a = argv[i]
        if a == "--base" and i + 1 < len(argv):
            base = argv[i + 1]; i += 2; continue
        if a.startswith("--base="):
            base = a.split("=", 1)[1]; i += 1; continue
        if a == "--fail-on-internal-skip":
            fail_on_internal_skip = True; i += 1; continue
        if a.startswith("--"):
            i += 1; continue
        args.append(a); i += 1

    ref = None
    if os.path.exists(BARS):
        ref = json.load(open(BARS))
        try:
            age = (date.today() - datetime.strptime(ref["as_of"], "%Y-%m-%d").date()).days
            if age > BARS_MAX_AGE:
                print(f"! bars.json is {age} days old (as_of {ref['as_of']}). "
                      f"External checks compare against stale data — refresh it "
                      f"from the Robinhood MCP tools.\n")
        except Exception:
            pass
    else:
        print(f"! {BARS} not found — internal checks only.\n")

    symbols = args or (sorted(ref["bars"]) if ref else [])
    if not symbols:
        print("No symbols. Pass them as arguments or provide bars.json.")
        return 2

    print(f"Cross-validating {base}\n")
    for sym in symbols:
        print(f"{sym}")
        try:
            html = fetch(sym, base)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            record(sym, "fetch", "page fetch", "FAIL", f"{type(e).__name__}: {e}")
            print()
            continue
        check_internal(sym, html)
        if ref and sym in ref["bars"]:
            check_external(sym, html, [tuple(b) for b in ref["bars"][sym]])
        else:
            record(sym, "external", "reference bars", "SKIP", "no bars.json entry")
        print()

    fails = [r for r in RESULTS if r[3] == "FAIL"]
    warns = [r for r in RESULTS if r[3] == "WARN"]
    skips = [r for r in RESULTS if r[3] == "SKIP"]
    print("─" * 72)
    print(f"{len(RESULTS)} checks   {len(RESULTS)-len(fails)-len(warns)-len(skips)} pass   "
          f"{len(fails)} FAIL   {len(warns)} warn   {len(skips)} skip")
    if fails:
        print("\nFailures:")
        for sym, _, name, _, detail in fails:
            print(f"  {sym:<6} {name:<34} {detail}")
    if skips:
        print("\nSkipped (pattern drift — the page copy likely changed; "
              "update PATTERNS rather than ignoring):")
        for sym, _, name, _, _ in skips:
            print(f"  {sym:<6} {name}")
    # In CI, a SKIPPED INTERNAL check is a failure. This is the exact failure
    # mode that motivated wiring this in at all: copy changes silently degraded
    # sixteen checks to SKIP, and an exit-0 run looked green while checking
    # nothing. External skips stay soft — bars.json legitimately absent in CI.
    internal_skips = [r for r in skips if r[1] in ("internal", "fetch")]
    if fail_on_internal_skip and internal_skips and not fails:
        print("\n--fail-on-internal-skip: treating the internal skips above as failures.")
        return 1
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
